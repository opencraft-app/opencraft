package httpapi

import "testing"

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
