package httpapi

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/openclaw/openclaw/mono/backend/auth/internal/service"

	"github.com/gin-gonic/gin"

	"github.com/openclaw/openclaw/mono/backend/auth/internal/oidc"
)

func newOIDCHTTPTestRouter(t *testing.T) (*gin.Engine, *service.Service) {
	t.Helper()

	seed := bytes.Repeat([]byte{0x11}, ed25519.SeedSize)
	signingKey := ed25519.NewKeyFromSeed(seed)
	registry, err := oidc.NewRegistry([]oidc.Client{{
		ID:           "site-gateway",
		DisplayName:  "Lightvela Sites",
		RedirectURIs: []string{"https://sites-auth.lightvela.tech/auth/lightvela/callback", "https://sites-auth.lightvela.site/auth/lightvela/callback"},
	}})
	if err != nil {
		t.Fatal(err)
	}

	store := service.NewMemoryStore(service.StoreOptions{Now: fixedHTTPTestNow, SeedDefaultInvites: true})
	svc := service.NewWithStore(store, service.Options{Now: fixedHTTPTestNow, SessionTTL: 30 * 24 * time.Hour})
	router := NewRouter(svc, ServerConfig{
		CookieSecure:   true,
		CookieSameSite: http.SameSiteLaxMode,
		SessionTTL:     30 * 24 * time.Hour,
		OIDC: &OIDCConfig{
			Provider: oidc.NewProvider(oidc.ProviderConfig{
				Issuer:            "https://auth.lightclaw.test",
				AuthorizationPath: "/oauth2/authorize",
				TokenPath:         "/oauth2/token",
				JWKSPath:          "/.well-known/jwks.json",
				Registry:          registry,
				CodeStore:         oidc.NewMemoryCodeStore(fixedHTTPTestNow),
				SigningKeyID:      "oidc-1",
				SigningKey:        signingKey,
				Now:               fixedHTTPTestNow,
			}),
		},
	})
	return router, svc
}

func TestOIDCDiscoveryAndJWKSExposeEd25519Metadata(t *testing.T) {
	router, _ := newOIDCHTTPTestRouter(t)

	discovery := performJSONRequest(t, router, http.MethodGet, "/.well-known/openid-configuration", nil)
	if discovery.Code != http.StatusOK {
		t.Fatalf("discovery status = %d body=%s", discovery.Code, discovery.Body.String())
	}
	if !strings.Contains(discovery.Body.String(), "\"issuer\":\"https://auth.lightclaw.test\"") {
		t.Fatalf("unexpected discovery body: %s", discovery.Body.String())
	}

	jwks := performJSONRequest(t, router, http.MethodGet, "/.well-known/jwks.json", nil)
	if jwks.Code != http.StatusOK {
		t.Fatalf("jwks status = %d body=%s", jwks.Code, jwks.Body.String())
	}
	if !strings.Contains(jwks.Body.String(), "\"kty\":\"OKP\"") || !strings.Contains(jwks.Body.String(), "\"crv\":\"Ed25519\"") {
		t.Fatalf("unexpected jwks body: %s", jwks.Body.String())
	}
}

func TestOIDCAuthorizeContextAndTokenFlow(t *testing.T) {
	router, _ := newOIDCHTTPTestRouter(t)

	signUp := performJSONRequest(t, router, http.MethodPost, "/auth/password/sign-up", map[string]any{
		"name": "OIDC Alice", "email": "oidc-alice@example.com", "password": "password123", "inviteCode": "VALID2026",
	})
	sessionCookie := sessionCookieFromRecorder(t, signUp)

	redirectURI := "https://sites-auth.lightvela.tech/auth/lightvela/callback"
	codeVerifier := "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
	sum := sha256.Sum256([]byte(codeVerifier))
	codeChallenge := base64.RawURLEncoding.EncodeToString(sum[:])

	contextResp := performJSONRequest(t, router, http.MethodGet, "/oauth2/authorize/context?client_id=site-gateway&redirect_uri="+url.QueryEscape(redirectURI)+"&response_type=code&scope="+url.QueryEscape("openid profile email")+"&state=state-1&nonce=nonce-1&code_challenge="+url.QueryEscape(codeChallenge)+"&code_challenge_method=S256", nil, sessionCookie)
	if contextResp.Code != http.StatusOK {
		t.Fatalf("authorize context status = %d body=%s", contextResp.Code, contextResp.Body.String())
	}
	var contextBody struct {
		Client struct {
			ID          string `json:"id"`
			DisplayName string `json:"display_name"`
		} `json:"client"`
		RedirectURI         string `json:"redirect_uri"`
		State               string `json:"state"`
		ResponseType        string `json:"response_type"`
		Scope               string `json:"scope"`
		CodeChallenge       string `json:"code_challenge"`
		CodeChallengeMethod string `json:"code_challenge_method"`
		Nonce               string `json:"nonce"`
		Session             struct {
			Authenticated bool `json:"authenticated"`
		} `json:"session"`
	}
	decodeJSONResponse(t, contextResp, &contextBody)
	if contextBody.Client.ID != "site-gateway" || contextBody.Client.DisplayName != "Lightvela Sites" {
		t.Fatalf("unexpected client context: %+v", contextBody.Client)
	}
	if contextBody.RedirectURI != redirectURI || contextBody.State != "state-1" || contextBody.ResponseType != "code" {
		t.Fatalf("unexpected authorize context core fields: %+v", contextBody)
	}
	if contextBody.Scope != "openid profile email" || contextBody.CodeChallenge != codeChallenge || contextBody.CodeChallengeMethod != "S256" || contextBody.Nonce != "nonce-1" {
		t.Fatalf("unexpected authorize context oidc fields: %+v", contextBody)
	}
	if !contextBody.Session.Authenticated {
		t.Fatalf("expected authenticated session in context: %+v", contextBody.Session)
	}

	authorizeResp := performJSONRequest(t, router, http.MethodPost, "/oauth2/authorize", map[string]any{
		"client_id":             "site-gateway",
		"redirect_uri":          redirectURI,
		"response_type":         "code",
		"scope":                 "openid profile email",
		"state":                 "state-1",
		"nonce":                 "nonce-1",
		"code_challenge":        codeChallenge,
		"code_challenge_method": "S256",
	}, sessionCookie)
	if authorizeResp.Code != http.StatusOK {
		t.Fatalf("authorize status = %d body=%s", authorizeResp.Code, authorizeResp.Body.String())
	}
	var authorizeBody struct {
		RedirectURL string    `json:"redirect_url"`
		ExpiresAt   time.Time `json:"expires_at"`
	}
	decodeJSONResponse(t, authorizeResp, &authorizeBody)
	redirected, err := url.Parse(authorizeBody.RedirectURL)
	if err != nil {
		t.Fatalf("parse authorize redirect_url: %v", err)
	}
	code := redirected.Query().Get("code")
	if code == "" || redirected.Query().Get("state") != "state-1" {
		t.Fatalf("unexpected authorize redirect payload: %+v", authorizeBody)
	}
	if authorizeBody.ExpiresAt.IsZero() {
		t.Fatalf("missing expires_at in authorize response: %+v", authorizeBody)
	}

	tokenResp := performFormRequest(t, router, http.MethodPost, "/oauth2/token", url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"client_id":     {"site-gateway"},
		"redirect_uri":  {redirectURI},
		"code_verifier": {codeVerifier},
	})
	if tokenResp.Code != http.StatusOK {
		t.Fatalf("token status = %d body=%s", tokenResp.Code, tokenResp.Body.String())
	}
	var tokenBody struct {
		IDToken string `json:"id_token"`
	}
	decodeJSONResponse(t, tokenResp, &tokenBody)
	if tokenBody.IDToken == "" {
		t.Fatalf("missing id_token in response: %s", tokenResp.Body.String())
	}

	replay := performFormRequest(t, router, http.MethodPost, "/oauth2/token", url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"client_id":     {"site-gateway"},
		"redirect_uri":  {redirectURI},
		"code_verifier": {codeVerifier},
	})
	if replay.Code != http.StatusBadRequest {
		t.Fatalf("replay status = %d body=%s", replay.Code, replay.Body.String())
	}
}

func performFormRequest(t *testing.T, router http.Handler, method string, path string, form url.Values, cookies ...*http.Cookie) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	for _, cookie := range cookies {
		req.AddCookie(cookie)
	}
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, req)
	return recorder
}
