package httpapi

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"git.woa.com/wisp/mono2/llmgateway/internal/gateway"
)

func TestPlanAPIStoresImmutableEntitlementsWithoutUpstreamMapping(t *testing.T) {
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

	body := `{"id":"starter-2026-07","name":"入门型","monthly_tokens":10000,"period_value":1,"period_unit":"months"}`
	if rec := post(body); rec.Code != http.StatusOK {
		t.Fatalf("create status=%d body=%s", rec.Code, rec.Body.String())
	}
	if rec := post(body); rec.Code != http.StatusOK {
		t.Fatalf("idempotent status=%d body=%s", rec.Code, rec.Body.String())
	}
	if rec := post(`{"id":"starter-2026-07","name":"入门型","monthly_tokens":10001,"period_value":1,"period_unit":"months"}`); rec.Code != http.StatusConflict {
		t.Fatalf("conflict status=%d body=%s", rec.Code, rec.Body.String())
	}

	req := httptest.NewRequest(http.MethodGet, "/api/plans/starter-2026-07/sets", nil)
	req.Header.Set("Authorization", "Bearer admin-token")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"set_id":"set-a"`) || !strings.Contains(rec.Body.String(), `"status":"pending"`) {
		t.Fatalf("set states status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestPlanPeriodAPIRegistersAndListsVariant(t *testing.T) {
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
	if rec.Code != http.StatusOK {
		t.Fatalf("post status=%d body=%s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/api/plans/plan-launch/periods", nil)
	req.Header.Set("Authorization", "Bearer admin-token")
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"period_value":14`) || !strings.Contains(rec.Body.String(), `"period_unit":"days"`) {
		t.Fatalf("get status=%d body=%s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/api/plans/plan-launch/periods/sets", nil)
	req.Header.Set("Authorization", "Bearer admin-token")
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"set_id":"set-a"`) || !strings.Contains(rec.Body.String(), `"status":"pending"`) {
		t.Fatalf("period set states status=%d body=%s", rec.Code, rec.Body.String())
	}
}
