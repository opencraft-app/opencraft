package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"git.woa.com/wisp/mono2/llmgateway/internal/gateway"
)

func TestPlanAPICreatesImmutableEntitlementAndRetiresIt(t *testing.T) {
	store := gateway.NewMemoryStore()
	if err := store.SaveSet(t.Context(), gateway.Set{ID: "set-a", Status: gateway.SetStatusActive}); err != nil {
		t.Fatal(err)
	}
	handler := NewControlServer(gateway.NewService(store, nil, gateway.Options{}), Config{AdminToken: "admin-token"})

	post := func(body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/api/plans", bytes.NewBufferString(body))
		req.Header.Set("Authorization", "Bearer admin-token")
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		return rec
	}

	body := `{"id":"starter","name":"入门型","monthly_tokens":10000,"quota_reset_period":"monthly"}`
	created := post(body)
	if created.Code != http.StatusOK {
		t.Fatalf("create status=%d body=%s", created.Code, created.Body.String())
	}
	var createdResponse struct {
		Data gateway.Plan `json:"data"`
	}
	if err := json.Unmarshal(created.Body.Bytes(), &createdResponse); err != nil {
		t.Fatalf("decode create response: %v", err)
	}
	if createdResponse.Data.Fingerprint == "" {
		t.Fatal("create response omitted fingerprint")
	}
	if rec := post(body); rec.Code != http.StatusOK {
		t.Fatalf("create status=%d body=%s", rec.Code, rec.Body.String())
	}
	if rec := post(body); rec.Code != http.StatusOK {
		t.Fatalf("idempotent status=%d body=%s", rec.Code, rec.Body.String())
	}
	if rec := post(`{"id":"starter","name":"入门型","monthly_tokens":10001,"quota_reset_period":"monthly"}`); rec.Code != http.StatusConflict {
		t.Fatalf("conflict status=%d body=%s", rec.Code, rec.Body.String())
	}

	req := httptest.NewRequest(http.MethodPut, "/api/plans/starter", bytes.NewBufferString(
		`{"name":"入门型","monthly_tokens":20000,"quota_reset_period":"weekly","is_active":true}`,
	))
	req.Header.Set("Authorization", "Bearer admin-token")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("immutable update status=%d body=%s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodPost, "/api/plans/starter/retire", nil)
	req.Header.Set("Authorization", "Bearer admin-token")
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("retire status=%d body=%s", rec.Code, rec.Body.String())
	}
	var retiredResponse struct {
		Data gateway.Plan `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &retiredResponse); err != nil {
		t.Fatalf("decode retire response: %v", err)
	}
	if retiredResponse.Data.IsActive {
		t.Fatalf("retired plan is still active: %+v", retiredResponse.Data)
	}
	if retiredResponse.Data.Fingerprint != createdResponse.Data.Fingerprint {
		t.Fatalf("retire changed immutable fingerprint: got=%s want=%s",
			retiredResponse.Data.Fingerprint, createdResponse.Data.Fingerprint)
	}

	req = httptest.NewRequest(http.MethodPost, "/api/plans/starter/retire", nil)
	req.Header.Set("Authorization", "Bearer admin-token")
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"is_active":false`) {
		t.Fatalf("idempotent retire status=%d body=%s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/api/plans/starter/sets", nil)
	req.Header.Set("Authorization", "Bearer admin-token")
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"set_id":"set-a"`) || !strings.Contains(rec.Body.String(), `"status":"pending"`) {
		t.Fatalf("set states status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestPlanPeriodAPIIsRetiredWithoutDeletingLegacyData(t *testing.T) {
	store := gateway.NewMemoryStore()
	if err := store.SaveSet(t.Context(), gateway.Set{ID: "set-a", Status: gateway.SetStatusActive}); err != nil {
		t.Fatal(err)
	}
	svc := gateway.NewService(store, nil, gateway.Options{})
	if err := svc.RegisterPlan(t.Context(), gateway.Plan{ID: "plan-launch", Name: "Launch", MonthlyTokens: 1000, PeriodValue: 1, PeriodUnit: "months", IsActive: true}); err != nil {
		t.Fatal(err)
	}
	handler := NewControlServer(svc, Config{AdminToken: "admin-token"})

	req := httptest.NewRequest(http.MethodPost, "/api/plans/plan-launch/periods", bytes.NewBufferString(`{"period_value":14,"period_unit":"d"}`))
	req.Header.Set("Authorization", "Bearer admin-token")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusGone {
		t.Fatalf("post status=%d body=%s", rec.Code, rec.Body.String())
	}
	if periods, err := store.ListPlanPeriods(t.Context(), "plan-launch"); err != nil || len(periods) != 0 {
		t.Fatalf("retired API wrote legacy rows: periods=%v err=%v", periods, err)
	}
}
