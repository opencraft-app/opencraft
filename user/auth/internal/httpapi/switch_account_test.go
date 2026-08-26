package httpapi

import (
	"bytes"
	"net/http"
	"testing"
	"time"

	"github.com/openclaw/openclaw/mono/backend/auth/internal/federation"
)

func newSwitchTestFederationConfig(t *testing.T) *FederationConfig {
	t.Helper()
	codec, err := federation.NewCodec(federation.CodecConfig{
		Environment: "test",
		ActiveKeyID: "k1",
		Keys:        map[string][]byte{"k1": bytes.Repeat([]byte{0x51}, 32)},
		NonceKey:    bytes.Repeat([]byte{0x52}, 32),
	})
	if err != nil {
		t.Fatal(err)
	}
	return &FederationConfig{Codec: codec, SwitchTTL: 5 * time.Minute, Now: fixedHTTPTestNow}
}

func TestFederationSwitchPrepareRequiresCurrentSessionAndCancelPreservesIt(t *testing.T) {
	router, svc := newAuthTestRouterWithOptionsAndService(nil, "")
	handlerRouter := NewRouter(svc, ServerConfig{
		CookieSecure: true, CookieSameSite: http.SameSiteNoneMode, SessionTTL: 30 * 24 * time.Hour,
		Federation: newSwitchTestFederationConfig(t),
	})
	_ = router

	unauthorized := performJSONRequest(t, handlerRouter, http.MethodPost, "/auth/federation/switch/prepare", nil)
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("prepare without session = %d, want 401", unauthorized.Code)
	}

	signUp := performJSONRequest(t, handlerRouter, http.MethodPost, "/auth/password/sign-up", map[string]any{
		"name": "Old User", "email": "old-switch@example.com", "password": "password123", "inviteCode": "VALID2026",
	})
	oldSession := sessionCookieFromRecorder(t, signUp)
	prepare := performJSONRequest(t, handlerRouter, http.MethodPost, "/auth/federation/switch/prepare", nil, oldSession)
	if prepare.Code != http.StatusNoContent {
		t.Fatalf("prepare = %d %s, want 204", prepare.Code, prepare.Body.String())
	}
	switchCookie := cookieFromRecorderByName(t, prepare, federationSwitchCookieName)
	if !switchCookie.HttpOnly || switchCookie.MaxAge != int((5*time.Minute)/time.Second) {
		t.Fatalf("unexpected switch cookie: %+v", switchCookie)
	}

	cancel := performJSONRequest(t, handlerRouter, http.MethodDelete, "/auth/federation/switch", nil, oldSession, switchCookie)
	if cancel.Code != http.StatusNoContent {
		t.Fatalf("cancel = %d %s, want 204", cancel.Code, cancel.Body.String())
	}
	cleared := cookieFromRecorderByName(t, cancel, federationSwitchCookieName)
	if cleared.MaxAge >= 0 {
		t.Fatalf("switch cookie was not cleared: %+v", cleared)
	}
	current := performJSONRequest(t, handlerRouter, http.MethodGet, "/auth/session", nil, oldSession)
	if current.Code != http.StatusOK {
		t.Fatalf("cancel revoked old session: %d %s", current.Code, current.Body.String())
	}
}

func TestFederationSwitchPasswordLoginRevokesOldSession(t *testing.T) {
	_, svc := newAuthTestRouterWithOptionsAndService(nil, "")
	router := NewRouter(svc, ServerConfig{
		CookieSecure: true, CookieSameSite: http.SameSiteNoneMode, SessionTTL: 30 * 24 * time.Hour,
		Federation: newSwitchTestFederationConfig(t),
	})
	oldSignup := performJSONRequest(t, router, http.MethodPost, "/auth/password/sign-up", map[string]any{
		"name": "Old User", "email": "old-password-switch@example.com", "password": "password123", "inviteCode": "VALID2026",
	})
	oldSession := sessionCookieFromRecorder(t, oldSignup)
	_ = performJSONRequest(t, router, http.MethodPost, "/auth/password/sign-up", map[string]any{
		"name": "New User", "email": "new-password-switch@example.com", "password": "password456", "inviteCode": "VALID2026",
	})
	prepare := performJSONRequest(t, router, http.MethodPost, "/auth/federation/switch/prepare", nil, oldSession)
	switchCookie := cookieFromRecorderByName(t, prepare, federationSwitchCookieName)
	signIn := performJSONRequest(t, router, http.MethodPost, "/auth/password/sign-in", map[string]any{
		"email": "new-password-switch@example.com", "password": "password456",
	}, oldSession, switchCookie)
	if signIn.Code != http.StatusOK {
		t.Fatalf("new password sign-in = %d %s", signIn.Code, signIn.Body.String())
	}
	oldCurrent := performJSONRequest(t, router, http.MethodGet, "/auth/session", nil, oldSession)
	if oldCurrent.Code != http.StatusUnauthorized {
		t.Fatalf("old session after password switch = %d %s", oldCurrent.Code, oldCurrent.Body.String())
	}
}
