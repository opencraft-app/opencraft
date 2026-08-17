package computerupdate

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"testing"
	"time"
)

func TestSignAndVerifyChannelDescriptorUsesExactPayloadBytes(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 8, 17, 14, 0, 0, 0, time.UTC)
	privateKey := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{0x42}, ed25519.SeedSize))
	descriptor := ChannelDescriptor{
		SchemaVersion:   1,
		Channel:         "stable",
		Target:          "linux-amd64",
		Sequence:        7,
		ExpectedVersion: "v0.1.52",
		CatalogSHA256:   bytes.Repeat([]byte{0xab}, 32),
		IssuedAt:        now,
	}
	signed, err := SignDescriptor(
		descriptor,
		"computer-channel-2026-08",
		privateKey,
	)
	if err != nil {
		t.Fatal(err)
	}
	payload, err := base64.RawURLEncoding.DecodeString(signed.Payload)
	if err != nil {
		t.Fatal(err)
	}
	wantPayload := `{"schemaVersion":1,"channel":"stable","target":"linux-amd64","sequence":7,"expectedVersion":"v0.1.52","catalogSHA256":"abababababababababababababababababababababababababababababababab","issuedAt":"2026-08-17T14:00:00Z"}`
	if string(payload) != wantPayload {
		t.Fatalf("payload = %s", payload)
	}
	verified, digest, err := VerifySignedDescriptor(
		signed,
		map[string]ed25519.PublicKey{
			"computer-channel-2026-08": privateKey.Public().(ed25519.PublicKey),
		},
		"stable",
		"linux-amd64",
	)
	if err != nil {
		t.Fatal(err)
	}
	if verified.Sequence != descriptor.Sequence ||
		verified.ExpectedVersion != descriptor.ExpectedVersion ||
		len(digest) != 32 {
		t.Fatalf("verified = %#v digest=%x", verified, digest)
	}

	tampered := signed
	tampered.Payload = base64.RawURLEncoding.EncodeToString(
		bytes.Replace(payload, []byte("v0.1.52"), []byte("v0.1.53"), 1),
	)
	if _, _, err := VerifySignedDescriptor(
		tampered,
		map[string]ed25519.PublicKey{
			"computer-channel-2026-08": privateKey.Public().(ed25519.PublicKey),
		},
		"stable",
		"linux-amd64",
	); err == nil {
		t.Fatal("tampered payload verified")
	}
}

func TestChannelDescriptorRejectsInvalidAuthorityFields(t *testing.T) {
	t.Parallel()
	valid := ChannelDescriptor{
		SchemaVersion:   1,
		Channel:         "canary",
		Target:          "darwin-arm64",
		Sequence:        1,
		ExpectedVersion: "v0.1.51",
		CatalogSHA256:   bytes.Repeat([]byte{0xcd}, 32),
		IssuedAt:        time.Date(2026, 8, 17, 14, 0, 0, 0, time.UTC),
	}
	tests := []struct {
		name   string
		mutate func(*ChannelDescriptor)
	}{
		{"schema", func(value *ChannelDescriptor) { value.SchemaVersion = 2 }},
		{"channel", func(value *ChannelDescriptor) { value.Channel = "latest" }},
		{"target", func(value *ChannelDescriptor) { value.Target = "linux-arm64" }},
		{"sequence", func(value *ChannelDescriptor) { value.Sequence = 0 }},
		{"version", func(value *ChannelDescriptor) { value.ExpectedVersion = "latest" }},
		{"digest", func(value *ChannelDescriptor) { value.CatalogSHA256 = []byte{1} }},
		{"issued", func(value *ChannelDescriptor) { value.IssuedAt = time.Time{} }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			value := valid
			value.CatalogSHA256 = append([]byte(nil), valid.CatalogSHA256...)
			test.mutate(&value)
			if err := ValidateDescriptor(value); err == nil {
				t.Fatalf("ValidateDescriptor(%#v) succeeded", value)
			}
		})
	}
}
