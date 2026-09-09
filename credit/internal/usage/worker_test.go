package usage

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"git.woa.com/wisp/mono/credit/internal/service"
	"git.woa.com/wisp/mono/credit/internal/store"
)

type fakeUsageStore struct {
	row       *store.CreditPackageUsage
	claimed   bool
	snapshot  *SnapshotUpdate
	succeeded bool
	baselined bool
}

func (s *fakeUsageStore) ListDueUsages(context.Context, time.Time, int) ([]*store.CreditPackageUsage, error) {
	return []*store.CreditPackageUsage{s.row}, nil
}

func (s *fakeUsageStore) TryClaimUsage(context.Context, int64, time.Time, string, time.Time, time.Time) (bool, error) {
	return s.claimed, nil
}

func (s *fakeUsageStore) SaveUsageSnapshot(_ context.Context, _ int64, _ string, update SnapshotUpdate) error {
	s.snapshot = &update
	s.row.UsageDate = update.UsageDate
	s.row.CalcDate = update.CalcDate
	s.row.CreditTotal = update.CreditTotal
	s.row.CreditUsedTotal = update.CreditUsedTotal
	s.row.CreditUsedDay = update.CreditUsedDay
	s.row.CreditLeft = update.CreditLeft
	s.row.RequestPayload = append([]byte(nil), update.RequestPayload...)
	return nil
}

func (s *fakeUsageStore) MarkUsageSuccess(context.Context, int64, string, time.Time, []byte, time.Time) error {
	s.succeeded = true
	return nil
}

func (s *fakeUsageStore) MarkUsageBaseline(context.Context, int64, string, time.Time, time.Time) error {
	s.baselined = true
	return nil
}

func (s *fakeUsageStore) MarkUsageFailure(context.Context, int64, string, time.Time, string, time.Time) error {
	return nil
}

type fakeUsageLLM struct {
	list  service.ActiveSubscriptionList
	calls int
}

func (f *fakeUsageLLM) ListActiveSubscriptions(context.Context, string) (service.ActiveSubscriptionList, error) {
	f.calls++
	return f.list, nil
}

type fakeReporter struct {
	requests []ReportRequest
}

func (r *fakeReporter) ReportUsage(_ context.Context, req ReportRequest) (json.RawMessage, error) {
	r.requests = append(r.requests, req)
	return json.RawMessage(`{"success":true}`), nil
}

func TestRunOnceClaimsCalculatesAndSchedulesTomorrow(t *testing.T) {
	now := time.Date(2026, 9, 3, 16, 0, 5, 0, time.UTC) // 2026-09-04 00:00:05 Beijing.
	row := &store.CreditPackageUsage{
		ID: 1, PackageID: "cpkg-test001", UserID: "usr_1", ProductID: "credit_100", DealName: "deal-1",
		Uin: "700000164995", AppID: 1300000001, PackageExpiredTime: now.Add(24 * time.Hour),
		CalcDate: time.Date(2026, 9, 3, 0, 0, 0, 0, time.UTC), CreditTotal: 100000,
		NextRetryTime: now.Add(-time.Second),
	}
	st := &fakeUsageStore{row: row, claimed: true}
	reporter := &fakeReporter{}
	worker := NewWorker(st, &fakeUsageLLM{list: service.ActiveSubscriptionList{Subscriptions: []service.Subscription{{
		Name: "credit-package:cpkg-test001", TokenTotal: 100000, TokenBalance: 99999,
	}}}}, reporter, WorkerOptions{Now: func() time.Time { return now }, CreditTokenRatio: 10000})

	if err := worker.RunOnce(context.Background()); err != nil {
		t.Fatalf("run once: %v", err)
	}
	if !st.succeeded || st.snapshot == nil || len(reporter.requests) != 1 {
		t.Fatalf("worker did not complete report: succeeded=%v snapshot=%+v requests=%d", st.succeeded, st.snapshot, len(reporter.requests))
	}
	if st.snapshot.CreditUsedDay.String() != "0.0001" || st.snapshot.CreditLeft.String() != "9.9999" {
		t.Fatalf("unexpected decimal usage snapshot: %+v", st.snapshot)
	}
}

func TestRunOnceSkipsRecordWhenClaimLoses(t *testing.T) {
	now := time.Date(2026, 9, 3, 16, 0, 5, 0, time.UTC)
	st := &fakeUsageStore{row: &store.CreditPackageUsage{ID: 1, NextRetryTime: now.Add(-time.Second)}}
	reporter := &fakeReporter{}
	worker := NewWorker(st, &fakeUsageLLM{}, reporter, WorkerOptions{Now: func() time.Time { return now }})

	if err := worker.RunOnce(context.Background()); err != nil {
		t.Fatalf("run once: %v", err)
	}
	if len(reporter.requests) != 0 {
		t.Fatalf("lost claim must not report usage")
	}
}

func TestRunOnceBuildsBaselineForExistingPackageWithoutReporting(t *testing.T) {
	now := time.Date(2026, 9, 3, 16, 0, 5, 0, time.UTC)
	row := &store.CreditPackageUsage{
		ID: 2, PackageID: "cpkg-existing", UserID: "usr_1", ProductID: "credit_100", DealName: "deal-2",
		Uin: "700000164995", AppID: 1300000001, PackageExpiredTime: now.Add(24 * time.Hour), NextRetryTime: now.Add(-time.Second),
	}
	st := &fakeUsageStore{row: row, claimed: true}
	reporter := &fakeReporter{}
	worker := NewWorker(st, &fakeUsageLLM{list: service.ActiveSubscriptionList{Subscriptions: []service.Subscription{{
		Name: "credit-package:cpkg-existing", TokenTotal: 100000, TokenBalance: 75000,
	}}}}, reporter, WorkerOptions{Now: func() time.Time { return now }, CreditTokenRatio: 10000})

	if err := worker.RunOnce(context.Background()); err != nil {
		t.Fatalf("run once: %v", err)
	}
	if !st.baselined || len(reporter.requests) != 0 || st.snapshot.CreditUsedTotal.String() != "2.5000" {
		t.Fatalf("unexpected baseline: baselined=%v reports=%d snapshot=%+v", st.baselined, len(reporter.requests), st.snapshot)
	}
}

func TestRunOnceReportsOrdinaryZeroUsage(t *testing.T) {
	now := time.Date(2026, 9, 3, 16, 0, 5, 0, time.UTC)
	row := &store.CreditPackageUsage{
		ID: 3, PackageID: "cpkg-zero", UserID: "usr_1", ProductID: "credit_100", DealName: "deal-3",
		Uin: "700000164995", AppID: 1300000001, PackageExpiredTime: now.Add(24 * time.Hour),
		CalcDate: time.Date(2026, 9, 3, 0, 0, 0, 0, time.UTC), CreditTotal: 100000,
		CreditUsedTotal: 25000, CreditLeft: 75000, NextRetryTime: now.Add(-time.Second),
	}
	st := &fakeUsageStore{row: row, claimed: true}
	reporter := &fakeReporter{}
	llm := &fakeUsageLLM{list: service.ActiveSubscriptionList{Subscriptions: []service.Subscription{{
		Name: "credit-package:cpkg-zero", TokenTotal: 100000, TokenBalance: 75000,
	}}}}
	worker := NewWorker(st, llm, reporter, WorkerOptions{Now: func() time.Time { return now }, CreditTokenRatio: 10000})

	if err := worker.RunOnce(context.Background()); err != nil {
		t.Fatalf("run once: %v", err)
	}
	if len(reporter.requests) != 1 || reporter.requests[0].CreditUsedDay != 0 {
		t.Fatalf("ordinary zero usage must be reported: %+v", reporter.requests)
	}
}

func TestRunOnceRetriesFrozenPayloadWithoutReadingLLMGateway(t *testing.T) {
	now := time.Date(2026, 9, 3, 16, 0, 5, 0, time.UTC)
	frozen := ReportRequest{
		PackageID: "cpkg-retry", ProductID: "credit_100", DealName: "deal-4", Uin: "700000164995",
		AppID: 1300000001, UsageDate: "2026-09-03", CalcDate: "2026-09-04", PackageExpiredTime: now.Add(24 * time.Hour),
		CreditTotal: 100000, CreditUsedDay: 1000, CreditLeft: 99000,
	}
	payload, err := json.Marshal(frozen)
	if err != nil {
		t.Fatal(err)
	}
	row := &store.CreditPackageUsage{
		ID: 4, PackageID: frozen.PackageID, PackageExpiredTime: frozen.PackageExpiredTime,
		CalcDate: time.Date(2026, 9, 4, 0, 0, 0, 0, time.UTC), RequestPayload: payload,
		NextRetryTime: now.Add(-time.Second),
	}
	st := &fakeUsageStore{row: row, claimed: true}
	reporter := &fakeReporter{}
	llm := &fakeUsageLLM{}
	worker := NewWorker(st, llm, reporter, WorkerOptions{Now: func() time.Time { return now }})

	if err := worker.RunOnce(context.Background()); err != nil {
		t.Fatalf("run once: %v", err)
	}
	if llm.calls != 0 || len(reporter.requests) != 1 || reporter.requests[0].CreditUsedDay != frozen.CreditUsedDay {
		t.Fatalf("retry must reuse frozen payload: llm_calls=%d requests=%+v", llm.calls, reporter.requests)
	}
}
