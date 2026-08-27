package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"git.woa.com/wisp/mono/site-gateway/internal/hostroute"
	"git.woa.com/wisp/mono/site-gateway/internal/siteauth"
	"git.woa.com/wisp/mono/site-gateway/internal/sitemeta"
)

type fakeShareCodeVerifier struct {
	verification ShareVerification
	err          error
	calls        int
	siteID       string
	code         string
	clientIP     string
}

func (f *fakeShareCodeVerifier) Verify(_ context.Context, siteID, code, clientIP string) (ShareVerification, error) {
	f.calls++
	f.siteID, f.code, f.clientIP = siteID, code, clientIP
	return f.verification, f.err
}

const shareTestGeneration = "generation-3"

var shareTestNow = time.Date(2026, 8, 24, 10, 0, 0, 0, time.UTC)

func activeShareVerification() ShareVerification {
	return ShareVerification{Generation: shareTestGeneration, ExpiresAt: shareTestNow.Add(90 * time.Minute)}
}

func newShareHandler(t *testing.T, sites *fakeSites, obj *fakeOrigin, verifier *fakeShareCodeVerifier, trustProxy bool) (*SiteHandler, *siteauth.TokenCodec) {
	t.Helper()
	codec, err := siteauth.NewTokenCodec(siteauth.TokenCodecConfig{
		ActiveKeyID: "key-1",
		Keys: map[string][]byte{
			"key-1": []byte("0123456789abcdef0123456789abcdef"),
		},
		Clock:      func() time.Time { return shareTestNow },
		SessionTTL: 5 * time.Minute,
	})
	if err != nil {
		t.Fatal(err)
	}
	return NewSiteHandler(Options{
		Resolver: hostroute.New([]string{domesticRootDomain}),
		Sites:    sites,
		Origin:   obj,
		Logger:   log.New(io.Discard, "", 0),
		Auth: AuthOptions{
			Required:          true,
			TokenCodec:        codec,
			ShareVerifier:     verifier,
			TrustProxyHeaders: trustProxy,
			Clock:             func() time.Time { return shareTestNow },
		},
	}), codec
}

func shareSite(siteID, generation string, expiresAt time.Time) *fakeSites {
	sites := activeSite(siteID)
	sites.sites[siteID].AccessMode = sitemeta.AccessModeShareCode
	sites.sites[siteID].ShareGeneration = generation
	sites.sites[siteID].ShareExpiresAt = &expiresAt
	return sites
}

func activeShareSite(siteID string) *fakeSites {
	verification := activeShareVerification()
	return shareSite(siteID, verification.Generation, verification.ExpiresAt)
}

func shareFormRequest(host, code, returnTo string) *http.Request {
	form := url.Values{"code": []string{code}, "return_to": []string{returnTo}}
	req := httptest.NewRequest(http.MethodPost, "https://"+host+siteSharePath, strings.NewReader(form.Encode()))
	req.Host = host
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	return req
}

func TestShareModeRedirectsToSameOriginPageAndRendersPrivateForm(t *testing.T) {
	verifier := &fakeShareCodeVerifier{verification: activeShareVerification()}
	handler, _ := newShareHandler(t, activeShareSite("ws-abc"), &fakeOrigin{}, verifier, false)
	host := "ws-abc." + domesticRootDomain

	redirectRec := httptest.NewRecorder()
	handler.ServeHTTP(redirectRec, requestWithHost(http.MethodGet, host, "/about?tab=security"))
	if redirectRec.Code != http.StatusFound || redirectRec.Header().Get("Location") != siteSharePath+"?return_to=%2Fabout%3Ftab%3Dsecurity" {
		t.Fatalf("redirect = %d Location=%q", redirectRec.Code, redirectRec.Header().Get("Location"))
	}

	pageRec := httptest.NewRecorder()
	handler.ServeHTTP(pageRec, requestWithHost(http.MethodGet, host, redirectRec.Header().Get("Location")))
	if pageRec.Code != http.StatusOK {
		t.Fatalf("share page status=%d body=%s", pageRec.Code, pageRec.Body.String())
	}
	for _, expected := range []string{"<form", `name="code"`, `autocomplete="off"`, siteAuthStartPath} {
		if !strings.Contains(pageRec.Body.String(), expected) {
			t.Fatalf("share page missing %q: %s", expected, pageRec.Body.String())
		}
	}
	if pageRec.Header().Get("Cache-Control") != "private, no-store" || !strings.Contains(pageRec.Header().Get("X-Robots-Tag"), "noindex") {
		t.Fatalf("share page headers=%v", pageRec.Header())
	}

	headRec := httptest.NewRecorder()
	handler.ServeHTTP(headRec, requestWithHost(http.MethodHead, host, siteSharePath))
	if headRec.Code != http.StatusOK || headRec.Body.Len() != 0 {
		t.Fatalf("HEAD response=%d body=%q", headRec.Code, headRec.Body.String())
	}
}

func TestSharePageUsesLightVelaAuthVisualsAndAccessibleErrorState(t *testing.T) {
	verifier := &fakeShareCodeVerifier{verification: activeShareVerification()}
	handler, _ := newShareHandler(t, activeShareSite("ws-abc"), &fakeOrigin{}, verifier, false)
	host := "ws-abc." + domesticRootDomain

	pageRec := httptest.NewRecorder()
	handler.ServeHTTP(pageRec, requestWithHost(http.MethodGet, host, siteSharePath))
	if pageRec.Code != http.StatusOK {
		t.Fatalf("share page status=%d body=%s", pageRec.Code, pageRec.Body.String())
	}
	for _, expected := range []string{
		`class="brand-lockup"`,
		`aria-label="LightVela"`,
		`--button-bg:#101216`,
		`border-radius:999px`,
		`:focus-visible`,
		`aria-invalid="false"`,
		`aria-describedby="share-help share-error"`,
		`站点所有者无需分享码，可直接登录`,
		`使用 LightVela 账号登录`,
		`@media (max-width:520px)`,
	} {
		if !strings.Contains(pageRec.Body.String(), expected) {
			t.Fatalf("share page missing %q: %s", expected, pageRec.Body.String())
		}
	}

	errorRec := httptest.NewRecorder()
	handler.ServeHTTP(errorRec, shareFormRequest(host, "INVALID", "/"))
	if errorRec.Code != http.StatusForbidden {
		t.Fatalf("error page status=%d body=%s", errorRec.Code, errorRec.Body.String())
	}
	for _, expected := range []string{
		`aria-invalid="true"`,
		`aria-errormessage="share-error"`,
		`id="share-error" class="field-error" role="alert"`,
	} {
		if !strings.Contains(errorRec.Body.String(), expected) {
			t.Fatalf("error page missing %q: %s", expected, errorRec.Body.String())
		}
	}
}

func TestShareCodeIssuesHostOnlyCookieBoundedByExpiryAndGenerationRevokesIt(t *testing.T) {
	verification := activeShareVerification()
	verifier := &fakeShareCodeVerifier{verification: verification}
	sites := activeShareSite("ws-abc")
	obj := &fakeOrigin{objects: map[string]string{"sites/ws-abc/current/about/index.html": "shared content"}}
	handler, codec := newShareHandler(t, sites, obj, verifier, false)
	host := "ws-abc." + domesticRootDomain

	req := shareFormRequest(host, "7kq9xm", "/about")
	req.Header.Set("X-Forwarded-For", "203.0.113.7")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusFound || rec.Header().Get("Location") != "/about" {
		t.Fatalf("verify response=%d Location=%q body=%s", rec.Code, rec.Header().Get("Location"), rec.Body.String())
	}
	if verifier.siteID != "ws-abc" || verifier.code != "7KQ9XM" || verifier.clientIP != "" {
		t.Fatalf("verifier args=%q/%q/%q", verifier.siteID, verifier.code, verifier.clientIP)
	}
	cookie := cookieFromResponse(t, rec, shareSessionCookie)
	if cookie.Domain != "" || !cookie.Secure || !cookie.HttpOnly || cookie.Path != "/" || cookie.SameSite != http.SameSiteLaxMode || cookie.MaxAge != 90*60 || !cookie.Expires.Equal(verification.ExpiresAt) {
		t.Fatalf("share cookie=%+v", cookie)
	}
	claims, err := codec.OpenShareSession(cookie.Value, host)
	if err != nil || claims.SiteID != "ws-abc" || claims.Generation != shareTestGeneration {
		t.Fatalf("share claims=%+v err=%v", claims, err)
	}

	contentReq := requestWithHost(http.MethodGet, host, "/about")
	contentReq.AddCookie(cookie)
	contentRec := httptest.NewRecorder()
	handler.ServeHTTP(contentRec, contentReq)
	if contentRec.Code != http.StatusOK || contentRec.Body.String() != "shared content" {
		t.Fatalf("shared content=%d/%q", contentRec.Code, contentRec.Body.String())
	}

	sites.sites["ws-abc"].ShareGeneration = "generation-4"
	revokedReq := requestWithHost(http.MethodGet, host, "/about")
	revokedReq.AddCookie(cookie)
	revokedRec := httptest.NewRecorder()
	handler.ServeHTTP(revokedRec, revokedReq)
	if revokedRec.Code != http.StatusFound || !strings.HasPrefix(revokedRec.Header().Get("Location"), siteSharePath) {
		t.Fatalf("revoked response=%d Location=%q", revokedRec.Code, revokedRec.Header().Get("Location"))
	}
}

func TestShareModeOwnerSessionStillBypassesSharePage(t *testing.T) {
	sites := activeShareSite("ws-abc")
	obj := &fakeOrigin{objects: map[string]string{"sites/ws-abc/current/index.html": "owner content"}}
	verifier := &fakeShareCodeVerifier{verification: activeShareVerification()}
	handler, codec := newShareHandler(t, sites, obj, verifier, false)
	host := "ws-abc." + domesticRootDomain
	ownerRaw, err := codec.SealSession(siteauth.SessionClaims{SiteID: "ws-abc", SiteHost: host, UserID: "user-1", Nonce: "nonce"})
	if err != nil {
		t.Fatal(err)
	}

	req := requestWithHost(http.MethodGet, host, "/")
	req.AddCookie(&http.Cookie{Name: siteSessionCookie, Value: ownerRaw})
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || rec.Body.String() != "owner content" || verifier.calls != 0 {
		t.Fatalf("owner response=%d/%q verifier calls=%d", rec.Code, rec.Body.String(), verifier.calls)
	}
}

func TestExpiredShareMetadataFallsBackToOwnerOnly(t *testing.T) {
	sites := shareSite("ws-abc", shareTestGeneration, shareTestNow)
	verifier := &fakeShareCodeVerifier{verification: activeShareVerification()}
	handler, _ := newShareHandler(t, sites, &fakeOrigin{}, verifier, false)

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, requestWithHost(http.MethodGet, "ws-abc."+domesticRootDomain, "/"))
	if rec.Code != http.StatusForbidden || strings.HasPrefix(rec.Header().Get("Location"), siteSharePath) || verifier.calls != 0 {
		t.Fatalf("expired response=%d Location=%q verifier calls=%d", rec.Code, rec.Header().Get("Location"), verifier.calls)
	}
}

func TestShareVerifierCannotIssueCookiePastAbsoluteExpiry(t *testing.T) {
	verification := activeShareVerification()
	verification.ExpiresAt = shareTestNow
	verifier := &fakeShareCodeVerifier{verification: verification}
	handler, _ := newShareHandler(t, activeShareSite("ws-abc"), &fakeOrigin{}, verifier, false)

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, shareFormRequest("ws-abc."+domesticRootDomain, "7KQ9XM", "/"))
	if rec.Code != http.StatusServiceUnavailable || len(rec.Result().Cookies()) != 0 {
		t.Fatalf("expired verifier response=%d cookies=%v", rec.Code, rec.Result().Cookies())
	}
}

func TestShareVerifierErrorsAreFailClosedAndNeverEchoCode(t *testing.T) {
	for _, tc := range []struct {
		name   string
		err    error
		status int
	}{
		{"invalid", ErrShareCodeInvalid, http.StatusForbidden},
		{"limited", ErrShareRateLimited, http.StatusTooManyRequests},
		{"unavailable", ErrShareUnavailable, http.StatusServiceUnavailable},
	} {
		t.Run(tc.name, func(t *testing.T) {
			verifier := &fakeShareCodeVerifier{err: tc.err}
			handler, _ := newShareHandler(t, activeShareSite("ws-abc"), &fakeOrigin{}, verifier, false)
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, shareFormRequest("ws-abc."+domesticRootDomain, "7KQ9XM", "/"))
			if rec.Code != tc.status || strings.Contains(rec.Body.String(), "7KQ9XM") || len(rec.Result().Cookies()) != 0 {
				t.Fatalf("response=%d body=%q cookies=%v", rec.Code, rec.Body.String(), rec.Result().Cookies())
			}
		})
	}
}

func TestShareClientIPUsesForwardedHeaderOnlyWhenExplicitlyTrusted(t *testing.T) {
	verifier := &fakeShareCodeVerifier{verification: activeShareVerification()}
	handler, _ := newShareHandler(t, activeShareSite("ws-abc"), &fakeOrigin{}, verifier, true)
	req := shareFormRequest("ws-abc."+domesticRootDomain, "7KQ9XM", "/")
	req.Header.Set("X-Forwarded-For", "garbage, 203.0.113.7, 198.51.100.8")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusFound || verifier.clientIP != "203.0.113.7" {
		t.Fatalf("response=%d clientIP=%q", rec.Code, verifier.clientIP)
	}
}

func TestPublicModeIgnoresSharePolicyAndVerifier(t *testing.T) {
	sites := activeShareSite("ws-abc")
	obj := &fakeOrigin{objects: map[string]string{"sites/ws-abc/current/index.html": "public"}}
	verifier := &fakeShareCodeVerifier{err: errors.New("must not be called")}
	handler := NewSiteHandler(Options{
		Resolver: hostroute.New([]string{intlRootDomain}), Sites: sites, Origin: obj,
		Auth: AuthOptions{ShareVerifier: verifier},
	})
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, requestWithHost(http.MethodGet, "ws-abc."+intlRootDomain, "/"))
	if rec.Code != http.StatusOK || rec.Body.String() != "public" || verifier.calls != 0 {
		t.Fatalf("public response=%d/%q verifier calls=%d", rec.Code, rec.Body.String(), verifier.calls)
	}
}

func TestUnknownAccessModeFailsClosedToOwnerFlow(t *testing.T) {
	sites := activeSite("ws-abc")
	sites.sites["ws-abc"].AccessMode = "unexpected"
	verifier := &fakeShareCodeVerifier{verification: activeShareVerification()}
	handler, _ := newShareHandler(t, sites, &fakeOrigin{}, verifier, false)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, requestWithHost(http.MethodGet, "ws-abc."+domesticRootDomain, "/"))
	if rec.Code != http.StatusForbidden || strings.HasPrefix(rec.Header().Get("Location"), siteSharePath) || verifier.calls != 0 {
		t.Fatalf("response=%d Location=%q verifier calls=%d", rec.Code, rec.Header().Get("Location"), verifier.calls)
	}
}

func TestCTLShareCodeVerifierSendsInternalContractAndMapsResponses(t *testing.T) {
	var gotPath, gotToken, gotIP, gotCode string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotToken = r.Header.Get("X-Internal-Token")
		gotIP = r.Header.Get("X-Site-Client-IP")
		var body struct {
			Code string `json:"code"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode request: %v", err)
		}
		gotCode = body.Code
		_, _ = w.Write([]byte(`{"code":"OK","data":{"verified":true,` +
			`"share_generation":"generation-11","share_expires_at":"2026-08-24T11:30:00Z"}}`))
	}))
	defer server.Close()

	verifier := NewCTLShareCodeVerifier(server.URL, "internal-token", server.Client())
	verification, err := verifier.Verify(context.Background(), "ws-abc", "7KQ9XM", "203.0.113.7")
	if err != nil || verification.Generation != "generation-11" ||
		!verification.ExpiresAt.Equal(time.Date(2026, 8, 24, 11, 30, 0, 0, time.UTC)) {
		t.Fatalf("Verify result=%+v err=%v", verification, err)
	}
	if gotPath != "/internal/ctl/websites/sites/ws-abc/share-code/verify" || gotToken != "internal-token" || gotIP != "203.0.113.7" || gotCode != "7KQ9XM" {
		t.Fatalf("request path/token/ip/code=%q/%q/%q/%q", gotPath, gotToken, gotIP, gotCode)
	}

	for _, tc := range []struct {
		status int
		want   error
	}{
		{http.StatusForbidden, ErrShareCodeInvalid},
		{http.StatusTooManyRequests, ErrShareRateLimited},
		{http.StatusServiceUnavailable, ErrShareUnavailable},
	} {
		statusServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(tc.status)
		}))
		mapped := NewCTLShareCodeVerifier(statusServer.URL, "token", statusServer.Client())
		_, err := mapped.Verify(context.Background(), "ws-abc", "7KQ9XM", "")
		statusServer.Close()
		if !errors.Is(err, tc.want) {
			t.Fatalf("status %d error=%v, want %v", tc.status, err, tc.want)
		}
	}
}
