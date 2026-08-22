package httpapi

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/openclaw/openclaw/mono/backend/auth/internal/federation"
	"github.com/openclaw/openclaw/mono/backend/auth/internal/service"
)

func newFederationHTTPTestRouter(t *testing.T) (*gin.Engine, *service.Service) {
	t.Helper()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/internal/bots/bot-1/tat/session" {
			t.Fatalf("unexpected TAT path: %s", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer internal-token" || r.Header.Get("X-User-Id") == "" {
			t.Fatal("missing narrow internal identity")
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{
			"sessionId": "tat-session", "region": "ap-beijing", "instanceId": "ins-1",
			"ownerUin": "10001", "loginUin": "10002", "appId": 123, "wsUrl": "wss://tat.example/ws",
			"cols": 120, "rows": 30, "timeoutSeconds": 3600,
		}})
	}))
	t.Cleanup(upstream.Close)
	registry, err := federation.NewRegistry([]federation.Client{{
		ID: "personal-site", DisplayName: "Personal Site", CallbackPath: "/auth/lightvela/callback",
		CallbackHosts: []federation.CallbackHost{{Host: "lightvela.site", IncludeSubdomains: true}},
		HMACKeys:      map[string][]byte{"h1": bytes.Repeat([]byte{0x44}, 32)},
	}})
	if err != nil {
		t.Fatal(err)
	}
	codec, err := federation.NewCodec(federation.CodecConfig{
		Environment: "test", ActiveKeyID: "k1",
		Keys: map[string][]byte{"k1": bytes.Repeat([]byte{0x11}, 32)}, NonceKey: bytes.Repeat([]byte{0x33}, 32),
	})
	if err != nil {
		t.Fatal(err)
	}
	tatClient, err := federation.NewTATClient(federation.TATClientConfig{BaseURL: upstream.URL, InternalToken: "internal-token", Timeout: 5 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	store := service.NewMemoryStore(service.StoreOptions{Now: fixedHTTPTestNow, SeedDefaultInvites: true})
	svc := service.NewWithStore(store, service.Options{Now: fixedHTTPTestNow, SessionTTL: 30 * 24 * time.Hour})
	router := NewRouter(svc, ServerConfig{
		CookieSecure: true, CookieSameSite: http.SameSiteLaxMode, SessionTTL: 30 * 24 * time.Hour,
		Federation: &FederationConfig{
			Registry: registry, Codec: codec, Verifier: federation.NewVerifier(registry, 30*time.Second), TATClient: tatClient,
			HandoffTTL: 5 * time.Second, DelegatedSessionTTL: 8 * time.Hour, Now: fixedHTTPTestNow,
		},
	})
	return router, svc
}

func TestFederationRoutesAreDisabledByDefault(t *testing.T) {
	recorder := performJSONRequest(t, newAuthTestRouter(), http.MethodGet, "/auth/federation/context?client_id=personal-site&redirect_uri=https%3A%2F%2Fapp.lightvela.site%2Fauth%2Flightvela%2Fcallback&state=s", nil)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("disabled federation status = %d, want 404", recorder.Code)
	}
}

func TestFederationRejectsOversizedState(t *testing.T) {
	router, _ := newFederationHTTPTestRouter(t)
	callback := url.QueryEscape("https://app.lightvela.site/auth/lightvela/callback")
	state := strings.Repeat("s", 2049)
	response := performJSONRequest(t, router, http.MethodGet, "/auth/federation/context?client_id=personal-site&redirect_uri="+callback+"&state="+state, nil)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("oversized state status = %d body=%s", response.Code, response.Body.String())
	}
}

func TestFederationHandoffExchangeAndTATFlow(t *testing.T) {
	router, _ := newFederationHTTPTestRouter(t)
	callback := "https://app.lightvela.site/auth/lightvela/callback"
	contextResponse := performJSONRequest(t, router, http.MethodGet, "/auth/federation/context?client_id=personal-site&redirect_uri="+url.QueryEscape(callback)+"&state=opaque-state", nil)
	if contextResponse.Code != http.StatusOK || strings.Contains(contextResponse.Body.String(), "source_session") {
		t.Fatalf("context response = %d %s", contextResponse.Code, contextResponse.Body.String())
	}

	signUp := performJSONRequest(t, router, http.MethodPost, "/auth/password/sign-up", map[string]any{
		"name": "Alice", "email": "federation@example.com", "password": "password123", "inviteCode": "VALID2026",
	})
	sessionCookie := sessionCookieFromRecorder(t, signUp)
	ticketResponse := performJSONRequest(t, router, http.MethodPost, "/auth/federation/tickets", map[string]any{
		"client_id": "personal-site", "redirect_uri": callback, "state": "opaque-state",
	}, sessionCookie)
	if ticketResponse.Code != http.StatusOK {
		t.Fatalf("ticket response = %d %s", ticketResponse.Code, ticketResponse.Body.String())
	}
	var ticketBody struct {
		RedirectURL string `json:"redirect_url"`
	}
	decodeJSONResponse(t, ticketResponse, &ticketBody)
	redirect, err := url.Parse(ticketBody.RedirectURL)
	if err != nil {
		t.Fatal(err)
	}
	ticket := redirect.Query().Get("ticket")
	if ticket == "" || redirect.Query().Get("state") != "opaque-state" {
		t.Fatalf("unexpected redirect URL: %s", ticketBody.RedirectURL)
	}

	exchange := performSignedFederationRequest(t, router, "/auth/federation/exchange", map[string]any{"ticket": ticket, "redirect_uri": callback})
	if exchange.Code != http.StatusOK {
		t.Fatalf("exchange response = %d %s", exchange.Code, exchange.Body.String())
	}
	var exchangeBody struct {
		DelegatedSession string `json:"delegated_session"`
		ExpiresAt        string `json:"expires_at"`
	}
	decodeJSONResponse(t, exchange, &exchangeBody)
	if exchangeBody.DelegatedSession == "" || exchangeBody.ExpiresAt == "" {
		t.Fatalf("unexpected exchange body: %+v", exchangeBody)
	}
	replay := performSignedFederationRequest(t, router, "/auth/federation/exchange", map[string]any{"ticket": ticket, "redirect_uri": callback})
	var replayBody struct {
		DelegatedSession string `json:"delegated_session"`
	}
	decodeJSONResponse(t, replay, &replayBody)
	if replayBody.DelegatedSession != exchangeBody.DelegatedSession {
		t.Fatal("exchange replay was not deterministic")
	}

	tatResponse := performSignedFederationRequest(t, router, "/auth/federation/bots/bot-1/tat/session", map[string]any{"delegated_session": exchangeBody.DelegatedSession})
	if tatResponse.Code != http.StatusOK || !strings.Contains(tatResponse.Body.String(), "tat-session") {
		t.Fatalf("TAT response = %d %s", tatResponse.Code, tatResponse.Body.String())
	}
	if strings.Contains(tatResponse.Body.String(), "source-session") {
		t.Fatal("TAT response exposed source session")
	}
	withAuthorityOverride := performSignedFederationRequest(t, router, "/auth/federation/bots/bot-1/tat/session", map[string]any{
		"delegated_session": exchangeBody.DelegatedSession,
		"instance_id":       "attacker-selected-instance",
	})
	if withAuthorityOverride.Code != http.StatusBadRequest {
		t.Fatalf("TAT request with authority override = %d %s", withAuthorityOverride.Code, withAuthorityOverride.Body.String())
	}
	signOut := performJSONRequest(t, router, http.MethodDelete, "/auth/session", nil, sessionCookie)
	if signOut.Code != http.StatusNoContent {
		t.Fatalf("sign out response = %d %s", signOut.Code, signOut.Body.String())
	}
	afterLogout := performSignedFederationRequest(t, router, "/auth/federation/bots/bot-1/tat/session", map[string]any{"delegated_session": exchangeBody.DelegatedSession})
	if afterLogout.Code != http.StatusUnauthorized {
		t.Fatalf("delegated session after source logout = %d %s", afterLogout.Code, afterLogout.Body.String())
	}
}

func performSignedFederationRequest(t *testing.T, router http.Handler, path string, body map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	payload, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	timestamp := fixedHTTPTestNow().Format(time.RFC3339)
	requestID := "req_0123456789abcdef"
	canonical := federation.CanonicalString("personal-site", "h1", http.MethodPost, path, nil, timestamp, requestID, payload)
	mac := hmac.New(sha256.New, bytes.Repeat([]byte{0x44}, 32))
	_, _ = mac.Write([]byte(canonical))
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(federation.HeaderClientID, "personal-site")
	req.Header.Set(federation.HeaderKeyID, "h1")
	req.Header.Set(federation.HeaderTimestamp, timestamp)
	req.Header.Set(federation.HeaderRequestID, requestID)
	req.Header.Set(federation.HeaderSignature, base64.RawURLEncoding.EncodeToString(mac.Sum(nil)))
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, req)
	return recorder
}
