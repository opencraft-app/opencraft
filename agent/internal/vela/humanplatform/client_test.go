package humanplatform

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

func TestLoginPersistsOnlyRefreshTokenAndAuthorizedRequestUsesAccessToken(t *testing.T) {
	var meCalls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/v1/auth/login":
			_, _ = writer.Write([]byte(`{"accessToken":"access-secret","refreshToken":"refresh-secret","expiresAt":"2099-01-01T00:00:00Z","account":{"id":"a1","email":"a@example.com","status":"active","imUserId":"human_a1","createdAt":"2026-01-01T00:00:00Z"}}`))
		case "/v1/me":
			meCalls.Add(1)
			if request.Header.Get("Authorization") != "Bearer access-secret" {
				t.Fatalf("authorization = %q", request.Header.Get("Authorization"))
			}
			_, _ = writer.Write([]byte(`{"id":"a1","email":"a@example.com","status":"active","imUserId":"human_a1","createdAt":"2026-01-01T00:00:00Z"}`))
		default:
			http.NotFound(writer, request)
		}
	}))
	defer server.Close()

	statePath := filepath.Join(t.TempDir(), "human", "session.json")
	client, err := NewClient(Config{BaseURL: server.URL, StatePath: statePath})
	if err != nil {
		t.Fatal(err)
	}
	account, err := client.Login(context.Background(), "a@example.com", "password123")
	if err != nil || account["id"] != "a1" {
		t.Fatalf("Login() = %#v, %v", account, err)
	}
	if _, err := client.Request(context.Background(), Request{Method: http.MethodGet, Path: "/me"}); err != nil {
		t.Fatal(err)
	}
	if meCalls.Load() != 1 {
		t.Fatalf("me calls = %d", meCalls.Load())
	}

	contents, err := os.ReadFile(statePath)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(contents), "access-secret") || !strings.Contains(string(contents), "refresh-secret") {
		t.Fatalf("session file = %s", contents)
	}
	info, err := os.Stat(statePath)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("session permissions = %o", info.Mode().Perm())
	}
}

func TestRemoteHTTPRequiresExplicitDevelopmentOverride(t *testing.T) {
	statePath := filepath.Join(t.TempDir(), "human", "session.json")
	if _, err := NewClient(Config{
		BaseURL:   "http://9.135.236.23",
		StatePath: statePath,
	}); !errors.Is(err, ErrUnsafeBaseURL) {
		t.Fatalf("default remote HTTP error = %v, want ErrUnsafeBaseURL", err)
	}
	if _, err := NewClient(Config{
		BaseURL:           "http://9.135.236.23",
		StatePath:         statePath,
		AllowInsecureHTTP: true,
	}); err != nil {
		t.Fatalf("explicit remote HTTP override: %v", err)
	}
}

func TestRestoreRotatesRefreshTokenAndNeverExposesIMSessionToGenericRequest(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/v1/auth/refresh":
			_, _ = writer.Write([]byte(`{"accessToken":"new-access","refreshToken":"new-refresh","expiresAt":"2099-01-01T00:00:00Z","account":{"id":"a1","email":"a@example.com","status":"active","imUserId":"human_a1","createdAt":"2026-01-01T00:00:00Z"}}`))
		case "/v1/me":
			_, _ = writer.Write([]byte(`{"id":"a1","email":"a@example.com","status":"active","imUserId":"human_a1","createdAt":"2026-01-01T00:00:00Z"}`))
		default:
			http.NotFound(writer, request)
		}
	}))
	defer server.Close()

	statePath := filepath.Join(t.TempDir(), "session.json")
	if err := os.WriteFile(statePath, []byte(`{"refreshToken":"old-refresh"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	client, err := NewClient(Config{BaseURL: server.URL, StatePath: statePath})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.Restore(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := client.Request(context.Background(), Request{Method: http.MethodPost, Path: "/me/im/session"}); err == nil {
		t.Fatal("generic request exposed IM session endpoint")
	}
	contents, _ := os.ReadFile(statePath)
	if !strings.Contains(string(contents), "new-refresh") || strings.Contains(string(contents), "old-refresh") {
		t.Fatalf("rotated session = %s", contents)
	}
}

func TestGenericPlatformRequestAllowsThreadReadPUTOnlyInsideSafePaths(t *testing.T) {
	if err := validateRequest(Request{
		Method: http.MethodPut,
		Path:   "/servers/server-1/channels/channel-1/threads/thread-1/read",
	}); err != nil {
		t.Fatalf("safe PUT rejected: %v", err)
	}
	if err := validateRequest(Request{
		Method: http.MethodPut,
		Path:   "/me/im/session",
	}); !errors.Is(err, ErrUnsafeRequest) {
		t.Fatalf("protected PUT error = %v, want ErrUnsafeRequest", err)
	}
}
