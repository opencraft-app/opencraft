package gateway

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"go.opentelemetry.io/otel"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

func TestBootstrapSetInitializesEmptyNewAPIAndStoresAdminToken(t *testing.T) {
	var confirmedCompliance bool
	var forcedDefaultTheme bool
	var secureVerificationEnabled bool
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "GET /api/setup":
			writeTestJSON(t, w, map[string]any{"success": true, "data": map[string]any{"status": false}})
		case "POST /api/setup":
			writeTestJSON(t, w, map[string]any{"success": true})
		case "POST /api/user/login":
			http.SetCookie(w, &http.Cookie{Name: "session", Value: "root-session", Path: "/"})
			writeTestJSON(t, w, map[string]any{"success": true, "data": map[string]any{"id": 1, "username": "set-root", "role": 100, "status": 1, "group": "default"}})
		case "POST /api/option/payment_compliance":
			if r.Header.Get("Authorization") != "" || r.Header.Get("New-Api-User") != "1" {
				t.Fatalf("compliance confirmation must use session auth, got Authorization=%q New-Api-User=%q", r.Header.Get("Authorization"), r.Header.Get("New-Api-User"))
			}
			cookie, err := r.Cookie("session")
			if err != nil || cookie.Value != "root-session" {
				t.Fatalf("missing root session cookie: cookie=%v err=%v", cookie, err)
			}
			var req struct {
				Confirmed bool `json:"confirmed"`
			}
			decodeTestJSON(t, r, &req)
			if !req.Confirmed {
				t.Fatalf("confirmed = false, want true")
			}
			confirmedCompliance = true
			writeTestJSON(t, w, map[string]any{"success": true, "data": map[string]any{"confirmed": true, "terms_version": "v1"}})
		case "PUT /api/option/":
			if !confirmedCompliance {
				t.Fatalf("forced frontend theme before confirming compliance")
			}
			if r.Header.Get("Authorization") != "" || r.Header.Get("New-Api-User") != "1" {
				t.Fatalf("frontend theme update must use session auth, got Authorization=%q New-Api-User=%q", r.Header.Get("Authorization"), r.Header.Get("New-Api-User"))
			}
			cookie, err := r.Cookie("session")
			if err != nil || cookie.Value != "root-session" {
				t.Fatalf("missing root session cookie: cookie=%v err=%v", cookie, err)
			}
			var req struct {
				Key   string `json:"key"`
				Value string `json:"value"`
			}
			decodeTestJSON(t, r, &req)
			if req.Key != "theme.frontend" || req.Value != "default" {
				t.Fatalf("unexpected frontend theme update: %+v", req)
			}
			forcedDefaultTheme = true
			writeTestJSON(t, w, map[string]any{"success": true})
		case "POST /api/user/2fa/setup":
			if !forcedDefaultTheme {
				t.Fatalf("started 2FA setup before forcing default frontend theme")
			}
			if r.Header.Get("New-Api-User") != "1" {
				t.Fatalf("missing admin user header")
			}
			writeTestJSON(t, w, map[string]any{
				"success": true,
				"data": map[string]any{
					"secret": "JBSWY3DPEHPK3PXP",
				},
			})
		case "POST /api/user/2fa/enable":
			var req struct {
				Code string `json:"code"`
			}
			decodeTestJSON(t, r, &req)
			if len(req.Code) != 6 {
				t.Fatalf("2FA enable code length = %d, want 6", len(req.Code))
			}
			if _, err := strconv.Atoi(req.Code); err != nil {
				t.Fatalf("2FA enable code must be numeric, got %q", req.Code)
			}
			secureVerificationEnabled = true
			writeTestJSON(t, w, map[string]any{"success": true})
		case "GET /api/user/token":
			if !confirmedCompliance {
				t.Fatalf("generated admin token before confirming compliance")
			}
			if !forcedDefaultTheme {
				t.Fatalf("generated admin token before forcing default frontend theme")
			}
			if !secureVerificationEnabled {
				t.Fatalf("generated admin token before enabling automated secure verification")
			}
			if r.Header.Get("New-Api-User") != "1" {
				t.Fatalf("missing admin user header")
			}
			writeTestJSON(t, w, map[string]any{"success": true, "data": "set-admin-token"})
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer upstream.Close()

	store := NewMemoryStore()
	svc := NewService(store, nil, Options{RootUsername: "set-root", RootPassword: "Qq373866172!"})
	if err := svc.RegisterSet(t.Context(), RegisterSetInput{ID: "set-a", BaseURL: upstream.URL, Status: SetStatusActive}); err != nil {
		t.Fatal(err)
	}

	set, err := svc.BootstrapSet(t.Context(), "set-a")
	if err != nil {
		t.Fatal(err)
	}
	if !set.Setup || set.AdminUserID != 1 || set.AdminAccessToken != "set-admin-token" {
		t.Fatalf("unexpected set after bootstrap: %+v", set)
	}
	if !confirmedCompliance {
		t.Fatal("expected compliance confirmation during bootstrap")
	}
	if !forcedDefaultTheme {
		t.Fatal("expected default frontend theme during bootstrap")
	}
	if !secureVerificationEnabled {
		t.Fatal("expected automated secure verification setup during bootstrap")
	}
	if set.AdminTOTPSecret != "JBSWY3DPEHPK3PXP" {
		t.Fatalf("admin totp secret = %q", set.AdminTOTPSecret)
	}
}

func TestBootstrapSetInitializesWhenNewAPIReportsRootNotInitialized(t *testing.T) {
	var setupCalled bool
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "GET /api/setup":
			writeTestJSON(t, w, map[string]any{"success": true, "data": map[string]any{"status": true, "root_init": false}})
		case "POST /api/setup":
			setupCalled = true
			writeTestJSON(t, w, map[string]any{"success": true})
		case "POST /api/user/login":
			if !setupCalled {
				t.Fatalf("login happened before root setup")
			}
			writeTestJSON(t, w, map[string]any{"success": true, "data": map[string]any{"id": 1, "username": "set-root", "role": 100, "status": 1, "group": "default"}})
		case "POST /api/option/payment_compliance", "PUT /api/option/", "POST /api/user/2fa/enable":
			writeTestJSON(t, w, map[string]any{"success": true})
		case "POST /api/user/2fa/setup":
			writeTestJSON(t, w, map[string]any{"success": true, "data": map[string]any{"secret": "JBSWY3DPEHPK3PXP"}})
		case "GET /api/user/token":
			writeTestJSON(t, w, map[string]any{"success": true, "data": "set-admin-token"})
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer upstream.Close()

	store := NewMemoryStore()
	svc := NewService(store, nil, Options{RootUsername: "set-root", RootPassword: "Qq373866172!"})
	if err := svc.RegisterSet(t.Context(), RegisterSetInput{ID: "set-a", BaseURL: upstream.URL, Status: SetStatusActive}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.BootstrapSet(t.Context(), "set-a"); err != nil {
		t.Fatal(err)
	}
	if !setupCalled {
		t.Fatal("expected bootstrap to initialize root when root_init=false")
	}
}

func TestBootstrapSetContinuesWhenSetupIsAlreadyInitialized(t *testing.T) {
	var setupCalled bool
	var loginCalled bool
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "GET /api/setup":
			writeTestJSON(t, w, map[string]any{"success": true, "data": map[string]any{"status": true, "root_init": false}})
		case "POST /api/setup":
			setupCalled = true
			writeTestJSON(t, w, map[string]any{"success": false, "message": "系统已经初始化完成"})
		case "POST /api/user/login":
			loginCalled = true
			writeTestJSON(t, w, map[string]any{"success": true, "data": map[string]any{"id": 1, "username": "set-root", "role": 100, "status": 1, "group": "default"}})
		case "POST /api/option/payment_compliance", "PUT /api/option/", "POST /api/user/2fa/enable":
			writeTestJSON(t, w, map[string]any{"success": true})
		case "POST /api/user/2fa/setup":
			writeTestJSON(t, w, map[string]any{"success": true, "data": map[string]any{"secret": "JBSWY3DPEHPK3PXP"}})
		case "GET /api/user/token":
			writeTestJSON(t, w, map[string]any{"success": true, "data": "set-admin-token"})
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer upstream.Close()

	store := NewMemoryStore()
	svc := NewService(store, nil, Options{RootUsername: "set-root", RootPassword: "Qq373866172!"})
	if err := svc.RegisterSet(t.Context(), RegisterSetInput{ID: "set-a", BaseURL: upstream.URL, Status: SetStatusActive}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.BootstrapSet(t.Context(), "set-a"); err != nil {
		t.Fatal(err)
	}
	if !setupCalled || !loginCalled {
		t.Fatalf("expected bootstrap to treat already-initialized setup as idempotent: setup=%v login=%v", setupCalled, loginCalled)
	}
}

func TestBootstrapSetCompletesTwoFALoginWhenManagedRootAlreadyRequiresIt(t *testing.T) {
	var completed2FA bool
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "GET /api/setup":
			writeTestJSON(t, w, map[string]any{"success": true, "data": map[string]any{"status": true, "root_init": true}})
		case "POST /api/user/login":
			http.SetCookie(w, &http.Cookie{Name: "session", Value: "pending-2fa", Path: "/"})
			writeTestJSON(t, w, map[string]any{"success": true, "data": map[string]any{"require_2fa": true}})
		case "POST /api/user/login/2fa":
			cookie, err := r.Cookie("session")
			if err != nil || cookie.Value != "pending-2fa" {
				t.Fatalf("missing pending 2FA session cookie: cookie=%v err=%v", cookie, err)
			}
			var req struct {
				Code string `json:"code"`
			}
			decodeTestJSON(t, r, &req)
			if len(req.Code) != 6 || strings.Trim(req.Code, "0123456789") != "" {
				t.Fatalf("unexpected 2FA login code %q", req.Code)
			}
			completed2FA = true
			writeTestJSON(t, w, map[string]any{"success": true, "data": map[string]any{"id": 1, "username": "set-root", "role": 100, "status": 1, "group": "default"}})
		case "POST /api/option/payment_compliance":
			if !completed2FA {
				t.Fatalf("confirmed compliance before completing 2FA login")
			}
			writeTestJSON(t, w, map[string]any{"success": true})
		case "PUT /api/option/":
			writeTestJSON(t, w, map[string]any{"success": true})
		case "GET /api/user/token":
			writeTestJSON(t, w, map[string]any{"success": true, "data": "set-admin-token"})
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer upstream.Close()

	store := NewMemoryStore()
	svc := NewService(store, nil, Options{RootUsername: "set-root", RootPassword: "Qq373866172!"})
	if err := svc.RegisterSet(t.Context(), RegisterSetInput{ID: "set-a", BaseURL: upstream.URL, Status: SetStatusActive}); err != nil {
		t.Fatal(err)
	}
	set, ok, err := store.GetSet(t.Context(), "set-a")
	if err != nil || !ok {
		t.Fatalf("set not found: ok=%v err=%v", ok, err)
	}
	set.Setup = true
	set.AdminUserID = 1
	set.AdminTOTPSecret = "JBSWY3DPEHPK3PXP"
	if err := store.SaveSet(t.Context(), set); err != nil {
		t.Fatal(err)
	}

	bootstrapped, err := svc.BootstrapSet(t.Context(), "set-a")
	if err != nil {
		t.Fatal(err)
	}
	if !completed2FA {
		t.Fatal("expected bootstrap to complete 2FA login")
	}
	if bootstrapped.AdminTOTPSecret != "JBSWY3DPEHPK3PXP" {
		t.Fatalf("admin totp secret was not preserved: %+v", bootstrapped)
	}
}

func TestGetManagedChannelKeyUsesStoredRootTOTPSecret(t *testing.T) {
	var verified bool
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "POST /api/verify":
			if r.Header.Get("Authorization") != "Bearer set-admin-token" || r.Header.Get("New-Api-User") != "1" {
				t.Fatalf("missing admin auth: Authorization=%q New-Api-User=%q", r.Header.Get("Authorization"), r.Header.Get("New-Api-User"))
			}
			var req struct {
				Method string `json:"method"`
				Code   string `json:"code"`
			}
			decodeTestJSON(t, r, &req)
			if req.Method != "2fa" || len(req.Code) != 6 || strings.Trim(req.Code, "0123456789") != "" {
				t.Fatalf("unexpected verify request: %+v", req)
			}
			http.SetCookie(w, &http.Cookie{Name: "session", Value: "verified-session", Path: "/"})
			verified = true
			writeTestJSON(t, w, map[string]any{"success": true})
		case "POST /api/channel/17/key":
			if !verified {
				t.Fatalf("key fetched before secure verification")
			}
			if cookie, err := r.Cookie("session"); err != nil || cookie.Value != "verified-session" {
				t.Fatalf("missing verified session: cookie=%v err=%v", cookie, err)
			}
			writeTestJSON(t, w, map[string]any{"success": true, "data": map[string]any{"key": "sk-provider"}})
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer upstream.Close()

	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	if err := store.SaveSet(t.Context(), Set{
		ID:               "set-a",
		BaseURL:          upstream.URL,
		Status:           SetStatusActive,
		Setup:            true,
		AdminUserID:      1,
		AdminAccessToken: "set-admin-token",
		AdminTOTPSecret:  "JBSWY3DPEHPK3PXP",
	}); err != nil {
		t.Fatal(err)
	}

	key, err := svc.GetManagedChannelKey(t.Context(), "set-a", 17)
	if err != nil {
		t.Fatal(err)
	}
	if key != "sk-provider" {
		t.Fatalf("key = %q, want sk-provider", key)
	}
}

func TestCreateExternalKeyEnsuresUserAndCreatesUpstreamToken(t *testing.T) {
	userExists := false
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "POST /api/user/":
			if r.Header.Get("Authorization") != "Bearer set-admin-token" {
				t.Fatalf("missing admin token")
			}
			userExists = true
			writeTestJSON(t, w, map[string]any{"success": true})
		case "GET /api/user/search":
			items := []map[string]any{}
			if userExists {
				items = append(items, map[string]any{"id": 42, "username": "sgw-user-1", "display_name": "sgw-user-1", "role": 1, "status": 1, "group": "default"})
			}
			writeTestJSON(t, w, map[string]any{"success": true, "data": map[string]any{"items": items}})
		case "POST /api/user/login":
			writeTestJSON(t, w, map[string]any{"success": true, "data": map[string]any{"id": 42, "username": "sgw-user-1", "role": 1, "status": 1, "group": "default"}})
		case "GET /api/user/token":
			if r.Header.Get("New-Api-User") != "42" {
				t.Fatalf("missing upstream user header")
			}
			writeTestJSON(t, w, map[string]any{"success": true, "data": "user-access-token"})
		case "POST /api/token/":
			if r.Header.Get("Authorization") != "Bearer user-access-token" {
				t.Fatalf("missing user access token")
			}
			var req struct {
				Group string `json:"group"`
			}
			decodeTestJSON(t, r, &req)
			if req.Group != "default" {
				t.Fatalf("platform upstream token group = %q, want default", req.Group)
			}
			writeTestJSON(t, w, map[string]any{"success": true})
		case "GET /api/token/search":
			writeTestJSON(t, w, map[string]any{"success": true, "data": map[string]any{"items": []map[string]any{{"id": 7, "name": r.URL.Query().Get("keyword")}}}})
		case "POST /api/token/7/key":
			writeTestJSON(t, w, map[string]any{"success": true, "data": map[string]any{"key": "sk-upstream"}})
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer upstream.Close()

	store := NewMemoryStore()
	routeCache := NewMemoryAPIKeyRouteCache(0, 100)
	svc := NewService(store, nil, Options{KeyRouteCache: routeCache})
	if err := svc.RegisterSet(t.Context(), RegisterSetInput{ID: "set-a", BaseURL: upstream.URL, Status: SetStatusActive}); err != nil {
		t.Fatal(err)
	}
	set, ok, _ := store.GetSet(t.Context(), "set-a")
	set.Setup = true
	set.AdminUserID = 1
	set.AdminAccessToken = "set-admin-token"
	if !ok {
		t.Fatal("set not found")
	}
	if err := store.SaveSet(t.Context(), set); err != nil {
		t.Fatal(err)
	}

	key, err := svc.CreateExternalKey(t.Context(), "user-1")
	if err != nil {
		t.Fatal(err)
	}
	if key.ExternalKey == "" || key.SetID != "set-a" || key.UpstreamKey != "sk-upstream" || key.UpstreamKeyID != 7 {
		t.Fatalf("unexpected key binding: %+v", key)
	}
	saved, ok, err := store.GetAPIKeyBindingByExternalKey(t.Context(), key.ExternalKey)
	if err != nil || !ok {
		t.Fatalf("saved binding not found: ok=%v err=%v", ok, err)
	}
	if saved.UpstreamKey != "sk-upstream" {
		t.Fatalf("saved upstream key = %q", saved.UpstreamKey)
	}
	binding, ok, err := store.GetUserBinding(t.Context(), "user-1")
	if err != nil || !ok {
		t.Fatalf("binding not found after key creation: ok=%v err=%v", ok, err)
	}
	if binding.ProvisionStatus != BindingProvisionStatusTokenReady || binding.LastProvisionError != "" {
		t.Fatalf("unexpected binding provisioning state: %+v", binding)
	}
	route, ok, err := routeCache.GetRoute(t.Context(), parseTrafficRouteLookup(key.ExternalKey))
	if err != nil || !ok {
		t.Fatalf("traffic route not found after assignment: ok=%v err=%v", ok, err)
	}
	if !route.Enabled {
		t.Fatalf("traffic route remained disabled after tenant became active: %+v", route)
	}
}

func TestCreateExternalKeyReusesActivePurposeBinding(t *testing.T) {
	var upstreamCreates atomic.Int32
	upstream := newKeyIssuanceUpstream(t, func() { upstreamCreates.Add(1) })
	defer upstream.Close()

	store := NewMemoryStore()
	prepareReadyKeyIssuanceUser(t, store, upstream.URL)
	svc := NewService(store, nil, Options{KeyRouteCache: NewMemoryAPIKeyRouteCache(0, 100)})

	first, err := svc.createExternalKey(t.Context(), "user-1", "default")
	if err != nil {
		t.Fatal(err)
	}
	second, err := svc.createExternalKey(t.Context(), "user-1", "default")
	if err != nil {
		t.Fatal(err)
	}
	if second.ExternalKeyID != first.ExternalKeyID || second.ExternalKey != first.ExternalKey {
		t.Fatalf("second key = %+v, want original key id=%q", second, first.ExternalKeyID)
	}
	if upstreamCreates.Load() != 1 {
		t.Fatalf("upstream token creates = %d, want 1", upstreamCreates.Load())
	}
}

func TestCreateExternalKeyRejectsUnusablePurposeBindingStates(t *testing.T) {
	material, err := generateExternalKeyV2(bytes.NewReader(bytes.Repeat([]byte{4}, externalKeyRandomBytes)))
	if err != nil {
		t.Fatal(err)
	}
	valid := APIKeyBinding{
		ExternalKey:     material.ExternalKey,
		ExternalKeyHash: material.ExternalKeyHash,
		ExternalKeyID:   material.ExternalKeyID,
		SecretHash:      material.SecretHash,
		KeyVersion:      material.Version,
		RouteSlot:       material.RouteSlot,
		Purpose:         "default",
		SetID:           "set-a",
		UserID:          "user-1",
		UpstreamKey:     "sk-upstream",
		UpstreamKeyID:   7,
	}
	tests := []struct {
		name      string
		status    string
		mutate    func(*APIKeyBinding)
		wantError error
	}{
		{name: "reserved", status: APIKeyStatusReserved, wantError: ErrAPIKeyProvisioning},
		{name: "upstream ready", status: APIKeyStatusUpstreamReady, wantError: ErrAPIKeyProvisioning},
		{name: "route pending", status: APIKeyStatusRoutePending, wantError: ErrAPIKeyProvisioning},
		{name: "error", status: APIKeyStatusError, wantError: ErrAPIKeyStateUnavailable},
		{name: "legacy disabled", status: APIKeyStatusLegacyDisabled, wantError: ErrAPIKeyStateUnavailable},
		{
			name:      "active missing material",
			status:    APIKeyStatusActive,
			mutate:    func(binding *APIKeyBinding) { binding.ExternalKey = "" },
			wantError: ErrAPIKeyMaterialMissing,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			memory := NewMemoryStore()
			prepareReadyKeyIssuanceUser(t, memory, "http://unused.invalid")
			binding := valid
			binding.Status = test.status
			if test.mutate != nil {
				test.mutate(&binding)
			}
			store := &fixedPurposeLookupStore{Store: memory, binding: binding}
			svc := NewService(store, nil, Options{})
			_, err := svc.createExternalKey(t.Context(), "user-1", "DEFAULT")
			if !errors.Is(err, test.wantError) {
				t.Fatalf("error = %v, want %v", err, test.wantError)
			}
			if strings.Contains(err.Error(), material.ExternalKey) {
				t.Fatal("state error leaked external key")
			}
		})
	}
}

func TestCreateExternalKeyDoesNotReturnActiveKeyForInactiveTenant(t *testing.T) {
	material, err := generateExternalKeyV2(bytes.NewReader(bytes.Repeat([]byte{3}, externalKeyRandomBytes)))
	if err != nil {
		t.Fatal(err)
	}
	binding := APIKeyBinding{
		ExternalKey: material.ExternalKey, ExternalKeyHash: material.ExternalKeyHash,
		ExternalKeyID: material.ExternalKeyID, SecretHash: material.SecretHash,
		KeyVersion: material.Version, RouteSlot: material.RouteSlot,
		Purpose: "default", SetID: "set-a", UserID: "user-1", Status: APIKeyStatusActive,
	}
	for _, status := range []string{TenantStatusDisabled, TenantStatusDeleting, TenantStatusDeleted} {
		memory := NewMemoryStore()
		prepareReadyKeyIssuanceUser(t, memory, "http://unused.invalid")
		if err := memory.SaveTenant(t.Context(), Tenant{
			ExternalUserID: "user-1", Backend: UserBackendNew, SetID: "set-a", Status: status,
		}); err != nil {
			t.Fatal(err)
		}
		store := &fixedPurposeLookupStore{Store: memory, binding: binding}
		svc := NewService(store, nil, Options{})
		if _, err := svc.createExternalKey(t.Context(), "user-1", "default"); !errors.Is(err, ErrTenantInactive) {
			t.Fatalf("status %s error = %v, want tenant inactive", status, err)
		} else if strings.Contains(err.Error(), material.ExternalKey) {
			t.Fatalf("status %s error leaked external key", status)
		}
	}
}

func TestCreateExternalKeyWithoutPurposeCreatesDistinctKeys(t *testing.T) {
	upstream := newKeyIssuanceUpstream(t, nil)
	defer upstream.Close()
	store := NewMemoryStore()
	prepareReadyKeyIssuanceUser(t, store, upstream.URL)
	svc := NewService(store, nil, Options{})

	first, err := svc.CreateExternalKey(t.Context(), "user-1")
	if err != nil {
		t.Fatal(err)
	}
	second, err := svc.CreateExternalKey(t.Context(), "user-1")
	if err != nil {
		t.Fatal(err)
	}
	if first.ExternalKeyID == second.ExternalKeyID || first.ExternalKey == second.ExternalKey {
		t.Fatalf("purpose-less keys unexpectedly reused: first=%q second=%q", first.ExternalKeyID, second.ExternalKeyID)
	}
}

func TestCreateExternalKeyEmitsProvisionSpans(t *testing.T) {
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	previous := otel.GetTracerProvider()
	otel.SetTracerProvider(provider)
	defer otel.SetTracerProvider(previous)
	defer func() { _ = provider.Shutdown(t.Context()) }()

	userExists := false
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "POST /api/user/":
			userExists = true
			writeTestJSON(t, w, map[string]any{"success": true})
		case "POST /api/user/login":
			if !userExists {
				t.Fatal("login before user create")
			}
			writeTestJSON(t, w, map[string]any{"success": true, "data": map[string]any{"id": 42, "username": "sgw-user-1", "role": 1, "status": 1, "group": "default"}})
		case "GET /api/user/token":
			writeTestJSON(t, w, map[string]any{"success": true, "data": "user-access-token"})
		case "POST /api/token/":
			writeTestJSON(t, w, map[string]any{"success": true})
		case "GET /api/token/search":
			writeTestJSON(t, w, map[string]any{"success": true, "data": map[string]any{"items": []map[string]any{{"id": 7, "name": r.URL.Query().Get("keyword")}}}})
		case "POST /api/token/7/key":
			writeTestJSON(t, w, map[string]any{"success": true, "data": map[string]any{"key": "sk-upstream"}})
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer upstream.Close()

	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	if err := svc.RegisterSet(t.Context(), RegisterSetInput{ID: "set-a", BaseURL: upstream.URL, Status: SetStatusActive}); err != nil {
		t.Fatal(err)
	}
	set, ok, _ := store.GetSet(t.Context(), "set-a")
	if !ok {
		t.Fatal("set not found")
	}
	set.Setup = true
	set.AdminUserID = 1
	set.AdminAccessToken = "set-admin-token"
	if err := store.SaveSet(t.Context(), set); err != nil {
		t.Fatal(err)
	}

	if _, err := svc.CreateExternalKey(t.Context(), "user-1"); err != nil {
		t.Fatal(err)
	}
	spanNames := endedSpanNames(recorder)
	for _, want := range []string{
		"llmgateway.key.issue",
		"llmgateway.ensure_user_binding",
		"llmgateway.ensure_upstream_user",
		"newapi.create_user_token",
	} {
		if !spanNameExists(spanNames, want) {
			t.Fatalf("missing span %q in %v", want, spanNames)
		}
	}
}

func TestCreateExternalKeyClaimsExistingUpstreamUser(t *testing.T) {
	var resetPassword string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "GET /api/user/search":
			writeTestJSON(t, w, map[string]any{"success": true, "data": map[string]any{"items": []map[string]any{{
				"id":           42,
				"username":     "sgw-user-1",
				"display_name": "sgw-user-1",
				"role":         1,
				"status":       1,
				"group":        "default",
			}}}})
		case "PUT /api/user/":
			var req struct {
				ID       int    `json:"id"`
				Username string `json:"username"`
				Password string `json:"password"`
			}
			decodeTestJSON(t, r, &req)
			if req.ID != 42 || req.Username != "sgw-user-1" || req.Password == "" {
				t.Fatalf("unexpected update user request: %+v", req)
			}
			resetPassword = req.Password
			writeTestJSON(t, w, map[string]any{"success": true})
		case "POST /api/user/login":
			var req struct {
				Username string `json:"username"`
				Password string `json:"password"`
			}
			decodeTestJSON(t, r, &req)
			if resetPassword == "" {
				writeTestJSON(t, w, map[string]any{"success": false, "message": "用户名或密码错误"})
				return
			}
			if req.Username != "sgw-user-1" || req.Password != resetPassword {
				t.Fatalf("unexpected login after password reset: %+v reset=%q", req, resetPassword)
			}
			writeTestJSON(t, w, map[string]any{"success": true, "data": map[string]any{"id": 42, "username": "sgw-user-1", "role": 1, "status": 1, "group": "default"}})
		case "GET /api/user/token":
			writeTestJSON(t, w, map[string]any{"success": true, "data": "user-access-token"})
		case "POST /api/token/":
			var req struct {
				Group string `json:"group"`
			}
			decodeTestJSON(t, r, &req)
			if req.Group != "default" {
				t.Fatalf("platform upstream token group = %q, want default", req.Group)
			}
			writeTestJSON(t, w, map[string]any{"success": true})
		case "GET /api/token/search":
			writeTestJSON(t, w, map[string]any{"success": true, "data": map[string]any{"items": []map[string]any{{"id": 7, "name": r.URL.Query().Get("keyword")}}}})
		case "POST /api/token/7/key":
			writeTestJSON(t, w, map[string]any{"success": true, "data": map[string]any{"key": "sk-upstream"}})
		case "POST /api/user/":
			writeTestJSON(t, w, map[string]any{
				"success": false,
				"message": "Error 1062 (23000): Duplicate entry 'sgw-user-1' for key 'users.username'",
			})
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer upstream.Close()

	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	if err := svc.RegisterSet(t.Context(), RegisterSetInput{ID: "set-a", BaseURL: upstream.URL, Status: SetStatusActive}); err != nil {
		t.Fatal(err)
	}
	set, ok, _ := store.GetSet(t.Context(), "set-a")
	if !ok {
		t.Fatal("set not found")
	}
	set.Setup = true
	set.AdminUserID = 1
	set.AdminAccessToken = "set-admin-token"
	if err := store.SaveSet(t.Context(), set); err != nil {
		t.Fatal(err)
	}

	key, err := svc.CreateExternalKey(t.Context(), "user-1")
	if err != nil {
		t.Fatal(err)
	}
	if key.UpstreamKeyID != 7 || key.UpstreamKey != "sk-upstream" {
		t.Fatalf("unexpected key binding: %+v", key)
	}
}

func TestCreateExternalKeyReservesCentralIdentityBeforeCreatingUpstreamToken(t *testing.T) {
	var eventsMu sync.Mutex
	events := []string{}
	record := func(event string) {
		eventsMu.Lock()
		defer eventsMu.Unlock()
		events = append(events, event)
	}
	upstream := newKeyIssuanceUpstream(t, func() { record("upstream_create") })
	defer upstream.Close()

	memory := NewMemoryStore()
	prepareReadyKeyIssuanceUser(t, memory, upstream.URL)
	store := &keyIssuanceOrderStore{Store: memory, record: record}
	svc := NewService(store, nil, Options{})

	if _, err := svc.CreateExternalKey(t.Context(), "user-1"); err != nil {
		t.Fatal(err)
	}
	eventsMu.Lock()
	defer eventsMu.Unlock()
	if len(events) < 2 || events[0] != "reserve" || events[1] != "upstream_create" {
		t.Fatalf("issuance events = %v, want reservation before upstream create", events)
	}
}

func TestCreateExternalKeyDoesNotReturnKeyWhenRoutePublicationFails(t *testing.T) {
	upstream := newKeyIssuanceUpstream(t, nil)
	defer upstream.Close()

	store := NewMemoryStore()
	prepareReadyKeyIssuanceUser(t, store, upstream.URL)
	cache := &failingRoutePublicationCache{
		MemoryAPIKeyRouteCache: NewMemoryAPIKeyRouteCache(0, 100),
		err:                    errors.New("redis unavailable"),
	}
	svc := NewService(store, nil, Options{KeyRouteCache: cache})

	key, err := svc.CreateExternalKey(t.Context(), "user-1")
	if err == nil {
		t.Fatalf("expected route publication failure, got key %+v", key)
	}
	bindings, listErr := store.ListAPIKeyBindingsByUser(t.Context(), "user-1")
	if listErr != nil {
		t.Fatal(listErr)
	}
	if len(bindings) != 1 || bindings[0].Status != APIKeyStatusRoutePending {
		t.Fatalf("bindings after route failure = %+v, want one route_pending binding", bindings)
	}
}

func TestCreateExternalKeyAcceptsWorkerWinningRouteActivationRace(t *testing.T) {
	upstream := newKeyIssuanceUpstream(t, nil)
	defer upstream.Close()

	memory := NewMemoryStore()
	prepareReadyKeyIssuanceUser(t, memory, upstream.URL)
	store := &routeActivationRaceStore{Store: memory}
	cache := NewMemoryAPIKeyRouteCache(0, 100)
	svc := NewService(store, nil, Options{KeyRouteCache: cache})

	key, err := svc.CreateExternalKey(t.Context(), "user-1")
	if err != nil {
		t.Fatal(err)
	}
	if key.Status != APIKeyStatusActive || key.ExternalKey == "" || !store.raced.Load() {
		t.Fatalf("key = %+v raced=%t, want active key after worker race", key, store.raced.Load())
	}
	saved, ok, err := memory.GetAPIKeyBindingByExternalKeyID(t.Context(), key.ExternalKeyID)
	if err != nil || !ok || saved.Status != APIKeyStatusActive {
		t.Fatalf("saved key = %+v ok=%t err=%v, want active", saved, ok, err)
	}
}

func TestCreateExternalKeyRetriesRandomIdentityCollisionAtMostFiveTimes(t *testing.T) {
	var upstreamCreates atomic.Int32
	upstream := newKeyIssuanceUpstream(t, func() { upstreamCreates.Add(1) })
	defer upstream.Close()

	t.Run("fifth candidate succeeds", func(t *testing.T) {
		memory := NewMemoryStore()
		prepareReadyKeyIssuanceUser(t, memory, upstream.URL)
		store := &collisionReservationStore{Store: memory, randomCollisions: 4}
		svc := NewService(store, nil, Options{
			ExternalKeyRandom: bytes.NewReader(bytes.Repeat([]byte{9}, externalKeyRandomBytes*externalKeyReservationAttempts)),
		})
		if _, err := svc.CreateExternalKey(t.Context(), "user-1"); err != nil {
			t.Fatal(err)
		}
		if store.attempts.Load() != externalKeyReservationAttempts {
			t.Fatalf("reservation attempts = %d, want %d", store.attempts.Load(), externalKeyReservationAttempts)
		}
	})

	t.Run("fifth collision stops without upstream create", func(t *testing.T) {
		before := upstreamCreates.Load()
		memory := NewMemoryStore()
		prepareReadyKeyIssuanceUser(t, memory, upstream.URL)
		store := &collisionReservationStore{Store: memory, randomCollisions: externalKeyReservationAttempts}
		svc := NewService(store, nil, Options{
			ExternalKeyRandom: bytes.NewReader(bytes.Repeat([]byte{8}, externalKeyRandomBytes*externalKeyReservationAttempts)),
		})
		if _, err := svc.CreateExternalKey(t.Context(), "user-1"); !errors.Is(err, ErrAPIKeyRandomCollision) {
			t.Fatalf("error = %v, want random collision", err)
		}
		if store.attempts.Load() != externalKeyReservationAttempts {
			t.Fatalf("reservation attempts = %d, want %d", store.attempts.Load(), externalKeyReservationAttempts)
		}
		if upstreamCreates.Load() != before {
			t.Fatal("upstream token was created after reservation collisions were exhausted")
		}
	})
}

func TestCreateExternalKeyDoesNotRetryPurposeConflict(t *testing.T) {
	var upstreamCreates atomic.Int32
	upstream := newKeyIssuanceUpstream(t, func() { upstreamCreates.Add(1) })
	defer upstream.Close()
	memory := NewMemoryStore()
	prepareReadyKeyIssuanceUser(t, memory, upstream.URL)
	store := &collisionReservationStore{Store: memory, purposeConflict: true}
	svc := NewService(store, nil, Options{
		ExternalKeyRandom: bytes.NewReader(bytes.Repeat([]byte{7}, externalKeyRandomBytes*externalKeyReservationAttempts)),
	})

	if _, err := svc.createExternalKey(t.Context(), "user-1", APIKeyPurposeTrafficProbe); !errors.Is(err, ErrAPIKeyPurposeConflict) {
		t.Fatalf("error = %v, want purpose conflict", err)
	}
	if store.attempts.Load() != 1 {
		t.Fatalf("reservation attempts = %d, want 1", store.attempts.Load())
	}
	if upstreamCreates.Load() != 0 {
		t.Fatal("upstream token was created after purpose conflict")
	}
}

func TestCreateExternalKeyPurposeConflictReturnsConcurrentWinnerWithoutUpstreamToken(t *testing.T) {
	var upstreamCreates atomic.Int32
	upstream := newKeyIssuanceUpstream(t, func() { upstreamCreates.Add(1) })
	defer upstream.Close()

	memory := NewMemoryStore()
	prepareReadyKeyIssuanceUser(t, memory, upstream.URL)
	material, err := generateExternalKeyV2(bytes.NewReader(bytes.Repeat([]byte{6}, externalKeyRandomBytes)))
	if err != nil {
		t.Fatal(err)
	}
	winner := APIKeyBinding{
		ExternalKey:     material.ExternalKey,
		ExternalKeyHash: material.ExternalKeyHash,
		ExternalKeyID:   material.ExternalKeyID,
		SecretHash:      material.SecretHash,
		KeyVersion:      material.Version,
		RouteSlot:       material.RouteSlot,
		Purpose:         "default",
		SetID:           "set-a",
		UserID:          "user-1",
		UpstreamKey:     "sk-winner-upstream",
		UpstreamKeyID:   77,
		Status:          APIKeyStatusActive,
	}
	store := &purposeConflictWinnerStore{Store: memory, winner: winner}
	svc := NewService(store, nil, Options{})

	key, err := svc.createExternalKey(t.Context(), "user-1", "default")
	if err != nil {
		t.Fatal(err)
	}
	if key.ExternalKeyID != winner.ExternalKeyID || key.ExternalKey != winner.ExternalKey {
		t.Fatalf("key = %+v, want concurrent winner %+v", key, winner)
	}
	if upstreamCreates.Load() != 0 {
		t.Fatalf("upstream token creates = %d, want 0", upstreamCreates.Load())
	}
}

type keyIssuanceOrderStore struct {
	Store
	record func(string)
}

func (s *keyIssuanceOrderStore) ReserveAPIKeyBinding(ctx context.Context, binding APIKeyBinding) error {
	s.record("reserve")
	return s.Store.ReserveAPIKeyBinding(ctx, binding)
}

func (s *keyIssuanceOrderStore) SaveAPIKeyBinding(ctx context.Context, binding APIKeyBinding) error {
	s.record("save")
	return s.Store.SaveAPIKeyBinding(ctx, binding)
}

type fixedPurposeLookupStore struct {
	Store
	binding APIKeyBinding
}

func (s *fixedPurposeLookupStore) GetAPIKeyBindingByUserPurpose(context.Context, string, string) (APIKeyBinding, bool, error) {
	return s.binding, true, nil
}

type failingRoutePublicationCache struct {
	*MemoryAPIKeyRouteCache
	err error
}

type routeActivationRaceStore struct {
	Store
	raced atomic.Bool
}

func (s *routeActivationRaceStore) TransitionAPIKeyBinding(ctx context.Context, keyID, expectedStatus, nextStatus, upstreamKey string, upstreamKeyID int, lastError string, updatedAt time.Time) (APIKeyBinding, error) {
	if expectedStatus == APIKeyStatusRoutePending && nextStatus == APIKeyStatusActive && s.raced.CompareAndSwap(false, true) {
		if _, err := s.Store.TransitionAPIKeyBinding(ctx, keyID, expectedStatus, nextStatus, upstreamKey, upstreamKeyID, lastError, updatedAt); err != nil {
			return APIKeyBinding{}, err
		}
		return APIKeyBinding{}, fmt.Errorf("%w: key=%s expected=%s", ErrAPIKeyStateConflict, keyID, expectedStatus)
	}
	return s.Store.TransitionAPIKeyBinding(ctx, keyID, expectedStatus, nextStatus, upstreamKey, upstreamKeyID, lastError, updatedAt)
}

type collisionReservationStore struct {
	Store
	randomCollisions int32
	purposeConflict  bool
	attempts         atomic.Int32
}

type purposeConflictWinnerStore struct {
	Store
	winner APIKeyBinding
	once   sync.Once
}

func (s *purposeConflictWinnerStore) ReserveAPIKeyBinding(ctx context.Context, _ APIKeyBinding) error {
	var saveErr error
	s.once.Do(func() {
		saveErr = s.Store.SaveAPIKeyBinding(ctx, s.winner)
	})
	if saveErr != nil {
		return saveErr
	}
	return ErrAPIKeyPurposeConflict
}

func (s *collisionReservationStore) ReserveAPIKeyBinding(ctx context.Context, binding APIKeyBinding) error {
	attempt := s.attempts.Add(1)
	if s.purposeConflict {
		return ErrAPIKeyPurposeConflict
	}
	if attempt <= s.randomCollisions {
		return ErrAPIKeyRandomCollision
	}
	return s.Store.ReserveAPIKeyBinding(ctx, binding)
}

func (c *failingRoutePublicationCache) SetRoute(context.Context, TrafficRouteSnapshot) error {
	return c.err
}

func newKeyIssuanceUpstream(t *testing.T, onCreate func()) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "POST /api/user/login":
			writeTestJSON(t, w, map[string]any{"success": true, "data": map[string]any{"id": 42, "username": "sgw-user-1"}})
		case "GET /api/user/token":
			writeTestJSON(t, w, map[string]any{"success": true, "data": "user-access-token"})
		case "POST /api/token/":
			if onCreate != nil {
				onCreate()
			}
			writeTestJSON(t, w, map[string]any{"success": true})
		case "GET /api/token/search":
			writeTestJSON(t, w, map[string]any{"success": true, "data": map[string]any{"items": []map[string]any{{"id": 7, "name": r.URL.Query().Get("keyword")}}}})
		case "POST /api/token/7/key":
			writeTestJSON(t, w, map[string]any{"success": true, "data": map[string]any{"key": "sk-upstream"}})
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
}

func prepareReadyKeyIssuanceUser(t *testing.T, store Store, baseURL string) {
	t.Helper()
	if err := store.SaveSet(t.Context(), Set{
		ID: "set-a", BaseURL: baseURL, TrafficBaseURL: baseURL, Status: SetStatusActive,
		Setup: true, AdminUserID: 1, AdminAccessToken: "set-admin-token",
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveTenant(t.Context(), Tenant{
		ExternalUserID: "user-1", Backend: UserBackendNew, SetID: "set-a", Status: TenantStatusActive,
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveUserBinding(t.Context(), UserBinding{
		ExternalUserID: "user-1", SetID: "set-a", UpstreamUserID: 42,
		Username: "sgw-user-1", Password: "password", ProvisionStatus: BindingProvisionStatusUserReady,
	}); err != nil {
		t.Fatal(err)
	}
}

func decodeTestJSON(t *testing.T, r *http.Request, out any) {
	t.Helper()
	if err := json.NewDecoder(r.Body).Decode(out); err != nil {
		t.Fatal(err)
	}
}

func writeTestJSON(t *testing.T, w http.ResponseWriter, v any) {
	t.Helper()
	if err := json.NewEncoder(w).Encode(v); err != nil {
		t.Fatal(err)
	}
}
