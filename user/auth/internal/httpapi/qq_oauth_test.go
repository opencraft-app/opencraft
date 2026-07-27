package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDecodeQQOAuthTokenAcceptsStringExpiresIn(t *testing.T) {
	t.Parallel()

	token, err := decodeQQOAuthToken([]byte(`{
		"access_token":"token-123",
		"refresh_token":"refresh-123",
		"expires_in":"7776000"
	}`))
	if err != nil {
		t.Fatalf("expected token payload to decode, got error: %v", err)
	}
	if token.AccessToken != "token-123" {
		t.Fatalf("expected access token to decode, got %q", token.AccessToken)
	}
	if token.ExpiresIn != 7776000 {
		t.Fatalf("expected expires_in to decode as int, got %d", token.ExpiresIn)
	}
}

func TestQQOAuthAuthorizeURLUsesConfiguredEndpoint(t *testing.T) {
	t.Parallel()

	client := newQQOAuth(&QQOAuthConfig{
		AppID:        "local-qq-app-id",
		AppKey:       "local-qq-app-key",
		RedirectURI:  "http://localhost:8085/auth/oauth/qq/callback",
		AuthorizeURL: "http://localhost:19010/oauth2.0/authorize",
	})
	if client == nil {
		t.Fatal("expected qq oauth client")
	}

	rawURL := client.authorizeURL("state-123", "http://localhost:8085/auth/oauth/qq/callback")
	if !strings.HasPrefix(rawURL, "http://localhost:19010/oauth2.0/authorize?") {
		t.Fatalf("expected configured authorize endpoint, got %q", rawURL)
	}
}

func TestQQOAuthHTTPClientUsesConfiguredAPIBaseURL(t *testing.T) {
	t.Parallel()

	var requestedPaths []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestedPaths = append(requestedPaths, r.URL.Path)
		switch r.URL.Path {
		case "/oauth2.0/token":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"access_token": "fake-token",
				"expires_in":   7776000,
			})
		case "/oauth2.0/me":
			_, _ = w.Write([]byte(`callback({"client_id":"local-qq-app-id","openid":"fake-openid"});`))
		case "/user/get_user_info":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ret":      0,
				"nickname": "Local QQ User",
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	client := &qqOAuthHTTPClient{
		appID:      "local-qq-app-id",
		appKey:     "local-qq-app-key",
		apiBaseURL: server.URL,
		httpClient: server.Client(),
	}
	token, err := client.ExchangeCode(context.Background(), "fake-code", "http://localhost:8085/auth/oauth/qq/callback")
	if err != nil {
		t.Fatalf("exchange code: %v", err)
	}
	identity, err := client.ResolveIdentity(context.Background(), token.AccessToken)
	if err != nil {
		t.Fatalf("resolve identity: %v", err)
	}
	if identity.Provider != "qq" || identity.ProviderSubject != "fake-openid" || identity.Name != "Local QQ User" {
		t.Fatalf("unexpected identity: %+v", identity)
	}

	wantPaths := strings.Join([]string{"/oauth2.0/token", "/oauth2.0/me", "/user/get_user_info"}, ",")
	if gotPaths := strings.Join(requestedPaths, ","); gotPaths != wantPaths {
		t.Fatalf("expected requests %s, got %s", wantPaths, gotPaths)
	}
}
