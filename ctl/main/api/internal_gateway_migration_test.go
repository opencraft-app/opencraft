package main

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"testing"

	"ctl/pkg/transport"
)

func TestInternalGatewayMigrationRequiresConfiguredBearer(t *testing.T) {
	t.Setenv("LIGHTCLAW_INTERNAL_SERVICE_TOKEN", "internal-secret")
	h := &instanceHandler{logic: &stubLogic{}}
	req := httptest.NewRequest(http.MethodPost, "/internal/instances/ins-1/gateway/migrate", bytes.NewBufferString(`{"user_id":"usr_1","dry_run":true}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	h.handleInternalInstanceSubresource(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestInternalGatewayMigrationPassesSingleUserAndInstanceToLogic(t *testing.T) {
	t.Setenv("LIGHTCLAW_INTERNAL_SERVICE_TOKEN", "internal-secret")
	logic := &stubLogic{migrateGatewayResp: &transport.InstanceGatewayMigrationResponse{
		UserID: "usr_1", InstanceID: "ins-1", DryRun: true,
		PreviousGateway: "ai_gateway", TargetGateway: "llm_gateway",
	}}
	h := &instanceHandler{logic: logic}
	req := httptest.NewRequest(http.MethodPost, "/internal/instances/ins-1/gateway/migrate", bytes.NewBufferString(`{"user_id":"usr_1","dry_run":true}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer internal-secret")
	rec := httptest.NewRecorder()

	h.handleInternalInstanceSubresource(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if logic.migrateGatewayUserID != "usr_1" || logic.migrateGatewayInstanceID != "ins-1" || !logic.migrateGatewayDryRun {
		t.Fatalf("unexpected migration call: user=%q instance=%q dry_run=%v", logic.migrateGatewayUserID, logic.migrateGatewayInstanceID, logic.migrateGatewayDryRun)
	}
}

func TestInternalGatewayMigrationNormalizesInstanceIDMetricLabel(t *testing.T) {
	got := normalizePath("/internal/instances/ins-sensitive/gateway/migrate")
	if got != "/internal/instances/{id}/gateway/migrate" {
		t.Fatalf("normalizePath()=%q", got)
	}
}
