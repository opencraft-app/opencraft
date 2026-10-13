package gateway

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCollaborationRouteUsesVerifiedHumanAndInternalBearer(t *testing.T) {
	const internalToken = "test-collaboration-internal-token"
	t.Setenv("COLLABORATION_GATEWAY_TOKEN", internalToken)
	auth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer human-session" {
			t.Fatalf("auth authorization = %q", r.Header.Get("Authorization"))
		}
		_, _ = w.Write([]byte(`{"session":{"user":{"id":"usr_0123456789abcdef","email":"human@example.test"}}}`))
	}))
	defer auth.Close()

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/me" {
			t.Fatalf("upstream path = %q", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer "+internalToken {
			t.Fatalf("upstream authorization = %q", r.Header.Get("Authorization"))
		}
		if r.Header.Get("X-Lightclaw-User-ID") != "usr_0123456789abcdef" {
			t.Fatalf("upstream user = %q", r.Header.Get("X-Lightclaw-User-ID"))
		}
		if got := r.Header.Get("Origin"); got != "" {
			t.Fatalf("upstream origin = %q", got)
		}
		if r.Header.Get("Cookie") != "" {
			t.Fatalf("upstream cookie = %q", r.Header.Get("Cookie"))
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()

	handler, err := NewHandler(Config{
		AuthServiceURL: auth.URL,
		Collaboration: &CollaborationRouteConfig{
			Upstream:               upstream.URL,
			UpstreamBearerTokenEnv: "COLLABORATION_GATEWAY_TOKEN",
			AllowedOrigins:         []string{"http://127.0.0.1:*"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "/v1/collaboration/me", nil)
	req.Header.Set("Authorization", "Bearer human-session")
	req.Header.Set("Origin", "http://127.0.0.1:10000")
	req.Header.Set("X-Lightclaw-User-ID", "forged")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "http://127.0.0.1:10000" {
		t.Fatalf("public Access-Control-Allow-Origin = %q", got)
	}
}

func TestCollaborationRouteRejectsUnpublishedSurfacesAndAllowsBrowserHeaders(t *testing.T) {
	t.Setenv("COLLABORATION_GATEWAY_TOKEN", "test-collaboration-internal-token")
	config := Config{AuthServiceURL: "http://auth.example.test", AllowedOrigins: []string{"https://unrelated.example.test"}, Collaboration: &CollaborationRouteConfig{
		Upstream:               "http://collaboration.example.test",
		UpstreamBearerTokenEnv: "COLLABORATION_GATEWAY_TOKEN",
		AllowedOrigins:         []string{"https://chat.lightvela.com", "http://localhost:*"},
	}}
	handler, err := NewHandler(config)
	if err != nil {
		t.Fatal(err)
	}

	blocked := httptest.NewRequest(http.MethodGet, "/v1/collaboration/computer/setup-codes", nil)
	blockedRec := httptest.NewRecorder()
	handler.ServeHTTP(blockedRec, blocked)
	if blockedRec.Code != http.StatusNotFound {
		t.Fatalf("blocked status = %d", blockedRec.Code)
	}

	preflight := httptest.NewRequest(http.MethodOptions, "/v1/collaboration/servers/server-1/direct-conversations", nil)
	preflight.Header.Set("Origin", "https://chat.lightvela.com")
	preflight.Header.Set("Access-Control-Request-Method", http.MethodPost)
	preflight.Header.Set("Access-Control-Request-Headers", "content-type,idempotency-key")
	preflightRec := httptest.NewRecorder()
	handler.ServeHTTP(preflightRec, preflight)
	if preflightRec.Code != http.StatusNoContent {
		t.Fatalf("preflight status = %d body=%s", preflightRec.Code, preflightRec.Body)
	}
	if got := preflightRec.Header().Get("Access-Control-Allow-Headers"); got != "Authorization, Content-Type, Idempotency-Key, X-Request-Id, X-Resource-Revision, X-Trace-Id, X-Requested-With" {
		t.Fatalf("allow headers = %q", got)
	}

	computerPreflight := httptest.NewRequest(http.MethodOptions, "/v1/collaboration/servers/server-1/computers-v2", nil)
	computerPreflight.Header.Set("Origin", "http://localhost:5173")
	computerPreflight.Header.Set("Access-Control-Request-Method", http.MethodPost)
	computerPreflight.Header.Set("Access-Control-Request-Headers", "content-type,idempotency-key")
	computerPreflightRec := httptest.NewRecorder()
	handler.ServeHTTP(computerPreflightRec, computerPreflight)
	if computerPreflightRec.Code != http.StatusNoContent {
		t.Fatalf("computer preflight status = %d body=%s", computerPreflightRec.Code, computerPreflightRec.Body)
	}

	untrustedPreflight := httptest.NewRequest(http.MethodOptions, "/v1/collaboration/me", nil)
	untrustedPreflight.Header.Set("Origin", "https://evil.example")
	untrustedPreflight.Header.Set("Access-Control-Request-Method", http.MethodGet)
	untrustedPreflightRec := httptest.NewRecorder()
	handler.ServeHTTP(untrustedPreflightRec, untrustedPreflight)
	if got := untrustedPreflightRec.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("untrusted Access-Control-Allow-Origin = %q", got)
	}
}

func TestCollaborationRouteRequiresConfiguredInternalTokenAtStartup(t *testing.T) {
	t.Setenv("COLLABORATION_GATEWAY_TOKEN", "")
	_, err := NewHandler(Config{
		AuthServiceURL: "http://auth.example.test",
		Collaboration: &CollaborationRouteConfig{
			Upstream:               "http://collaboration.example.test",
			UpstreamBearerTokenEnv: "COLLABORATION_GATEWAY_TOKEN",
		},
	})
	if err == nil {
		t.Fatal("NewHandler() error = nil")
	}
}

func TestCollaborationRoutePublishesMemberInvitesAndOperationStatus(t *testing.T) {
	t.Setenv("COLLABORATION_GATEWAY_TOKEN", "test-collaboration-internal-token")
	auth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"session":{"user":{"id":"usr_0123456789abcdef","email":"human@example.test"}}}`))
	}))
	defer auth.Close()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Lightclaw-User-ID") != "usr_0123456789abcdef" {
			t.Errorf("upstream user = %q", r.Header.Get("X-Lightclaw-User-ID"))
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()
	handler, err := NewHandler(Config{
		AuthServiceURL: auth.URL,
		Collaboration: &CollaborationRouteConfig{
			Upstream:               upstream.URL,
			UpstreamBearerTokenEnv: "COLLABORATION_GATEWAY_TOKEN",
			AllowedOrigins:         []string{"http://localhost:*"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range []struct{ method, path string }{
		{http.MethodGet, "/v1/collaboration/me/profile"},
		{http.MethodPost, "/v1/collaboration/servers/server-1/invites"},
		{http.MethodPost, "/v1/collaboration/join-links/accept"},
		{http.MethodGet, "/v1/collaboration/servers/server-1/operations/operation-1"},
	} {
		t.Run(item.method+" "+item.path, func(t *testing.T) {
			req := httptest.NewRequest(item.method, item.path, nil)
			req.Header.Set("Authorization", "Bearer human-session")
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)
			if rec.Code != http.StatusNoContent {
				t.Fatalf("status = %d body=%s", rec.Code, rec.Body)
			}
		})
	}
}

func TestCollaborationBotRuntimeKeepsTheAgentCredentialAndSkipsLightVelaLogin(t *testing.T) {
	t.Setenv("COLLABORATION_GATEWAY_TOKEN", "test-collaboration-internal-token")
	auth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("bot runtime must not consult LightVela auth: %s", r.URL.Path)
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer auth.Close()
	var seen []string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r.Method+" "+r.URL.Path)
		if got := r.Header.Get("Authorization"); got != "BotCredential bot-secret" {
			t.Errorf("upstream authorization = %q, want the Agent's own credential", got)
		}
		if got := r.Header.Get("X-Lightclaw-User-ID"); got != "" {
			t.Errorf("forged identity header reached collaboration: %q", got)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()
	handler, err := NewHandler(Config{
		AuthServiceURL: auth.URL,
		Collaboration: &CollaborationRouteConfig{
			Upstream: upstream.URL, UpstreamBearerTokenEnv: "COLLABORATION_GATEWAY_TOKEN",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		method, path string
		status       int
	}{
		{http.MethodPost, "/v1/collaboration/runtime/bot/session", http.StatusNoContent},
		{http.MethodGet, "/v1/collaboration/runtime/bot/me", http.StatusNoContent},
		{http.MethodPut, "/v1/collaboration/runtime/bot/groups/g1/members/a_peer", http.StatusNoContent},
		{http.MethodDelete, "/v1/collaboration/runtime/bot/groups/g1", http.StatusNoContent},
		{http.MethodGet, "/v1/collaboration/runtime/bot/unpublished", http.StatusNotFound},
	} {
		req := httptest.NewRequest(test.method, test.path, nil)
		req.Header.Set("Authorization", "BotCredential bot-secret")
		req.Header.Set("X-Lightclaw-User-ID", "usr_forged")
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != test.status {
			t.Fatalf("%s %s status = %d body=%s", test.method, test.path, rec.Code, rec.Body)
		}
	}
	if len(seen) != 4 || seen[0] != "POST /v1/runtime/bot/session" || seen[2] != "PUT /v1/runtime/bot/groups/g1/members/a_peer" {
		t.Fatalf("upstream saw %v", seen)
	}
}

func TestCollaborationRoutePublishesVelaIMHumanEndpoints(t *testing.T) {
	const internalToken = "test-collaboration-internal-token"
	t.Setenv("COLLABORATION_GATEWAY_TOKEN", internalToken)
	auth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"session":{"user":{"id":"usr_0123456789abcdef","email":"human@example.test"}}}`))
	}))
	defer auth.Close()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+internalToken || r.Header.Get("X-Lightclaw-User-ID") != "usr_0123456789abcdef" {
			t.Errorf("%s %s reached collaboration without the verified human", r.Method, r.URL.Path)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()
	handler, err := NewHandler(Config{
		AuthServiceURL: auth.URL,
		Collaboration:  &CollaborationRouteConfig{Upstream: upstream.URL, UpstreamBearerTokenEnv: "COLLABORATION_GATEWAY_TOKEN"},
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct{ method, path string }{
		{http.MethodGet, "/v1/collaboration/me/bots"},
		{http.MethodPatch, "/v1/collaboration/me/bots/b1"},
		{http.MethodDelete, "/v1/collaboration/me/bots/b1"},
		{http.MethodPost, "/v1/collaboration/me/groups"},
		{http.MethodPatch, "/v1/collaboration/me/groups/g1"},
		{http.MethodPut, "/v1/collaboration/me/groups/g1/members/a_x"},
		{http.MethodDelete, "/v1/collaboration/me/groups/g1/members/a_x"},
		{http.MethodPost, "/v1/collaboration/me/groups/g1/invite-link"},
		{http.MethodPost, "/v1/collaboration/me/group-invites/accept"},
	} {
		req := httptest.NewRequest(test.method, test.path, nil)
		req.Header.Set("Authorization", "Bearer human-session")
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusNoContent {
			t.Fatalf("%s %s status = %d body=%s", test.method, test.path, rec.Code, rec.Body)
		}
	}
}
