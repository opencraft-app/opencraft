package main

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"testing"

	"ctl/pkg/transport"
)

func TestInternalGatewayQuotaResetRequiresConfiguredBearer(t *testing.T) {
	t.Setenv("LIGHTCLAW_INTERNAL_SERVICE_TOKEN", "internal-secret")
	h := &instanceHandler{logic: &stubLogic{}}
	req := httptest.NewRequest(http.MethodPost, "/internal/users/usr_1/gateway/quota/reset", bytes.NewBufferString(`{"dry_run":true}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	h.handleInternalUserSubresource(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestInternalGatewayQuotaResetPassesPathUserToLogic(t *testing.T) {
	t.Setenv("LIGHTCLAW_INTERNAL_SERVICE_TOKEN", "internal-secret")
	logic := &stubLogic{resetGatewayQuotaResp: &transport.UserGatewayQuotaResetResponse{
		UserID: "usr_1", Gateway: "llm_gateway", DryRun: true, Status: "ready",
	}}
	h := &instanceHandler{logic: logic}
	req := httptest.NewRequest(http.MethodPost, "/internal/users/usr_1/gateway/quota/reset", bytes.NewBufferString(`{"dry_run":true}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer internal-secret")
	rec := httptest.NewRecorder()

	h.handleInternalUserSubresource(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if logic.resetGatewayQuotaUserID != "usr_1" || !logic.resetGatewayQuotaDryRun {
		t.Fatalf("unexpected reset call user=%q dry_run=%v", logic.resetGatewayQuotaUserID, logic.resetGatewayQuotaDryRun)
	}
}

func TestInternalGatewayQuotaResetNormalizesUserIDMetricLabel(t *testing.T) {
	got := normalizePath("/internal/users/usr_sensitive/gateway/quota/reset")
	if got != "/internal/users/{id}/gateway/quota/reset" {
		t.Fatalf("normalizePath()=%q", got)
	}
}
