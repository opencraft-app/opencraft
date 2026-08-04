//go:build darwin || linux

package platform

import (
	"context"
	"encoding/pem"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
)

var testNow = time.Date(2026, 7, 30, 12, 0, 0, 0, time.UTC)

func TestSessionSecretsAreRedacted(t *testing.T) {
	t.Parallel()

	accessToken, err := NewAccessToken("runtime-access-token")
	if err != nil {
		t.Fatal(err)
	}
	userSig, err := NewUserSig("short-usersig")
	if err != nil {
		t.Fatal(err)
	}
	for _, value := range []any{accessToken, userSig} {
		formatted := fmt.Sprintf("%#v", value)
		if formatted != "[REDACTED]" ||
			strings.Contains(formatted, "short-usersig") ||
			strings.Contains(formatted, "runtime-access-token") {
			t.Fatalf("unsafe secret formatting: %q", formatted)
		}
		if encoded, err := common.Marshal(value); err == nil {
			t.Fatalf("secret unexpectedly marshaled as %s", encoded)
		}
	}
}

func TestClientRejectsRemoteHTTPAndClassifiesComputerCredentialFailure(
	t *testing.T,
) {
	t.Parallel()

	if _, err := NewClient(Config{
		BaseURL:       "http://example.com",
		Now:           func() time.Time { return testNow },
		MaxSessionTTL: time.Hour,
	}); !errors.Is(err, ErrInvalidConfig) {
		t.Fatalf("remote HTTP error = %v", err)
	}

	server := httptest.NewServer(http.HandlerFunc(func(
		writer http.ResponseWriter,
		_ *http.Request,
	) {
		writer.WriteHeader(http.StatusUnauthorized)
	}))
	defer server.Close()
	client, err := NewClient(Config{
		BaseURL:               server.URL,
		HTTPClient:            server.Client(),
		AllowInsecureLoopback: true,
		Now:                   func() time.Time { return testNow },
		MaxSessionTTL:         time.Hour,
	})
	if err != nil {
		t.Fatal(err)
	}
	credential, err := NewComputerCredential(computerCredentialFixture())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.CreateComputerSession(
		context.Background(), credential,
	); !errors.Is(err, ErrCredentialRejected) {
		t.Fatalf("credential error = %v", err)
	}
}

func TestClientAllowsEnrollmentApprovedPrivateHTTP(t *testing.T) {
	t.Parallel()

	client, err := NewClient(Config{
		BaseURL:           "http://192.0.2.10",
		AllowInsecureHTTP: true,
		Now:               func() time.Time { return testNow },
		MaxSessionTTL:     time.Hour,
	})
	if err != nil {
		t.Fatalf("approved private HTTP error = %v", err)
	}
	if client.baseURL != "http://192.0.2.10/v1" {
		t.Fatalf("base URL = %q", client.baseURL)
	}
}

func TestClientHonorsSSL_CERT_FILEForPrivatePlatformCA(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(
		writer http.ResponseWriter,
		_ *http.Request,
	) {
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(http.StatusCreated)
		writeComputerJSON(t, writer, map[string]any{
			"accessToken": "computer-short-token",
			"expiresAt":   testNow.Add(30 * time.Minute),
			"computer": map[string]any{
				"id": computerTestID, "serverId": computerTestServerID,
				"credentialVersion": 1, "assignmentEpoch": computerTestEpoch,
				"assignmentRevision": 1,
			},
			"assignmentVersions": []int{1},
		})
	}))
	defer server.Close()

	certificate := pem.EncodeToMemory(&pem.Block{
		Type:  "CERTIFICATE",
		Bytes: server.Certificate().Raw,
	})
	caFile := filepath.Join(t.TempDir(), "platform-ca.pem")
	if err := os.WriteFile(caFile, certificate, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SSL_CERT_FILE", caFile)

	client, err := NewClient(Config{
		BaseURL:       server.URL,
		Now:           func() time.Time { return testNow },
		MaxSessionTTL: 2 * time.Hour,
	})
	if err != nil {
		t.Fatal(err)
	}
	credential, err := NewComputerCredential(computerCredentialFixture())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.CreateComputerSession(
		context.Background(), credential,
	); err != nil {
		t.Fatalf("CreateComputerSession() with SSL_CERT_FILE: %v", err)
	}
}
