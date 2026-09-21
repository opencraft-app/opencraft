package usage

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strings"
	"time"

	"git.woa.com/wisp/mono/credit/internal/service"
	"git.woa.com/wisp/mono/credit/internal/store"
)

const subscriptionPrefix = "credit-package:"

type SnapshotUpdate = store.UsageSnapshotUpdate

type UsageStore interface {
	ListDueUsages(context.Context, time.Time, int) ([]*store.CreditPackageUsage, error)
	TryClaimUsage(context.Context, int64, time.Time, string, time.Time, time.Time) (bool, error)
	SaveUsageSnapshot(context.Context, int64, string, SnapshotUpdate) error
	MarkUsageSuccess(context.Context, int64, string, time.Time, []byte, time.Time) error
	MarkUsageBaseline(context.Context, int64, string, time.Time, time.Time) error
	MarkUsageFailure(context.Context, int64, string, time.Time, string, time.Time) error
}

type LLMGateway interface {
	ListActiveSubscriptions(context.Context, string) (service.ActiveSubscriptionList, error)
}

type Reporter interface {
	ReportUsage(context.Context, ReportRequest) (json.RawMessage, error)
}

type ReportRequest struct {
	PackageID          string             `json:"package_id"`
	ProductID          string             `json:"product_id"`
	DealName           string             `json:"deal_name"`
	Uin                string             `json:"uin"`
	AppID              int64              `json:"app_id"`
	UsageDate          string             `json:"usage_date"`
	CalcDate           string             `json:"calc_date"`
	PackageExpiredTime time.Time          `json:"package_expired_time"`
	CreditTotal        store.CreditAmount `json:"credit_total"`
	CreditUsedDay      store.CreditAmount `json:"credit_used_day"`
	CreditLeft         store.CreditAmount `json:"credit_left"`
}

type WorkerOptions struct {
	Now              func() time.Time
	CreditTokenRatio int64
	LeaseDuration    time.Duration
	PollInterval     time.Duration
	BatchSize        int
}

type Worker struct {
	store        UsageStore
	llm          LLMGateway
	reporter     Reporter
	now          func() time.Time
	ratio        int64
	lease        time.Duration
	pollInterval time.Duration
	batchSize    int
}

func NewWorker(st UsageStore, llm LLMGateway, reporter Reporter, opts WorkerOptions) *Worker {
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	ratio := opts.CreditTokenRatio
	if ratio <= 0 {
		ratio = 10000
	}
	lease := opts.LeaseDuration
	if lease <= 0 {
		lease = 30 * time.Second
	}
	poll := opts.PollInterval
	if poll <= 0 {
		poll = 10 * time.Second
	}
	batchSize := opts.BatchSize
	if batchSize <= 0 || batchSize > 50 {
		batchSize = 50
	}
	return &Worker{store: st, llm: llm, reporter: reporter, now: now, ratio: ratio, lease: lease, pollInterval: poll, batchSize: batchSize}
}

func (w *Worker) Run(ctx context.Context) error {
	ticker := time.NewTicker(w.pollInterval)
	defer ticker.Stop()
	for {
		if err := w.RunOnce(ctx); err != nil && !errors.Is(err, context.Canceled) {
			log.Printf("[credit-usage-worker] run failed: %v", err)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

func (w *Worker) RunOnce(ctx context.Context) error {
	now := w.now().UTC()
	rows, err := w.store.ListDueUsages(ctx, now, w.batchSize)
	if err != nil {
		return err
	}
	var errs []error
	for _, row := range rows {
		if err := w.process(ctx, row, now); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

func (w *Worker) process(ctx context.Context, row *store.CreditPackageUsage, now time.Time) error {
	owner := randomOwner()
	claimed, err := w.store.TryClaimUsage(ctx, row.ID, row.NextRetryTime, owner, now.Add(w.lease), now)
	if err != nil || !claimed {
		return err
	}
	req, err := w.reportRequest(ctx, row, owner, now)
	if errors.Is(err, errBaselineCreated) {
		return w.store.MarkUsageBaseline(ctx, row.ID, owner, nextBeijingMidnight(now), now)
	}
	if err != nil {
		return w.fail(ctx, row, owner, now, err)
	}
	response, err := w.reporter.ReportUsage(ctx, req)
	if err != nil {
		return w.fail(ctx, row, owner, now, err)
	}
	return w.store.MarkUsageSuccess(ctx, row.ID, owner, nextBeijingMidnight(now), response, now)
}

var errBaselineCreated = errors.New("usage baseline created")

func (w *Worker) reportRequest(ctx context.Context, row *store.CreditPackageUsage, owner string, now time.Time) (ReportRequest, error) {
	calcDate := beijingDate(now)
	if row.CalcDate.Equal(calcDate) && len(row.RequestPayload) > 0 {
		var req ReportRequest
		if err := json.Unmarshal(row.RequestPayload, &req); err != nil {
			return ReportRequest{}, fmt.Errorf("decode frozen usage payload: %w", err)
		}
		return req, nil
	}
	list, err := w.llm.ListActiveSubscriptions(ctx, row.UserID)
	if err != nil {
		return ReportRequest{}, err
	}
	var subscription *service.Subscription
	wanted := subscriptionPrefix + row.PackageID
	for i := range list.Subscriptions {
		if strings.TrimSpace(list.Subscriptions[i].Name) == wanted {
			subscription = &list.Subscriptions[i]
			break
		}
	}
	if subscription == nil {
		return ReportRequest{}, fmt.Errorf("active subscription %s not found", wanted)
	}
	total, err := store.CreditAmountFromTokens(subscription.TokenTotal, w.ratio)
	if err != nil {
		return ReportRequest{}, err
	}
	left, err := store.CreditAmountFromTokens(subscription.TokenBalance, w.ratio)
	if err != nil {
		return ReportRequest{}, err
	}
	if left > total {
		left = total
	}
	usedTotal := total - left
	if usedTotal < 0 {
		usedTotal = 0
	}
	usedDay := usedTotal - row.CreditUsedTotal
	if usedDay < 0 {
		usedDay = 0
	}
	usageDate := calcDate.AddDate(0, 0, -1)
	if row.CreditTotal == 0 && len(row.RequestPayload) == 0 {
		update := SnapshotUpdate{
			UsageDate: usageDate, CalcDate: calcDate, CreditTotal: total, CreditUsedTotal: usedTotal,
			CreditUsedDay: 0, CreditLeft: left, SnapshotTime: now,
		}
		if err := w.store.SaveUsageSnapshot(ctx, row.ID, owner, update); err != nil {
			return ReportRequest{}, err
		}
		return ReportRequest{}, errBaselineCreated
	}
	req := ReportRequest{
		PackageID: row.PackageID, ProductID: row.ProductID, DealName: row.DealName,
		Uin: row.Uin, AppID: row.AppID, UsageDate: usageDate.Format(time.DateOnly), CalcDate: calcDate.Format(time.DateOnly),
		PackageExpiredTime: row.PackageExpiredTime,
		CreditTotal:        total, CreditUsedDay: usedDay, CreditLeft: left,
	}
	payload, err := json.Marshal(req)
	if err != nil {
		return ReportRequest{}, err
	}
	update := SnapshotUpdate{
		UsageDate: usageDate, CalcDate: calcDate, CreditTotal: total, CreditUsedTotal: usedTotal,
		CreditUsedDay: usedDay, CreditLeft: left, SnapshotTime: now, RequestPayload: payload,
	}
	if err := w.store.SaveUsageSnapshot(ctx, row.ID, owner, update); err != nil {
		return ReportRequest{}, err
	}
	return req, nil
}

func (w *Worker) fail(ctx context.Context, row *store.CreditPackageUsage, owner string, now time.Time, cause error) error {
	next := now.Add(retryDelay(row.PushAttempts))
	if !next.Before(beijingCutoff(now)) {
		next = nextBeijingMidnight(now)
	}
	if err := w.store.MarkUsageFailure(ctx, row.ID, owner, next, cause.Error(), now); err != nil {
		return errors.Join(cause, err)
	}
	return cause
}

func retryDelay(attempts int) time.Duration {
	delays := []time.Duration{30 * time.Second, time.Minute, 2 * time.Minute, 5 * time.Minute}
	if attempts < 0 {
		attempts = 0
	}
	if attempts >= len(delays) {
		return delays[len(delays)-1]
	}
	return delays[attempts]
}

var beijing = time.FixedZone("Asia/Shanghai", 8*60*60)

func beijingDate(now time.Time) time.Time {
	local := now.In(beijing)
	return time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, time.UTC)
}

func nextBeijingMidnight(now time.Time) time.Time {
	local := now.In(beijing)
	return time.Date(local.Year(), local.Month(), local.Day()+1, 0, 0, 0, 0, beijing).UTC()
}

func beijingCutoff(now time.Time) time.Time {
	local := now.In(beijing)
	return time.Date(local.Year(), local.Month(), local.Day(), 1, 0, 0, 0, beijing).UTC()
}

func randomOwner() string {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return fmt.Sprintf("worker-%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(value[:])
}
