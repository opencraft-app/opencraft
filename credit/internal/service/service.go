package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"strings"
	"time"

	"git.woa.com/wisp/mono/credit/internal/store"
)

const (
	CreditTypePaid = "paid"
	CreditTypeFree = "free"

	paidSubscriptionPrefix = "credit-package:"
	freeSubscriptionPrefix = "free-credit:"
)

type LLMGateway interface {
	ApplySubscription(context.Context, ApplySubscriptionRequest) (Subscription, error)
	CancelSelectedSubscriptions(context.Context, CancelSelectedSubscriptionsRequest) error
	ListActiveSubscriptions(context.Context, string) (ActiveSubscriptionList, error)
}

type ApplySubscriptionRequest struct {
	IdempotencyKey   string
	UserID           string
	PlanID           string
	SubscriptionName string
	IsUnique         bool
}

type CancelSelectedSubscriptionsRequest struct {
	UserID            string
	SubscriptionNames []string
}

type Subscription struct {
	ID           string `json:"id"`
	Name         string `json:"name,omitempty"`
	UserID       string `json:"user_id"`
	PlanID       string `json:"plan_id"`
	Status       string `json:"status"`
	TokenTotal   int64  `json:"token_total"`
	TokenBalance int64  `json:"token_balance"`
	PeriodEnd    string `json:"period_end"`
}

type ActiveSubscriptionList struct {
	UserID        string         `json:"user_id"`
	Subscriptions []Subscription `json:"subscriptions"`
}

type Options struct {
	Now               func() time.Time
	GeneratePackageID func(context.Context, string) (string, error)
	CreditTokenRatio  int64
}

type Service struct {
	store store.Store
	llm   LLMGateway
	now   func() time.Time
	genID func(context.Context, string) (string, error)
	ratio int64
}

func New(st store.Store, llm LLMGateway, opts Options) *Service {
	now := opts.Now
	if now == nil {
		now = func() time.Time { return time.Now().UTC() }
	}
	ratio := opts.CreditTokenRatio
	if ratio <= 0 {
		ratio = 10000
	}
	return &Service{store: st, llm: llm, now: now, genID: opts.GeneratePackageID, ratio: ratio}
}

type CompletePaidPackageRequest struct {
	DealName   string
	BigOrderID string
	UserID     string
	ProductID  string
	Uin        string
	AppID      int64
	TimeSpan   int
	TimeUnit   string
}

func (s *Service) CompletePaidPackage(ctx context.Context, req CompletePaidPackageRequest) (*store.CreditPackage, error) {
	if err := validateCompleteRequest(req); err != nil {
		return nil, err
	}
	if existing, err := s.store.GetPackageByDealName(ctx, strings.TrimSpace(req.DealName)); err == nil {
		return existing, nil
	} else if err != store.ErrPackageNotFound {
		return nil, err
	}
	product, err := s.store.GetProductByID(ctx, req.ProductID)
	if err != nil {
		return nil, err
	}
	if product.State != store.ProductStateOnline {
		return nil, fmt.Errorf("credit product %s is offline", req.ProductID)
	}
	now := s.now().UTC()
	expiredTime, err := addBillingPeriod(now, req.TimeSpan, req.TimeUnit)
	if err != nil {
		return nil, err
	}
	if s.genID == nil {
		return nil, errors.New("credit package ID generator is required")
	}
	packageID, err := s.genID(ctx, strings.TrimSpace(req.DealName))
	if err != nil {
		return nil, fmt.Errorf("generate credit package ID: %w", err)
	}
	packageID = strings.TrimSpace(packageID)
	if packageID == "" {
		return nil, errors.New("generated credit package ID is empty")
	}
	if existing, err := s.store.GetPackageByID(ctx, packageID); err == nil {
		return existing, nil
	} else if err != store.ErrPackageNotFound {
		return nil, err
	}
	subscriptionName := paidSubscriptionPrefix + packageID
	_, err = s.llm.ApplySubscription(ctx, ApplySubscriptionRequest{
		IdempotencyKey:   "trade:" + strings.TrimSpace(req.DealName),
		UserID:           strings.TrimSpace(req.UserID),
		PlanID:           product.LLMGatewayPlanID,
		SubscriptionName: subscriptionName,
		IsUnique:         false,
	})
	if err != nil {
		return nil, err
	}
	active, err := s.llm.ListActiveSubscriptions(ctx, strings.TrimSpace(req.UserID))
	if err != nil {
		return nil, fmt.Errorf("list active subscriptions after apply: %w", err)
	}
	sub, ok := subscriptionByName(active.Subscriptions, subscriptionName)
	if !ok {
		return nil, fmt.Errorf("active subscription %s not found after apply", subscriptionName)
	}
	pkg := &store.CreditPackage{
		PackageID:           packageID,
		UserID:              strings.TrimSpace(req.UserID),
		ProductID:           product.ProductID,
		Uin:                 strings.TrimSpace(req.Uin),
		AppID:               req.AppID,
		DealName:            strings.TrimSpace(req.DealName),
		BigOrderID:          strings.TrimSpace(req.BigOrderID),
		LLMGatewayPlanID:    product.LLMGatewayPlanID,
		LLMSubscriptionID:   sub.ID,
		LLMSubscriptionName: subscriptionName,
		CreatedTime:         now,
		ExpiredTime:         expiredTime.UTC(),
		Status:              store.PackageStatusActive,
		UpdatedTime:         now,
	}
	creditTotal, err := store.CreditAmountFromTokens(sub.TokenTotal, s.ratio)
	if err != nil {
		return nil, err
	}
	creditLeft, err := store.CreditAmountFromTokens(sub.TokenBalance, s.ratio)
	if err != nil {
		return nil, err
	}
	if creditLeft > creditTotal {
		creditLeft = creditTotal
	}
	creditUsed := creditTotal - creditLeft
	if creditUsed < 0 {
		creditUsed = 0
	}
	usageDate, nextRetryTime := usageBaselineAndNextRetry(now)
	usage := &store.CreditPackageUsage{
		PackageID:          pkg.PackageID,
		UserID:             pkg.UserID,
		ProductID:          pkg.ProductID,
		DealName:           pkg.DealName,
		Uin:                pkg.Uin,
		AppID:              pkg.AppID,
		UsageDate:          usageDate,
		CalcDate:           usageDate,
		PackageExpiredTime: pkg.ExpiredTime,
		CreditTotal:        creditTotal,
		CreditUsedTotal:    creditUsed,
		CreditLeft:         creditLeft,
		SnapshotTime:       now,
		PushStatus:         store.UsagePushStatusInit,
		NextRetryTime:      nextRetryTime,
		CreatedTime:        now,
		UpdatedTime:        now,
	}
	if err := s.store.CreatePackageWithUsage(ctx, pkg, usage); err != nil {
		return nil, err
	}
	return pkg, nil
}

func subscriptionByName(subscriptions []Subscription, name string) (Subscription, bool) {
	wanted := strings.TrimSpace(name)
	for i := range subscriptions {
		if strings.TrimSpace(subscriptions[i].Name) == wanted {
			return subscriptions[i], true
		}
	}
	return Subscription{}, false
}

func usageBaselineAndNextRetry(now time.Time) (time.Time, time.Time) {
	location := time.FixedZone("Asia/Shanghai", 8*60*60)
	local := now.In(location)
	date := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, time.UTC)
	nextLocalMidnight := time.Date(local.Year(), local.Month(), local.Day()+1, 0, 0, 0, 0, location)
	return date, nextLocalMidnight.UTC()
}

func (s *Service) IsolatePaidPackage(ctx context.Context, packageID string, reason string) error {
	now := s.now().UTC()
	return s.destroyPaidPackage(ctx, packageID, defaultString(reason, "billing_isolate"), &now)
}

func (s *Service) ExpirePaidPackage(ctx context.Context, packageID string) error {
	return s.destroyPaidPackage(ctx, packageID, "expired", nil)
}

func (s *Service) destroyPaidPackage(ctx context.Context, packageID string, reason string, isolatedAt *time.Time) error {
	packageID = strings.TrimSpace(packageID)
	now := s.now().UTC()
	pkg, err := s.store.GetPackageByID(ctx, packageID)
	if errors.Is(err, store.ErrPackageNotFound) {
		return s.store.MovePackageToHistory(ctx, packageID, now, strings.TrimSpace(reason), isolatedAt)
	}
	if err != nil {
		return err
	}
	if pkg.Status != store.PackageStatusIsolated {
		if err := s.llm.CancelSelectedSubscriptions(ctx, CancelSelectedSubscriptionsRequest{
			UserID:            pkg.UserID,
			SubscriptionNames: []string{pkg.LLMSubscriptionName},
		}); err != nil {
			return err
		}
	} else if isolatedAt != nil && pkg.IsolatedTime != nil {
		isolatedAt = pkg.IsolatedTime
	}
	return s.store.MovePackageToHistory(ctx, pkg.PackageID, now, strings.TrimSpace(reason), isolatedAt)
}

func defaultString(value, fallback string) string {
	if value = strings.TrimSpace(value); value != "" {
		return value
	}
	return fallback
}

type CreditItem struct {
	CreditType      string             `json:"credit_type"`
	CreditTotal     store.CreditAmount `json:"credit_total"`
	CreditAvailable store.CreditAmount `json:"credit_available"`
	ExpiredTime     time.Time          `json:"expired_time"`
}

type UsedAmountRequest struct {
	Uin         string
	AppID       int64
	ResourceIDs []string
}

type UsedAmountItem struct {
	PackageID string      `json:"package_id"`
	ProductID string      `json:"product_id"`
	DealName  string      `json:"deal_name"`
	UsedRatio json.Number `json:"used_ratio"`
}

type ResourcePageRequest struct {
	ProductIDs []string
	PageNo     int
	PageSize   int
}

type UserResourcePageRequest struct {
	Uin        string
	AppID      int64
	ProductIDs []string
	PageNo     int
	PageSize   int
}

type ResourceQueryRequest struct {
	Uin         string
	AppID       int64
	ResourceIDs []string
}

type ResourceItem struct {
	PackageID    string     `json:"package_id"`
	ProductID    string     `json:"product_id"`
	Uin          string     `json:"uin"`
	AppID        int64      `json:"app_id"`
	CreatedTime  time.Time  `json:"created_time"`
	ExpiredTime  time.Time  `json:"expired_time"`
	IsolatedTime *time.Time `json:"isolated_time,omitempty"`
	Status       string     `json:"status"`
	AllowReturn  bool       `json:"allow_return"`
}

func (s *Service) ListResourceAppIDs(ctx context.Context, req ResourcePageRequest) ([]int64, int64, error) {
	if err := validatePage(req.PageNo, req.PageSize, 20000); err != nil {
		return nil, 0, err
	}
	return s.store.ListPackageAppIDs(ctx, cleanStrings(req.ProductIDs), req.PageNo, req.PageSize)
}

func (s *Service) ListUserResources(ctx context.Context, req UserResourcePageRequest) ([]ResourceItem, int64, error) {
	if strings.TrimSpace(req.Uin) == "" || req.AppID <= 0 {
		return nil, 0, fmt.Errorf("uin and app_id are required")
	}
	if err := validatePage(req.PageNo, req.PageSize, 1000); err != nil {
		return nil, 0, err
	}
	packages, total, err := s.store.ListPackagesByOwner(
		ctx, strings.TrimSpace(req.Uin), req.AppID, cleanStrings(req.ProductIDs), req.PageNo, req.PageSize,
	)
	if err != nil {
		return nil, 0, err
	}
	return s.resourceItems(packages), total, nil
}

func (s *Service) QueryResources(ctx context.Context, req ResourceQueryRequest) ([]ResourceItem, error) {
	if req.AppID <= 0 || len(req.ResourceIDs) == 0 {
		return nil, fmt.Errorf("app_id and resource_ids are required")
	}
	if len(req.ResourceIDs) > 100 {
		return nil, fmt.Errorf("resource_ids exceed limit 100")
	}
	uin := strings.TrimSpace(req.Uin)
	packages := make([]*store.CreditPackage, 0, len(req.ResourceIDs))
	for _, resourceID := range req.ResourceIDs {
		pkg, err := s.store.GetPackageByID(ctx, strings.TrimSpace(resourceID))
		if errors.Is(err, store.ErrPackageNotFound) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if pkg.AppID != req.AppID || (uin != "" && pkg.Uin != uin) {
			continue
		}
		packages = append(packages, pkg)
	}
	return s.resourceItems(packages), nil
}

func (s *Service) resourceItems(packages []*store.CreditPackage) []ResourceItem {
	now := s.now().UTC()
	items := make([]ResourceItem, 0, len(packages))
	for _, pkg := range packages {
		if pkg == nil {
			continue
		}
		items = append(items, ResourceItem{
			PackageID: pkg.PackageID, ProductID: pkg.ProductID, Uin: pkg.Uin, AppID: pkg.AppID,
			CreatedTime: pkg.CreatedTime.UTC(), ExpiredTime: pkg.ExpiredTime.UTC(), IsolatedTime: pkg.IsolatedTime,
			Status: pkg.Status, AllowReturn: pkg.Status == store.PackageStatusActive && pkg.ExpiredTime.After(now),
		})
	}
	return items
}

func validatePage(pageNo, pageSize, maxPageSize int) error {
	if pageNo < 0 {
		return fmt.Errorf("page_no must be >= 0")
	}
	if pageSize <= 0 || pageSize > maxPageSize {
		return fmt.Errorf("page_size must be between 1 and %d", maxPageSize)
	}
	return nil
}

func cleanStrings(values []string) []string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			out = append(out, value)
		}
	}
	return out
}

func (s *Service) GetUsedAmounts(ctx context.Context, req UsedAmountRequest) (map[string]UsedAmountItem, error) {
	if strings.TrimSpace(req.Uin) == "" || req.AppID <= 0 || len(req.ResourceIDs) == 0 {
		return nil, fmt.Errorf("uin, app_id and resource_ids are required")
	}
	now := s.now().UTC()
	packages := make([]*store.CreditPackage, 0, len(req.ResourceIDs))
	byUser := make(map[string][]*store.CreditPackage)
	for _, resourceID := range req.ResourceIDs {
		pkg, err := s.store.GetPackageByID(ctx, strings.TrimSpace(resourceID))
		if err != nil {
			return nil, err
		}
		if pkg.Uin != strings.TrimSpace(req.Uin) || pkg.AppID != req.AppID {
			return nil, fmt.Errorf("credit package %s does not belong to uin/app_id", pkg.PackageID)
		}
		if pkg.Status != store.PackageStatusActive || !pkg.ExpiredTime.After(now) {
			return nil, fmt.Errorf("credit package %s is not active", pkg.PackageID)
		}
		packages = append(packages, pkg)
		byUser[pkg.UserID] = append(byUser[pkg.UserID], pkg)
	}

	subscriptions := make(map[string]Subscription, len(packages))
	for userID, userPackages := range byUser {
		list, err := s.llm.ListActiveSubscriptions(ctx, userID)
		if err != nil {
			return nil, err
		}
		wanted := make(map[string]struct{}, len(userPackages))
		for _, pkg := range userPackages {
			wanted[pkg.LLMSubscriptionName] = struct{}{}
		}
		for _, sub := range list.Subscriptions {
			if _, ok := wanted[strings.TrimSpace(sub.Name)]; ok {
				subscriptions[strings.TrimSpace(sub.Name)] = sub
			}
		}
	}

	out := make(map[string]UsedAmountItem, len(packages))
	for _, pkg := range packages {
		sub, ok := subscriptions[pkg.LLMSubscriptionName]
		if !ok {
			return nil, fmt.Errorf("active llmgateway subscription missing for credit package %s", pkg.PackageID)
		}
		ratio, err := usedRatio(sub.TokenTotal, sub.TokenBalance)
		if err != nil {
			return nil, fmt.Errorf("credit package %s: %w", pkg.PackageID, err)
		}
		out[pkg.PackageID] = UsedAmountItem{
			PackageID: pkg.PackageID,
			ProductID: pkg.ProductID,
			DealName:  pkg.DealName,
			UsedRatio: ratio,
		}
	}
	return out, nil
}

func usedRatio(total, balance int64) (json.Number, error) {
	if total <= 0 {
		return "", fmt.Errorf("subscription total must be positive")
	}
	used := total - balance
	if used < 0 {
		used = 0
	}
	if used > total {
		used = total
	}
	text := new(big.Rat).SetFrac(big.NewInt(used), big.NewInt(total)).FloatString(8)
	text = strings.TrimRight(strings.TrimRight(text, "0"), ".")
	if text == "" {
		text = "0"
	}
	return json.Number(text), nil
}

func (s *Service) QueryCredits(ctx context.Context, userID string) ([]CreditItem, error) {
	list, err := s.llm.ListActiveSubscriptions(ctx, strings.TrimSpace(userID))
	if err != nil {
		return nil, err
	}
	now := s.now().UTC()
	items := make([]CreditItem, 0, len(list.Subscriptions))
	for _, sub := range list.Subscriptions {
		name := strings.TrimSpace(sub.Name)
		switch {
		case strings.HasPrefix(name, paidSubscriptionPrefix):
			pkg, err := s.store.GetPackageBySubscriptionName(ctx, name)
			if err != nil {
				continue
			}
			if pkg.Status != store.PackageStatusActive || !pkg.ExpiredTime.After(now) {
				continue
			}
			total, err := store.CreditAmountFromTokens(sub.TokenTotal, s.ratio)
			if err != nil {
				return nil, err
			}
			available, err := store.CreditAmountFromTokens(sub.TokenBalance, s.ratio)
			if err != nil {
				return nil, err
			}
			items = append(items, CreditItem{
				CreditType:      CreditTypePaid,
				CreditTotal:     total,
				CreditAvailable: available,
				ExpiredTime:     pkg.ExpiredTime.UTC(),
			})
		case strings.HasPrefix(name, freeSubscriptionPrefix):
			expiredTime, _ := time.Parse(time.RFC3339, strings.TrimSpace(sub.PeriodEnd))
			total, err := store.CreditAmountFromTokens(sub.TokenTotal, s.ratio)
			if err != nil {
				return nil, err
			}
			available, err := store.CreditAmountFromTokens(sub.TokenBalance, s.ratio)
			if err != nil {
				return nil, err
			}
			items = append(items, CreditItem{
				CreditType:      CreditTypeFree,
				CreditTotal:     total,
				CreditAvailable: available,
				ExpiredTime:     expiredTime.UTC(),
			})
		}
	}
	return items, nil
}

func validateCompleteRequest(req CompletePaidPackageRequest) error {
	switch {
	case strings.TrimSpace(req.DealName) == "":
		return fmt.Errorf("deal_name is required")
	case strings.TrimSpace(req.BigOrderID) == "":
		return fmt.Errorf("big_order_id is required")
	case strings.TrimSpace(req.UserID) == "":
		return fmt.Errorf("user_id is required")
	case strings.TrimSpace(req.ProductID) == "":
		return fmt.Errorf("product_id is required")
	case strings.TrimSpace(req.Uin) == "":
		return fmt.Errorf("uin is required")
	case req.AppID <= 0:
		return fmt.Errorf("app_id is required")
	case req.TimeSpan <= 0:
		return fmt.Errorf("time_span is required")
	case strings.TrimSpace(req.TimeUnit) == "":
		return fmt.Errorf("time_unit is required")
	default:
		return nil
	}
}

func addBillingPeriod(base time.Time, span int, unit string) (time.Time, error) {
	if span <= 0 {
		return time.Time{}, fmt.Errorf("time_span must be positive")
	}
	switch strings.TrimSpace(unit) {
	case "d":
		return base.AddDate(0, 0, span), nil
	case "m":
		return base.AddDate(0, span, 0), nil
	case "y":
		return base.AddDate(span, 0, 0), nil
	case "h":
		return base.Add(time.Duration(span) * time.Hour), nil
	case "M":
		return base.Add(time.Duration(span) * time.Minute), nil
	case "s":
		return base.Add(time.Duration(span) * time.Second), nil
	default:
		return time.Time{}, fmt.Errorf("unsupported time_unit %q", unit)
	}
}
