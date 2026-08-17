package selfupdate

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestChannelClientReadsAnonymouslyWithoutComputerIdentity(t *testing.T) {
	t.Parallel()
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 8, 17, 22, 0, 0, 0, time.UTC)
	catalogDigest := sha256.Sum256([]byte("catalog"))
	payload, _ := json.Marshal(testDescriptorDocument{
		SchemaVersion: 1, Channel: "stable", Target: "linux-amd64", Sequence: 8,
		ExpectedVersion: "v0.1.52", CatalogSHA256: hex.EncodeToString(catalogDigest[:]),
		IssuedAt: now.Add(-time.Minute).Format(time.RFC3339Nano),
	})
	document := testEnvelopeDocument{SchemaVersion: 1, Payload: base64.RawURLEncoding.EncodeToString(payload)}
	document.Signature.Algorithm = "ed25519"
	document.Signature.KeyID = "computer-channel-2026-08"
	document.Signature.Value = base64.RawURLEncoding.EncodeToString(ed25519.Sign(privateKey, payload))
	document.Downloads.CatalogURL = "https://release.cos.ap-beijing.myqcloud.com/catalog"
	document.Downloads.ManifestURL = "https://release.cos.ap-beijing.myqcloud.com/manifest"
	document.Downloads.ManifestSignatureURL = "https://release.cos.ap-beijing.myqcloud.com/signature"
	document.Downloads.ProgramURL = "https://release.cos.ap-beijing.myqcloud.com/program"
	document.Downloads.ExpiresAt = now.Add(5 * time.Minute).Format(time.RFC3339Nano)
	raw, _ := json.Marshal(document)

	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet || request.URL.Path != "/computer-releases/stable/linux-amd64" ||
			request.URL.RawQuery != "" || request.Header.Get("Authorization") != "" ||
			request.Header.Get("Cookie") != "" || request.Header.Get("X-Computer-ID") != "" ||
			request.Header.Get("X-Server-ID") != "" {
			t.Errorf("anonymous update request = %s %s headers=%v", request.Method, request.URL.String(), request.Header)
		}
		writer.Header().Set("Content-Type", "application/json")
		writer.Header().Set("Cache-Control", "no-store")
		_, _ = writer.Write(raw)
	}))
	defer server.Close()
	client, err := NewChannelClient(ChannelClientConfig{
		BaseURL: server.URL, HTTPClient: server.Client(), AllowInsecureLoopback: true,
		Channel: "stable", Target: "linux-amd64", KeyID: "computer-channel-2026-08",
		PublicKey: publicKey, Now: func() time.Time { return now },
	})
	if err != nil {
		t.Fatal(err)
	}
	verified, err := client.Get(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if verified.Descriptor.Sequence != 8 || verified.Descriptor.ExpectedVersion != "v0.1.52" {
		t.Fatalf("Get() = %#v", verified)
	}
}
