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

func TestAdminResourcesListsWhitelistedResources(t *testing.T) {
	handler := NewServer(gateway.NewService(gateway.NewMemoryStore(), nil, gateway.Options{}), Config{AdminToken: "cluster-token"})

	req := httptest.NewRequest(http.MethodGet, "/api/admin/resources", nil)
	req.Header.Set("Authorization", "Bearer cluster-token")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var resp struct {
		Success bool `json:"success"`
		Data    []struct {
			ID         string `json:"id"`
			PrimaryKey string `json:"primary_key"`
		} `json:"data"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatal(err)
	}
	if !resp.Success {
		t.Fatalf("unexpected response: %+v", resp)
	}
	ids := map[string]string{}
	for _, resource := range resp.Data {
		ids[resource.ID] = resource.PrimaryKey
	}
	for id, primaryKey := range map[string]string{
		"tenants":                      "user_id",
		"sets":                         "id",
		"set_reconcile_facts":          "source,namespace,fleet,set_id",
		"set_provision_requests":       "id",
		"user_bindings":                "external_user_id",
		"api_key_bindings":             "external_key_id",
		"plans":                        "id",
		"set_plans":                    "plan_id,set_id",
		"channel_specs":                "id",
		"channel_sync_states":          "channel_id,set_id",
		"tenant_observations":          "user_id",
		"subscription_period_overlays": "external_user_id",
	} {
		if ids[id] != primaryKey {
			t.Fatalf("resource %s primary_key=%q, want %q; all=%+v", id, ids[id], primaryKey, ids)
		}
	}
}

func TestAdminResourceRowsMasksSensitiveFields(t *testing.T) {
	store := gateway.NewMemoryStore()
	svc := gateway.NewService(store, nil, gateway.Options{})
	if err := svc.RegisterSet(t.Context(), gateway.RegisterSetInput{ID: "set-a", Name: "Set A", BaseURL: "http://set-a", Status: gateway.SetStatusActive}); err != nil {
		t.Fatal(err)
	}
	set, ok, err := store.GetSet(t.Context(), "set-a")
	if err != nil || !ok {
		t.Fatalf("get set ok=%v err=%v", ok, err)
	}
	set.AdminAccessToken = "secret-admin-token"
	set.AdminUserID = 1
	if err := store.SaveSet(t.Context(), set); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveUserBinding(t.Context(), gateway.UserBinding{
		ExternalUserID:  "user-1",
		SetID:           "set-a",
		UpstreamUserID:  42,
		Username:        "sgw-user-1",
		Password:        "secret-password",
		ProvisionStatus: gateway.BindingProvisionStatusUserReady,
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveAPIKeyBinding(t.Context(), gateway.APIKeyBinding{
		ExternalKey:   "sk-visible-external",
		ExternalKeyID: "key-1",
		SetID:         "set-a",
		UserID:        "user-1",
		UpstreamKey:   "sk-secret-upstream",
		UpstreamKeyID: 7,
	}); err != nil {
		t.Fatal(err)
	}
	handler := NewServer(svc, Config{AdminToken: "cluster-token"})

	req := httptest.NewRequest(http.MethodGet, "/api/admin/resources/user_bindings/rows?limit=10", nil)
	req.Header.Set("Authorization", "Bearer cluster-token")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	if strings.Contains(body, "secret-password") || strings.Contains(body, "sk-secret-upstream") || strings.Contains(body, "secret-admin-token") {
		t.Fatalf("resource rows leaked sensitive data: %s", body)
	}
	if !strings.Contains(body, `"password":"***"`) {
		t.Fatalf("password should be masked, body=%s", body)
	}

	keyReq := httptest.NewRequest(http.MethodGet, "/api/admin/resources/api_key_bindings/rows?limit=10", nil)
	keyReq.Header.Set("Authorization", "Bearer cluster-token")
	keyRec := httptest.NewRecorder()
	handler.ServeHTTP(keyRec, keyReq)
	if keyRec.Code != http.StatusOK {
		t.Fatalf("key rows status=%d body=%s", keyRec.Code, keyRec.Body.String())
	}
	keyBody := keyRec.Body.String()
	if strings.Contains(keyBody, "sk-visible-external") || strings.Contains(keyBody, "sk-secret-upstream") {
		t.Fatalf("key rows leaked recoverable credentials: %s", keyBody)
	}
	if strings.Count(keyBody, `"***"`) < 2 {
		t.Fatalf("external and upstream keys should both be masked: %s", keyBody)
	}
}

func TestAdminResourcePatchTenantDisplayNameAndRejectsRouteColumns(t *testing.T) {
	store := gateway.NewMemoryStore()
	svc := gateway.NewService(store, nil, gateway.Options{})
	if err := store.SaveTenant(t.Context(), gateway.Tenant{
		ExternalUserID: "user-1",
		Backend:        gateway.UserBackendPending,
		Status:         gateway.TenantStatusActive,
	}); err != nil {
		t.Fatal(err)
	}
	handler := NewServer(svc, Config{AdminToken: "cluster-token"})

	patchReq := httptest.NewRequest(http.MethodPatch, "/api/admin/resources/tenants/rows/user-1", bytes.NewBufferString(`{"values":{"display_name":"User One"}}`))
	patchReq.Header.Set("Authorization", "Bearer cluster-token")
	patchRec := httptest.NewRecorder()
	handler.ServeHTTP(patchRec, patchReq)
	if patchRec.Code != http.StatusOK {
		t.Fatalf("patch status=%d body=%s", patchRec.Code, patchRec.Body.String())
	}
	tenant, ok, err := store.GetTenant(t.Context(), "user-1")
	if err != nil || !ok {
		t.Fatalf("tenant not saved ok=%v err=%v", ok, err)
	}
	if tenant.DisplayName != "User One" {
		t.Fatalf("display_name=%q, want User One", tenant.DisplayName)
	}

	routeReq := httptest.NewRequest(http.MethodPatch, "/api/admin/resources/tenants/rows/user-1", bytes.NewBufferString(`{"values":{"backend":"new","set_id":"set-a"}}`))
	routeReq.Header.Set("Authorization", "Bearer cluster-token")
	routeRec := httptest.NewRecorder()
	handler.ServeHTTP(routeRec, routeReq)
	if routeRec.Code != http.StatusBadRequest {
		t.Fatalf("route patch status=%d body=%s", routeRec.Code, routeRec.Body.String())
	}
}

func TestAdminResourceTenantDisableActionUsesDomainState(t *testing.T) {
	store := gateway.NewMemoryStore()
	svc := gateway.NewService(store, nil, gateway.Options{})
	if err := svc.RegisterSet(t.Context(), gateway.RegisterSetInput{ID: "set-a", BaseURL: "http://set-a", Status: gateway.SetStatusActive}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveTenant(t.Context(), gateway.Tenant{
		ExternalUserID: "user-1",
		Backend:        gateway.UserBackendPending,
		Status:         gateway.TenantStatusActive,
	}); err != nil {
		t.Fatal(err)
	}
	handler := NewServer(svc, Config{AdminToken: "cluster-token"})

	req := httptest.NewRequest(http.MethodPost, "/api/admin/resources/tenants/actions/disable", bytes.NewBufferString(`{"id":"user-1"}`))
	req.Header.Set("Authorization", "Bearer cluster-token")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("disable status=%d body=%s", rec.Code, rec.Body.String())
	}
	tenant, ok, err := store.GetTenant(t.Context(), "user-1")
	if err != nil || !ok {
		t.Fatalf("tenant not saved ok=%v err=%v", ok, err)
	}
	if tenant.Status != gateway.TenantStatusDisabled {
		t.Fatalf("tenant status=%q, want disabled", tenant.Status)
	}
	if _, err := svc.EnsureUserBinding(t.Context(), "user-1"); err == nil {
		t.Fatal("disabled tenant should reject binding allocation")
	}
}
