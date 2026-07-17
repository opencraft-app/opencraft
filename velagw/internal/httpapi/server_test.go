package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"git.woa.com/wisp/mono2/llmgateway/internal/gateway"
)

func TestAdminLoginAndSetRegistry(t *testing.T) {
	svc := gateway.NewService(gateway.NewMemoryStore(), nil, gateway.Options{})
	handler := NewServer(svc, Config{
		AdminUsername: "cluster-admin",
		AdminPassword: "test-local-password",
		AdminToken:    "cluster-token",
	})

	loginBody := bytes.NewBufferString(`{"username":"cluster-admin","password":"test-local-password"}`)
	loginReq := httptest.NewRequest(http.MethodPost, "/api/admin/login", loginBody)
	loginRec := httptest.NewRecorder()
	handler.ServeHTTP(loginRec, loginReq)
	if loginRec.Code != http.StatusOK {
		t.Fatalf("login status = %d body = %s", loginRec.Code, loginRec.Body.String())
	}

	var loginResp struct {
		Success bool `json:"success"`
		Data    struct {
			Token string `json:"token"`
		} `json:"data"`
	}
	if err := json.NewDecoder(loginRec.Body).Decode(&loginResp); err != nil {
		t.Fatal(err)
	}
	if !loginResp.Success || loginResp.Data.Token != "cluster-token" {
		t.Fatalf("unexpected login response: %+v", loginResp)
	}

	createReq := httptest.NewRequest(http.MethodPost, "/api/sets", bytes.NewBufferString(`{"id":"set-a","base_url":"http://localhost:13001","status":"active"}`))
	createReq.Header.Set("Authorization", "Bearer cluster-token")
	createRec := httptest.NewRecorder()
	handler.ServeHTTP(createRec, createReq)
	if createRec.Code != http.StatusOK {
		t.Fatalf("create status = %d body = %s", createRec.Code, createRec.Body.String())
	}

	listReq := httptest.NewRequest(http.MethodGet, "/api/sets", nil)
	listReq.Header.Set("Authorization", "Bearer cluster-token")
	listRec := httptest.NewRecorder()
	handler.ServeHTTP(listRec, listReq)
	if listRec.Code != http.StatusOK {
		t.Fatalf("list status = %d body = %s", listRec.Code, listRec.Body.String())
	}
	if !bytes.Contains(listRec.Body.Bytes(), []byte(`"id":"set-a"`)) {
		t.Fatalf("set-a missing from list: %s", listRec.Body.String())
	}
}

func TestWriteInternalServiceErrorPreservesSubscriptionIdempotencySemantics(t *testing.T) {
	tests := []struct {
		name       string
		err        error
		wantStatus int
		wantCode   string
	}{
		{name: "conflict", err: gateway.ErrSubscriptionIdempotencyConflict, wantStatus: http.StatusConflict, wantCode: "idempotency_conflict"},
		{name: "processing", err: gateway.ErrSubscriptionIdempotencyPending, wantStatus: http.StatusConflict, wantCode: "idempotency_in_progress"},
		{name: "unknown", err: gateway.ErrSubscriptionOutcomeUnknown, wantStatus: http.StatusServiceUnavailable, wantCode: "delivery_outcome_unknown"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			writeInternalServiceError(recorder, tc.err)
			if recorder.Code != tc.wantStatus {
				t.Fatalf("status = %d, want %d", recorder.Code, tc.wantStatus)
			}
			if !strings.Contains(recorder.Body.String(), tc.wantCode) {
				t.Fatalf("body = %s, want code %q", recorder.Body.String(), tc.wantCode)
			}
		})
	}
}

func TestAdminEndpointsRequireBearerToken(t *testing.T) {
	svc := gateway.NewService(gateway.NewMemoryStore(), nil, gateway.Options{})
	handler := NewServer(svc, Config{AdminToken: "cluster-token"})

	req := httptest.NewRequest(http.MethodGet, "/api/sets", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestAdminShellRequiresLoginAndCookieCanAuthorizeAdminAPIs(t *testing.T) {
	svc := gateway.NewService(gateway.NewMemoryStore(), nil, gateway.Options{})
	handler := NewServer(svc, Config{
		AdminUsername: "cluster-admin",
		AdminPassword: "admin-password",
		AdminToken:    "cluster-token",
	})

	adminReq := httptest.NewRequest(http.MethodGet, "/admin", nil)
	adminRec := httptest.NewRecorder()
	handler.ServeHTTP(adminRec, adminReq)
	if adminRec.Code != http.StatusFound {
		t.Fatalf("admin status = %d, want redirect", adminRec.Code)
	}
	if location := adminRec.Header().Get("Location"); !strings.HasPrefix(location, "/admin/login?next=") {
		t.Fatalf("location = %q", location)
	}

	loginPageReq := httptest.NewRequest(http.MethodGet, "/admin/login", nil)
	loginPageRec := httptest.NewRecorder()
	handler.ServeHTTP(loginPageRec, loginPageReq)
	if loginPageRec.Code != http.StatusOK || !strings.Contains(loginPageRec.Body.String(), "Control plane sign in") {
		t.Fatalf("login page status = %d body = %s", loginPageRec.Code, loginPageRec.Body.String())
	}

	loginReq := httptest.NewRequest(http.MethodPost, "/api/admin/login", bytes.NewBufferString(`{"username":"cluster-admin","password":"admin-password"}`))
	loginRec := httptest.NewRecorder()
	handler.ServeHTTP(loginRec, loginReq)
	if loginRec.Code != http.StatusOK {
		t.Fatalf("login status = %d body = %s", loginRec.Code, loginRec.Body.String())
	}
	cookies := loginRec.Result().Cookies()
	var session *http.Cookie
	for _, cookie := range cookies {
		if cookie.Name == adminSessionCookieName {
			session = cookie
		}
	}
	if session == nil || session.Value != "cluster-token" || !session.HttpOnly {
		t.Fatalf("session cookie = %+v", session)
	}

	apiReq := httptest.NewRequest(http.MethodGet, "/api/sets", nil)
	apiReq.AddCookie(session)
	apiRec := httptest.NewRecorder()
	handler.ServeHTTP(apiRec, apiReq)
	if apiRec.Code != http.StatusOK {
		t.Fatalf("cookie api status = %d body = %s", apiRec.Code, apiRec.Body.String())
	}

	adminWithCookieReq := httptest.NewRequest(http.MethodGet, "/admin", nil)
	adminWithCookieReq.AddCookie(session)
	adminWithCookieRec := httptest.NewRecorder()
	handler.ServeHTTP(adminWithCookieRec, adminWithCookieReq)
	if adminWithCookieRec.Code != http.StatusInternalServerError || !strings.Contains(adminWithCookieRec.Body.String(), "LLMGateway console is not built") {
		t.Fatalf("admin with cookie status = %d body = %s", adminWithCookieRec.Code, adminWithCookieRec.Body.String())
	}
}

func TestAdminLogoutExpiresSessionCookie(t *testing.T) {
	svc := gateway.NewService(gateway.NewMemoryStore(), nil, gateway.Options{})
	handler := NewServer(svc, Config{AdminToken: "cluster-token"})

	logoutReq := httptest.NewRequest(http.MethodPost, "/api/admin/logout", nil)
	logoutReq.AddCookie(&http.Cookie{Name: adminSessionCookieName, Value: "cluster-token", Path: "/"})
	logoutRec := httptest.NewRecorder()
	handler.ServeHTTP(logoutRec, logoutReq)

	if logoutRec.Code != http.StatusOK {
		t.Fatalf("logout status = %d body = %s", logoutRec.Code, logoutRec.Body.String())
	}
	var expired *http.Cookie
	for _, cookie := range logoutRec.Result().Cookies() {
		if cookie.Name == adminSessionCookieName {
			expired = cookie
		}
	}
	if expired == nil || expired.Value != "" || expired.MaxAge >= 0 || expired.Path != "/" || !expired.HttpOnly {
		t.Fatalf("expired session cookie = %+v", expired)
	}
}

func TestAdminEndpointsAllowRequestsWhenAdminTokenUnset(t *testing.T) {
	svc := gateway.NewService(gateway.NewMemoryStore(), nil, gateway.Options{})
	handler := NewServer(svc, Config{})

	req := httptest.NewRequest(http.MethodGet, "/api/sets", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
}

func TestAdminShardsEndpointReturnsLogicalConnectionBudget(t *testing.T) {
	svc := gateway.NewService(gateway.NewMemoryStore(), nil, gateway.Options{})
	handler := NewServer(svc, Config{AdminToken: "cluster-token"})

	createShardReq := httptest.NewRequest(http.MethodPost, "/api/admin/shards", bytes.NewBufferString(`{
		"id":"mysql-a",
		"name":"主库 A",
		"kind":"mysql",
		"endpoint":"mysql-a.internal:3306",
		"status":"active",
		"max_connections":2000,
		"reserved_connections":200,
		"warn_ratio":0.7,
		"critical_ratio":0.85
	}`))
	createShardReq.Header.Set("Authorization", "Bearer cluster-token")
	createShardRec := httptest.NewRecorder()
	handler.ServeHTTP(createShardRec, createShardReq)
	if createShardRec.Code != http.StatusOK {
		t.Fatalf("create shard status = %d body = %s", createShardRec.Code, createShardRec.Body.String())
	}

	createSetReq := httptest.NewRequest(http.MethodPost, "/api/sets", bytes.NewBufferString(`{
		"id":"set-a",
		"base_url":"http://localhost:13001",
		"status":"active",
		"shard_id":"mysql-a",
		"newapi_replicas":3,
		"sql_max_open_conns":100,
		"sql_max_idle_conns":20
	}`))
	createSetReq.Header.Set("Authorization", "Bearer cluster-token")
	createSetRec := httptest.NewRecorder()
	handler.ServeHTTP(createSetRec, createSetReq)
	if createSetRec.Code != http.StatusOK {
		t.Fatalf("create set status = %d body = %s", createSetRec.Code, createSetRec.Body.String())
	}

	listReq := httptest.NewRequest(http.MethodGet, "/api/admin/shards", nil)
	listReq.Header.Set("Authorization", "Bearer cluster-token")
	listRec := httptest.NewRecorder()
	handler.ServeHTTP(listRec, listReq)
	if listRec.Code != http.StatusOK {
		t.Fatalf("list shards status = %d body = %s", listRec.Code, listRec.Body.String())
	}
	if !bytes.Contains(listRec.Body.Bytes(), []byte(`"logical_connections":300`)) {
		t.Fatalf("logical budget missing from list: %s", listRec.Body.String())
	}

	detailReq := httptest.NewRequest(http.MethodGet, "/api/admin/shards/mysql-a", nil)
	detailReq.Header.Set("Authorization", "Bearer cluster-token")
	detailRec := httptest.NewRecorder()
	handler.ServeHTTP(detailRec, detailReq)
	if detailRec.Code != http.StatusOK {
		t.Fatalf("detail shard status = %d body = %s", detailRec.Code, detailRec.Body.String())
	}
	if !bytes.Contains(detailRec.Body.Bytes(), []byte(`"set_id":"set-a"`)) {
		t.Fatalf("set budget missing from detail: %s", detailRec.Body.String())
	}
}

func TestAdminSetReconcileFactsEndpointRecordsFactsWithoutRegisteringSet(t *testing.T) {
	store := gateway.NewMemoryStore()
	svc := gateway.NewService(store, nil, gateway.Options{})
	handler := NewServer(svc, Config{AdminToken: "cluster-token"})

	req := httptest.NewRequest(http.MethodPost, "/api/admin/set-reconcile-facts", bytes.NewBufferString(`{
		"source":"kro",
		"namespace":"llmgateway-kro-demo",
		"fleet":"fleet-demo",
		"sets":[{"set_id":"set-a","name":"Set A","base_url":"http://fleet-demo-set-a-newapi:3000","shard_ref":"shard-a"}]
	}`))
	req.Header.Set("Authorization", "Bearer cluster-token")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("record facts status = %d body = %s", rec.Code, rec.Body.String())
	}

	sets, err := svc.ListSets(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if len(sets) != 0 {
		t.Fatalf("recording set facts should not register sets: %+v", sets)
	}
	facts, err := store.ListSetReconcileFacts(t.Context(), gateway.SetReconcileFactListOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(facts) != 1 || facts[0].Status != gateway.SetReconcileStatusPending {
		t.Fatalf("unexpected facts: %+v", facts)
	}
}

func TestAdminSetReconcileFactsEndpointConsumesPendingFacts(t *testing.T) {
	upstream := newHTTPBootstrapTestServer(t)
	defer upstream.Close()

	store := gateway.NewMemoryStore()
	svc := gateway.NewService(store, nil, gateway.Options{RootUsername: "set-root", RootPassword: "test-local-password"})
	handler := NewServer(svc, Config{AdminToken: "cluster-token"})
	if _, err := svc.RecordSetReconcileFacts(t.Context(), gateway.RecordSetReconcileFactsInput{
		Source:    "kro",
		Namespace: "llmgateway-kro-demo",
		Fleet:     "fleet-demo",
		Sets: []gateway.SetReconcileFactInput{
			{SetID: "set-a", Name: "Set A", BaseURL: upstream.URL, ShardRef: "shard-a"},
		},
	}); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/admin/set-reconcile-facts/reconcile", bytes.NewBufferString(`{"limit":10}`))
	req.Header.Set("Authorization", "Bearer cluster-token")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("reconcile facts status = %d body = %s", rec.Code, rec.Body.String())
	}
	if !bytes.Contains(rec.Body.Bytes(), []byte(`"managed":1`)) {
		t.Fatalf("reconcile response missing managed count: %s", rec.Body.String())
	}
	set, ok, err := store.GetSet(t.Context(), "set-a")
	if err != nil || !ok {
		t.Fatalf("set not saved: ok=%v err=%v", ok, err)
	}
	if !set.Setup || set.AdminAccessToken != "set-admin-token" {
		t.Fatalf("unexpected set: %+v", set)
	}
}

func TestAdminSetCapacityEndpointCreatesProvisionRequest(t *testing.T) {
	store := gateway.NewMemoryStore()
	svc := gateway.NewService(store, nil, gateway.Options{})
	saveHTTPReadySet(t, store, "set-a")
	if err := store.IncrementSetObservedUserCount(t.Context(), "set-a", 9); err != nil {
		t.Fatal(err)
	}
	handler := NewServer(svc, Config{AdminToken: "cluster-token"})

	req := httptest.NewRequest(http.MethodPost, "/api/admin/set-capacity/reconcile", bytes.NewBufferString(`{
		"namespace":"llmgateway-kro-demo",
		"fleet":"fleet-demo",
		"shard_refs":["shard-a"],
		"max_users_per_set":10,
		"min_ready_free_users":5,
		"max_scale_up_per_cycle":1,
		"set_id_prefix":"set-auto"
	}`))
	req.Header.Set("Authorization", "Bearer cluster-token")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("capacity status=%d body=%s", rec.Code, rec.Body.String())
	}
	if !bytes.Contains(rec.Body.Bytes(), []byte(`"created_requests":1`)) ||
		!bytes.Contains(rec.Body.Bytes(), []byte(`"set_id":"set-auto-000001"`)) {
		t.Fatalf("capacity response missing request: %s", rec.Body.String())
	}
}

func TestAdminSetCapacityEndpointAcceptsExplicitRedisDBZero(t *testing.T) {
	store := gateway.NewMemoryStore()
	svc := gateway.NewService(store, nil, gateway.Options{})
	saveHTTPReadySet(t, store, "set-a")
	handler := NewServer(svc, Config{AdminToken: "cluster-token"})

	req := httptest.NewRequest(http.MethodPost, "/api/admin/set-capacity/reconcile", bytes.NewBufferString(`{
		"namespace":"llmgateway-kro-demo",
		"fleet":"fleet-demo",
		"shard_refs":["shard-a"],
		"max_users_per_set":1,
		"min_ready_free_users":2,
		"max_scale_up_per_cycle":1,
		"set_id_prefix":"set-db0",
		"redis_db_start":0,
		"redis_db_limit":1
	}`))
	req.Header.Set("Authorization", "Bearer cluster-token")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("capacity status=%d body=%s", rec.Code, rec.Body.String())
	}
	if !bytes.Contains(rec.Body.Bytes(), []byte(`"redis_db":"0"`)) ||
		!bytes.Contains(rec.Body.Bytes(), []byte(`"redis_db_start":0`)) {
		t.Fatalf("capacity response should preserve explicit Redis DB 0: %s", rec.Body.String())
	}
}

func TestAdminSetProvisionRequestsCanListAndUpdateStatus(t *testing.T) {
	store := gateway.NewMemoryStore()
	svc := gateway.NewService(store, nil, gateway.Options{})
	request := gateway.SetProvisionRequest{
		ID:           "kro:llmgateway-kro-demo:fleet-demo:set-auto-000001",
		Source:       "kro",
		Namespace:    "llmgateway-kro-demo",
		Fleet:        "fleet-demo",
		SetID:        "set-auto-000001",
		ShardRef:     "shard-a",
		DatabaseName: "newapi_set_auto_000001",
		RedisDB:      "1",
		Status:       gateway.SetProvisionStatusPending,
	}
	if err := store.SaveSetProvisionRequest(t.Context(), request); err != nil {
		t.Fatal(err)
	}
	handler := NewServer(svc, Config{AdminToken: "cluster-token"})

	listReq := httptest.NewRequest(http.MethodGet, "/api/admin/set-provision-requests?status=pending", nil)
	listReq.Header.Set("Authorization", "Bearer cluster-token")
	listRec := httptest.NewRecorder()
	handler.ServeHTTP(listRec, listReq)
	if listRec.Code != http.StatusOK || !bytes.Contains(listRec.Body.Bytes(), []byte(`"set-auto-000001"`)) {
		t.Fatalf("list status=%d body=%s", listRec.Code, listRec.Body.String())
	}

	updateReq := httptest.NewRequest(http.MethodPost, "/api/admin/set-provision-requests/"+request.ID+"/status", bytes.NewBufferString(`{"status":"created"}`))
	updateReq.Header.Set("Authorization", "Bearer cluster-token")
	updateRec := httptest.NewRecorder()
	handler.ServeHTTP(updateRec, updateReq)
	if updateRec.Code != http.StatusOK {
		t.Fatalf("update status=%d body=%s", updateRec.Code, updateRec.Body.String())
	}
	stored, ok, err := store.GetSetProvisionRequest(t.Context(), request.ID)
	if err != nil || !ok {
		t.Fatalf("request not stored: ok=%v err=%v", ok, err)
	}
	if stored.Status != gateway.SetProvisionStatusCreated {
		t.Fatalf("status=%s, want created", stored.Status)
	}
}

func TestPlanEndpointDefaultsOmittedActiveToTrue(t *testing.T) {
	store := gateway.NewMemoryStore()
	svc := gateway.NewService(store, nil, gateway.Options{})
	handler := NewServer(svc, Config{AdminToken: "cluster-token"})

	body := `{"id":"plan-pro","name":"Pro","monthly_tokens":1000,"period_value":1,"period_unit":"months"}`
	req := httptest.NewRequest(http.MethodPost, "/api/plans", bytes.NewBufferString(body))
	req.Header.Set("Authorization", "Bearer cluster-token")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("create plan status = %d body = %s", rec.Code, rec.Body.String())
	}

	plan, err := svc.GetPlan(t.Context(), "plan-pro")
	if err != nil {
		t.Fatal(err)
	}
	if !plan.IsActive {
		t.Fatalf("plan should default active when is_active is omitted: %+v", plan)
	}
}

func TestPlanEndpointGeneratesIDAndReturnsCreatedPlan(t *testing.T) {
	store := gateway.NewMemoryStore()
	svc := gateway.NewService(store, nil, gateway.Options{})
	handler := NewServer(svc, Config{AdminToken: "cluster-token"})

	body := `{"name":"入门型 14 天","monthly_tokens":1000000,"period_value":14,"period_unit":"days"}`
	req := httptest.NewRequest(http.MethodPost, "/api/plans", bytes.NewBufferString(body))
	req.Header.Set("Authorization", "Bearer cluster-token")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create plan status = %d body = %s", rec.Code, rec.Body.String())
	}
	var payload struct {
		Success bool         `json:"success"`
		Data    gateway.Plan `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if !payload.Success || !strings.HasPrefix(payload.Data.ID, "plan-") || payload.Data.PeriodValue != 14 || payload.Data.PeriodUnit != "days" {
		t.Fatalf("unexpected response: %+v", payload)
	}
	if _, err := svc.GetPlan(t.Context(), payload.Data.ID); err != nil {
		t.Fatalf("generated plan was not persisted: %v", err)
	}
}

func TestPlanEndpointPreservesExplicitInactive(t *testing.T) {
	store := gateway.NewMemoryStore()
	svc := gateway.NewService(store, nil, gateway.Options{})
	handler := NewServer(svc, Config{AdminToken: "cluster-token"})

	body := `{"id":"plan-disabled","name":"Disabled","monthly_tokens":1000,"period_value":1,"period_unit":"months","is_active":false}`
	req := httptest.NewRequest(http.MethodPost, "/api/plans", bytes.NewBufferString(body))
	req.Header.Set("Authorization", "Bearer cluster-token")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("create plan status = %d body = %s", rec.Code, rec.Body.String())
	}

	plan, err := svc.GetPlan(t.Context(), "plan-disabled")
	if err != nil {
		t.Fatal(err)
	}
	if plan.IsActive {
		t.Fatalf("explicit inactive plan was not preserved: %+v", plan)
	}
}

func TestAdminObserveTenantReturnsAndPersistsProjection(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "GET /api/subscription/admin/users/42/subscriptions":
			writeJSONForHTTPTest(t, w, map[string]any{"success": true, "data": []map[string]any{{
				"subscription": map[string]any{
					"id":           9,
					"user_id":      42,
					"plan_id":      7,
					"amount_total": 1000,
					"amount_used":  125,
					"start_time":   time.Now().Add(-time.Hour).Unix(),
					"end_time":     time.Now().Add(time.Hour).Unix(),
					"status":       "active",
				},
			}}})
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer upstream.Close()

	store := gateway.NewMemoryStore()
	svc := gateway.NewService(store, nil, gateway.Options{})
	if err := svc.RegisterSet(t.Context(), gateway.RegisterSetInput{ID: "set-a", BaseURL: upstream.URL, Status: gateway.SetStatusActive}); err != nil {
		t.Fatal(err)
	}
	set, _, _ := store.GetSet(t.Context(), "set-a")
	set.Setup = true
	set.AdminUserID = 1
	set.AdminAccessToken = "set-admin-token"
	if err := store.SaveSet(t.Context(), set); err != nil {
		t.Fatal(err)
	}
	if err := store.SavePlanMapping(t.Context(), gateway.PlanMapping{
		ID:              "plan-pro",
		Name:            "Pro",
		MonthlyTokens:   1000,
		PeriodValue:     1,
		PeriodUnit:      "months",
		IsActive:        true,
		UpstreamPlanIDs: map[string]int{"set-a": 7},
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveUserBinding(t.Context(), gateway.UserBinding{
		ExternalUserID: "user-1",
		SetID:          "set-a",
		UpstreamUserID: 42,
		Username:       "sgw-user-1",
		LastPlanID:     "plan-pro",
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.SetUserAssignment(t.Context(), gateway.UserAssignment{
		ExternalUserID: "user-1",
		Backend:        gateway.UserBackendNew,
		SetID:          "set-a",
	}); err != nil {
		t.Fatal(err)
	}
	handler := NewServer(svc, Config{AdminToken: "cluster-token"})

	req := httptest.NewRequest(http.MethodPost, "/api/admin/users/user-1/observe", nil)
	req.Header.Set("Authorization", "Bearer cluster-token")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("observe status = %d body = %s", rec.Code, rec.Body.String())
	}
	if !bytes.Contains(rec.Body.Bytes(), []byte(`"current_plan_id":"plan-pro"`)) ||
		!bytes.Contains(rec.Body.Bytes(), []byte(`"credit_available":875`)) {
		t.Fatalf("observe response missing projection: %s", rec.Body.String())
	}
	saved, ok, err := store.GetTenantObservation(t.Context(), "user-1")
	if err != nil || !ok {
		t.Fatalf("projection was not saved: ok=%v err=%v", ok, err)
	}
	if saved.CurrentPlanID != "plan-pro" || saved.CreditAvailable != 875 {
		t.Fatalf("unexpected saved projection: %+v", saved)
	}
}

func TestAdminTenantsRejectsInvalidCursor(t *testing.T) {
	svc := gateway.NewService(gateway.NewMemoryStore(), nil, gateway.Options{})
	handler := NewServer(svc, Config{AdminToken: "cluster-token"})

	req := httptest.NewRequest(http.MethodGet, "/api/admin/tenants?cursor=not-a-cursor", nil)
	req.Header.Set("Authorization", "Bearer cluster-token")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
}

func TestInternalGetActiveSubscriptionReturnsOpenAIStyleNotFound(t *testing.T) {
	svc := gateway.NewService(gateway.NewMemoryStore(), nil, gateway.Options{})
	handler := NewServer(svc, Config{AdminToken: "cluster-token"})

	req := httptest.NewRequest(http.MethodGet, "/api/internal/users/user-missing/subscriptions", nil)
	req.Header.Set("Authorization", "Bearer cluster-token")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	if !bytes.Contains(rec.Body.Bytes(), []byte(`"error"`)) || !bytes.Contains(rec.Body.Bytes(), []byte(`"code":"not_found"`)) {
		t.Fatalf("expected OpenAI style not_found body, got %s", rec.Body.String())
	}
}

func TestInternalEndpointsCanUseDedicatedServiceToken(t *testing.T) {
	svc := gateway.NewService(gateway.NewMemoryStore(), nil, gateway.Options{})
	handler := NewServer(svc, Config{AdminToken: "admin-token", InternalToken: "internal-token"})

	internalWithAdminToken := httptest.NewRequest(http.MethodGet, "/api/internal/users/user-missing/subscriptions", nil)
	internalWithAdminToken.Header.Set("Authorization", "Bearer admin-token")
	internalWithAdminTokenRec := httptest.NewRecorder()
	handler.ServeHTTP(internalWithAdminTokenRec, internalWithAdminToken)
	if internalWithAdminTokenRec.Code != http.StatusUnauthorized {
		t.Fatalf("internal with admin token status=%d body=%s", internalWithAdminTokenRec.Code, internalWithAdminTokenRec.Body.String())
	}

	internalWithInternalToken := httptest.NewRequest(http.MethodGet, "/api/internal/users/user-missing/subscriptions", nil)
	internalWithInternalToken.Header.Set("Authorization", "Bearer internal-token")
	internalWithInternalTokenRec := httptest.NewRecorder()
	handler.ServeHTTP(internalWithInternalTokenRec, internalWithInternalToken)
	if internalWithInternalTokenRec.Code != http.StatusNotFound {
		t.Fatalf("internal with internal token status=%d body=%s", internalWithInternalTokenRec.Code, internalWithInternalTokenRec.Body.String())
	}

	adminWithInternalToken := httptest.NewRequest(http.MethodGet, "/api/sets", nil)
	adminWithInternalToken.Header.Set("Authorization", "Bearer internal-token")
	adminWithInternalTokenRec := httptest.NewRecorder()
	handler.ServeHTTP(adminWithInternalTokenRec, adminWithInternalToken)
	if adminWithInternalTokenRec.Code != http.StatusUnauthorized {
		t.Fatalf("admin with internal token status=%d body=%s", adminWithInternalTokenRec.Code, adminWithInternalTokenRec.Body.String())
	}
}

func TestLegacySubscriptionCompatOnlyBypassesApplyAndCancel(t *testing.T) {
	svc := gateway.NewService(gateway.NewMemoryStore(), nil, gateway.Options{})
	handler := NewServer(svc, Config{
		AdminToken:                     "admin-token",
		InternalToken:                  "internal-token",
		LegacySubscriptionClientCompat: true,
	})

	planReq := httptest.NewRequest(http.MethodGet, "/api/internal/plans/plan-pro", nil)
	planRec := httptest.NewRecorder()
	handler.ServeHTTP(planRec, planReq)
	if planRec.Code != http.StatusUnauthorized {
		t.Fatalf("no-auth plan lookup status=%d body=%s", planRec.Code, planRec.Body.String())
	}

	applyReq := httptest.NewRequest(http.MethodPost, "/api/internal/subscriptions/apply", bytes.NewBufferString(`{}`))
	applyReq.Header.Set("Content-Type", "application/json")
	applyRec := httptest.NewRecorder()
	handler.ServeHTTP(applyRec, applyReq)
	if applyRec.Code == http.StatusUnauthorized {
		t.Fatalf("legacy apply should bypass auth and fail at request validation, body=%s", applyRec.Body.String())
	}

	cancelReq := httptest.NewRequest(http.MethodPost, "/api/internal/subscriptions/cancel", bytes.NewBufferString(`{}`))
	cancelReq.Header.Set("Content-Type", "application/json")
	cancelRec := httptest.NewRecorder()
	handler.ServeHTTP(cancelRec, cancelReq)
	if cancelRec.Code == http.StatusUnauthorized {
		t.Fatalf("legacy cancel should bypass auth and fail at request validation, body=%s", cancelRec.Body.String())
	}
}

func TestInternalSubscriptionEndpointsUseAIGatewayCompatibleShapes(t *testing.T) {
	userCreated := false
	var createdUsername string
	var createdPassword string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "POST /api/user/":
			var body struct {
				Username string `json:"username"`
				Password string `json:"password"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			userCreated = true
			createdUsername = body.Username
			createdPassword = body.Password
			writeJSONForHTTPTest(t, w, map[string]any{"success": true})
		case "POST /api/user/login":
			var body struct {
				Username string `json:"username"`
				Password string `json:"password"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			if !userCreated || body.Username != createdUsername || body.Password != createdPassword {
				writeJSONForHTTPTest(t, w, map[string]any{"success": false, "message": "用户名或密码错误"})
				return
			}
			writeJSONForHTTPTest(t, w, map[string]any{"success": true, "data": map[string]any{"id": 42, "username": body.Username, "role": 1, "status": 1, "group": "default"}})
		case "GET /api/user/search":
			writeJSONForHTTPTest(t, w, map[string]any{"success": true, "data": map[string]any{"items": []map[string]any{{
				"id":           42,
				"username":     "sgw-user-1",
				"display_name": "sgw-user-1",
				"role":         1,
				"status":       1,
				"group":        "default",
			}}}})
		case "PUT /api/user/":
			writeJSONForHTTPTest(t, w, map[string]any{"success": true})
		case "GET /api/subscription/admin/users/42/subscriptions":
			writeJSONForHTTPTest(t, w, map[string]any{"success": true, "data": []map[string]any{{
				"subscription": map[string]any{
					"id":           9,
					"user_id":      42,
					"plan_id":      7,
					"amount_total": 1000,
					"amount_used":  0,
					"start_time":   time.Now().Add(-time.Minute).Unix(),
					"end_time":     time.Now().Add(time.Hour).Unix(),
					"status":       "active",
				},
			}}})
		case "POST /api/subscription/admin/user_subscriptions/9/invalidate":
			writeJSONForHTTPTest(t, w, map[string]any{"success": true})
		case "POST /api/subscription/admin/users/42/subscriptions":
			writeJSONForHTTPTest(t, w, map[string]any{"success": true})
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer upstream.Close()

	store := gateway.NewMemoryStore()
	svc := gateway.NewService(store, nil, gateway.Options{})
	if err := svc.RegisterSet(t.Context(), gateway.RegisterSetInput{ID: "set-a", BaseURL: upstream.URL, Status: gateway.SetStatusActive}); err != nil {
		t.Fatal(err)
	}
	set, _, _ := store.GetSet(t.Context(), "set-a")
	set.Setup = true
	set.AdminUserID = 1
	set.AdminAccessToken = "set-admin-token"
	if err := store.SaveSet(t.Context(), set); err != nil {
		t.Fatal(err)
	}
	if err := store.SavePlanMapping(t.Context(), gateway.PlanMapping{
		ID:              "plan-pro",
		Name:            "Pro",
		MonthlyTokens:   1000,
		PeriodValue:     1,
		PeriodUnit:      "months",
		IsActive:        true,
		UpstreamPlanIDs: map[string]int{"set-a": 7},
	}); err != nil {
		t.Fatal(err)
	}
	handler := NewServer(svc, Config{AdminToken: "cluster-token"})

	planReq := httptest.NewRequest(http.MethodGet, "/api/internal/plans/plan-pro", nil)
	planReq.Header.Set("Authorization", "Bearer cluster-token")
	planRec := httptest.NewRecorder()
	handler.ServeHTTP(planRec, planReq)
	if planRec.Code != http.StatusOK || !bytes.Contains(planRec.Body.Bytes(), []byte(`"monthly_tokens":1000`)) {
		t.Fatalf("plan response status=%d body=%s", planRec.Code, planRec.Body.String())
	}

	applyReq := httptest.NewRequest(http.MethodPost, "/api/internal/subscriptions/apply", bytes.NewBufferString(`{"idempotency_key":"trade:deal-http-shape","user_id":"user-1","plan_id":"plan-pro"}`))
	applyReq.Header.Set("Authorization", "Bearer cluster-token")
	applyRec := httptest.NewRecorder()
	handler.ServeHTTP(applyRec, applyReq)
	if applyRec.Code != http.StatusOK || !bytes.Contains(applyRec.Body.Bytes(), []byte(`"token_balance":1000`)) {
		t.Fatalf("apply response status=%d body=%s", applyRec.Code, applyRec.Body.String())
	}
}

func TestInternalUserAssignmentDefaultsOldAndCanBeSetNew(t *testing.T) {
	store := gateway.NewMemoryStore()
	svc := gateway.NewService(store, nil, gateway.Options{})
	handler := NewServer(svc, Config{AdminToken: "cluster-token"})

	getReq := httptest.NewRequest(http.MethodGet, "/api/internal/users/user-1/assignment", nil)
	getReq.Header.Set("Authorization", "Bearer cluster-token")
	getRec := httptest.NewRecorder()
	handler.ServeHTTP(getRec, getReq)
	if getRec.Code != http.StatusOK {
		t.Fatalf("get default assignment status=%d body=%s", getRec.Code, getRec.Body.String())
	}
	var getResp struct {
		Success bool `json:"success"`
		Data    struct {
			UserID  string `json:"user_id"`
			Backend string `json:"backend"`
			SetID   string `json:"set_id"`
		} `json:"data"`
	}
	if err := json.NewDecoder(getRec.Body).Decode(&getResp); err != nil {
		t.Fatal(err)
	}
	if !getResp.Success || getResp.Data.UserID != "user-1" || getResp.Data.Backend != "pending" || getResp.Data.SetID != "" {
		t.Fatalf("unexpected default assignment: %+v", getResp)
	}

	postReq := httptest.NewRequest(http.MethodPost, "/api/internal/users/user-1/assignment", bytes.NewBufferString(`{"backend":"new","set_id":"set-a"}`))
	postReq.Header.Set("Authorization", "Bearer cluster-token")
	postRec := httptest.NewRecorder()
	handler.ServeHTTP(postRec, postReq)
	if postRec.Code != http.StatusOK {
		t.Fatalf("set assignment status=%d body=%s", postRec.Code, postRec.Body.String())
	}

	assignment, err := svc.GetUserAssignment(t.Context(), "user-1")
	if err != nil {
		t.Fatal(err)
	}
	if assignment.Backend != "new" || assignment.SetID != "set-a" {
		t.Fatalf("stored assignment = %+v, want new/set-a", assignment)
	}
}

func TestInternalGetUserCreditRejectsPendingTenant(t *testing.T) {
	store := gateway.NewMemoryStore()
	svc := gateway.NewService(store, nil, gateway.Options{})
	handler := NewServer(svc, Config{InternalToken: "internal-token"})

	req := httptest.NewRequest(http.MethodGet, "/api/internal/users/user-1/credit", nil)
	req.Header.Set("Authorization", "Bearer internal-token")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "tenant_pending") {
		t.Fatalf("credit status=%d body=%s, want tenant_pending conflict", rec.Code, rec.Body.String())
	}
}

func TestAdminGetUserStateShowsCurrentPlanFromNewAPI(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "GET /api/subscription/admin/users/42/subscriptions":
			writeJSONForHTTPTest(t, w, map[string]any{"success": true, "data": []map[string]any{{
				"subscription": map[string]any{
					"id":           9,
					"user_id":      42,
					"plan_id":      7,
					"amount_total": 1000,
					"amount_used":  125,
					"start_time":   time.Now().Add(-time.Hour).Unix(),
					"end_time":     time.Now().Add(time.Hour).Unix(),
					"status":       "active",
				},
			}}})
		default:
			t.Fatalf("unexpected upstream request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer upstream.Close()

	store := gateway.NewMemoryStore()
	svc := gateway.NewService(store, nil, gateway.Options{})
	registerHTTPMigrationSet(t, svc, store, "set-a", upstream.URL)
	if err := store.SaveUserBinding(t.Context(), gateway.UserBinding{
		ExternalUserID: "user-1",
		SetID:          "set-a",
		UpstreamUserID: 42,
		Username:       "sgw-user-1",
		Password:       "user-pass-123",
		LastPlanID:     "plan-pro",
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SavePlanMapping(t.Context(), gateway.PlanMapping{
		ID:              "plan-pro",
		Name:            "Pro",
		MonthlyTokens:   1000,
		PeriodValue:     1,
		PeriodUnit:      "months",
		IsActive:        true,
		UpstreamPlanIDs: map[string]int{"set-a": 7},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.SetUserAssignment(t.Context(), gateway.UserAssignment{
		ExternalUserID: "user-1",
		Backend:        gateway.UserBackendNew,
		SetID:          "set-a",
	}); err != nil {
		t.Fatal(err)
	}
	handler := NewServer(svc, Config{AdminToken: "cluster-token"})

	req := httptest.NewRequest(http.MethodGet, "/api/admin/users/user-1/state", nil)
	req.Header.Set("Authorization", "Bearer cluster-token")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("state status=%d body=%s", rec.Code, rec.Body.String())
	}
	var resp struct {
		Success bool `json:"success"`
		Data    struct {
			UserID                string `json:"user_id"`
			Backend               string `json:"backend"`
			SetID                 string `json:"set_id"`
			CurrentPlanID         string `json:"current_plan_id"`
			LastAppliedPlanID     string `json:"last_applied_plan_id"`
			HasActiveSubscription bool   `json:"has_active_subscription"`
			CreditAvailable       int64  `json:"credit_available"`
			SubscriptionStatus    string `json:"subscription_status"`
			Source                string `json:"source"`
		} `json:"data"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatal(err)
	}
	if !resp.Success || resp.Data.UserID != "user-1" || resp.Data.Backend != "new" || resp.Data.SetID != "set-a" {
		t.Fatalf("unexpected state identity: %+v", resp)
	}
	if resp.Data.CurrentPlanID != "plan-pro" || resp.Data.LastAppliedPlanID != "plan-pro" || !resp.Data.HasActiveSubscription {
		t.Fatalf("unexpected plan state: %+v", resp.Data)
	}
	if resp.Data.CreditAvailable != 875 || resp.Data.SubscriptionStatus != "active" || resp.Data.Source != "new-api" {
		t.Fatalf("unexpected credit state: %+v", resp.Data)
	}
}

func TestAdminListTenantsReturnsKnownLLMTenants(t *testing.T) {
	store := gateway.NewMemoryStore()
	svc := gateway.NewService(store, nil, gateway.Options{})
	handler := NewServer(svc, Config{AdminToken: "cluster-token"})
	if err := store.SaveUserBinding(t.Context(), gateway.UserBinding{
		ExternalUserID: "tenant-new",
		SetID:          "set-a",
		UpstreamUserID: 42,
		Username:       "sgw-tenant-new",
		LastPlanID:     "plan-pro",
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.SetUserAssignment(t.Context(), gateway.UserAssignment{
		ExternalUserID: "tenant-new",
		Backend:        gateway.UserBackendNew,
		SetID:          "set-a",
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveAPIKeyBinding(t.Context(), gateway.APIKeyBinding{
		ExternalKey:   "sk-tenant-new",
		ExternalKeyID: "key-tenant-new",
		SetID:         "set-a",
		UserID:        "tenant-new",
		UpstreamKey:   "sk-upstream",
	}); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/admin/tenants?keyword=tenant&include_total=true", nil)
	req.Header.Set("Authorization", "Bearer cluster-token")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("list tenants status=%d body=%s", rec.Code, rec.Body.String())
	}
	var parsed struct {
		Success bool `json:"success"`
		Data    struct {
			Total int `json:"total"`
			Items []struct {
				UserID           string `json:"user_id"`
				Backend          string `json:"backend"`
				SetID            string `json:"set_id"`
				LastPlanID       string `json:"last_plan_id"`
				KeyCount         int    `json:"key_count"`
				AssignmentStatus string `json:"assignment_status"`
			} `json:"items"`
		} `json:"data"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&parsed); err != nil {
		t.Fatal(err)
	}
	if !parsed.Success || parsed.Data.Total != 1 || len(parsed.Data.Items) != 1 {
		t.Fatalf("unexpected tenant envelope: %+v", parsed)
	}
	got := parsed.Data.Items[0]
	if got.UserID != "tenant-new" || got.Backend != "new" || got.SetID != "set-a" || got.LastPlanID != "plan-pro" || got.KeyCount != 1 || got.AssignmentStatus != "explicit" {
		t.Fatalf("unexpected tenant row: %+v", got)
	}
}

func TestLegacyChannelAdminEndpointsAreNotExposed(t *testing.T) {
	svc := gateway.NewService(gateway.NewMemoryStore(), nil, gateway.Options{})
	handler := NewServer(svc, Config{AdminToken: "cluster-token"})

	for _, item := range []struct {
		method string
		path   string
		body   string
	}{
		{method: http.MethodGet, path: "/api/channels"},
		{method: http.MethodPost, path: "/api/channels", body: `{"id":"minimax"}`},
		{method: http.MethodPost, path: "/api/channels/minimax/sync", body: `{}`},
		{method: http.MethodPost, path: "/api/channels/fetch-models", body: `{}`},
	} {
		req := httptest.NewRequest(item.method, item.path, strings.NewReader(item.body))
		req.Header.Set("Authorization", "Bearer cluster-token")
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusNotFound {
			t.Fatalf("%s %s status=%d body=%s, want 404", item.method, item.path, rec.Code, rec.Body.String())
		}
	}
}

func TestAdminChannelBundlesPlanAndApply(t *testing.T) {
	var remoteCreated bool
	var optionUpdated bool
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "GET /api/channel/search":
			items := []map[string]any{}
			if remoteCreated {
				items = append(items, map[string]any{
					"id":       21,
					"name":     "llmgw:minimax:MiniMax",
					"type":     1,
					"status":   1,
					"models":   "minimax-m2.7",
					"group":    "default",
					"base_url": "https://tokenhub.tencentmaas.com",
				})
			}
			writeJSONForHTTPTest(t, w, map[string]any{"success": true, "data": map[string]any{"items": items, "total": len(items)}})
		case "PUT /api/option/":
			var req struct {
				Key   string `json:"key"`
				Value any    `json:"value"`
			}
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				t.Fatal(err)
			}
			if req.Key != "ModelRatio" || req.Value != `{"minimax-m2.7":1}` {
				t.Fatalf("unexpected option update: %+v", req)
			}
			optionUpdated = true
			writeJSONForHTTPTest(t, w, map[string]any{"success": true})
		case "POST /api/channel/":
			remoteCreated = true
			writeJSONForHTTPTest(t, w, map[string]any{"success": true})
		case "PUT /api/channel/":
			writeJSONForHTTPTest(t, w, map[string]any{"success": true})
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer upstream.Close()

	store := gateway.NewMemoryStore()
	svc := gateway.NewService(store, upstream.Client().Transport, gateway.Options{})
	if err := store.SaveSet(t.Context(), gateway.Set{
		ID:               "set-a",
		BaseURL:          upstream.URL,
		Status:           gateway.SetStatusActive,
		Setup:            true,
		AdminUserID:      1,
		AdminAccessToken: "set-admin-token",
	}); err != nil {
		t.Fatal(err)
	}
	handler := NewServer(svc, Config{AdminToken: "cluster-token"})

	createReq := httptest.NewRequest(http.MethodPost, "/api/channel-bundles", bytes.NewBufferString(`{
		"id":"golden",
		"name":"Golden channels",
		"spec":{
			"options":[{"key":"ModelRatio","value":"{\"minimax-m2.7\":1}"}],
			"channels":[{
				"id":"minimax",
				"name":"MiniMax",
				"type":1,
				"key":"sk-provider",
				"base_url":"https://tokenhub.tencentmaas.com",
				"models":"minimax-m2.7",
				"group":"default",
				"status":"enabled"
			}]
		}
	}`))
	createReq.Header.Set("Authorization", "Bearer cluster-token")
	createRec := httptest.NewRecorder()
	handler.ServeHTTP(createRec, createReq)
	if createRec.Code != http.StatusOK {
		t.Fatalf("create bundle status=%d body=%s", createRec.Code, createRec.Body.String())
	}
	if strings.Contains(createRec.Body.String(), "sk-provider") {
		t.Fatalf("create bundle response leaked provider key: %s", createRec.Body.String())
	}

	planReq := httptest.NewRequest(http.MethodPost, "/api/channel-bundles/golden/plan", bytes.NewBufferString(`{"set_id":"set-a"}`))
	planReq.Header.Set("Authorization", "Bearer cluster-token")
	planRec := httptest.NewRecorder()
	handler.ServeHTTP(planRec, planReq)
	if planRec.Code != http.StatusOK {
		t.Fatalf("plan bundle status=%d body=%s", planRec.Code, planRec.Body.String())
	}
	if !strings.Contains(planRec.Body.String(), `"kind":"create_channel"`) {
		t.Fatalf("plan response did not include create_channel: %s", planRec.Body.String())
	}

	applyReq := httptest.NewRequest(http.MethodPost, "/api/channel-bundles/golden/apply", bytes.NewBufferString(`{"set_id":"set-a"}`))
	applyReq.Header.Set("Authorization", "Bearer cluster-token")
	applyRec := httptest.NewRecorder()
	handler.ServeHTTP(applyRec, applyReq)
	if applyRec.Code != http.StatusOK {
		t.Fatalf("apply bundle status=%d body=%s", applyRec.Code, applyRec.Body.String())
	}
	if !strings.Contains(applyRec.Body.String(), `"status":"synced"`) {
		t.Fatalf("apply response did not sync: %s", applyRec.Body.String())
	}
	if !optionUpdated {
		t.Fatal("bundle option was not applied to the managed set")
	}
}

func TestAdminChannelBundlesImportFromManagedSet(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "GET /api/channel/search":
			writeJSONForHTTPTest(t, w, map[string]any{
				"success": true,
				"data": map[string]any{
					"items": []map[string]any{{
						"id":       17,
						"name":     "MiniMax",
						"type":     1,
						"status":   1,
						"models":   "minimax-m2.7",
						"group":    "default",
						"base_url": "https://tokenhub.tencentmaas.com",
					}},
					"total": 1,
				},
			})
		case "GET /api/option/":
			writeJSONForHTTPTest(t, w, map[string]any{
				"success": true,
				"data": []map[string]any{
					{"key": "ModelRatio", "value": `{"minimax-m2.7":1}`},
					{"key": "CompletionRatio", "value": `{"minimax-m2.7":1}`},
				},
			})
		case "POST /api/verify":
			writeJSONForHTTPTest(t, w, map[string]any{"success": true})
		case "POST /api/channel/17/key":
			writeJSONForHTTPTest(t, w, map[string]any{"success": true, "data": map[string]any{"key": "sk-provider"}})
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer upstream.Close()

	store := gateway.NewMemoryStore()
	svc := gateway.NewService(store, upstream.Client().Transport, gateway.Options{})
	if err := store.SaveSet(t.Context(), gateway.Set{
		ID:               "set-a",
		BaseURL:          upstream.URL,
		Status:           gateway.SetStatusActive,
		Setup:            true,
		AdminUserID:      1,
		AdminAccessToken: "set-admin-token",
		AdminTOTPSecret:  "JBSWY3DPEHPK3PXP",
	}); err != nil {
		t.Fatal(err)
	}
	handler := NewServer(svc, Config{AdminToken: "cluster-token"})

	req := httptest.NewRequest(http.MethodPost, "/api/channel-bundles/import", bytes.NewBufferString(`{
		"source_set_id":"set-a",
		"id":"golden",
		"name":"Golden channels"
	}`))
	req.Header.Set("Authorization", "Bearer cluster-token")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("import bundle status=%d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"source_set_id":"set-a"`) || !strings.Contains(rec.Body.String(), `"id":"minimax"`) {
		t.Fatalf("unexpected import response: %s", rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "sk-provider") {
		t.Fatalf("import response leaked provider key: %s", rec.Body.String())
	}

	exportReq := httptest.NewRequest(http.MethodPost, "/api/desired-config/export", bytes.NewBufferString(`{
		"source_set_id":"set-a",
		"id":"golden",
		"name":"Golden channels"
	}`))
	exportReq.Header.Set("Authorization", "Bearer cluster-token")
	exportRec := httptest.NewRecorder()
	handler.ServeHTTP(exportRec, exportReq)
	if exportRec.Code != http.StatusOK {
		t.Fatalf("export desired config status=%d body=%s", exportRec.Code, exportRec.Body.String())
	}
	if exportRec.Header().Get("Cache-Control") != "no-store" || !strings.Contains(exportRec.Header().Get("Content-Disposition"), ".json") {
		t.Fatalf("export headers do not protect the plaintext backup: %v", exportRec.Header())
	}
	if !strings.Contains(exportRec.Body.String(), `"key":"sk-provider"`) || !strings.Contains(exportRec.Body.String(), `"global_options"`) {
		t.Fatalf("export is not a complete plaintext backup: %s", exportRec.Body.String())
	}

	importReq := httptest.NewRequest(http.MethodPost, "/api/desired-config/import", strings.NewReader(exportRec.Body.String()))
	importReq.Header.Set("Authorization", "Bearer cluster-token")
	importRec := httptest.NewRecorder()
	handler.ServeHTTP(importRec, importReq)
	if importRec.Code != http.StatusOK {
		t.Fatalf("import desired config status=%d body=%s", importRec.Code, importRec.Body.String())
	}
	if strings.Contains(importRec.Body.String(), "sk-provider") {
		t.Fatalf("normal import response leaked provider key: %s", importRec.Body.String())
	}
}

func TestSafeDownloadNameFallsBackForPunctuation(t *testing.T) {
	if got := safeDownloadName("!!!"); got != "backup" {
		t.Fatalf("safeDownloadName punctuation = %q, want backup", got)
	}
}

func TestInternalMigrationDryRunEndpointDoesNotWriteAssignment(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatalf("dry-run should not call new-api, got %s %s", r.Method, r.URL.Path)
	}))
	defer upstream.Close()

	store := gateway.NewMemoryStore()
	svc := gateway.NewService(store, nil, gateway.Options{})
	registerHTTPMigrationSet(t, svc, store, "set-a", upstream.URL)
	registerHTTPMigrationPlan(t, store, "plan-pro", map[string]int{"set-a": 7})
	handler := NewServer(svc, Config{InternalToken: "internal-token"})

	req := httptest.NewRequest(http.MethodPost, "/api/internal/migrations/users/user-1/dry-run", bytes.NewBufferString(`{"set_id":"set-a","plan_id":"plan-pro"}`))
	req.Header.Set("Authorization", "Bearer internal-token")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("dry-run migration status=%d body=%s", rec.Code, rec.Body.String())
	}
	var resp struct {
		Success bool `json:"success"`
		Data    struct {
			UserID         string `json:"user_id"`
			SetID          string `json:"set_id"`
			PlanID         string `json:"plan_id"`
			UpstreamPlanID int    `json:"upstream_plan_id"`
			DryRun         bool   `json:"dry_run"`
			Migrated       bool   `json:"migrated"`
		} `json:"data"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatal(err)
	}
	if !resp.Success || !resp.Data.DryRun || resp.Data.Migrated || resp.Data.UserID != "user-1" || resp.Data.SetID != "set-a" || resp.Data.PlanID != "plan-pro" || resp.Data.UpstreamPlanID != 7 {
		t.Fatalf("unexpected dry-run response: %+v", resp)
	}
	assignment, err := svc.GetUserAssignment(t.Context(), "user-1")
	if err != nil {
		t.Fatal(err)
	}
	if assignment.Backend != gateway.UserBackendPending {
		t.Fatalf("dry-run changed assignment: %+v", assignment)
	}
}

func TestInternalMigrationCommitEndpointActivatesUser(t *testing.T) {
	userCreated := false
	var createdUsername string
	var createdPassword string
	var createdPlanID int
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "GET /api/user/search":
			items := []map[string]any{}
			if userCreated {
				items = append(items, map[string]any{"id": 42, "username": "sgw-user-1", "display_name": "sgw-user-1", "role": 1, "status": 1, "group": "default"})
			}
			writeJSONForHTTPTest(t, w, map[string]any{"success": true, "data": map[string]any{"items": items}})
		case "POST /api/user/":
			var body struct {
				Username string `json:"username"`
				Password string `json:"password"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			userCreated = true
			createdUsername = body.Username
			createdPassword = body.Password
			writeJSONForHTTPTest(t, w, map[string]any{"success": true})
		case "POST /api/user/login":
			var body struct {
				Username string `json:"username"`
				Password string `json:"password"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			if !userCreated || body.Username != createdUsername || body.Password != createdPassword {
				writeJSONForHTTPTest(t, w, map[string]any{"success": false, "message": "用户名或密码错误"})
				return
			}
			writeJSONForHTTPTest(t, w, map[string]any{"success": true, "data": map[string]any{"id": 42, "username": body.Username, "role": 1, "status": 1, "group": "default"}})
		case "GET /api/subscription/admin/users/42/subscriptions":
			writeJSONForHTTPTest(t, w, map[string]any{"success": true, "data": []map[string]any{}})
		case "POST /api/subscription/admin/users/42/subscriptions":
			var body struct {
				PlanID int `json:"plan_id"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			createdPlanID = body.PlanID
			writeJSONForHTTPTest(t, w, map[string]any{"success": true})
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer upstream.Close()

	store := gateway.NewMemoryStore()
	svc := gateway.NewService(store, nil, gateway.Options{})
	registerHTTPMigrationSet(t, svc, store, "set-b", upstream.URL)
	registerHTTPMigrationPlan(t, store, "plan-pro", map[string]int{"set-b": 11})
	handler := NewServer(svc, Config{InternalToken: "internal-token"})

	req := httptest.NewRequest(http.MethodPost, "/api/internal/migrations/users/user-1", bytes.NewBufferString(`{"set_id":"set-b","plan_id":"plan-pro"}`))
	req.Header.Set("Authorization", "Bearer internal-token")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("commit migration status=%d body=%s", rec.Code, rec.Body.String())
	}
	if createdPlanID != 11 {
		t.Fatalf("created upstream plan id = %d, want 11", createdPlanID)
	}
	assignment, err := svc.GetUserAssignment(t.Context(), "user-1")
	if err != nil {
		t.Fatal(err)
	}
	if assignment.Backend != gateway.UserBackendNew || assignment.SetID != "set-b" {
		t.Fatalf("commit did not cut assignment: %+v", assignment)
	}
}

func TestAIGatewayCompatibleAdminAPIKeyCreateAndRevoke(t *testing.T) {
	userExists := false
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "POST /api/user/":
			userExists = true
			writeJSONForHTTPTest(t, w, map[string]any{"success": true})
		case "GET /api/user/search":
			items := []map[string]any{}
			if userExists {
				items = append(items, map[string]any{
					"id":           42,
					"username":     "sgw-user-1",
					"display_name": "sgw-user-1",
					"role":         1,
					"status":       1,
					"group":        "default",
				})
			}
			writeJSONForHTTPTest(t, w, map[string]any{"success": true, "data": map[string]any{"items": items}})
		case "POST /api/user/login":
			writeJSONForHTTPTest(t, w, map[string]any{"success": true, "data": map[string]any{"id": 42, "username": "sgw-user-1", "role": 1, "status": 1, "group": "default"}})
		case "GET /api/user/token":
			writeJSONForHTTPTest(t, w, map[string]any{"success": true, "data": "user-access-token"})
		case "POST /api/token/":
			writeJSONForHTTPTest(t, w, map[string]any{"success": true})
		case "GET /api/token/search":
			writeJSONForHTTPTest(t, w, map[string]any{"success": true, "data": map[string]any{"items": []map[string]any{{"id": 7, "name": r.URL.Query().Get("keyword")}}}})
		case "POST /api/token/7/key":
			writeJSONForHTTPTest(t, w, map[string]any{"success": true, "data": map[string]any{"key": "sk-upstream"}})
		case "POST /v1/chat/completions":
			if got := r.Header.Get("Authorization"); got != "Bearer sk-upstream" {
				t.Fatalf("proxy authorization = %q", got)
			}
			writeJSONForHTTPTest(t, w, map[string]any{"ok": true})
		default:
			t.Fatalf("unexpected upstream request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer upstream.Close()

	store := gateway.NewMemoryStore()
	svc := gateway.NewService(store, nil, gateway.Options{})
	if err := svc.RegisterSet(t.Context(), gateway.RegisterSetInput{ID: "set-a", BaseURL: upstream.URL, Status: gateway.SetStatusActive}); err != nil {
		t.Fatal(err)
	}
	set, ok, err := store.GetSet(t.Context(), "set-a")
	if err != nil || !ok {
		t.Fatalf("get set: ok=%v err=%v", ok, err)
	}
	set.Setup = true
	set.AdminUserID = 1
	set.AdminAccessToken = "set-admin-token"
	if err := store.SaveSet(t.Context(), set); err != nil {
		t.Fatal(err)
	}
	handler := NewServer(svc, Config{AdminToken: "cluster-token"})

	createReq := httptest.NewRequest(http.MethodPost, "/api/admin/users/user-1/api-keys", bytes.NewBufferString(`{"name":"instance-key"}`))
	createReq.Header.Set("Authorization", "Bearer cluster-token")
	createRec := httptest.NewRecorder()
	handler.ServeHTTP(createRec, createReq)
	if createRec.Code != http.StatusOK {
		t.Fatalf("create api-key status=%d body=%s", createRec.Code, createRec.Body.String())
	}
	var createResp struct {
		Success bool `json:"success"`
		Data    struct {
			APIKey    string `json:"api_key"`
			KeyID     string `json:"key_id"`
			KeyPrefix string `json:"key_prefix"`
			Name      string `json:"name"`
			CreatedAt string `json:"created_at"`
		} `json:"data"`
	}
	if err := json.NewDecoder(createRec.Body).Decode(&createResp); err != nil {
		t.Fatal(err)
	}
	if !createResp.Success || createResp.Data.APIKey == "" || createResp.Data.KeyID == "" || createResp.Data.CreatedAt == "" {
		t.Fatalf("unexpected create api-key response: %+v", createResp)
	}
	if createResp.Data.Name != "instance-key" {
		t.Fatalf("name = %q, want instance-key", createResp.Data.Name)
	}
	if createResp.Data.KeyPrefix == "" || !strings.HasPrefix(createResp.Data.APIKey, createResp.Data.KeyPrefix) {
		t.Fatalf("key prefix %q does not match api key %q", createResp.Data.KeyPrefix, createResp.Data.APIKey)
	}
	assignment, err := svc.GetUserAssignment(t.Context(), "user-1")
	if err != nil {
		t.Fatal(err)
	}
	if assignment.Backend != "new" || assignment.SetID != "set-a" {
		t.Fatalf("create key should mark user assignment new/set-a, got %+v", assignment)
	}

	proxyReq := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	proxyReq.Header.Set("Authorization", "Bearer "+createResp.Data.APIKey)
	proxyRec := httptest.NewRecorder()
	handler.ServeHTTP(proxyRec, proxyReq)
	if proxyRec.Code != http.StatusOK {
		t.Fatalf("proxy status=%d body=%s", proxyRec.Code, proxyRec.Body.String())
	}

	revokeReq := httptest.NewRequest(http.MethodDelete, "/api/admin/api-keys/"+createResp.Data.KeyID, nil)
	revokeReq.Header.Set("Authorization", "Bearer cluster-token")
	revokeRec := httptest.NewRecorder()
	handler.ServeHTTP(revokeRec, revokeReq)
	if revokeRec.Code != http.StatusOK {
		t.Fatalf("revoke status=%d body=%s", revokeRec.Code, revokeRec.Body.String())
	}

	proxyAfterRevokeReq := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	proxyAfterRevokeReq.Header.Set("Authorization", "Bearer "+createResp.Data.APIKey)
	proxyAfterRevokeRec := httptest.NewRecorder()
	handler.ServeHTTP(proxyAfterRevokeRec, proxyAfterRevokeReq)
	if proxyAfterRevokeRec.Code != http.StatusUnauthorized {
		t.Fatalf("proxy after revoke status=%d body=%s", proxyAfterRevokeRec.Code, proxyAfterRevokeRec.Body.String())
	}
}

func TestAIGatewayCompatibleUserUsageReturnsTopLevelPayload(t *testing.T) {
	svc := gateway.NewService(gateway.NewMemoryStore(), nil, gateway.Options{})
	handler := NewServer(svc, Config{AdminToken: "cluster-token"})

	req := httptest.NewRequest(http.MethodGet, "/api/admin/users/user-1/usage?days=7", nil)
	req.Header.Set("Authorization", "Bearer cluster-token")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("usage status=%d body=%s", rec.Code, rec.Body.String())
	}
	var usage struct {
		UserID        string `json:"user_id"`
		Days          int    `json:"days"`
		TotalTokens   int64  `json:"total_tokens"`
		TotalRequests int64  `json:"total_requests"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&usage); err != nil {
		t.Fatal(err)
	}
	if usage.UserID != "user-1" || usage.Days != 7 || usage.TotalTokens != 0 || usage.TotalRequests != 0 {
		t.Fatalf("unexpected usage payload: %+v body=%s", usage, rec.Body.String())
	}
}

func newHTTPBootstrapTestServer(t *testing.T) *httptest.Server {
	t.Helper()
	initialized := false
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "GET /api/setup":
			writeJSONForHTTPTest(t, w, map[string]any{"success": true, "data": map[string]any{"status": initialized, "root_init": initialized}})
		case "POST /api/setup":
			initialized = true
			writeJSONForHTTPTest(t, w, map[string]any{"success": true})
		case "POST /api/user/login":
			http.SetCookie(w, &http.Cookie{Name: "session", Value: "root-session", Path: "/"})
			writeJSONForHTTPTest(t, w, map[string]any{"success": true, "data": map[string]any{"id": 1, "username": "set-root", "role": 100, "status": 1, "group": "default"}})
		case "POST /api/option/payment_compliance":
			writeJSONForHTTPTest(t, w, map[string]any{"success": true})
		case "PUT /api/option/":
			writeJSONForHTTPTest(t, w, map[string]any{"success": true})
		case "POST /api/user/2fa/setup":
			writeJSONForHTTPTest(t, w, map[string]any{"success": true, "data": map[string]any{"secret": "JBSWY3DPEHPK3PXP"}})
		case "POST /api/user/2fa/enable":
			writeJSONForHTTPTest(t, w, map[string]any{"success": true})
		case "GET /api/user/token":
			writeJSONForHTTPTest(t, w, map[string]any{"success": true, "data": "set-admin-token"})
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
}

func saveHTTPReadySet(t *testing.T, store *gateway.MemoryStore, setID string) {
	t.Helper()
	if err := store.SaveSet(t.Context(), gateway.Set{
		ID:               setID,
		Name:             setID,
		BaseURL:          "http://" + setID,
		Status:           gateway.SetStatusActive,
		Setup:            true,
		AdminUserID:      1,
		AdminAccessToken: "set-admin-token",
	}); err != nil {
		t.Fatal(err)
	}
}

func writeJSONForHTTPTest(t *testing.T, w http.ResponseWriter, v any) {
	t.Helper()
	if err := json.NewEncoder(w).Encode(v); err != nil {
		t.Fatal(err)
	}
}

func registerHTTPMigrationSet(t *testing.T, svc *gateway.Service, store *gateway.MemoryStore, setID string, baseURL string) {
	t.Helper()
	if err := svc.RegisterSet(t.Context(), gateway.RegisterSetInput{ID: setID, BaseURL: baseURL, Status: gateway.SetStatusActive}); err != nil {
		t.Fatal(err)
	}
	set, ok, err := store.GetSet(t.Context(), setID)
	if err != nil || !ok {
		t.Fatalf("set not saved: ok=%v err=%v", ok, err)
	}
	set.Setup = true
	set.AdminUserID = 1
	set.AdminAccessToken = "set-admin-token"
	if err := store.SaveSet(t.Context(), set); err != nil {
		t.Fatal(err)
	}
}

func registerHTTPMigrationPlan(t *testing.T, store *gateway.MemoryStore, planID string, upstreamPlanIDs map[string]int) {
	t.Helper()
	if err := store.SavePlanMapping(t.Context(), gateway.PlanMapping{
		ID:              planID,
		Name:            planID,
		MonthlyTokens:   1000,
		PeriodValue:     1,
		PeriodUnit:      "months",
		IsActive:        true,
		UpstreamPlanIDs: upstreamPlanIDs,
	}); err != nil {
		t.Fatal(err)
	}
}
