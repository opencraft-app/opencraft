package prodk8s

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestProductionEntitlementPlanBootstrapContainsOnlyReferencedPlans(t *testing.T) {
	raw, err := os.ReadFile("bootstrap/entitlement-plans.json")
	if err != nil {
		t.Fatal(err)
	}
	var plans []struct {
		ID            string `json:"id"`
		Name          string `json:"name"`
		MonthlyTokens int64  `json:"monthly_tokens"`
		PeriodValue   int    `json:"period_value"`
		PeriodUnit    string `json:"period_unit"`
		IsActive      bool   `json:"is_active"`
		Periods       []struct {
			PeriodValue int    `json:"period_value"`
			PeriodUnit  string `json:"period_unit"`
		} `json:"periods"`
	}
	if err := json.Unmarshal(raw, &plans); err != nil {
		t.Fatal(err)
	}
	if len(plans) != 6 {
		t.Fatalf("plan count=%d, want 6", len(plans))
	}
	seen := map[string]struct{}{}
	starterPeriodFound := false
	for _, plan := range plans {
		if plan.ID == "" || plan.Name == "" || plan.MonthlyTokens < 0 || plan.PeriodValue <= 0 || plan.PeriodUnit == "" || !plan.IsActive {
			t.Fatalf("invalid plan: %+v", plan)
		}
		if strings.HasPrefix(plan.ID, "load-") || strings.HasPrefix(strings.ToLower(plan.Name), "load-") {
			t.Fatalf("load-test plan must not be bootstrapped: %+v", plan)
		}
		if _, ok := seen[plan.ID]; ok {
			t.Fatalf("duplicate plan id %q", plan.ID)
		}
		seen[plan.ID] = struct{}{}
		for _, period := range plan.Periods {
			if period.PeriodValue <= 0 || period.PeriodUnit == "" {
				t.Fatalf("invalid period variant for plan %q: %+v", plan.ID, period)
			}
			if plan.ID == "e87f3e65-9aaa-4790-b335-ce567a577f8f" && period.PeriodValue == 14 && period.PeriodUnit == "days" {
				starterPeriodFound = true
			}
		}
	}
	if !starterPeriodFound {
		t.Fatal("starter plan is missing the 14-day period variant")
	}
	if _, ok := seen["e87f3e65-9aaa-4790-b335-ce567a577f8f:14:days"]; ok {
		t.Fatal("period variant must not be bootstrapped as a separate plan")
	}
}
