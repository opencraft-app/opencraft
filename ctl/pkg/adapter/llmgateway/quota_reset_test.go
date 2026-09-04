package llmgateway

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"ctl/pkg/config"

	"go.uber.org/zap"
)

type quotaResetFixture struct {
	mu          sync.Mutex
	resetCalls  int
	amountUsed  int64
	nextReset   int64
	endTime     int64
	failBinding bool
}

func (f *quotaResetFixture) handler(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Authorization") != "Bearer admin-token" {
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
		_, _ = w.Write([]byte(`{"success":true,"data":{"row":{"values":{"set_id":"set-a","upstream_user_id":20,"last_plan_id":"plan-launch"}}}}`))
	case "/api/plans/plan-launch/sets":
		_, _ = w.Write([]byte(`{"success":true,"data":[{"set_id":"set-a","status":"ready","upstream_plan_id":13}]}`))
	case "/_llmgateway_console/set-a/api/subscription/admin/users/20/subscriptions":
		f.mu.Lock()
		amount := f.amountUsed
		f.mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "data": []any{map[string]any{"subscription": map[string]any{
			"id": 31, "status": "active", "plan_id": 13, "amount_used": amount,
			"next_reset_time": f.nextReset, "end_time": f.endTime,
		}}}})
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
		f.mu.Unlock()
		_, _ = w.Write([]byte(`{"success":true,"data":{"reset_count":1,"user_count":1,"advance_reset_time":false}}`))
	default:
		http.NotFound(w, r)
	}
}

func newQuotaResetTestAdapter(t *testing.T, fixture *quotaResetFixture) *LLMGatewayAdapter {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(fixture.handler))
	t.Cleanup(server.Close)
	return NewLLMGatewayAdapter(&config.LLMGatewayConfig{
		BaseURL: server.URL, AdminToken: "admin-token", Timeout: 5,
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
