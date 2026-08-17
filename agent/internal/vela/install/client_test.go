package install

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"velachat/agent/internal/common"
)

const (
	testServerID     = "019fbd14-1992-73d2-bcbc-48be5a76415d"
	testComputerID   = "019fc179-4b0f-75a4-bc6d-b8348a7ab68e"
	testCredentialID = "019fcafe-15a6-7494-9da6-0f69a8e60c24"
)

func TestClientClaimsCredentialAndReplaysProviderBootstrap(t *testing.T) {
	t.Parallel()

	secret := []byte("01234567890123456789012345678901")
	secretPart := base64.RawURLEncoding.EncodeToString(secret)
	digest := sha256.Sum256([]byte(secretPart))
	token := "cen1." + testServerID + "." + testComputerID + ".1.signature"
	expiresAt := time.Now().UTC().Add(time.Hour).Truncate(time.Second)
	providerCalls := 0
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/v1/computer/enrollments:claim":
			if request.Header.Get("Authorization") != "Enrollment "+token {
				t.Fatalf("claim authorization = %q", request.Header.Get("Authorization"))
			}
			var body map[string]any
			if err := common.DecodeJson(request.Body, &body); err != nil {
				t.Fatal(err)
			}
			if body["credentialDigest"] != hex.EncodeToString(digest[:]) ||
				body["installerVersion"] != "0.2.0" {
				t.Fatalf("claim body = %#v", body)
			}
			writer.Header().Set("Content-Type", "application/json")
			writer.WriteHeader(http.StatusCreated)
			writeJSON(t, writer, map[string]any{
				"serverId": testServerID, "computerId": testComputerID,
				"credentialId": testCredentialID, "credentialVersion": 1,
				"expiresAt": expiresAt,
			})
		case "/v1/bootstrap/provider-registration":
			providerCalls++
			if request.Header.Get("Authorization") != "ComputerCredential crc_"+
				testServerID+"."+testComputerID+".1."+secretPart {
				t.Fatalf("provider authorization is invalid")
			}
			writer.Header().Set("Content-Type", "application/json")
			if providerCalls == 1 {
				writer.Header().Set("Retry-After", "1")
				writer.WriteHeader(http.StatusAccepted)
				writeJSON(t, writer, map[string]any{
					"operationId": testCredentialID, "state": "pending",
					"retryAfterSeconds": 1,
				})
				return
			}
			writeJSON(t, writer, map[string]any{
				"operationId": testCredentialID, "state": "ready",
				"protocol": "tencent-tat-register-v1", "region": "ap-beijing",
				"registerCodeId": "code-id", "registerCodeValue": "code-value",
				"tags":      []map[string]any{{"key": "agent-network-computer-id", "value": testComputerID}},
				"expiresAt": expiresAt,
			})
		default:
			http.NotFound(writer, request)
		}
	}))
	defer server.Close()

	client, err := NewClient(ClientConfig{BaseURL: server.URL, HTTP: server.Client()})
	if err != nil {
		t.Fatal(err)
	}
	claim, err := client.Claim(context.Background(), ClaimRequest{
		Token: token, SecretPart: secretPart, OSType: "macos",
		Architecture: "arm64", InstallerVersion: "0.2.0",
	})
	if err != nil {
		t.Fatal(err)
	}
	if claim.ServerID != testServerID || claim.ComputerID != testComputerID ||
		claim.Version != 1 || claim.Credential == "" {
		t.Fatalf("claim = %#v", claim)
	}
	pending, err := client.Provider(context.Background(), claim.Credential)
	if err != nil || pending.Ready || pending.RetryAfter != time.Second {
		t.Fatalf("pending = %#v, err = %v", pending, err)
	}
	ready, err := client.Provider(context.Background(), claim.Credential)
	if err != nil || !ready.Ready || ready.Registration.Region != "ap-beijing" ||
		len(ready.Registration.Tags) != 1 {
		t.Fatalf("ready = %#v, err = %v", ready, err)
	}
}

func TestValidClaimRequestAcceptsOnlyReleasedPlatformPairs(t *testing.T) {
	base := ClaimRequest{
		Token:            "cen1.0198f4c2-7a31-7c91-a6d2-7d76f9188c38.0198f4c2-7a35-7af3-a01e-0fcb31e9d84c.1.signature",
		SecretPart:       base64.RawURLEncoding.EncodeToString([]byte("01234567890123456789012345678901")),
		InstallerVersion: "v0.1.46",
	}
	for _, platform := range [][2]string{{"macos", "arm64"}, {"linux", "amd64"}} {
		request := base
		request.OSType, request.Architecture = platform[0], platform[1]
		if !validClaimRequest(request) {
			t.Errorf("released platform rejected: %s/%s", platform[0], platform[1])
		}
	}
	for _, platform := range [][2]string{{"macos", "amd64"}, {"linux", "arm64"}} {
		request := base
		request.OSType, request.Architecture = platform[0], platform[1]
		if validClaimRequest(request) {
			t.Errorf("cross-paired platform accepted: %s/%s", platform[0], platform[1])
		}
	}
}

func TestClientPreflightsRemovedComputerAndClaimsWithReplacementGrant(t *testing.T) {
	t.Parallel()

	oldCredential := "crc_" + testServerID + "." + testComputerID + ".1." +
		base64.RawURLEncoding.EncodeToString([]byte("01234567890123456789012345678901"))
	newComputerID := "019fd111-1111-7111-8111-111111111111"
	token := "cen1." + testServerID + "." + newComputerID + ".2.signature"
	grant := "rpg1.payload.signature-with-enough-bytes"
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/v1/computer/preflight":
			if request.Header.Get("Authorization") != "ComputerCredential "+oldCredential {
				t.Fatalf("preflight authorization = %q", request.Header.Get("Authorization"))
			}
			var body map[string]map[string]string
			if err := common.DecodeJson(request.Body, &body); err != nil ||
				body["replacement"]["enrollmentToken"] != token ||
				body["replacement"]["tatRegion"] != "ap-guangzhou" ||
				body["replacement"]["tatInstanceId"] != "rins-existing" {
				t.Fatalf("preflight body=%#v err=%v", body, err)
			}
			writer.Header().Set("Content-Type", "application/json")
			writer.WriteHeader(http.StatusGone)
			writeJSON(t, writer, map[string]any{
				"error": map[string]any{
					"code": "computer_removed", "message": "removed",
					"requestId": testCredentialID, "replacementGrant": grant,
				},
			})
		case "/v1/computer/enrollments:claim":
			var body map[string]any
			if err := common.DecodeJson(request.Body, &body); err != nil || body["replacementGrant"] != grant {
				t.Fatalf("claim body=%#v err=%v", body, err)
			}
			writer.Header().Set("Content-Type", "application/json")
			writer.WriteHeader(http.StatusCreated)
			writeJSON(t, writer, map[string]any{
				"serverId": testServerID, "computerId": newComputerID,
				"credentialId": testCredentialID, "credentialVersion": 1,
				"expiresAt": time.Now().UTC().Add(time.Hour),
			})
		default:
			http.NotFound(writer, request)
		}
	}))
	defer server.Close()
	client, err := NewClient(ClientConfig{BaseURL: server.URL, HTTP: server.Client()})
	if err != nil {
		t.Fatal(err)
	}
	preflight, err := client.Preflight(context.Background(), PreflightRequest{
		Credential: oldCredential, EnrollmentToken: token,
		TATRegion: "ap-guangzhou", TATInstanceID: "rins-existing",
	})
	if err != nil || preflight.Status != PreflightRemoved || preflight.ReplacementGrant != grant {
		t.Fatalf("preflight=%#v err=%v", preflight, err)
	}
	secret := base64.RawURLEncoding.EncodeToString([]byte("abcdefghijklmnopqrstuvwxyzABCDEF"))
	if _, err := client.Claim(context.Background(), ClaimRequest{
		Token: token, SecretPart: secret, OSType: "macos", Architecture: "arm64",
		InstallerVersion: "0.2.0", ReplacementGrant: grant,
	}); err != nil {
		t.Fatal(err)
	}
}

func writeJSON(t *testing.T, writer http.ResponseWriter, value any) {
	t.Helper()
	content, err := common.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := writer.Write(content); err != nil {
		t.Fatal(err)
	}
}
