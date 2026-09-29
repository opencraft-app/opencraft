package llmgateway

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"

	"ctl/pkg/config"

	"go.uber.org/zap"
)

type quotaResetFixture struct {
	mu                 sync.Mutex
	resetCalls         int
	amountUsed         int64
	nextReset          int64
	endTime            int64
	baseName           string
	projectedBaseName  string
	noBase             bool
	lastPlanIsCredit   bool
	extraSubscriptions []quotaSubscription
	failBinding        bool
}

func (f *quotaResetFixture) handler(w http.ResponseWriter, r *http.Request) {
	wantAuth := "Bearer admin-token"
	if r.URL.Path == "/api/internal/users/usr_test/subscriptions/active" {
		wantAuth = "Bearer internal-token"
	}
	if r.Header.Get("Authorization") != wantAuth {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	switch r.URL.Path {
	case "/api/admin/resources/user_bindings/rows/usr_test":
		if f.failBinding {
			_, _ = w.Write([]byte(`{"success":false,"message":"binding unavailable"}`))
			return
		}
		lastPlan := "plan-launch"
		if f.lastPlanIsCredit {
			lastPlan = "plan-credit"
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "data": map[string]any{"row": map[string]any{"values": map[string]any{
			"set_id": "set-a", "upstream_user_id": 20, "last_plan_id": lastPlan,
		}}}})
	case "/api/plans/plan-launch/sets":
		_, _ = w.Write([]byte(`{"success":true,"data":[{"set_id":"set-a","status":"ready","upstream_plan_id":13}]}`))
	case "/_llmgateway_console/set-a/api/subscription/admin/users/20/subscriptions":
		f.mu.Lock()
		subs := make([]any, 0, len(f.extraSubscriptions)+1)
		if !f.noBase {
			subs = append(subs, map[string]any{"subscription": quotaSubscription{
				ID: 31, Name: f.baseName, Status: "active", PlanID: 13, AmountUsed: f.amountUsed,
				NextResetTime: f.nextReset, EndTime: f.endTime,
			}})
		}
		for _, sub := range f.extraSubscriptions {
			subs = append(subs, map[string]any{"subscription": sub})
		}
		f.mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "data": subs})
	case "/api/internal/users/usr_test/subscriptions/active":
		f.mu.Lock()
		subs := make([]Subscription, 0, len(f.extraSubscriptions)+1)
		if !f.noBase {
			name := f.baseName
			if f.projectedBaseName != "" {
				name = f.projectedBaseName
			}
			subs = append(subs, Subscription{ID: "31", Name: name, UserID: "usr_test", PlanID: "plan-launch", Status: "active"})
		}
		for _, sub := range f.extraSubscriptions {
			planID := "plan-credit"
			if sub.PlanID == 13 {
				planID = "plan-launch"
			}
			subs = append(subs, Subscription{ID: strconv.Itoa(sub.ID), Name: sub.Name, UserID: "usr_test", PlanID: planID, Status: sub.Status})
		}
		f.mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "data": ActiveSubscriptionList{UserID: "usr_test", Subscriptions: subs}})
	case "/_llmgateway_console/set-a/api/subscription/admin/users/20/subscriptions/reset":
		if r.Method != http.MethodPost {
			http.Error(w, "method", http.StatusMethodNotAllowed)
			return
		}
		var body struct {
			PlanID           int  `json:"plan_id"`
			AdvanceResetTime bool `json:"advance_reset_time"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.PlanID != 13 || body.AdvanceResetTime {
			http.Error(w, "bad body", http.StatusBadRequest)
			return
		}
		f.mu.Lock()
		f.resetCalls++
		f.amountUsed = 0
		resetCount := 1
		for i := range f.extraSubscriptions {
			if f.extraSubscriptions[i].PlanID == body.PlanID {
				f.extraSubscriptions[i].AmountUsed = 0
				resetCount++
			}
		}
		f.mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "data": map[string]any{
			"reset_count": resetCount, "user_count": 1, "advance_reset_time": false,
		}})
	default:
		http.NotFound(w, r)
	}
}

func newQuotaResetTestAdapter(t *testing.T, fixture *quotaResetFixture) *LLMGatewayAdapter {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(fixture.handler))
	t.Cleanup(server.Close)
	return NewLLMGatewayAdapter(&config.LLMGatewayConfig{
		BaseURL: server.URL, AdminToken: "admin-token", InternalServiceToken: "internal-token", Timeout: 5,
	}, zap.NewNop())
}

func TestResetUserQuotaDryRunDoesNotPost(t *testing.T) {
	fixture := &quotaResetFixture{amountUsed: 99, nextReset: 1800000000, endTime: 1900000000}
	adapter := newQuotaResetTestAdapter(t, fixture)

	result, err := adapter.ResetUserQuota(t.Context(), "usr_test", true)
	if err != nil {
		t.Fatal(err)
	}
	if !result.DryRun || result.Status != "ready" || result.AmountUsedBefore != 99 || fixture.resetCalls != 0 {
		t.Fatalf("unexpected dry-run result=%+v reset_calls=%d", result, fixture.resetCalls)
	}
}

func TestResetUserQuotaExecutesOneUserPlanAndPreservesSchedule(t *testing.T) {
	fixture := &quotaResetFixture{amountUsed: 99, nextReset: 1800000000, endTime: 1900000000}
	adapter := newQuotaResetTestAdapter(t, fixture)

	result, err := adapter.ResetUserQuota(t.Context(), "usr_test", false)
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "reset" || result.AmountUsedAfter != 0 || !result.ScheduleUnchanged || fixture.resetCalls != 1 {
		t.Fatalf("unexpected reset result=%+v reset_calls=%d", result, fixture.resetCalls)
	}
	if result.SubscriptionID != "31" || result.UpstreamPlanID != 13 || result.SetID != "set-a" {
		t.Fatalf("unexpected target resolution: %+v", result)
	}
}

func TestResetUserQuotaRejectsControlErrorEnvelope(t *testing.T) {
	fixture := &quotaResetFixture{failBinding: true}
	adapter := newQuotaResetTestAdapter(t, fixture)

	_, err := adapter.ResetUserQuota(t.Context(), "usr_test", true)
	if err == nil || !strings.Contains(err.Error(), "binding unavailable") {
		t.Fatalf("expected control error message, got %v", err)
	}
}

func TestResetUserQuotaPreservesAdditiveSubscriptionsWhenLastPlanIsCredit(t *testing.T) {
	fixture := &quotaResetFixture{
		amountUsed: 99, nextReset: 1800000000, endTime: 1900000000,
		lastPlanIsCredit: true,
		extraSubscriptions: []quotaSubscription{
			{ID: 41, Name: "credit-package:cpkg-1", Status: "active", PlanID: 14, AmountUsed: 7, EndTime: 1900000000},
			{ID: 42, Name: "free-credit:campaign-1", Status: "active", PlanID: 15, AmountUsed: 8, EndTime: 1900000000},
		},
	}
	adapter := newQuotaResetTestAdapter(t, fixture)

	preview, err := adapter.ResetUserQuota(t.Context(), "usr_test", true)
	if err != nil {
		t.Fatal(err)
	}
	if preview.SubscriptionID != "31" || preview.PlanID != "plan-launch" || preview.UpstreamPlanID != 13 || preview.AmountUsedBefore != 99 || fixture.resetCalls != 0 {
		t.Fatalf("preview selected the wrong subscription: %+v", preview)
	}
	result, err := adapter.ResetUserQuota(t.Context(), "usr_test", false)
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "reset" || result.SubscriptionID != "31" || result.AmountUsedAfter != 0 || fixture.resetCalls != 1 {
		t.Fatalf("unexpected reset result: %+v calls=%d", result, fixture.resetCalls)
	}
	if fixture.extraSubscriptions[0].AmountUsed != 7 || fixture.extraSubscriptions[1].AmountUsed != 8 {
		t.Fatalf("additive subscriptions changed: %+v", fixture.extraSubscriptions)
	}
}

func TestResetUserQuotaSelectsNamedPackageSubscription(t *testing.T) {
	fixture := &quotaResetFixture{amountUsed: 99, nextReset: 1800000000, endTime: 1900000000, baseName: "package:usr_test:pass-1"}
	adapter := newQuotaResetTestAdapter(t, fixture)
	result, err := adapter.ResetUserQuota(t.Context(), "usr_test", true)
	if err != nil {
		t.Fatal(err)
	}
	if result.SubscriptionID != "31" || result.PlanID != "plan-launch" || fixture.resetCalls != 0 {
		t.Fatalf("named package should be selected without writing, result=%+v error=%v calls=%d", result, err, fixture.resetCalls)
	}
}

func TestResetUserQuotaRejectsAdditiveSubscriptionSharingPackagePlan(t *testing.T) {
	fixture := &quotaResetFixture{
		amountUsed: 99, nextReset: 1800000000, endTime: 1900000000,
		extraSubscriptions: []quotaSubscription{{ID: 41, Name: "credit-package:cpkg-1", Status: "active", PlanID: 13, AmountUsed: 7, EndTime: 1900000000}},
	}
	adapter := newQuotaResetTestAdapter(t, fixture)
	_, err := adapter.ResetUserQuota(t.Context(), "usr_test", false)
	if err == nil || !strings.Contains(err.Error(), "plan is shared") || fixture.resetCalls != 0 {
		t.Fatalf("shared plan must fail before reset, error=%v calls=%d", err, fixture.resetCalls)
	}
}

func TestResetUserQuotaRejectsProjectionThatClassifiesLegacySubscriptionAsCredit(t *testing.T) {
	fixture := &quotaResetFixture{
		amountUsed: 99, nextReset: 1800000000, endTime: 1900000000,
		projectedBaseName: "credit-package:cpkg-1",
	}
	adapter := newQuotaResetTestAdapter(t, fixture)
	_, err := adapter.ResetUserQuota(t.Context(), "usr_test", false)
	if err == nil || !strings.Contains(err.Error(), "not an active package") || fixture.resetCalls != 0 {
		t.Fatalf("credit projection must fail before reset, error=%v calls=%d", err, fixture.resetCalls)
	}
}

func TestResetUserQuotaRejectsAmbiguousOrUnknownPackageSubscriptions(t *testing.T) {
	for _, tc := range []struct {
		name      string
		noBase    bool
		extra     quotaSubscription
		wantError string
	}{
		{name: "only-credit", noBase: true, extra: quotaSubscription{ID: 41, Name: "credit-package:cpkg-1", Status: "active", PlanID: 14, EndTime: 1900000000}, wantError: "found 0"},
		{name: "two-packages", extra: quotaSubscription{ID: 41, Name: "package:usr_test:pass-2", Status: "active", PlanID: 14, NextResetTime: 1800000000, EndTime: 1900000000}, wantError: "found 2"},
		{name: "unknown-kind", extra: quotaSubscription{ID: 41, Name: "other:subscription", Status: "active", PlanID: 14, EndTime: 1900000000}, wantError: "unknown active subscription kind"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fixture := &quotaResetFixture{amountUsed: 99, nextReset: 1800000000, endTime: 1900000000, noBase: tc.noBase, extraSubscriptions: []quotaSubscription{tc.extra}}
			adapter := newQuotaResetTestAdapter(t, fixture)
			_, err := adapter.ResetUserQuota(t.Context(), "usr_test", false)
			if err == nil || !strings.Contains(err.Error(), tc.wantError) || fixture.resetCalls != 0 {
				t.Fatalf("ambiguous target must fail before reset, error=%v calls=%d", err, fixture.resetCalls)
			}
		})
	}
}
