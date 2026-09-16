package bootstrap

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	credentialsadapter "git.woa.com/wisp/mono2/collaboration/internal/adapters/credentials"
	"git.woa.com/wisp/mono2/collaboration/internal/api/openapi"
	"git.woa.com/wisp/mono2/collaboration/internal/config"
	"git.woa.com/wisp/mono2/collaboration/internal/database"
	"git.woa.com/wisp/mono2/collaboration/internal/database/migration"
	tencentimport "git.woa.com/wisp/mono2/collaboration/internal/ports/tencentim"
)

type recordingUserSigIssuer struct {
	userID string
	ttl    time.Duration
	result tencentimport.UserSig
}

func (issuer *recordingUserSigIssuer) Issue(
	_ context.Context,
	userID string,
	ttl time.Duration,
) (tencentimport.UserSig, error) {
	issuer.userID = userID
	issuer.ttl = ttl
	return issuer.result, nil
}

func TestHumanAPIMeAndIMSessionUseCurrentAuthenticatedAccount(t *testing.T) {
	handle := openHumanAPIDatabase(t)
	expiry := time.Date(2026, 7, 30, 19, 0, 0, 0, time.UTC)
	issuer := &recordingUserSigIssuer{result: tencentimport.UserSig{
		Value:     "short-lived-user-sig",
		ExpiresAt: expiry,
	}}
	handler, err := NewHumanAPIHandler(HumanAPIConfig{
		Auth: AuthAPIConfig{
			Database:       handle,
			AccessTokenKey: bytes.Repeat([]byte{0x42}, 32),
			Password:       credentialsadapter.TestArgon2idConfig(),
			AccessTTL:      15 * time.Minute,
			RefreshTTL:     30 * 24 * time.Hour,
			RequestTimeout: 5 * time.Second,
			MaxBodyBytes:   16 * 1024,
		},
		SDKAppID:      1600000000,
		UserSigTTL:    time.Hour,
		UserSigIssuer: issuer,
	})
	if err != nil {
		t.Fatalf("NewHumanAPIHandler() error = %v", err)
	}
	registered := performJSON(
		t,
		handler,
		http.MethodPost,
		"/v1/auth/register",
		map[string]any{
			"email":       "alice@example.com",
			"password":    "password-123",
			"displayName": "爱丽丝",
		},
		"",
	)
	if registered.Code != http.StatusCreated {
		t.Fatalf("register status = %d body=%s", registered.Code, registered.Body)
	}
	auth := decodeAuthResult(t, registered)

	me := performJSON(
		t,
		handler,
		http.MethodGet,
		"/v1/me",
		nil,
		*auth.AccessToken,
	)
	if me.Code != http.StatusOK {
		t.Fatalf("GET /me status = %d body=%s", me.Code, me.Body)
	}
	var account openapi.Account
	if err := json.Unmarshal(me.Body.Bytes(), &account); err != nil {
		t.Fatal(err)
	}
	if account.ImState != "provisioning" || account.ImUserId != nil {
		t.Fatalf("GET /me account = %#v", account)
	}
	unready := performJSON(
		t,
		handler,
		http.MethodPost,
		"/v1/me/im/session",
		nil,
		*auth.AccessToken,
	)
	assertAPIError(
		t,
		unready,
		http.StatusServiceUnavailable,
		"im_session_unavailable",
	)

	_, err = handle.Client().Account.UpdateOneID(account.Id.String()).
		SetImUserID("u_OPAQUE").
		SetImState("ready").
		AddRevision(1).
		Save(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	sessionResponse := performJSON(
		t,
		handler,
		http.MethodPost,
		"/v1/me/im/session",
		nil,
		*auth.AccessToken,
	)
	if sessionResponse.Code != http.StatusOK {
		t.Fatalf(
			"IM session status = %d body=%s",
			sessionResponse.Code,
			sessionResponse.Body,
		)
	}
	assertSensitiveHeaders(t, sessionResponse)
	var session openapi.ImSession
	if err := json.Unmarshal(sessionResponse.Body.Bytes(), &session); err != nil {
		t.Fatal(err)
	}
	if session.SdkAppId != 1600000000 ||
		session.UserId != "u_OPAQUE" ||
		session.UserSig == nil ||
		*session.UserSig != "short-lived-user-sig" ||
		!session.ExpiresAt.Equal(expiry) ||
		issuer.userID != "u_OPAQUE" ||
		issuer.ttl != time.Hour {
		t.Fatalf("session = %#v issuer=(%q,%v)", session, issuer.userID, issuer.ttl)
	}
}

func TestHumanAPIMeJITMapsVerifiedLightVelaAccountWithoutLocalSession(t *testing.T) {
	handle := openHumanAPIDatabase(t)
	handler, err := NewHumanAPIHandler(HumanAPIConfig{
		Auth: AuthAPIConfig{
			Database:          handle,
			AccessTokenKey:    bytes.Repeat([]byte{0x42}, 32),
			GatewayHumanToken: []byte("service-gateway-internal-token"),
			Password:          credentialsadapter.TestArgon2idConfig(),
			AccessTTL:         15 * time.Minute,
			RefreshTTL:        30 * 24 * time.Hour,
			RequestTimeout:    5 * time.Second,
			MaxBodyBytes:      16 * 1024,
		},
		SDKAppID:      1600000000,
		UserSigTTL:    time.Hour,
		UserSigIssuer: &recordingUserSigIssuer{},
	})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, "/v1/me", nil)
	request.Header.Set("Authorization", "Bearer service-gateway-internal-token")
	request.Header.Set("X-Lightclaw-User-ID", "usr_0123456789abcdef01234567")
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("GET /me status = %d body=%s", response.Code, response.Body)
	}
	if count, err := handle.Client().Account.Query().Count(context.Background()); err != nil || count != 1 {
		t.Fatalf("account count = %d, %v", count, err)
	}
	if count, err := handle.Client().AuthSession.Query().Count(context.Background()); err != nil || count != 0 {
		t.Fatalf("auth session count = %d, %v", count, err)
	}
}

func TestHumanAPIDisablesLocalRegistrationWhenGatewayIdentityIsConfigured(t *testing.T) {
	handle := openHumanAPIDatabase(t)
	handler, err := NewHumanAPIHandler(HumanAPIConfig{
		Auth: AuthAPIConfig{
			Database:          handle,
			AccessTokenKey:    bytes.Repeat([]byte{0x42}, 32),
			GatewayHumanToken: []byte("service-gateway-internal-token"),
			Password:          credentialsadapter.TestArgon2idConfig(),
			AccessTTL:         15 * time.Minute,
			RefreshTTL:        30 * 24 * time.Hour,
			RequestTimeout:    5 * time.Second,
			MaxBodyBytes:      16 * 1024,
		},
		SDKAppID:      1600000000,
		UserSigTTL:    time.Hour,
		UserSigIssuer: &recordingUserSigIssuer{},
	})
	if err != nil {
		t.Fatal(err)
	}
	response := performJSON(t, handler, http.MethodPost, "/v1/auth/register", map[string]any{
		"email": "second-account@example.com", "password": "password-123", "displayName": "Duplicate",
	}, "")
	if response.Code != http.StatusNotFound {
		t.Fatalf("register status = %d body=%s", response.Code, response.Body)
	}
	if count, err := handle.Client().Account.Query().Count(context.Background()); err != nil || count != 0 {
		t.Fatalf("account count = %d, %v", count, err)
	}
}

func TestHumanAPIRequiresBearerForMe(t *testing.T) {
	handle := openHumanAPIDatabase(t)
	handler, err := NewHumanAPIHandler(HumanAPIConfig{
		Auth: AuthAPIConfig{
			Database:       handle,
			AccessTokenKey: bytes.Repeat([]byte{0x42}, 32),
			Password:       credentialsadapter.TestArgon2idConfig(),
			AccessTTL:      15 * time.Minute,
			RefreshTTL:     30 * 24 * time.Hour,
			RequestTimeout: 5 * time.Second,
			MaxBodyBytes:   16 * 1024,
		},
		SDKAppID:      1600000000,
		UserSigTTL:    time.Hour,
		UserSigIssuer: &recordingUserSigIssuer{},
	})
	if err != nil {
		t.Fatal(err)
	}
	response := performJSON(
		t,
		handler,
		http.MethodGet,
		"/v1/me",
		nil,
		"",
	)
	assertAPIError(t, response, http.StatusUnauthorized, "unauthenticated")
}

func openHumanAPIDatabase(t *testing.T) *database.Handle {
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
	t.Cleanup(func() { _ = handle.Close() })
	if err := migration.Apply(context.Background(), handle.SQLDB()); err != nil {
		t.Fatal(err)
	}
	return handle
}
