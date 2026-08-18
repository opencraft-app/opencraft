package httpapi

import (
	"crypto/ed25519"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"git.woa.com/wisp/mono/site-gateway/internal/hostroute"
	"git.woa.com/wisp/mono/site-gateway/internal/origin"
	"git.woa.com/wisp/mono/site-gateway/internal/siteauth"
	"git.woa.com/wisp/mono/site-gateway/internal/sitemeta"
)

const domesticRootDomain = "lightvela.tech"

func newRequiredHandler(sites *fakeSites, obj *fakeOrigin, verifier *siteauth.Verifier) *SiteHandler {
	return NewSiteHandler(Options{
		Resolver: hostroute.New([]string{domesticRootDomain}),
		Sites:    sites,
		Origin:   obj,
		Auth: AuthOptions{
			Required:   true,
			StartURL:   "https://lightvela.com/site-access/start",
			SessionTTL: 5 * time.Minute,
			Verifier:   verifier,
		},
	})
}

func newAuthVerifier(t *testing.T, now time.Time) (*siteauth.Verifier, ed25519.PrivateKey) {
	t.Helper()
	publicKey, privateKey, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	verifier, err := siteauth.NewVerifier(siteauth.Config{
		Issuer:     "lightvela-auth",
		Audience:   "lightvela-site-gateway",
		PublicKeys: map[string]ed25519.PublicKey{"key-1": publicKey},
		Clock:      func() time.Time { return now },
	})
	if err != nil {
		t.Fatal(err)
	}
	return verifier, privateKey
}

func signAuthTestToken(t *testing.T, key ed25519.PrivateKey, now time.Time, host, state string) string {
	t.Helper()
	token := jwt.NewWithClaims(jwt.SigningMethodEdDSA, siteauth.Claims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    "lightvela-auth",
			Audience:  jwt.ClaimStrings{"lightvela-site-gateway"},
			Subject:   "user-1",
			IssuedAt:  jwt.NewNumericDate(now.Add(-time.Second)),
			ExpiresAt: jwt.NewNumericDate(now.Add(5 * time.Minute)),
			ID:        "ticket-1",
		},
		SiteHost: host,
		State:    state,
	})
	token.Header["typ"] = "LV-Site-Access"
	token.Header["kid"] = "key-1"
	raw, err := token.SignedString(key)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func requestWithHost(method, host, target string) *http.Request {
	req := httptest.NewRequest(method, "https://"+host+target, nil)
	req.Host = host
	req.Header.Set("X-Forwarded-Proto", "https")
	return req
}

func cookieFromResponse(t *testing.T, rec *httptest.ResponseRecorder, name string) *http.Cookie {
	t.Helper()
	for _, cookie := range rec.Result().Cookies() {
		if cookie.Name == name {
			return cookie
		}
	}
	t.Fatalf("cookie %q not found", name)
	return nil
}

func TestRequiredModeRedirectsBeforeSiteLookupWithoutSession(t *testing.T) {
	now := time.Date(2026, 8, 18, 12, 0, 0, 0, time.UTC)
	verifier, _ := newAuthVerifier(t, now)
	obj := &fakeOrigin{objects: map[string]string{"sites/ws-abc/current/index.html": "secret"}}
	rec := httptest.NewRecorder()
	req := requestWithHost(http.MethodGet, "ws-abc."+domesticRootDomain, "/")
	newRequiredHandler(activeSite("ws-abc"), obj, verifier).ServeHTTP(rec, req)

	if rec.Code != http.StatusFound {
		t.Fatalf("status = %d, want 302", rec.Code)
	}
	location, err := url.Parse(rec.Header().Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	if location.Host != "lightvela.com" || location.Path != "/site-access/start" {
		t.Fatalf("Location = %q", location.String())
	}
	if location.Query().Get("state") == "" || location.Query().Get("redirect_uri") == "" {
		t.Fatalf("Location query = %v", location.Query())
	}
	stateCookie := cookieFromResponse(t, rec, "__Host-lv_site_state")
	if !stateCookie.HttpOnly || !stateCookie.Secure || stateCookie.SameSite != http.SameSiteLaxMode {
		t.Fatalf("state cookie = %+v", stateCookie)
	}
	if len(obj.requests) != 0 {
		t.Fatalf("auth challenge reached origin: %v", obj.requests)
	}
}

func TestValidCallbackSetsSessionAndServesPrivateContent(t *testing.T) {
	now := time.Date(2026, 8, 18, 12, 0, 0, 0, time.UTC)
	verifier, privateKey := newAuthVerifier(t, now)
	sites := activeSite("ws-abc")
	obj := &fakeOrigin{objects: map[string]string{
		"sites/ws-abc/current/about/index.html": "private content",
	}}
	handler := newRequiredHandler(sites, obj, verifier)
	host := "ws-abc." + domesticRootDomain

	startRec := httptest.NewRecorder()
	handler.ServeHTTP(startRec, requestWithHost(http.MethodGet, host, "/about"))
	stateCookie := cookieFromResponse(t, startRec, "__Host-lv_site_state")
	startLocation, err := url.Parse(startRec.Header().Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	state := startLocation.Query().Get("state")
	ticket := signAuthTestToken(t, privateKey, now, host, state)

	callback := "/__lightvela/auth/callback?ticket=" + url.QueryEscape(ticket) + "&state=" + url.QueryEscape(state) + "&return_to=%2Fabout"
	callbackReq := requestWithHost(http.MethodGet, host, callback)
	callbackReq.AddCookie(stateCookie)
	callbackRec := httptest.NewRecorder()
	handler.ServeHTTP(callbackRec, callbackReq)
	if callbackRec.Code != http.StatusFound || callbackRec.Header().Get("Location") != "/about" {
		t.Fatalf("callback = %d, Location=%q", callbackRec.Code, callbackRec.Header().Get("Location"))
	}
	sessionCookie := cookieFromResponse(t, callbackRec, "lv_site_session")
	if !sessionCookie.HttpOnly || !sessionCookie.Secure || sessionCookie.SameSite != http.SameSiteLaxMode {
		t.Fatalf("session cookie = %+v", sessionCookie)
	}

	contentReq := requestWithHost(http.MethodGet, host, "/about")
	contentReq.AddCookie(sessionCookie)
	contentRec := httptest.NewRecorder()
	handler.ServeHTTP(contentRec, contentReq)
	if contentRec.Code != http.StatusOK || contentRec.Body.String() != "private content" {
		t.Fatalf("content = %d/%q", contentRec.Code, contentRec.Body.String())
	}
	if got := contentRec.Header().Get("Cache-Control"); got != "private, no-store" {
		t.Fatalf("Cache-Control = %q", got)
	}
	if got := contentRec.Header().Get("X-Robots-Tag"); got != "noindex, nofollow, noarchive" {
		t.Fatalf("X-Robots-Tag = %q", got)
	}
	if len(obj.requests) != 2 || obj.requests[1] != "sites/ws-abc/current/about/index.html" {
		t.Fatalf("origin requests = %v", obj.requests)
	}
}

func TestRequiredModeRejectsInvalidCallbackBeforeCOS(t *testing.T) {
	now := time.Date(2026, 8, 18, 12, 0, 0, 0, time.UTC)
	verifier, privateKey := newAuthVerifier(t, now)
	obj := &fakeOrigin{objects: map[string]string{"sites/ws-abc/current/index.html": "secret"}}
	handler := newRequiredHandler(activeSite("ws-abc"), obj, verifier)
	host := "ws-abc." + domesticRootDomain

	startRec := httptest.NewRecorder()
	handler.ServeHTTP(startRec, requestWithHost(http.MethodGet, host, "/"))
	stateCookie := cookieFromResponse(t, startRec, "__Host-lv_site_state")
	startLocation, err := url.Parse(startRec.Header().Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	state := startLocation.Query().Get("state")
	ticket := signAuthTestToken(t, privateKey, now, "other."+domesticRootDomain, state)

	callbackReq := requestWithHost(http.MethodGet, host, "/__lightvela/auth/callback?ticket="+url.QueryEscape(ticket)+"&state="+url.QueryEscape(state))
	callbackReq.AddCookie(stateCookie)
	callbackRec := httptest.NewRecorder()
	handler.ServeHTTP(callbackRec, callbackReq)
	if callbackRec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", callbackRec.Code)
	}
	if callbackRec.Header().Get("Cache-Control") != "private, no-store" {
		t.Fatalf("Cache-Control = %q", callbackRec.Header().Get("Cache-Control"))
	}
	if len(obj.requests) != 0 {
		t.Fatalf("invalid callback reached origin: %v", obj.requests)
	}
}

func TestPublicModeRemainsAnonymous(t *testing.T) {
	obj := &fakeOrigin{objects: map[string]string{"sites/ws-abc/current/index.html": "public"}}
	rec := do(newHandler(activeSite("ws-abc"), obj), http.MethodGet, "ws-abc."+rootDomain, "/")
	if rec.Code != http.StatusOK || rec.Body.String() != "public" {
		t.Fatalf("public response = %d/%q", rec.Code, rec.Body.String())
	}
}

var _ origin.Fetcher = (*fakeOrigin)(nil)
var _ sitemeta.Lookup = (*fakeSites)(nil)
