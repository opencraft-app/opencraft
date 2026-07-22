package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"git.woa.com/wisp/mono2/llmgateway/internal/gateway"
)

func TestInternalSubscriptionReturnsAcceptedAndCommandLocationDuringAdminUpgrade(t *testing.T) {
	store := gateway.NewMemoryStore()
	if err := store.SaveSet(t.Context(), gateway.Set{
		ID: "set-a", BaseURL: "http://set-a.invalid", Status: gateway.SetStatusActive,
		Setup: true, AdminUserID: 1, AdminAccessToken: "admin-token",
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SetAdminWritesPaused(t.Context(), "set-a", true, "upgrade run-a", time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveUserBinding(t.Context(), gateway.UserBinding{
		ExternalUserID: "user-1", SetID: "set-a", UpstreamUserID: 42,
		Username: "sgw-user-1", Password: "password", ProvisionStatus: gateway.BindingProvisionStatusUserReady,
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SavePlanMapping(t.Context(), gateway.PlanMapping{
		ID: "plan-pro", Name: "Pro", MonthlyTokens: 1000, PeriodValue: 1,
		PeriodUnit: "months", IsActive: true, UpstreamPlanIDs: map[string]int{"set-a": 7},
	}); err != nil {
		t.Fatal(err)
	}
	server := NewServer(gateway.NewService(store, nil, gateway.Options{}), Config{AdminToken: "cluster-token"})

	req := httptest.NewRequest(http.MethodPost, "/api/internal/subscriptions/apply", bytes.NewBufferString(
		`{"idempotency_key":"trade:paused-http","user_id":"user-1","plan_id":"plan-pro"}`,
	))
	req.Header.Set("Authorization", "Bearer cluster-token")
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var queued struct {
		Data gateway.AdminCommand `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &queued); err != nil {
		t.Fatal(err)
	}
	if queued.Data.ID == "" || queued.Data.Status != gateway.AdminCommandStatusPending {
		t.Fatalf("queued command = %+v", queued.Data)
	}
	if got := rec.Header().Get("Location"); got != "/api/internal/admin-commands/"+queued.Data.ID {
		t.Fatalf("Location=%q", got)
	}

	statusReq := httptest.NewRequest(http.MethodGet, rec.Header().Get("Location"), nil)
	statusReq.Header.Set("Authorization", "Bearer cluster-token")
	statusRec := httptest.NewRecorder()
	server.ServeHTTP(statusRec, statusReq)
	if statusRec.Code != http.StatusOK || !bytes.Contains(statusRec.Body.Bytes(), []byte(queued.Data.ID)) {
		t.Fatalf("status response code=%d body=%s", statusRec.Code, statusRec.Body.String())
	}
}
