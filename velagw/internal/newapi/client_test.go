package newapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestNewClientAddsDefaultTimeoutToProvidedHTTPClient(t *testing.T) {
	provided := &http.Client{Transport: http.DefaultTransport}

	client := NewClient("https://new-api.example.com", provided)

	if client.httpClient == provided {
		t.Fatal("NewClient should copy a provided client before filling defaults")
	}
	if client.httpClient.Timeout != 15*time.Second {
		t.Fatalf("timeout = %s, want 15s", client.httpClient.Timeout)
	}
	if client.httpClient.Jar == nil {
		t.Fatal("cookie jar was not initialized")
	}
	if client.httpClient.Transport != http.DefaultTransport {
		t.Fatal("transport was not preserved")
	}
}

func TestClientRefreshUserCacheReadsAndRewritesUser(t *testing.T) {
	var calls []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, r.Method+" "+r.URL.Path)
		if r.Header.Get("Authorization") != "Bearer admin-token" || r.Header.Get("New-Api-User") != "1" {
			t.Fatalf("headers=%v", r.Header)
		}
		switch r.Method + " " + r.URL.Path {
		case "GET /api/user/42":
			writeJSON(t, w, map[string]any{"success": true, "data": map[string]any{
				"id": 42, "username": "probe-user", "display_name": "Probe User",
				"role": 1, "status": 1, "group": "default", "quota": 100000000,
			}})
		case "PUT /api/user/":
			var req UpdateUserRequest
			decodeJSON(t, r, &req)
			if req.ID != 42 || req.Username != "probe-user" || req.DisplayName != "Probe User" || req.Role != 1 || req.Status != 1 || req.Group != "default" {
				t.Fatalf("unexpected refresh request: %+v", req)
			}
			writeJSON(t, w, map[string]any{"success": true})
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer server.Close()

	client := NewClient(server.URL, server.Client())
	user, err := client.RefreshUserCache(t.Context(), AdminAuth{UserID: 1, AccessToken: "admin-token"}, 42)
	if err != nil {
		t.Fatal(err)
	}
	if user.Quota != 100000000 {
		t.Fatalf("quota = %d, want 100000000", user.Quota)
	}
	if got := strings.Join(calls, ","); got != "GET /api/user/42,PUT /api/user/" {
		t.Fatalf("calls = %q", got)
	}
}

func TestClientBootstrapAndCreateUserTokenFlow(t *testing.T) {
	var calls []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, r.Method+" "+r.URL.Path)
		w.Header().Set("Content-Type", "application/json")

		switch r.Method + " " + r.URL.Path {
		case "GET /api/setup":
			writeJSON(t, w, map[string]any{"success": true, "data": map[string]any{"status": false, "root_init": false, "database_type": "mysql"}})
		case "POST /api/setup":
			var req SetupRequest
			decodeJSON(t, r, &req)
			if req.Username != "set-root" || req.Password != "Qq373866172!" || req.ConfirmPassword != "Qq373866172!" {
				t.Fatalf("unexpected setup request: %+v", req)
			}
			writeJSON(t, w, map[string]any{"success": true})
		case "POST /api/user/login":
			var req LoginRequest
			decodeJSON(t, r, &req)
			writeJSON(t, w, map[string]any{"success": true, "data": map[string]any{"id": 1, "username": req.Username, "role": 100, "status": 1, "group": "default"}})
		case "GET /api/user/token":
			if r.Header.Get("New-Api-User") != "1" {
				t.Fatalf("missing New-Api-User header")
			}
			writeJSON(t, w, map[string]any{"success": true, "data": "admin-access-token"})
		case "POST /api/user/":
			if r.Header.Get("Authorization") != "Bearer admin-access-token" || r.Header.Get("New-Api-User") != "1" {
				t.Fatalf("missing admin auth headers")
			}
			writeJSON(t, w, map[string]any{"success": true})
		case "GET /api/user/search":
			writeJSON(t, w, map[string]any{"success": true, "data": map[string]any{"items": []map[string]any{{"id": 42, "username": "u-123"}}}})
		case "POST /api/token/":
			if r.Header.Get("New-Api-User") != "42" {
				t.Fatalf("token should be created as upstream user")
			}
			writeJSON(t, w, map[string]any{"success": true})
		case "GET /api/token/search":
			writeJSON(t, w, map[string]any{"success": true, "data": map[string]any{"items": []map[string]any{{"id": 7, "name": "sgw-key-1"}}}})
		case "POST /api/token/7/key":
			writeJSON(t, w, map[string]any{"success": true, "data": map[string]any{"key": "sk-upstream"}})
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer server.Close()

	client := NewClient(server.URL, server.Client())

	setup, err := client.GetSetup(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if setup.Status {
		t.Fatalf("setup status = true, want false")
	}
	if err := client.Setup(t.Context(), SetupRequest{Username: "set-root", Password: "Qq373866172!", ConfirmPassword: "Qq373866172!"}); err != nil {
		t.Fatal(err)
	}
	adminSession, err := client.Login(t.Context(), "set-root", "Qq373866172!")
	if err != nil {
		t.Fatal(err)
	}
	adminToken, err := client.GenerateAccessToken(t.Context(), adminSession.UserID)
	if err != nil {
		t.Fatal(err)
	}
	if adminToken != "admin-access-token" {
		t.Fatalf("admin token = %q", adminToken)
	}
	if err := client.CreateUser(t.Context(), AdminAuth{UserID: adminSession.UserID, AccessToken: adminToken}, CreateUserRequest{Username: "u-123", Password: "user-pass-123", Role: 1}); err != nil {
		t.Fatal(err)
	}
	upstreamUserID, err := client.FindUserID(t.Context(), AdminAuth{UserID: adminSession.UserID, AccessToken: adminToken}, "u-123")
	if err != nil {
		t.Fatal(err)
	}
	if upstreamUserID != 42 {
		t.Fatalf("upstream user id = %d, want 42", upstreamUserID)
	}
	userSession, err := client.Login(t.Context(), "u-123", "user-pass-123")
	if err != nil {
		t.Fatal(err)
	}
	if userSession.UserID != 1 {
		t.Fatalf("login fixture user id = %d", userSession.UserID)
	}
	key, err := client.CreateUserToken(t.Context(), 42, "user-access-token", CreateTokenRequest{Name: "sgw-key-1", UnlimitedQuota: true, ExpiredTime: -1})
	if err != nil {
		t.Fatal(err)
	}
	if key.ID != 7 || key.Key != "sk-upstream" {
		t.Fatalf("unexpected upstream key: %+v", key)
	}
	if len(calls) == 0 {
		t.Fatal("expected calls")
	}
}

func TestClientGenerateAccessTokenUsesLoginBearer(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		switch r.Method + " " + r.URL.Path {
		case "POST /api/user/login":
			writeJSON(t, w, map[string]any{"success": true, "data": map[string]any{
				"access_token": "login-access-token",
				"user": map[string]any{
					"id":       42,
					"username": "managed-user",
					"role":     1,
					"status":   1,
					"group":    "default",
				},
			}})
		case "GET /api/user/token":
			if r.Header.Get("Authorization") != "Bearer login-access-token" {
				http.Error(w, `{"success":false,"message":"unauthorized"}`, http.StatusUnauthorized)
				return
			}
			if r.Header.Get("New-Api-User") != "42" {
				t.Fatalf("New-Api-User = %q, want 42", r.Header.Get("New-Api-User"))
			}
			writeJSON(t, w, map[string]any{"success": true, "data": "generated-user-token"})
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer server.Close()

	client := NewClient(server.URL, server.Client())
	session, err := client.Login(t.Context(), "managed-user", "password")
	if err != nil {
		t.Fatal(err)
	}
	token, err := client.GenerateAccessToken(t.Context(), session.UserID, session.AccessToken)
	if err != nil {
		t.Fatal(err)
	}
	if token != "generated-user-token" {
		t.Fatalf("token = %q, want generated-user-token", token)
	}
}

func TestClientConfirmPaymentComplianceUsesDashboardSession(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "POST /api/user/login":
			http.SetCookie(w, &http.Cookie{Name: "session", Value: "root-session", Path: "/"})
			writeJSON(t, w, map[string]any{"success": true, "data": map[string]any{"id": 1, "username": "set-root", "role": 100, "status": 1, "group": "default"}})
		case "POST /api/option/payment_compliance":
			if r.Header.Get("Authorization") != "" || r.Header.Get("New-Api-User") != "1" {
				t.Fatalf("compliance confirmation must use dashboard session, got Authorization=%q New-Api-User=%q", r.Header.Get("Authorization"), r.Header.Get("New-Api-User"))
			}
			cookie, err := r.Cookie("session")
			if err != nil || cookie.Value != "root-session" {
				t.Fatalf("missing root session cookie: cookie=%v err=%v", cookie, err)
			}
			var req PaymentComplianceRequest
			decodeJSON(t, r, &req)
			if !req.Confirmed {
				t.Fatalf("confirmed = false, want true")
			}
			writeJSON(t, w, map[string]any{"success": true, "data": map[string]any{"confirmed": true, "terms_version": "v1"}})
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer server.Close()

	client := NewClient(server.URL, server.Client())
	if _, err := client.Login(t.Context(), "set-root", "Qq373866172!"); err != nil {
		t.Fatal(err)
	}
	if err := client.ConfirmPaymentCompliance(t.Context(), 1); err != nil {
		t.Fatal(err)
	}
}

func TestClientUpdateOptionSerializesStructuredValueAsJSONString(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut || r.URL.Path != "/api/option/" {
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		var req UpdateOptionRequest
		decodeJSON(t, r, &req)
		if req.Key != "AutoGroups" {
			t.Fatalf("key = %q, want AutoGroups", req.Key)
		}
		value, ok := req.Value.(string)
		if !ok {
			t.Fatalf("value type = %T, want JSON string", req.Value)
		}
		if value != `["default"]` {
			t.Fatalf("value = %q, want valid JSON array string", value)
		}
		writeJSON(t, w, map[string]any{"success": true})
	}))
	defer server.Close()

	client := NewClient(server.URL, server.Client())
	if err := client.UpdateOptionWithAuth(t.Context(), AdminAuth{UserID: 1, AccessToken: "admin-token"}, "AutoGroups", []string{"default"}); err != nil {
		t.Fatal(err)
	}
}

func TestClientResolveUserByLoginReturnsUserID(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method != http.MethodPost || r.URL.Path != "/api/user/login" {
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		var req LoginRequest
		decodeJSON(t, r, &req)
		if req.Username != "u-123" || req.Password != "user-pass-123" {
			t.Fatalf("unexpected login request: %+v", req)
		}
		writeJSON(t, w, map[string]any{"success": true, "data": map[string]any{
			"id":       42,
			"username": req.Username,
			"role":     1,
			"status":   1,
			"group":    "default",
		}})
	}))
	defer server.Close()

	client := NewClient(server.URL, server.Client())
	user, err := client.ResolveUserByLogin(t.Context(), "u-123", "user-pass-123")
	if err != nil {
		t.Fatal(err)
	}
	if user.ID != 42 || user.Username != "u-123" || user.Group != "default" {
		t.Fatalf("unexpected user: %+v", user)
	}
}

func TestClientResolveUserByLoginDoesNotPolluteAdminSession(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "POST /api/user/login":
			http.SetCookie(w, &http.Cookie{Name: "session", Value: "normal-user-session", Path: "/"})
			writeJSON(t, w, map[string]any{"success": true, "data": map[string]any{
				"id":       42,
				"username": "u-123",
				"role":     1,
				"status":   1,
				"group":    "default",
			}})
		case "GET /api/subscription/admin/users/42/subscriptions":
			if cookie := r.Header.Get("Cookie"); strings.Contains(cookie, "normal-user-session") {
				writeJSON(t, w, map[string]any{"success": false, "message": "无权进行此操作，access token 无效"})
				return
			}
			if r.Header.Get("Authorization") != "Bearer admin-access-token" || r.Header.Get("New-Api-User") != "1" {
				t.Fatalf("missing admin auth headers: Authorization=%q New-Api-User=%q", r.Header.Get("Authorization"), r.Header.Get("New-Api-User"))
			}
			writeJSON(t, w, map[string]any{"success": true, "data": []map[string]any{}})
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer server.Close()

	client := NewClient(server.URL, server.Client())
	if _, err := client.ResolveUserByLogin(t.Context(), "u-123", "user-pass-123"); err != nil {
		t.Fatal(err)
	}
	if _, err := client.AdminListUserSubscriptions(t.Context(), AdminAuth{UserID: 1, AccessToken: "admin-access-token"}, 42); err != nil {
		t.Fatal(err)
	}
}

func TestClientCreateUserRetriesInviteCodeCollision(t *testing.T) {
	attempts := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/user/" {
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		attempts++
		if attempts == 1 {
			writeJSON(t, w, map[string]any{
				"success": false,
				"message": "Error 1062 (23000): Duplicate entry 'WdPW' for key 'users.idx_users_aff_code'",
			})
			return
		}
		writeJSON(t, w, map[string]any{"success": true})
	}))
	defer server.Close()

	client := NewClient(server.URL, server.Client())
	err := client.CreateUser(t.Context(), AdminAuth{UserID: 1, AccessToken: "admin-access-token"}, CreateUserRequest{Username: "u-123", Password: "pass", Role: 1})
	if err != nil {
		t.Fatal(err)
	}
	if attempts != 2 {
		t.Fatalf("create user attempts=%d, want retry once after aff_code collision", attempts)
	}
}

func TestClientCreateUserDoesNotRetryUsernameDuplicate(t *testing.T) {
	attempts := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/user/" {
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		attempts++
		writeJSON(t, w, map[string]any{
			"success": false,
			"message": "Error 1062 (23000): Duplicate entry 'sgw-user-demo' for key 'users.username'",
		})
	}))
	defer server.Close()

	client := NewClient(server.URL, server.Client())
	err := client.CreateUser(t.Context(), AdminAuth{UserID: 1, AccessToken: "admin-access-token"}, CreateUserRequest{Username: "u-123", Password: "pass", Role: 1})
	if err == nil || !strings.Contains(err.Error(), "users.username") {
		t.Fatalf("error=%v, want username duplicate", err)
	}
	if attempts != 1 {
		t.Fatalf("create user attempts=%d, want no retry for username duplicate", attempts)
	}
}

func TestClientCreateUserStopsAfterInviteCodeCollisionRetries(t *testing.T) {
	attempts := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/user/" {
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		attempts++
		writeJSON(t, w, map[string]any{
			"success": false,
			"message": "Error 1062 (23000): Duplicate entry 'WdPW' for key 'users.idx_users_aff_code'",
		})
	}))
	defer server.Close()

	client := NewClient(server.URL, server.Client())
	err := client.CreateUser(t.Context(), AdminAuth{UserID: 1, AccessToken: "admin-access-token"}, CreateUserRequest{Username: "u-123", Password: "pass", Role: 1})
	if err == nil || !strings.Contains(err.Error(), "idx_users_aff_code") {
		t.Fatalf("error=%v, want aff_code duplicate", err)
	}
	if attempts != inviteCodeCollisionRetries+1 {
		t.Fatalf("create user attempts=%d, want initial attempt plus %d retries", attempts, inviteCodeCollisionRetries)
	}
}

func TestClientCreateUserTokenRetriesTransientMySQLDeadlock(t *testing.T) {
	createCalls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "POST /api/token/":
			createCalls++
			if createCalls == 1 {
				writeJSON(t, w, map[string]any{"success": false, "message": "Error 1213 (40001): Deadlock found when trying to get lock; try restarting transaction"})
				return
			}
			writeJSON(t, w, map[string]any{"success": true})
		case "GET /api/token/search":
			if !strings.Contains(r.URL.RawQuery, "sgw-key-retry") {
				t.Fatalf("unexpected token search query: %s", r.URL.RawQuery)
			}
			writeJSON(t, w, map[string]any{"success": true, "data": map[string]any{"items": []map[string]any{{"id": 7, "name": "sgw-key-retry"}}}})
		case "POST /api/token/7/key":
			writeJSON(t, w, map[string]any{"success": true, "data": map[string]any{"key": "sk-upstream"}})
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer server.Close()

	client := NewClient(server.URL, server.Client())
	key, err := client.CreateUserToken(t.Context(), 42, "user-access-token", CreateTokenRequest{Name: "sgw-key-retry", UnlimitedQuota: true, ExpiredTime: -1})
	if err != nil {
		t.Fatal(err)
	}
	if createCalls != 2 {
		t.Fatalf("create calls = %d, want 2", createCalls)
	}
	if key.ID != 7 || key.Key != "sk-upstream" {
		t.Fatalf("unexpected upstream key: %+v", key)
	}
}

func TestClientAdminUserSubscriptionFlow(t *testing.T) {
	var createdPlanID int
	var createdName string
	var createdRequestID string
	var invalidatedID int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Header.Get("Authorization") != "Bearer admin-access-token" || r.Header.Get("New-Api-User") != "1" {
			t.Fatalf("missing admin auth headers for %s %s", r.Method, r.URL.Path)
		}

		switch r.Method + " " + r.URL.Path {
		case "POST /api/subscription/admin/users/42/subscriptions":
			var req AdminCreateUserSubscriptionRequest
			decodeJSON(t, r, &req)
			createdPlanID = req.PlanID
			createdName = req.Name
			createdRequestID = req.RequestID
			writeJSON(t, w, map[string]any{
				"success": true,
				"data": map[string]any{
					"id":         9,
					"name":       req.Name,
					"request_id": req.RequestID,
					"user_id":    42,
					"plan_id":    req.PlanID,
					"status":     "active",
				},
			})
		case "GET /api/subscription/admin/users/42/subscriptions":
			writeJSON(t, w, map[string]any{
				"success": true,
				"data": []map[string]any{{
					"subscription": map[string]any{
						"id":           9,
						"name":         "package:user-1:pass-1",
						"user_id":      42,
						"plan_id":      7,
						"amount_total": 1000,
						"amount_used":  125,
						"start_time":   1700000000,
						"end_time":     1800000000,
						"status":       "active",
						"source":       "admin",
					},
				}},
			})
		case "POST /api/subscription/admin/user_subscriptions/9/invalidate":
			invalidatedID = 9
			writeJSON(t, w, map[string]any{"success": true})
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer server.Close()

	client := NewClient(server.URL, server.Client())
	auth := AdminAuth{UserID: 1, AccessToken: "admin-access-token"}
	created, err := client.AdminCreateUserSubscription(t.Context(), auth, 42, AdminCreateUserSubscriptionRequest{
		PlanID:    7,
		Name:      "package:user-1:pass-1",
		RequestID: "trade:deal-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if createdPlanID != 7 {
		t.Fatalf("created plan id = %d, want 7", createdPlanID)
	}
	if createdName != "package:user-1:pass-1" {
		t.Fatalf("created subscription name = %q", createdName)
	}
	if createdRequestID != "trade:deal-1" {
		t.Fatalf("created subscription request id = %q", createdRequestID)
	}
	if created.ID != 9 || created.Name != "package:user-1:pass-1" || created.RequestID != "trade:deal-1" {
		t.Fatalf("unexpected created subscription: %+v", created)
	}

	subs, err := client.AdminListUserSubscriptions(t.Context(), auth, 42)
	if err != nil {
		t.Fatal(err)
	}
	if len(subs) != 1 || subs[0].ID != 9 || subs[0].Name != "package:user-1:pass-1" || subs[0].AmountTotal != 1000 || subs[0].AmountUsed != 125 {
		t.Fatalf("unexpected subscriptions: %+v", subs)
	}

	if err := client.AdminInvalidateUserSubscription(t.Context(), auth, 9); err != nil {
		t.Fatal(err)
	}
	if invalidatedID != 9 {
		t.Fatalf("invalidated id = %d, want 9", invalidatedID)
	}
}

func TestClientAdminListUserSubscriptionsSkipsEmptySummaryItems(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "GET /api/subscription/admin/users/42/subscriptions":
			writeJSON(t, w, map[string]any{
				"success": true,
				"data": []map[string]any{
					{},
					{"subscription": map[string]any{
						"id":           9,
						"user_id":      42,
						"plan_id":      7,
						"amount_total": 1000,
						"amount_used":  0,
						"start_time":   1700000000,
						"end_time":     1800000000,
						"status":       "active",
					}},
				},
			})
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer server.Close()

	client := NewClient(server.URL, server.Client())
	subs, err := client.AdminListUserSubscriptions(t.Context(), AdminAuth{UserID: 1, AccessToken: "admin-access-token"}, 42)
	if err != nil {
		t.Fatal(err)
	}
	if len(subs) != 1 || subs[0].ID != 9 {
		t.Fatalf("unexpected subscriptions: %+v", subs)
	}
}

func TestClientAdminCreateUserSubscriptionRejectsInvalidIDsBeforeRequest(t *testing.T) {
	var called bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
	}))
	defer server.Close()

	client := NewClient(server.URL, server.Client())
	if _, err := client.AdminCreateUserSubscription(t.Context(), AdminAuth{UserID: 1, AccessToken: "admin-access-token"}, 0, AdminCreateUserSubscriptionRequest{PlanID: 7}); err == nil {
		t.Fatal("expected invalid user id to fail")
	}
	if _, err := client.AdminCreateUserSubscription(t.Context(), AdminAuth{UserID: 1, AccessToken: "admin-access-token"}, 42, AdminCreateUserSubscriptionRequest{PlanID: 0}); err == nil {
		t.Fatal("expected invalid plan id to fail")
	}
	if called {
		t.Fatal("client made HTTP request despite invalid ids")
	}
}

func TestClientChannelLifecycleFlow(t *testing.T) {
	var createdName string
	var updatedKey string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Header.Get("Authorization") != "Bearer admin-access-token" || r.Header.Get("New-Api-User") != "1" {
			t.Fatalf("missing admin auth headers for %s %s", r.Method, r.URL.Path)
		}

		switch r.Method + " " + r.URL.Path {
		case "GET /api/channel/search":
			if !strings.Contains(r.URL.RawQuery, "keyword=llmgw%3Aminimax%3AMiniMax") {
				t.Fatalf("unexpected search query: %s", r.URL.RawQuery)
			}
			writeJSON(t, w, map[string]any{
				"success": true,
				"data": map[string]any{
					"items": []map[string]any{{
						"id":       17,
						"name":     "llmgw:minimax:MiniMax",
						"type":     1,
						"status":   1,
						"models":   "minimax-m2.7",
						"group":    "default",
						"base_url": "https://tokenhub.tencentmaas.com",
					}},
					"total": 1,
				},
			})
		case "POST /api/channel/":
			var req AddChannelRequest
			decodeJSON(t, r, &req)
			if req.Mode != "single" || req.Channel == nil {
				t.Fatalf("unexpected add channel request: %+v", req)
			}
			createdName = req.Channel.Name
			writeJSON(t, w, map[string]any{"success": true})
		case "PUT /api/channel/":
			var ch Channel
			decodeJSON(t, r, &ch)
			updatedKey = ch.Key
			if ch.ID != 17 {
				t.Fatalf("update channel id = %d, want 17", ch.ID)
			}
			writeJSON(t, w, map[string]any{"success": true, "data": map[string]any{"id": 17, "name": ch.Name}})
		case "POST /api/channel/fetch_models":
			var req FetchModelsRequest
			decodeJSON(t, r, &req)
			if req.Key != "sk-provider" || req.BaseURL != "https://tokenhub.tencentmaas.com" {
				t.Fatalf("unexpected fetch models request: %+v", req)
			}
			writeJSON(t, w, map[string]any{"success": true, "data": []string{"minimax-m2.7", "gpt-4.1"}})
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer server.Close()

	client := NewClient(server.URL, server.Client())
	auth := AdminAuth{UserID: 1, AccessToken: "admin-access-token"}
	if err := client.CreateChannel(t.Context(), auth, Channel{
		Name:    "llmgw:minimax:MiniMax",
		Type:    1,
		Key:     "sk-provider",
		Models:  "minimax-m2.7",
		Group:   "default",
		BaseURL: ptr("https://tokenhub.tencentmaas.com"),
	}); err != nil {
		t.Fatal(err)
	}
	if createdName != "llmgw:minimax:MiniMax" {
		t.Fatalf("created name = %q", createdName)
	}

	channels, err := client.SearchChannels(t.Context(), auth, "llmgw:minimax:MiniMax")
	if err != nil {
		t.Fatal(err)
	}
	if len(channels) != 1 || channels[0].ID != 17 || channels[0].Key != "" {
		t.Fatalf("unexpected channels: %+v", channels)
	}

	if err := client.UpdateChannel(t.Context(), auth, Channel{ID: 17, Name: "llmgw:minimax:MiniMax", Type: 1, Key: "sk-provider-2"}); err != nil {
		t.Fatal(err)
	}
	if updatedKey != "sk-provider-2" {
		t.Fatalf("updated key = %q", updatedKey)
	}

	models, err := client.FetchModels(t.Context(), auth, FetchModelsRequest{Type: 1, BaseURL: "https://tokenhub.tencentmaas.com", Key: "sk-provider"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(models, ",") != "minimax-m2.7,gpt-4.1" {
		t.Fatalf("models = %+v", models)
	}
}

func TestClientListChannelsReadsEveryPage(t *testing.T) {
	var pages []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/api/channel/search" {
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		pages = append(pages, r.URL.Query().Get("p"))
		page := r.URL.Query().Get("p")
		items := make([]map[string]any, 0, 100)
		start := 1
		end := 100
		switch page {
		case "2":
			start, end = 101, 200
		case "3":
			start, end = 201, 205
		}
		for id := start; id <= end; id++ {
			items = append(items, map[string]any{
				"id": id, "name": "channel", "type": 1, "status": 1,
				"models": "model", "group": "default",
			})
		}
		writeJSON(t, w, map[string]any{
			"success": true,
			"data":    map[string]any{"items": items, "total": 205},
		})
	}))
	defer server.Close()

	client := NewClient(server.URL, server.Client())
	channels, err := client.ListChannels(t.Context(), AdminAuth{UserID: 1, AccessToken: "admin-access-token"})
	if err != nil {
		t.Fatal(err)
	}
	if len(channels) != 205 || channels[0].ID != 1 || channels[204].ID != 205 {
		t.Fatalf("unexpected paginated channels: len=%d first=%d last=%d", len(channels), channels[0].ID, channels[len(channels)-1].ID)
	}
	if strings.Join(pages, ",") != "1,2,3" {
		t.Fatalf("requested pages = %v, want one complete scan", pages)
	}
}

func TestClientListChannelsDeduplicatesOverlappingPages(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		page, _ := strconv.Atoi(r.URL.Query().Get("p"))
		start, end := 1, 100
		if page == 2 {
			start, end = 100, 150
		}
		items := make([]map[string]any, 0, end-start+1)
		for id := start; id <= end; id++ {
			items = append(items, map[string]any{"id": id, "name": "channel", "type": 1, "status": 1})
		}
		writeJSON(t, w, map[string]any{"success": true, "data": map[string]any{"items": items, "total": 150}})
	}))
	defer server.Close()

	client := NewClient(server.URL, server.Client())
	channels, err := client.ListChannels(t.Context(), AdminAuth{UserID: 1, AccessToken: "admin-access-token"})
	if err != nil {
		t.Fatal(err)
	}
	if len(channels) != 150 || channels[99].ID != 100 || channels[149].ID != 150 {
		t.Fatalf("overlapping pages were not deduplicated: len=%d", len(channels))
	}
}

func TestClientListChannelsRescansAndDeduplicatesChangingPages(t *testing.T) {
	scan := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		page, _ := strconv.Atoi(r.URL.Query().Get("p"))
		if page == 1 {
			scan++
		}
		total := 151
		start := (page-1)*100 + 1
		end := page * 100
		available := total
		if scan < 3 {
			available = 150
		}
		if end > available {
			end = available
		}
		items := make([]map[string]any, 0, 100)
		for id := start; id <= end; id++ {
			items = append(items, map[string]any{
				"id": id, "name": "channel", "type": 1, "status": 1,
				"models": "model", "group": "default",
			})
		}
		writeJSON(t, w, map[string]any{"success": true, "data": map[string]any{"items": items, "total": total}})
	}))
	defer server.Close()

	client := NewClient(server.URL, server.Client())
	channels, err := client.ListChannelsStable(t.Context(), AdminAuth{UserID: 1, AccessToken: "admin-access-token"})
	if err != nil {
		t.Fatal(err)
	}
	if len(channels) != 151 || channels[150].ID != 151 {
		t.Fatalf("deduplicated channels = %d last=%d, want 151", len(channels), channels[len(channels)-1].ID)
	}
	if scan != 4 {
		t.Fatalf("full scans = %d, want 4 after two incomplete scans and two matching snapshots", scan)
	}
}

func TestClientSecureChannelKeyUsesVerificationSession(t *testing.T) {
	var verified bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Header.Get("Authorization") != "Bearer admin-access-token" || r.Header.Get("New-Api-User") != "1" {
			t.Fatalf("missing admin auth headers for %s %s", r.Method, r.URL.Path)
		}
		switch r.Method + " " + r.URL.Path {
		case "POST /api/verify":
			var req VerifyRequest
			decodeJSON(t, r, &req)
			if req.Method != "2fa" || req.Code != "123456" {
				t.Fatalf("unexpected verify request: %+v", req)
			}
			http.SetCookie(w, &http.Cookie{Name: "session", Value: "verified-session", Path: "/"})
			verified = true
			writeJSON(t, w, map[string]any{"success": true, "data": map[string]any{"verified": true}})
		case "POST /api/channel/17/key":
			if !verified {
				t.Fatalf("channel key fetched before secure verification")
			}
			cookie, err := r.Cookie("session")
			if err != nil || cookie.Value != "verified-session" {
				t.Fatalf("missing verified session cookie: cookie=%v err=%v", cookie, err)
			}
			writeJSON(t, w, map[string]any{"success": true, "data": map[string]any{"key": "sk-provider"}})
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer server.Close()

	client := NewClient(server.URL, server.Client())
	key, err := client.GetChannelKey(t.Context(), AdminAuth{UserID: 1, AccessToken: "admin-access-token"}, 17, "123456")
	if err != nil {
		t.Fatal(err)
	}
	if key != "sk-provider" {
		t.Fatalf("key = %q, want sk-provider", key)
	}
}

func TestClientListsAndDeletesUserTokensAndChannels(t *testing.T) {
	var deleted []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "GET /api/token/":
			if r.Header.Get("Authorization") != "Bearer user-access-token" || r.Header.Get("New-Api-User") != "42" {
				t.Fatalf("missing user auth headers: %+v", r.Header)
			}
			writeJSON(t, w, map[string]any{
				"success": true,
				"data": map[string]any{
					"page": 1, "page_size": 100, "total": 2,
					"items": []map[string]any{{"id": 11, "name": "first"}, {"id": 12, "name": "second"}},
				},
			})
		case "DELETE /api/token/11", "DELETE /api/token/12":
			deleted = append(deleted, r.URL.Path)
			writeJSON(t, w, map[string]any{"success": true})
		case "DELETE /api/channel/31":
			if r.Header.Get("Authorization") != "Bearer admin-access-token" || r.Header.Get("New-Api-User") != "1" {
				t.Fatalf("missing admin auth headers: %+v", r.Header)
			}
			deleted = append(deleted, r.URL.Path)
			writeJSON(t, w, map[string]any{"success": true})
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer server.Close()

	client := NewClient(server.URL, server.Client())
	tokens, total, err := client.ListUserTokens(t.Context(), 42, "user-access-token", 1, 100)
	if err != nil {
		t.Fatal(err)
	}
	if total != 2 || len(tokens) != 2 || tokens[0].ID != 11 || tokens[1].ID != 12 {
		t.Fatalf("tokens=%+v total=%d", tokens, total)
	}
	for _, token := range tokens {
		if err := client.DeleteUserToken(t.Context(), 42, "user-access-token", token.ID); err != nil {
			t.Fatal(err)
		}
	}
	if err := client.DeleteChannel(t.Context(), AdminAuth{UserID: 1, AccessToken: "admin-access-token"}, 31); err != nil {
		t.Fatal(err)
	}
	if strings.Join(deleted, ",") != "/api/token/11,/api/token/12,/api/channel/31" {
		t.Fatalf("deleted = %v", deleted)
	}
}

func TestDeleteUserTokenTreatsNotFoundAsAlreadyDeleted(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete || r.URL.Path != "/api/token/99" {
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		http.Error(w, "not found", http.StatusNotFound)
	}))
	defer server.Close()

	client := NewClient(server.URL, server.Client())
	if err := client.DeleteUserToken(t.Context(), 42, "user-access-token", 99); err != nil {
		t.Fatalf("delete missing token: %v", err)
	}
}

func TestClientCreatesAndUpdatesMultiKeyChannel(t *testing.T) {
	var create AddChannelRequest
	var update UpdateChannelRequest
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "POST /api/channel/":
			decodeJSON(t, r, &create)
			writeJSON(t, w, map[string]any{"success": true})
		case "PUT /api/channel/":
			decodeJSON(t, r, &update)
			writeJSON(t, w, map[string]any{"success": true, "data": map[string]any{"id": 17}})
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer server.Close()

	client := NewClient(server.URL, server.Client())
	auth := AdminAuth{UserID: 1, AccessToken: "admin-access-token"}
	channel := Channel{
		ID: 17, Name: "llmgw:multi:Multi", Type: 1, Key: "sk-one\nsk-two",
		Status: ChannelStatusManuallyDisabled, Models: "auto", Group: "default",
		ChannelInfo: ChannelInfo{IsMultiKey: true, MultiKeyMode: "random"},
	}
	if err := client.CreateChannel(t.Context(), auth, channel); err != nil {
		t.Fatal(err)
	}
	if err := client.UpdateChannel(t.Context(), auth, channel); err != nil {
		t.Fatal(err)
	}

	if create.Mode != "multi_to_single" || create.MultiKeyMode != "random" {
		t.Fatalf("unexpected multi-key create request: %+v", create)
	}
	if update.MultiKeyMode == nil || *update.MultiKeyMode != "random" || update.KeyMode == nil || *update.KeyMode != "replace" {
		t.Fatalf("unexpected multi-key update request: %+v", update)
	}
	if update.Channel.Status != ChannelStatusManuallyDisabled || update.Channel.Key != "sk-one\nsk-two" {
		t.Fatalf("multi-key channel payload was not preserved: %+v", update.Channel)
	}
}

func ptr(value string) *string {
	return &value
}

func decodeJSON(t *testing.T, r *http.Request, out any) {
	t.Helper()
	if err := json.NewDecoder(r.Body).Decode(out); err != nil {
		t.Fatal(err)
	}
}

func writeJSON(t *testing.T, w http.ResponseWriter, v any) {
	t.Helper()
	if err := json.NewEncoder(w).Encode(v); err != nil {
		t.Fatal(err)
	}
}
