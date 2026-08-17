package selfupdate

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

type testDescriptorDocument struct {
	SchemaVersion   int    `json:"schemaVersion"`
	Channel         string `json:"channel"`
	Target          string `json:"target"`
	Sequence        int64  `json:"sequence"`
	ExpectedVersion string `json:"expectedVersion"`
	CatalogSHA256   string `json:"catalogSHA256"`
	IssuedAt        string `json:"issuedAt"`
}

type testEnvelopeDocument struct {
	SchemaVersion int    `json:"schemaVersion"`
	Payload       string `json:"payload"`
	Signature     struct {
		Algorithm string `json:"algorithm"`
		KeyID     string `json:"keyId"`
		Value     string `json:"value"`
	} `json:"signature"`
	Downloads struct {
		CatalogURL           string `json:"catalogUrl"`
		ManifestURL          string `json:"manifestUrl"`
		ManifestSignatureURL string `json:"manifestSignatureUrl"`
		ProgramURL           string `json:"programUrl"`
		ExpiresAt            string `json:"expiresAt"`
	} `json:"downloads"`
}

func TestVerifyChannelEnvelopeAuthenticatesExactPayloadAndRejectsTampering(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 8, 17, 20, 0, 0, 0, time.UTC)
	catalogDigest := sha256.Sum256([]byte("catalog"))
	payload, err := json.Marshal(testDescriptorDocument{
		SchemaVersion: 1, Channel: "stable", Target: "linux-amd64", Sequence: 7,
		ExpectedVersion: "v0.1.52", CatalogSHA256: hex.EncodeToString(catalogDigest[:]),
		IssuedAt: now.Add(-time.Hour).Format(time.RFC3339Nano),
	})
	if err != nil {
		t.Fatal(err)
	}
	document := testEnvelopeDocument{SchemaVersion: 1, Payload: base64.RawURLEncoding.EncodeToString(payload)}
	document.Signature.Algorithm = "ed25519"
	document.Signature.KeyID = "computer-channel-2026-08"
	document.Signature.Value = base64.RawURLEncoding.EncodeToString(ed25519.Sign(privateKey, payload))
	document.Downloads.CatalogURL = "https://release.cos.ap-beijing.myqcloud.com/catalog"
	document.Downloads.ManifestURL = "https://release.cos.ap-beijing.myqcloud.com/manifest"
	document.Downloads.ManifestSignatureURL = "https://release.cos.ap-beijing.myqcloud.com/signature"
	document.Downloads.ProgramURL = "https://release.cos.ap-beijing.myqcloud.com/program"
	document.Downloads.ExpiresAt = now.Add(5 * time.Minute).Format(time.RFC3339Nano)
	raw, err := json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}

	verified, err := VerifyChannelEnvelope(raw, VerifyChannelConfig{
		Channel: "stable", Target: "linux-amd64", Now: now,
		KeyID: "computer-channel-2026-08", PublicKey: publicKey,
	})
	if err != nil {
		t.Fatal(err)
	}
	if verified.Descriptor.Sequence != 7 || verified.Descriptor.ExpectedVersion != "v0.1.52" ||
		verified.Descriptor.CatalogSHA256 != catalogDigest || verified.PayloadSHA256 != sha256.Sum256(payload) {
		t.Fatalf("verified envelope = %#v", verified)
	}

	tampered := document
	tampered.Payload = strings.TrimSuffix(tampered.Payload, tampered.Payload[len(tampered.Payload)-1:]) + "A"
	tamperedRaw, _ := json.Marshal(tampered)
	if _, err := VerifyChannelEnvelope(tamperedRaw, VerifyChannelConfig{
		Channel: "stable", Target: "linux-amd64", Now: now,
		KeyID: "computer-channel-2026-08", PublicKey: publicKey,
	}); err == nil {
		t.Fatal("tampered signed payload was accepted")
	}

	unknown := append(append([]byte(nil), raw[:len(raw)-1]...), []byte(`,"computerId":"must-not-exist"}`)...)
	if _, err := VerifyChannelEnvelope(unknown, VerifyChannelConfig{
		Channel: "stable", Target: "linux-amd64", Now: now,
		KeyID: "computer-channel-2026-08", PublicKey: publicKey,
	}); err == nil {
		t.Fatal("unknown identity field was accepted")
	}
}
