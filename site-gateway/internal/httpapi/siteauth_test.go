package httpapi

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"git.woa.com/wisp/mono/site-gateway/internal/hostroute"
	"git.woa.com/wisp/mono/site-gateway/internal/origin"
	"git.woa.com/wisp/mono/site-gateway/internal/siteauth"
	"git.woa.com/wisp/mono/site-gateway/internal/sitemeta"
)

const (
	domesticRootDomain = "lightvela.tech"
	domesticAuthHost   = "sites-auth.lightvela.tech"
	intlRootDomain     = "lightvela.site"
	intlAuthHost       = "sites-auth.lightvela.site"
)

func newRequiredHandler(t *testing.T, now time.Time, provider *fakeOIDCProvider, sites *fakeSites, obj *fakeOrigin) *SiteHandler {
	return newRequiredHandlerWithCustomDomain(t, now, provider, sites, obj, nil)
}

func newRequiredHandlerWithCustomDomain(t *testing.T, now time.Time, provider *fakeOIDCProvider, sites *fakeSites, obj *fakeOrigin, dl sitemeta.DomainLookup) *SiteHandler {
	return newHandlerWithAuthMode(t, now, provider, sites, obj, dl, true, true, domesticRootDomain, domesticAuthHost)
}

func newPublicHandlerWithAuthEndpoints(t *testing.T, now time.Time, provider *fakeOIDCProvider, sites *fakeSites, obj *fakeOrigin) *SiteHandler {
	return newHandlerWithAuthMode(t, now, provider, sites, obj, nil, false, true, intlRootDomain, intlAuthHost)
}

func newHandlerWithAuthMode(t *testing.T, now time.Time, provider *fakeOIDCProvider, sites *fakeSites, obj *fakeOrigin, dl sitemeta.DomainLookup, required bool, endpointsEnabled bool, rootDomain string, fixedAuthHost string) *SiteHandler {
	t.Helper()
	codec, err := siteauth.NewTokenCodec(siteauth.TokenCodecConfig{
		ActiveKeyID: "key-1",
		Keys: map[string][]byte{
			"key-1": []byte("0123456789abcdef0123456789abcdef"),
		},
		Clock: func() time.Time { return now },
	})
	if err != nil {
		t.Fatal(err)
	}
	verifier, err := siteauth.NewIDTokenVerifier(siteauth.IDTokenVerifierConfig{
		Issuer:     provider.issuer,
		ClientID:   "site-gateway",
		JWKSURL:    provider.server.URL + "/.well-known/jwks.json",
		HTTPClient: provider.server.Client(),
		Clock:      func() time.Time { return now },
	})
	if err != nil {
		t.Fatal(err)
	}
	return NewSiteHandler(Options{
		Resolver:     hostroute.New([]string{rootDomain}),
		Sites:        sites,
		DomainLookup: dl,
		Origin:       obj,
		Auth: AuthOptions{
			Required:         required,
			EndpointsEnabled: endpointsEnabled,
			FixedAuthHost:    fixedAuthHost,
			AuthorizeURL:     provider.server.URL + "/oauth2/authorize",
			TokenURL:         provider.server.URL + "/oauth2/token",
			ClientID:         "site-gateway",
			SessionTTL:       5 * time.Minute,
			TokenCodec:       codec,
			IDTokens:         verifier,
			HTTPClient:       provider.server.Client(),
		},
	})
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

func TestRequiredModeRunsFixedHostOIDCFlowAndSetsHostOnlyCookies(t *testing.T) {
	now := time.Date(2026, 8, 24, 10, 0, 0, 0, time.UTC)
	provider := newFakeOIDCProvider(t, now)
	defer provider.Close()

	obj := &fakeOrigin{objects: map[string]string{
		"sites/ws-abc/current/about/index.html": "private content",
	}}
	handler := newRequiredHandler(t, now, provider, activeSite("ws-abc"), obj)
	siteHost := "ws-abc." + domesticRootDomain

	startRec := httptest.NewRecorder()
	handler.ServeHTTP(startRec, requestWithHost(http.MethodGet, siteHost, "/about"))
	if startRec.Code != http.StatusFound {
		t.Fatalf("initial status = %d, want 302", startRec.Code)
	}
	if len(startRec.Result().Cookies()) != 0 {
		t.Fatalf("site host must not set auth cookies before fixed-host start: %+v", startRec.Result().Cookies())
	}
	startLocation, err := url.Parse(startRec.Header().Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	if startLocation.Scheme != "https" || startLocation.Host != domesticAuthHost || startLocation.Path != fixedAuthStartPath {
		t.Fatalf("initial redirect = %q", startLocation.String())
	}
	if startLocation.Query().Get("launch") == "" || len(startLocation.Query()) != 1 {
		t.Fatalf("initial redirect query = %v", startLocation.Query())
	}

	fixedStartRec := httptest.NewRecorder()
	handler.ServeHTTP(fixedStartRec, requestWithHost(http.MethodGet, domesticAuthHost, startLocation.RequestURI()))
	if fixedStartRec.Code != http.StatusFound {
		t.Fatalf("fixed start status = %d, want 302", fixedStartRec.Code)
	}
	stateCookie := cookieFromResponse(t, fixedStartRec, "__Host-lv_oidc_state")
	if stateCookie.Domain != "" || !stateCookie.HttpOnly || !stateCookie.Secure || stateCookie.Path != "/" || stateCookie.SameSite != http.SameSiteLaxMode {
		t.Fatalf("state cookie = %+v", stateCookie)
	}
	if stateCookie.MaxAge <= 0 || stateCookie.MaxAge > 5*60 {
		t.Fatalf("state cookie MaxAge = %d", stateCookie.MaxAge)
	}
	callbackURL := provider.authorize(t, fixedStartRec.Header().Get("Location"))

	fixedCallbackReq := requestWithHost(http.MethodGet, domesticAuthHost, callbackURL.RequestURI())
	fixedCallbackReq.AddCookie(stateCookie)
	fixedCallbackRec := httptest.NewRecorder()
	handler.ServeHTTP(fixedCallbackRec, fixedCallbackReq)
	if fixedCallbackRec.Code != http.StatusFound {
		t.Fatalf("fixed callback status = %d, want 302", fixedCallbackRec.Code)
	}
	cleared := cookieFromResponse(t, fixedCallbackRec, "__Host-lv_oidc_state")
	if cleared.Value != "" || cleared.MaxAge != -1 || cleared.Domain != "" {
		t.Fatalf("cleared state cookie = %+v", cleared)
	}
	handoffURL, err := url.Parse(fixedCallbackRec.Header().Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	if handoffURL.Scheme != "https" || handoffURL.Host != siteHost || handoffURL.Path != siteAuthCallbackPath {
		t.Fatalf("handoff redirect = %q", handoffURL.String())
	}
	if handoffURL.Query().Get("handoff") == "" {
		t.Fatalf("handoff query = %v", handoffURL.Query())
	}

	siteCallbackRec := httptest.NewRecorder()
	handler.ServeHTTP(siteCallbackRec, requestWithHost(http.MethodGet, siteHost, handoffURL.RequestURI()))
	if siteCallbackRec.Code != http.StatusFound || siteCallbackRec.Header().Get("Location") != "/about" {
		t.Fatalf("site callback = %d Location=%q", siteCallbackRec.Code, siteCallbackRec.Header().Get("Location"))
	}
	sessionCookie := cookieFromResponse(t, siteCallbackRec, "lv_site_session")
	if sessionCookie.Domain != "" || !sessionCookie.HttpOnly || !sessionCookie.Secure || sessionCookie.Path != "/" || sessionCookie.SameSite != http.SameSiteLaxMode {
		t.Fatalf("session cookie = %+v", sessionCookie)
	}
	if sessionCookie.MaxAge <= 0 || sessionCookie.MaxAge > 5*60 {
		t.Fatalf("session cookie MaxAge = %d", sessionCookie.MaxAge)
	}

	contentReq := requestWithHost(http.MethodGet, siteHost, "/about")
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
}

func TestRequiredModeRunsFixedHostOIDCFlowForCustomDomain(t *testing.T) {
	now := time.Date(2026, 8, 24, 10, 0, 0, 0, time.UTC)
	provider := newFakeOIDCProvider(t, now)
	defer provider.Close()

	siteID := "ws-abc"
	siteHost := "Blog.Example.COM."
	obj := &fakeOrigin{objects: map[string]string{
		"sites/ws-abc/current/about/index.html": "private content",
	}}
	dl := &fakeDomainLookup{domains: map[string]string{
		"blog.example.com": siteID,
	}}
	handler := newRequiredHandlerWithCustomDomain(t, now, provider, activeSite(siteID), obj, dl)

	startRec := httptest.NewRecorder()
	handler.ServeHTTP(startRec, requestWithHost(http.MethodGet, siteHost, "/about"))
	if startRec.Code != http.StatusFound {
		t.Fatalf("initial status = %d, want 302", startRec.Code)
	}
	startLocation, err := url.Parse(startRec.Header().Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	if startLocation.Host != domesticAuthHost || startLocation.Path != fixedAuthStartPath {
		t.Fatalf("initial redirect = %q", startLocation.String())
	}

	fixedStartRec := httptest.NewRecorder()
	handler.ServeHTTP(fixedStartRec, requestWithHost(http.MethodGet, domesticAuthHost, startLocation.RequestURI()))
	if fixedStartRec.Code != http.StatusFound {
		t.Fatalf("fixed start status = %d, want 302", fixedStartRec.Code)
	}
	stateCookie := cookieFromResponse(t, fixedStartRec, "__Host-lv_oidc_state")
	callbackURL := provider.authorize(t, fixedStartRec.Header().Get("Location"))

	fixedCallbackReq := requestWithHost(http.MethodGet, domesticAuthHost, callbackURL.RequestURI())
	fixedCallbackReq.AddCookie(stateCookie)
	fixedCallbackRec := httptest.NewRecorder()
	handler.ServeHTTP(fixedCallbackRec, fixedCallbackReq)
	if fixedCallbackRec.Code != http.StatusFound {
		t.Fatalf("fixed callback status = %d, want 302", fixedCallbackRec.Code)
	}
	handoffURL, err := url.Parse(fixedCallbackRec.Header().Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	if handoffURL.Host != "blog.example.com" || handoffURL.Path != siteAuthCallbackPath {
		t.Fatalf("handoff redirect = %q", handoffURL.String())
	}

	siteCallbackRec := httptest.NewRecorder()
	handler.ServeHTTP(siteCallbackRec, requestWithHost(http.MethodGet, siteHost, handoffURL.RequestURI()))
	if siteCallbackRec.Code != http.StatusFound || siteCallbackRec.Header().Get("Location") != "/about" {
		t.Fatalf("site callback = %d Location=%q", siteCallbackRec.Code, siteCallbackRec.Header().Get("Location"))
	}
	sessionCookie := cookieFromResponse(t, siteCallbackRec, "lv_site_session")

	contentReq := requestWithHost(http.MethodGet, siteHost, "/about")
	contentReq.AddCookie(sessionCookie)
	contentRec := httptest.NewRecorder()
	handler.ServeHTTP(contentRec, contentReq)
	if contentRec.Code != http.StatusOK || contentRec.Body.String() != "private content" {
		t.Fatalf("content = %d/%q", contentRec.Code, contentRec.Body.String())
	}
}

func TestRequiredModeRejectsTamperedLaunchTokenAtFixedStart(t *testing.T) {
	now := time.Date(2026, 8, 24, 10, 0, 0, 0, time.UTC)
	provider := newFakeOIDCProvider(t, now)
	defer provider.Close()

	handler := newRequiredHandler(t, now, provider, activeSite("ws-abc"), &fakeOrigin{})
	siteHost := "ws-abc." + domesticRootDomain

	startRec := httptest.NewRecorder()
	handler.ServeHTTP(startRec, requestWithHost(http.MethodGet, siteHost, "/"))
	startLocation, err := url.Parse(startRec.Header().Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	launch := startLocation.Query().Get("launch")
	startLocation.RawQuery = url.Values{"launch": []string{tamperEncodedTokenPayload(t, launch)}}.Encode()

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, requestWithHost(http.MethodGet, domesticAuthHost, startLocation.RequestURI()))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", rec.Code)
	}
	if rec.Header().Get("Location") != "" {
		t.Fatalf("unexpected redirect = %q", rec.Header().Get("Location"))
	}
}

func TestRequiredModeRejectsTamperedStateAndClearsCookie(t *testing.T) {
	now := time.Date(2026, 8, 24, 10, 0, 0, 0, time.UTC)
	provider := newFakeOIDCProvider(t, now)
	defer provider.Close()

	handler := newRequiredHandler(t, now, provider, activeSite("ws-abc"), &fakeOrigin{})
	siteHost := "ws-abc." + domesticRootDomain

	startRec := httptest.NewRecorder()
	handler.ServeHTTP(startRec, requestWithHost(http.MethodGet, siteHost, "/"))
	startLocation, err := url.Parse(startRec.Header().Get("Location"))
	if err != nil {
		t.Fatal(err)
	}

	fixedStartRec := httptest.NewRecorder()
	handler.ServeHTTP(fixedStartRec, requestWithHost(http.MethodGet, domesticAuthHost, startLocation.RequestURI()))
	stateCookie := cookieFromResponse(t, fixedStartRec, "__Host-lv_oidc_state")
	callbackURL := provider.authorize(t, fixedStartRec.Header().Get("Location"))
	query := callbackURL.Query()
	query.Set("state", "tampered-state")
	callbackURL.RawQuery = query.Encode()

	req := requestWithHost(http.MethodGet, domesticAuthHost, callbackURL.RequestURI())
	req.AddCookie(stateCookie)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", rec.Code)
	}
	cleared := cookieFromResponse(t, rec, "__Host-lv_oidc_state")
	if cleared.MaxAge != -1 || cleared.Value != "" || cleared.Domain != "" {
		t.Fatalf("cleared cookie = %+v", cleared)
	}
}

func TestRequiredModeRejectsSiblingHostHandoffReplay(t *testing.T) {
	now := time.Date(2026, 8, 24, 10, 0, 0, 0, time.UTC)
	provider := newFakeOIDCProvider(t, now)
	defer provider.Close()

	handler := newRequiredHandler(t, now, provider, activeSite("ws-abc"), &fakeOrigin{})
	siteHost := "ws-abc." + domesticRootDomain

	startRec := httptest.NewRecorder()
	handler.ServeHTTP(startRec, requestWithHost(http.MethodGet, siteHost, "/"))
	startLocation, _ := url.Parse(startRec.Header().Get("Location"))
	fixedStartRec := httptest.NewRecorder()
	handler.ServeHTTP(fixedStartRec, requestWithHost(http.MethodGet, domesticAuthHost, startLocation.RequestURI()))
	stateCookie := cookieFromResponse(t, fixedStartRec, "__Host-lv_oidc_state")
	callbackURL := provider.authorize(t, fixedStartRec.Header().Get("Location"))

	fixedCallbackReq := requestWithHost(http.MethodGet, domesticAuthHost, callbackURL.RequestURI())
	fixedCallbackReq.AddCookie(stateCookie)
	fixedCallbackRec := httptest.NewRecorder()
	handler.ServeHTTP(fixedCallbackRec, fixedCallbackReq)

	handoffURL, err := url.Parse(fixedCallbackRec.Header().Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, requestWithHost(http.MethodGet, "ws-other."+domesticRootDomain, handoffURL.RequestURI()))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", rec.Code)
	}
}

func TestRequiredModeRejectsNonOwnerAtSiteCallback(t *testing.T) {
	now := time.Date(2026, 8, 24, 10, 0, 0, 0, time.UTC)
	provider := newFakeOIDCProvider(t, now)
	defer provider.Close()

	sites := activeSite("ws-abc")
	obj := &fakeOrigin{objects: map[string]string{"sites/ws-abc/current/index.html": "private"}}
	handler := newRequiredHandler(t, now, provider, sites, obj)
	siteHost := "ws-abc." + domesticRootDomain

	startRec := httptest.NewRecorder()
	handler.ServeHTTP(startRec, requestWithHost(http.MethodGet, siteHost, "/"))
	startLocation, _ := url.Parse(startRec.Header().Get("Location"))
	fixedStartRec := httptest.NewRecorder()
	handler.ServeHTTP(fixedStartRec, requestWithHost(http.MethodGet, domesticAuthHost, startLocation.RequestURI()))
	stateCookie := cookieFromResponse(t, fixedStartRec, "__Host-lv_oidc_state")
	callbackURL := provider.authorize(t, fixedStartRec.Header().Get("Location"))

	fixedCallbackReq := requestWithHost(http.MethodGet, domesticAuthHost, callbackURL.RequestURI())
	fixedCallbackReq.AddCookie(stateCookie)
	fixedCallbackRec := httptest.NewRecorder()
	handler.ServeHTTP(fixedCallbackRec, fixedCallbackReq)
	if fixedCallbackRec.Code != http.StatusFound {
		t.Fatalf("status = %d, want 302", fixedCallbackRec.Code)
	}
	handoffURL, err := url.Parse(fixedCallbackRec.Header().Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	sites.sites["ws-abc"].UserID = "user-2"
	siteCallbackRec := httptest.NewRecorder()
	handler.ServeHTTP(siteCallbackRec, requestWithHost(http.MethodGet, siteHost, handoffURL.RequestURI()))
	if siteCallbackRec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", siteCallbackRec.Code)
	}
	if len(obj.requests) != 0 {
		t.Fatalf("non-owner site callback reached origin: %v", obj.requests)
	}
}

func TestRequiredModeRejectsMissingOwnerBeforeIssuingHandoff(t *testing.T) {
	now := time.Date(2026, 8, 24, 10, 0, 0, 0, time.UTC)
	provider := newFakeOIDCProvider(t, now)
	defer provider.Close()

	sites := activeSite("ws-abc")
	sites.sites["ws-abc"].UserID = ""
	handler := newRequiredHandler(t, now, provider, sites, &fakeOrigin{})
	siteHost := "ws-abc." + domesticRootDomain

	startRec := httptest.NewRecorder()
	handler.ServeHTTP(startRec, requestWithHost(http.MethodGet, siteHost, "/"))
	startLocation, _ := url.Parse(startRec.Header().Get("Location"))
	fixedStartRec := httptest.NewRecorder()
	handler.ServeHTTP(fixedStartRec, requestWithHost(http.MethodGet, domesticAuthHost, startLocation.RequestURI()))
	stateCookie := cookieFromResponse(t, fixedStartRec, "__Host-lv_oidc_state")
	callbackURL := provider.authorize(t, fixedStartRec.Header().Get("Location"))

	fixedCallbackReq := requestWithHost(http.MethodGet, domesticAuthHost, callbackURL.RequestURI())
	fixedCallbackReq.AddCookie(stateCookie)
	fixedCallbackRec := httptest.NewRecorder()
	handler.ServeHTTP(fixedCallbackRec, fixedCallbackReq)
	if fixedCallbackRec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", fixedCallbackRec.Code)
	}
}

func TestRequiredModeUsesFreshOwnerLookupBeforeIssuingHandoff(t *testing.T) {
	now := time.Date(2026, 8, 24, 10, 0, 0, 0, time.UTC)
	provider := newFakeOIDCProvider(t, now)
	defer provider.Close()

	sites := activeSite("ws-abc")
	sites.freshSites = map[string]*sitemeta.Site{
		"ws-abc": {SiteID: "ws-abc", Status: sitemeta.StatusActive, UserID: "user-2"},
	}
	handler := newRequiredHandler(t, now, provider, sites, &fakeOrigin{})
	siteHost := "ws-abc." + domesticRootDomain

	startRec := httptest.NewRecorder()
	handler.ServeHTTP(startRec, requestWithHost(http.MethodGet, siteHost, "/"))
	startLocation, _ := url.Parse(startRec.Header().Get("Location"))
	fixedStartRec := httptest.NewRecorder()
	handler.ServeHTTP(fixedStartRec, requestWithHost(http.MethodGet, domesticAuthHost, startLocation.RequestURI()))
	stateCookie := cookieFromResponse(t, fixedStartRec, "__Host-lv_oidc_state")
	callbackURL := provider.authorize(t, fixedStartRec.Header().Get("Location"))

	fixedCallbackReq := requestWithHost(http.MethodGet, domesticAuthHost, callbackURL.RequestURI())
	fixedCallbackReq.AddCookie(stateCookie)
	fixedCallbackRec := httptest.NewRecorder()
	handler.ServeHTTP(fixedCallbackRec, fixedCallbackReq)
	if fixedCallbackRec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", fixedCallbackRec.Code)
	}
}

func TestRequiredModeRejectsSessionAfterSiteOwnershipChanges(t *testing.T) {
	now := time.Date(2026, 8, 24, 10, 0, 0, 0, time.UTC)
	provider := newFakeOIDCProvider(t, now)
	defer provider.Close()

	sites := activeSite("ws-abc")
	obj := &fakeOrigin{objects: map[string]string{
		"sites/ws-abc/current/about/index.html": "private content",
	}}
	handler := newRequiredHandler(t, now, provider, sites, obj)
	siteHost := "ws-abc." + domesticRootDomain

	startRec := httptest.NewRecorder()
	handler.ServeHTTP(startRec, requestWithHost(http.MethodGet, siteHost, "/about"))
	startLocation, _ := url.Parse(startRec.Header().Get("Location"))
	fixedStartRec := httptest.NewRecorder()
	handler.ServeHTTP(fixedStartRec, requestWithHost(http.MethodGet, domesticAuthHost, startLocation.RequestURI()))
	stateCookie := cookieFromResponse(t, fixedStartRec, "__Host-lv_oidc_state")
	callbackURL := provider.authorize(t, fixedStartRec.Header().Get("Location"))
	fixedCallbackReq := requestWithHost(http.MethodGet, domesticAuthHost, callbackURL.RequestURI())
	fixedCallbackReq.AddCookie(stateCookie)
	fixedCallbackRec := httptest.NewRecorder()
	handler.ServeHTTP(fixedCallbackRec, fixedCallbackReq)
	handoffURL, _ := url.Parse(fixedCallbackRec.Header().Get("Location"))
	siteCallbackRec := httptest.NewRecorder()
	handler.ServeHTTP(siteCallbackRec, requestWithHost(http.MethodGet, siteHost, handoffURL.RequestURI()))
	sessionCookie := cookieFromResponse(t, siteCallbackRec, "lv_site_session")

	sites.sites["ws-abc"].UserID = "user-2"

	contentReq := requestWithHost(http.MethodGet, siteHost, "/about")
	contentReq.AddCookie(sessionCookie)
	contentRec := httptest.NewRecorder()
	handler.ServeHTTP(contentRec, contentReq)
	if contentRec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", contentRec.Code)
	}
	if len(obj.requests) != 0 {
		t.Fatalf("owner-changed session reached origin: %v", obj.requests)
	}
}

func TestRequiredModeUsesFreshOwnerLookupWhenConsumingHandoff(t *testing.T) {
	now := time.Date(2026, 8, 24, 10, 0, 0, 0, time.UTC)
	provider := newFakeOIDCProvider(t, now)
	defer provider.Close()

	sites := activeSite("ws-abc")
	sites.freshSites = map[string]*sitemeta.Site{
		"ws-abc": {SiteID: "ws-abc", Status: sitemeta.StatusActive, UserID: "user-1"},
	}
	obj := &fakeOrigin{objects: map[string]string{"sites/ws-abc/current/index.html": "private"}}
	handler := newRequiredHandler(t, now, provider, sites, obj)
	siteHost := "ws-abc." + domesticRootDomain

	startRec := httptest.NewRecorder()
	handler.ServeHTTP(startRec, requestWithHost(http.MethodGet, siteHost, "/"))
	startLocation, _ := url.Parse(startRec.Header().Get("Location"))
	fixedStartRec := httptest.NewRecorder()
	handler.ServeHTTP(fixedStartRec, requestWithHost(http.MethodGet, domesticAuthHost, startLocation.RequestURI()))
	stateCookie := cookieFromResponse(t, fixedStartRec, "__Host-lv_oidc_state")
	callbackURL := provider.authorize(t, fixedStartRec.Header().Get("Location"))

	fixedCallbackReq := requestWithHost(http.MethodGet, domesticAuthHost, callbackURL.RequestURI())
	fixedCallbackReq.AddCookie(stateCookie)
	fixedCallbackRec := httptest.NewRecorder()
	handler.ServeHTTP(fixedCallbackRec, fixedCallbackReq)
	if fixedCallbackRec.Code != http.StatusFound {
		t.Fatalf("fixed callback status = %d, want 302", fixedCallbackRec.Code)
	}
	handoffURL, err := url.Parse(fixedCallbackRec.Header().Get("Location"))
	if err != nil {
		t.Fatal(err)
	}

	sites.freshSites["ws-abc"] = &sitemeta.Site{SiteID: "ws-abc", Status: sitemeta.StatusActive, UserID: "user-2"}

	siteCallbackRec := httptest.NewRecorder()
	handler.ServeHTTP(siteCallbackRec, requestWithHost(http.MethodGet, siteHost, handoffURL.RequestURI()))
	if siteCallbackRec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", siteCallbackRec.Code)
	}
	if len(obj.requests) != 0 {
		t.Fatalf("owner-changed handoff reached origin: %v", obj.requests)
	}
}

func TestRequiredModeUsesFreshOwnerLookupAfterCachedOwnershipChanges(t *testing.T) {
	now := time.Date(2026, 8, 24, 10, 0, 0, 0, time.UTC)
	provider := newFakeOIDCProvider(t, now)
	defer provider.Close()

	sites := activeSite("ws-abc")
	sites.freshSites = map[string]*sitemeta.Site{
		"ws-abc": {SiteID: "ws-abc", Status: sitemeta.StatusActive, UserID: "user-1"},
	}
	obj := &fakeOrigin{objects: map[string]string{
		"sites/ws-abc/current/about/index.html": "private content",
	}}
	handler := newRequiredHandler(t, now, provider, sites, obj)
	siteHost := "ws-abc." + domesticRootDomain

	startRec := httptest.NewRecorder()
	handler.ServeHTTP(startRec, requestWithHost(http.MethodGet, siteHost, "/about"))
	startLocation, _ := url.Parse(startRec.Header().Get("Location"))
	fixedStartRec := httptest.NewRecorder()
	handler.ServeHTTP(fixedStartRec, requestWithHost(http.MethodGet, domesticAuthHost, startLocation.RequestURI()))
	stateCookie := cookieFromResponse(t, fixedStartRec, "__Host-lv_oidc_state")
	callbackURL := provider.authorize(t, fixedStartRec.Header().Get("Location"))
	fixedCallbackReq := requestWithHost(http.MethodGet, domesticAuthHost, callbackURL.RequestURI())
	fixedCallbackReq.AddCookie(stateCookie)
	fixedCallbackRec := httptest.NewRecorder()
	handler.ServeHTTP(fixedCallbackRec, fixedCallbackReq)
	handoffURL, _ := url.Parse(fixedCallbackRec.Header().Get("Location"))
	siteCallbackRec := httptest.NewRecorder()
	handler.ServeHTTP(siteCallbackRec, requestWithHost(http.MethodGet, siteHost, handoffURL.RequestURI()))
	sessionCookie := cookieFromResponse(t, siteCallbackRec, "lv_site_session")

	sites.freshSites["ws-abc"] = &sitemeta.Site{SiteID: "ws-abc", Status: sitemeta.StatusActive, UserID: "user-2"}

	contentReq := requestWithHost(http.MethodGet, siteHost, "/about")
	contentReq.AddCookie(sessionCookie)
	contentRec := httptest.NewRecorder()
	handler.ServeHTTP(contentRec, contentReq)
	if contentRec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", contentRec.Code)
	}
	if len(obj.requests) != 0 {
		t.Fatalf("owner-changed session reached origin: %v", obj.requests)
	}
}

func TestPublicModeRemainsAnonymousOnSiteDomain(t *testing.T) {
	obj := &fakeOrigin{objects: map[string]string{"sites/ws-abc/current/index.html": "public"}}
	handler := NewSiteHandler(Options{
		Resolver: hostroute.New([]string{intlRootDomain}),
		Sites:    activeSite("ws-abc"),
		Origin:   obj,
	})
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, requestWithHost(http.MethodGet, "ws-abc."+intlRootDomain, "/"))
	if rec.Code != http.StatusOK || rec.Body.String() != "public" {
		t.Fatalf("public response = %d/%q", rec.Code, rec.Body.String())
	}
	if rec.Header().Get("Location") != "" || len(rec.Result().Cookies()) != 0 {
		t.Fatalf("public mode must stay anonymous, Location=%q cookies=%v", rec.Header().Get("Location"), rec.Result().Cookies())
	}
}

func TestPublicModeWithAuthEndpointsSupportsExplicitSiteStartAndLeavesContentAnonymous(t *testing.T) {
	now := time.Date(2026, 8, 24, 10, 0, 0, 0, time.UTC)
	provider := newFakeOIDCProvider(t, now)
	defer provider.Close()

	obj := &fakeOrigin{objects: map[string]string{
		"sites/ws-abc/current/index.html":       "public",
		"sites/ws-abc/current/about/index.html": "public about",
	}}
	handler := newPublicHandlerWithAuthEndpoints(t, now, provider, activeSite("ws-abc"), obj)
	siteHost := "ws-abc." + intlRootDomain

	publicRec := httptest.NewRecorder()
	handler.ServeHTTP(publicRec, requestWithHost(http.MethodGet, siteHost, "/"))
	if publicRec.Code != http.StatusOK || publicRec.Body.String() != "public" {
		t.Fatalf("public response = %d/%q", publicRec.Code, publicRec.Body.String())
	}
	if publicRec.Header().Get("Location") != "" || len(publicRec.Result().Cookies()) != 0 {
		t.Fatalf("public mode must stay anonymous, Location=%q cookies=%v", publicRec.Header().Get("Location"), publicRec.Result().Cookies())
	}

	startRec := httptest.NewRecorder()
	handler.ServeHTTP(startRec, requestWithHost(http.MethodGet, siteHost, siteAuthStartPath+"?return_to=%2Fabout"))
	if startRec.Code != http.StatusFound {
		t.Fatalf("start status = %d, want 302", startRec.Code)
	}
	startLocation, err := url.Parse(startRec.Header().Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	if startLocation.Scheme != "https" || startLocation.Host != intlAuthHost || startLocation.Path != fixedAuthStartPath {
		t.Fatalf("start redirect = %q", startLocation.String())
	}
	if startLocation.Query().Get("launch") == "" {
		t.Fatalf("start redirect query = %v", startLocation.Query())
	}

	fixedStartRec := httptest.NewRecorder()
	handler.ServeHTTP(fixedStartRec, requestWithHost(http.MethodGet, intlAuthHost, startLocation.RequestURI()))
	if fixedStartRec.Code != http.StatusFound {
		t.Fatalf("fixed start status = %d, want 302", fixedStartRec.Code)
	}
	stateCookie := cookieFromResponse(t, fixedStartRec, "__Host-lv_oidc_state")
	callbackURL := provider.authorize(t, fixedStartRec.Header().Get("Location"))

	fixedCallbackReq := requestWithHost(http.MethodGet, intlAuthHost, callbackURL.RequestURI())
	fixedCallbackReq.AddCookie(stateCookie)
	fixedCallbackRec := httptest.NewRecorder()
	handler.ServeHTTP(fixedCallbackRec, fixedCallbackReq)
	if fixedCallbackRec.Code != http.StatusFound {
		t.Fatalf("fixed callback status = %d, want 302", fixedCallbackRec.Code)
	}
	handoffURL, err := url.Parse(fixedCallbackRec.Header().Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	if handoffURL.Scheme != "https" || handoffURL.Host != siteHost || handoffURL.Path != siteAuthCallbackPath {
		t.Fatalf("handoff redirect = %q", handoffURL.String())
	}

	siteCallbackRec := httptest.NewRecorder()
	handler.ServeHTTP(siteCallbackRec, requestWithHost(http.MethodGet, siteHost, handoffURL.RequestURI()))
	if siteCallbackRec.Code != http.StatusFound || siteCallbackRec.Header().Get("Location") != "/about" {
		t.Fatalf("site callback = %d Location=%q", siteCallbackRec.Code, siteCallbackRec.Header().Get("Location"))
	}
	sessionCookie := cookieFromResponse(t, siteCallbackRec, "lv_site_session")
	if sessionCookie.Domain != "" || !sessionCookie.HttpOnly || !sessionCookie.Secure || sessionCookie.Path != "/" || sessionCookie.SameSite != http.SameSiteLaxMode {
		t.Fatalf("session cookie = %+v", sessionCookie)
	}
}

func TestPublicModeWithoutAuthEndpointsLeavesExplicitAuthStartAsStaticContent(t *testing.T) {
	obj := &fakeOrigin{objects: map[string]string{
		"sites/ws-abc/current/__lightvela/auth/start/index.html": "public auth page",
	}}
	handler := NewSiteHandler(Options{
		Resolver: hostroute.New([]string{intlRootDomain}),
		Sites:    activeSite("ws-abc"),
		Origin:   obj,
	})

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, requestWithHost(http.MethodGet, "ws-abc."+intlRootDomain, siteAuthStartPath))
	if rec.Code != http.StatusOK || rec.Body.String() != "public auth page" {
		t.Fatalf("response = %d/%q", rec.Code, rec.Body.String())
	}
	if rec.Header().Get("Location") != "" || len(rec.Result().Cookies()) != 0 {
		t.Fatalf("disabled auth endpoints must not redirect, Location=%q cookies=%v", rec.Header().Get("Location"), rec.Result().Cookies())
	}
}

type fakeOIDCProvider struct {
	t          *testing.T
	now        time.Time
	issuer     string
	publicKey  ed25519.PublicKey
	privateKey ed25519.PrivateKey
	server     *httptest.Server

	mu    sync.Mutex
	codes map[string]fakeOIDCCode
}

type fakeOIDCCode struct {
	nonce         string
	challenge     string
	redirectURI   string
	clientID      string
	consumed      bool
	targetSubject string
}

func newFakeOIDCProvider(t *testing.T, now time.Time) *fakeOIDCProvider {
	t.Helper()
	publicKey, privateKey, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	provider := &fakeOIDCProvider{
		t:          t,
		now:        now,
		issuer:     "https://userauth.example.test",
		publicKey:  publicKey,
		privateKey: privateKey,
		codes:      make(map[string]fakeOIDCCode),
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/oauth2/authorize", provider.handleAuthorize)
	mux.HandleFunc("/oauth2/token", provider.handleToken)
	mux.HandleFunc("/.well-known/jwks.json", provider.handleJWKS)
	provider.server = httptest.NewServer(mux)
	return provider
}

func (p *fakeOIDCProvider) Close() {
	if p.server != nil {
		p.server.Close()
	}
}

func (p *fakeOIDCProvider) authorize(t *testing.T, raw string) *url.URL {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, raw, nil)
	if err != nil {
		t.Fatal(err)
	}
	client := *p.server.Client()
	client.CheckRedirect = func(_ *http.Request, _ []*http.Request) error {
		return http.ErrUseLastResponse
	}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusFound {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("authorize status = %d body=%q", resp.StatusCode, string(body))
	}
	location, err := resp.Location()
	if err != nil {
		t.Fatal(err)
	}
	return location
}

func (p *fakeOIDCProvider) handleAuthorize(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	query := r.URL.Query()
	if query.Get("response_type") != "code" || query.Get("client_id") != "site-gateway" || query.Get("scope") != "openid" || query.Get("code_challenge_method") != "S256" {
		http.Error(w, "bad authorize request", http.StatusBadRequest)
		return
	}
	redirectURI := query.Get("redirect_uri")
	state := query.Get("state")
	nonce := query.Get("nonce")
	challenge := query.Get("code_challenge")
	if redirectURI == "" || state == "" || nonce == "" || challenge == "" {
		http.Error(w, "missing authorize parameters", http.StatusBadRequest)
		return
	}
	code := base64.RawURLEncoding.EncodeToString([]byte("code-" + nonce))
	p.mu.Lock()
	p.codes[code] = fakeOIDCCode{
		nonce:         nonce,
		challenge:     challenge,
		redirectURI:   redirectURI,
		clientID:      query.Get("client_id"),
		targetSubject: "user-1",
	}
	p.mu.Unlock()

	target, err := url.Parse(redirectURI)
	if err != nil {
		http.Error(w, "bad redirect uri", http.StatusBadRequest)
		return
	}
	values := target.Query()
	values.Set("code", code)
	values.Set("state", state)
	target.RawQuery = values.Encode()
	http.Redirect(w, r, target.String(), http.StatusFound)
}

func (p *fakeOIDCProvider) handleToken(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if err := r.ParseForm(); err != nil {
		http.Error(w, "parse form", http.StatusBadRequest)
		return
	}
	if r.Form.Get("grant_type") != "authorization_code" {
		http.Error(w, "grant type", http.StatusBadRequest)
		return
	}
	code := r.Form.Get("code")
	verifier := r.Form.Get("code_verifier")
	redirectURI := r.Form.Get("redirect_uri")
	clientID := r.Form.Get("client_id")
	sum := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(sum[:])

	p.mu.Lock()
	stored, ok := p.codes[code]
	if ok && !stored.consumed && stored.challenge == challenge && stored.redirectURI == redirectURI && stored.clientID == clientID {
		stored.consumed = true
		p.codes[code] = stored
	} else {
		ok = false
	}
	p.mu.Unlock()
	if !ok {
		http.Error(w, `{"error":"invalid_grant"}`, http.StatusBadRequest)
		return
	}

	token := jwt.NewWithClaims(jwt.SigningMethodEdDSA, jwt.MapClaims{
		"iss":   p.issuer,
		"sub":   stored.targetSubject,
		"aud":   stored.clientID,
		"iat":   p.now.Unix(),
		"exp":   p.now.Add(5 * time.Minute).Unix(),
		"nonce": stored.nonce,
		"name":  "Test User",
	})
	token.Header["kid"] = "kid-1"
	token.Header["typ"] = "JWT"
	idToken, err := token.SignedString(p.privateKey)
	if err != nil {
		http.Error(w, "sign id token", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"token_type": "Bearer",
		"id_token":   idToken,
	})
}

func (p *fakeOIDCProvider) handleJWKS(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"keys": []map[string]any{
			{
				"kty": "OKP",
				"crv": "Ed25519",
				"use": "sig",
				"alg": "EdDSA",
				"kid": "kid-1",
				"x":   base64.RawURLEncoding.EncodeToString(p.publicKey),
			},
		},
	})
}

func tamperEncodedTokenPayload(t *testing.T, raw string) string {
	t.Helper()

	parts := strings.SplitN(raw, ".", 2)
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		t.Fatalf("invalid token format: %q", raw)
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	if len(payload) == 0 {
		t.Fatal("empty token payload")
	}
	payload[len(payload)-1] ^= 0x01
	return parts[0] + "." + base64.RawURLEncoding.EncodeToString(payload)
}

var _ origin.Fetcher = (*fakeOrigin)(nil)
var _ sitemeta.Lookup = (*fakeSites)(nil)
