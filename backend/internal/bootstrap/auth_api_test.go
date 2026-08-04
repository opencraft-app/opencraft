package bootstrap

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	credentialsadapter "chatserver/internal/adapters/credentials"
	"chatserver/internal/api/openapi"
	"chatserver/internal/config"
	"chatserver/internal/database"
	"chatserver/internal/database/migration"
)

func TestComputerReplacementGrantKeyIsDomainSeparated(t *testing.T) {
	accessKey := bytes.Repeat([]byte{0x42}, 32)
	first := computerReplacementGrantKey(accessKey)
	second := computerReplacementGrantKey(accessKey)
	if len(first) != 32 || !bytes.Equal(first, second) || bytes.Equal(first, accessKey) {
		t.Fatalf("replacement key derivation = %x / %x", first, second)
	}
	first[0] ^= 0xff
	if bytes.Equal(first, computerReplacementGrantKey(accessKey)) {
		t.Fatal("replacement key derivation returned aliased storage")
	}
}

func TestAuthAPIRegistrationLoginRefreshAndLogout(t *testing.T) {
	handler := newAuthAPIForTest(t)

	registered := performJSON(t, handler, http.MethodPost, "/v1/auth/register", map[string]any{
		"email":       "Alice@Example.COM",
		"password":    "password-123",
		"displayName": "爱丽丝",
	}, "")
	if registered.Code != http.StatusCreated {
		t.Fatalf("register status = %d body=%s", registered.Code, registered.Body)
	}
	assertSensitiveHeaders(t, registered)
	registerResult := decodeAuthResult(t, registered)
	if string(registerResult.Account.Email) != "alice@example.com" ||
		registerResult.AccessToken == nil ||
		registerResult.RefreshToken == nil {
		t.Fatalf("register result = %#v", registerResult)
	}

	duplicate := performJSON(t, handler, http.MethodPost, "/v1/auth/register", map[string]any{
		"email":       "alice@example.com",
		"password":    "password-123",
		"displayName": "Alice",
	}, "")
	assertAPIError(t, duplicate, http.StatusConflict, "account_already_exists")

	wrong := performJSON(t, handler, http.MethodPost, "/v1/auth/login", map[string]any{
		"email":    "alice@example.com",
		"password": "wrong-password",
	}, "")
	assertAPIError(t, wrong, http.StatusUnauthorized, "unauthenticated")

	loggedIn := performJSON(t, handler, http.MethodPost, "/v1/auth/login", map[string]any{
		"email":    "ALICE@example.com",
		"password": "password-123",
	}, "")
	if loggedIn.Code != http.StatusOK {
		t.Fatalf("login status = %d body=%s", loggedIn.Code, loggedIn.Body)
	}
	loginResult := decodeAuthResult(t, loggedIn)

	refreshed := performJSON(t, handler, http.MethodPost, "/v1/auth/refresh", map[string]any{
		"refreshToken": *loginResult.RefreshToken,
	}, "")
	if refreshed.Code != http.StatusOK {
		t.Fatalf("refresh status = %d body=%s", refreshed.Code, refreshed.Body)
	}
	refreshResult := decodeAuthResult(t, refreshed)
	if *refreshResult.RefreshToken == *loginResult.RefreshToken ||
		*refreshResult.AccessToken == *loginResult.AccessToken {
		t.Fatal("refresh did not rotate tokens")
	}

	replayed := performJSON(t, handler, http.MethodPost, "/v1/auth/refresh", map[string]any{
		"refreshToken": *loginResult.RefreshToken,
	}, "")
	assertAPIError(t, replayed, http.StatusUnauthorized, "session_revoked")

	logout := performJSON(
		t,
		handler,
		http.MethodPost,
		"/v1/auth/logout",
		nil,
		*registerResult.AccessToken,
	)
	if logout.Code != http.StatusNoContent {
		t.Fatalf("logout status = %d body=%s", logout.Code, logout.Body)
	}
	afterLogout := performJSON(
		t,
		handler,
		http.MethodPost,
		"/v1/auth/logout",
		nil,
		*registerResult.AccessToken,
	)
	assertAPIError(t, afterLogout, http.StatusUnauthorized, "session_revoked")
}

func TestAuthAPIUsesUnifiedValidationAndImplementedRouteGate(t *testing.T) {
	handler := newAuthAPIForTest(t)

	invalid := httptest.NewRequest(
		http.MethodPost,
		"/v1/auth/login",
		strings.NewReader(`{"email":`),
	)
	invalid.Header.Set("Content-Type", "application/json")
	invalidRecorder := httptest.NewRecorder()
	handler.ServeHTTP(invalidRecorder, invalid)
	assertAPIError(t, invalidRecorder, http.StatusBadRequest, "invalid_request")

	unimplemented := httptest.NewRequest(http.MethodGet, "/v1/me", nil)
	unimplementedRecorder := httptest.NewRecorder()
	handler.ServeHTTP(unimplementedRecorder, unimplemented)
	assertAPIError(
		t,
		unimplementedRecorder,
		http.StatusNotFound,
		"route_not_found",
	)

	wrongMethod := httptest.NewRequest(http.MethodGet, "/v1/auth/login", nil)
	wrongMethodRecorder := httptest.NewRecorder()
	handler.ServeHTTP(wrongMethodRecorder, wrongMethod)
	assertAPIError(
		t,
		wrongMethodRecorder,
		http.StatusMethodNotAllowed,
		"method_not_allowed",
	)
	if got := wrongMethodRecorder.Header().Get("Allow"); got != http.MethodPost {
		t.Fatalf("Allow = %q, want POST", got)
	}
}

func TestPlatformCORSMethodsCoverOpenAPIMutations(t *testing.T) {
	methods := make(map[string]bool)
	for _, method := range platformCORSMethods() {
		methods[method] = true
	}
	for _, required := range []string{
		http.MethodDelete,
		http.MethodGet,
		http.MethodOptions,
		http.MethodPatch,
		http.MethodPost,
		http.MethodPut,
	} {
		if !methods[required] {
			t.Fatalf("platformCORSMethods() missing %s", required)
		}
	}
}

func TestPlatformCORSHeadersCoverOpenAPIConcurrency(t *testing.T) {
	headers := make(map[string]bool)
	for _, header := range platformCORSHeaders() {
		headers[http.CanonicalHeaderKey(header)] = true
	}
	for _, required := range []string{
		"Authorization",
		"Content-Type",
		"Idempotency-Key",
		"X-Resource-Revision",
		"X-Request-ID",
	} {
		if !headers[http.CanonicalHeaderKey(required)] {
			t.Fatalf("platformCORSHeaders() missing %s", required)
		}
	}
}

func newAuthAPIForTest(t *testing.T) http.Handler {
	t.Helper()
	cfg, err := config.NewDatabase(
		filepath.Join(t.TempDir(), "data", "chatserver.db"),
	)
	if err != nil {
		t.Fatal(err)
	}
	handle, err := database.OpenWriter(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := handle.Close(); err != nil {
			t.Errorf("Close() error = %v", err)
		}
	})
	if err := migration.Apply(context.Background(), handle.SQLDB()); err != nil {
		t.Fatal(err)
	}
	handler, err := NewAuthAPIHandler(AuthAPIConfig{
		Database:       handle,
		AccessTokenKey: bytes.Repeat([]byte{0x42}, 32),
		Password:       credentialsadapter.TestArgon2idConfig(),
		AccessTTL:      15 * time.Minute,
		RefreshTTL:     30 * 24 * time.Hour,
		RequestTimeout: 5 * time.Second,
		MaxBodyBytes:   16 * 1024,
	})
	if err != nil {
		t.Fatal(err)
	}
	return handler
}

func performJSON(
	t *testing.T,
	handler http.Handler,
	method string,
	path string,
	body any,
	bearer string,
) *httptest.ResponseRecorder {
	t.Helper()
	var data []byte
	var err error
	if body != nil {
		data, err = json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
	}
	request := httptest.NewRequest(method, path, bytes.NewReader(data))
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if bearer != "" {
		request.Header.Set("Authorization", "Bearer "+bearer)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

func decodeAuthResult(
	t *testing.T,
	recorder *httptest.ResponseRecorder,
) openapi.AuthResult {
	t.Helper()
	var result openapi.AuthResult
	if err := json.Unmarshal(recorder.Body.Bytes(), &result); err != nil {
		t.Fatalf("decode AuthResult: %v; body=%s", err, recorder.Body)
	}
	return result
}

func assertSensitiveHeaders(t *testing.T, recorder *httptest.ResponseRecorder) {
	t.Helper()
	if recorder.Header().Get("Cache-Control") != "no-store" ||
		recorder.Header().Get("Pragma") != "no-cache" {
		t.Fatalf("sensitive headers = %#v", recorder.Header())
	}
}

func assertAPIError(
	t *testing.T,
	recorder *httptest.ResponseRecorder,
	status int,
	code string,
) {
	t.Helper()
	if recorder.Code != status {
		t.Fatalf(
			"status = %d, want %d; body=%s",
			recorder.Code,
			status,
			recorder.Body,
		)
	}
	var envelope openapi.ErrorEnvelope
	if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("decode ErrorEnvelope: %v; body=%s", err, recorder.Body)
	}
	if envelope.Error.Code != code || envelope.Error.RequestId == "" {
		t.Fatalf("error = %#v", envelope.Error)
	}
}
