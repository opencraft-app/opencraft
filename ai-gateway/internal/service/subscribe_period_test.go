package service

import (
	"context"
	"testing"
	"time"

	"git.woa.com/wisp/mono/ai-gateway/internal/model"
	"github.com/google/uuid"
)

// R-MR-2 unit tests: Subscribe accepts (periodValue, periodUnit) and falls
// back to plan defaults per Q10=j1 (.tmp/aigateway-monthly-token-refresh-design.md §6.5.6).

func TestNormalizePeriodForSubscribe_FallbackToPlan(t *testing.T) {
	plan := &model.Plan{
		PeriodValue: 3,
		PeriodUnit:  "months",
	}
	cases := []struct {
		name     string
		inValue  int
		inUnit   string
		wantVal  int
		wantUnit string
	}{
		{"both_empty_falls_back", 0, "", 3, "months"},
		{"only_value_zero_falls_back", 0, "days", 3, "months"},
		{"only_unit_empty_falls_back", 5, "", 3, "months"},
		{"unrecognised_unit_falls_back", 5, "weeks", 3, "months"},
		{"both_present_used", 1, "y", 1, "years"},
		{"short_code_canonicalised", 7, "d", 7, "days"},
		{"long_form_canonicalised", 6, "Months", 6, "months"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			gv, gu := normalizePeriodForSubscribe(tc.inValue, tc.inUnit, plan)
			if gv != tc.wantVal || gu != tc.wantUnit {
				t.Errorf("normalizePeriodForSubscribe(%d, %q) = (%d, %q); want (%d, %q)",
					tc.inValue, tc.inUnit, gv, gu, tc.wantVal, tc.wantUnit)
			}
		})
	}
}

func TestNormalizePeriodForSubscribe_PlanShortCodeFallback(t *testing.T) {
	// Some legacy plans store unit as short codes like "m" — fallback should
	// still canonicalise it to "months" so calcPeriodEndFromValueUnit accepts it.
	plan := &model.Plan{PeriodValue: 1, PeriodUnit: "m"}
	gv, gu := normalizePeriodForSubscribe(0, "", plan)
	if gv != 1 || gu != "months" {
		t.Errorf("plan short-code fallback: got (%d, %q); want (1, \"months\")", gv, gu)
	}
}

func TestCalcPeriodEndFromValueUnit_Errors(t *testing.T) {
	start := time.Date(2026, time.May, 18, 0, 0, 0, 0, time.UTC)
	cases := []struct {
		name    string
		value   int
		unit    string
		wantErr string
	}{
		{"unknown_unit", 1, "weeks", "unsupported period_unit"},
		{"empty_unit", 1, "", "unsupported period_unit"},
		{"zero_value", 0, "months", "invalid period_value"},
		{"negative_value", -1, "months", "invalid period_value"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := calcPeriodEndFromValueUnit(start, tc.value, tc.unit)
			if err == nil {
				t.Fatalf("expected error containing %q, got nil", tc.wantErr)
			}
			if !contains(err.Error(), tc.wantErr) {
				t.Errorf("error = %q; want containing %q", err.Error(), tc.wantErr)
			}
		})
	}
}

func TestCalcPeriodEndFromValueUnit_BoundaryDates(t *testing.T) {
	// 与 timex.AddMonthsNatural 的月末溢出语义保持一致（Q2=b3 拍板）。
	cases := []struct {
		name     string
		start    time.Time
		value    int
		unit     string
		wantYear int
		wantMon  time.Month
		wantDay  int
	}{
		{"jan31_plus_1m_nonleap",
			time.Date(2026, time.January, 31, 0, 0, 0, 0, time.UTC),
			1, "months", 2026, time.February, 28},
		{"jan31_plus_1m_leap",
			time.Date(2024, time.January, 31, 0, 0, 0, 0, time.UTC),
			1, "months", 2024, time.February, 29},
		{"jan15_plus_3m",
			time.Date(2026, time.January, 15, 0, 0, 0, 0, time.UTC),
			3, "months", 2026, time.April, 15},
		{"jan15_plus_30d",
			time.Date(2026, time.January, 15, 0, 0, 0, 0, time.UTC),
			30, "days", 2026, time.February, 14},
		{"jan15_plus_1y",
			time.Date(2026, time.January, 15, 0, 0, 0, 0, time.UTC),
			1, "years", 2027, time.January, 15},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := calcPeriodEndFromValueUnit(tc.start, tc.value, tc.unit)
			if err != nil {
				t.Fatalf("error: %v", err)
			}
			if got.Year() != tc.wantYear || got.Month() != tc.wantMon || got.Day() != tc.wantDay {
				t.Errorf("calcPeriodEndFromValueUnit(%v, %d, %q) = %v; want %d-%s-%d",
					tc.start.Format("2006-01-02"), tc.value, tc.unit, got,
					tc.wantYear, tc.wantMon, tc.wantDay)
			}
		})
	}
}

func TestSubscribe_BundleDecouplingThreeDurations(t *testing.T) {
	// 关键 e2e：同一个 plan 在 R-MR-2 改造后可以被 1m / 3m / 1y 三种时长复用。
	planID := uuid.New()
	plan := &model.Plan{
		ID:            planID,
		Name:          "pro",
		MonthlyTokens: 1_000_000,
		PeriodValue:   1,        // plan 默认 1 个月
		PeriodUnit:    "months",
		IsActive:      true,
	}

	cases := []struct {
		name        string
		periodValue int
		periodUnit  string
		// 我们不验证 PeriodEnd 的精确日期（取决于 time.Now()），只验证 month-diff
		// 落在合理窗口内。
		wantMonths int
	}{
		{"1m_short_code", 1, "m", 1},
		{"3m_long_form", 3, "months", 3},
		{"1y_short_code", 1, "y", 12},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			subRepo := newMockSubscriptionRepo()
			planRepo := newMockPlanRepo()
			planRepo.plans[planID] = plan
			svc := NewSubscriptionService(subRepo, planRepo, nil)

			start := time.Date(2026, time.May, 18, 0, 0, 0, 0, time.UTC)
			sub, err := svc.Subscribe(uuid.New(), planID, &start, tc.periodValue, tc.periodUnit)
			if err != nil {
				t.Fatalf("Subscribe error: %v", err)
			}

			// 单月配额（不再是 N×MonthlyTokens）
			if sub.TokenBalance != plan.MonthlyTokens {
				t.Errorf("TokenBalance = %d; want %d (single-month quota)", sub.TokenBalance, plan.MonthlyTokens)
			}

			diffMonths := monthDiff(sub.PeriodStart, sub.PeriodEnd)
			if diffMonths != tc.wantMonths {
				t.Errorf("PeriodEnd - PeriodStart = %d months; want %d (start=%v, end=%v)",
					diffMonths, tc.wantMonths, sub.PeriodStart, sub.PeriodEnd)
			}
		})
	}
}

func TestSubscribe_FallbackToPlan(t *testing.T) {
	// Q10=j1: 调用方未传 PeriodValue/PeriodUnit 时回退到 plan 默认。
	planID := uuid.New()
	plan := &model.Plan{
		ID:            planID,
		Name:          "trial",
		MonthlyTokens: 100_000,
		PeriodValue:   7,
		PeriodUnit:    "days",
		IsActive:      true,
	}
	subRepo := newMockSubscriptionRepo()
	planRepo := newMockPlanRepo()
	planRepo.plans[planID] = plan
	svc := NewSubscriptionService(subRepo, planRepo, nil)

	start := time.Date(2026, time.May, 18, 0, 0, 0, 0, time.UTC)
	sub, err := svc.Subscribe(uuid.New(), planID, &start, 0, "")
	if err != nil {
		t.Fatalf("Subscribe error: %v", err)
	}
	wantEnd := start.AddDate(0, 0, 7)
	if !sub.PeriodEnd.Equal(wantEnd) {
		t.Errorf("PeriodEnd = %v; want %v (plan fallback 7 days)", sub.PeriodEnd, wantEnd)
	}
}

func TestSubscribe_HandlerProvidedOverridesPlan(t *testing.T) {
	// 调用方传入 PeriodValue/PeriodUnit 时 NOT to fall back to plan defaults.
	planID := uuid.New()
	plan := &model.Plan{
		ID:            planID,
		Name:          "pro",
		MonthlyTokens: 1_000_000,
		PeriodValue:   1, // plan 配 1 个月
		PeriodUnit:    "months",
		IsActive:      true,
	}
	subRepo := newMockSubscriptionRepo()
	planRepo := newMockPlanRepo()
	planRepo.plans[planID] = plan
	svc := NewSubscriptionService(subRepo, planRepo, nil)

	start := time.Date(2026, time.May, 18, 0, 0, 0, 0, time.UTC)
	// 调用方传入 1 年（覆盖 plan 默认 1 个月）
	sub, err := svc.Subscribe(uuid.New(), planID, &start, 1, "y")
	if err != nil {
		t.Fatalf("Subscribe error: %v", err)
	}
	wantEnd := start.AddDate(1, 0, 0)
	if !sub.PeriodEnd.Equal(wantEnd) {
		t.Errorf("PeriodEnd = %v; want %v (caller-provided 1 year)", sub.PeriodEnd, wantEnd)
	}
}

// helpers ---------------------------------------------------------------

func contains(haystack, needle string) bool {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return true
		}
	}
	return false
}

func monthDiff(start, end time.Time) int {
	years := end.Year() - start.Year()
	months := int(end.Month()) - int(start.Month())
	total := years*12 + months
	// AddMonthsNatural may have adjusted the day-of-month down (e.g. Jan 31 +1m
	// → Feb 28, which is still "1 month later"). The day comparison check is
	// not fully precise but for our test inputs (no month-end edges) this is OK.
	return total
}

// Silence unused-context import in case we add ctx-aware variants later.
var _ = context.Background
