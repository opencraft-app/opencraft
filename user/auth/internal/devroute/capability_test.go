package devroute

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"testing"
	"time"
)

func testCapability(uin string) (string, string) {
	token := developerCapabilityPrefix + "." + uin + "." + base64.RawURLEncoding.EncodeToString(make([]byte, 32))
	digest := sha256.Sum256([]byte(token))
	return token, hex.EncodeToString(digest[:])
}

func TestCapabilityVerifierAcceptsActiveMatchingRegistration(t *testing.T) {
	now := time.Date(2026, 9, 22, 8, 0, 0, 0, time.UTC)
	token, digest := testCapability("450860000023")
	registry := NewMemoryRegistry()
	if err := registry.Upsert(context.Background(), StoredRegistration{
		UIN: "450860000023", UserID: "usr_test", DeliveryMode: "devtunnel",
		SourceIP: "9.1.2.3", Port: 18084, BaseURL: "http://devtunnel.testing",
		TunnelHost: "uin-450860000023.tunnel.internal", TunnelTokenHash: digest,
		RenewedAt: now.Add(-time.Minute), TTLSeconds: 3600,
	}); err != nil {
		t.Fatal(err)
	}
	got, err := (CapabilityVerifier{Registry: registry, Now: func() time.Time { return now }}).Verify(context.Background(), token)
	if err != nil || got.UIN != "450860000023" || got.UserID != "usr_test" {
		t.Fatalf("Verify() registration=%+v err=%v", got, err)
	}
}

func TestCapabilityVerifierRejectsInvalidRevokedAndExpiredTokens(t *testing.T) {
	now := time.Date(2026, 9, 22, 8, 0, 0, 0, time.UTC)
	token, digest := testCapability("450860000023")
	tests := []struct {
		name         string
		token        string
		registration StoredRegistration
	}{
		{name: "malformed token", token: "invalid"},
		{name: "digest mismatch", token: token, registration: StoredRegistration{
			UIN: "450860000023", UserID: "usr_test", DeliveryMode: "devtunnel", RenewedAt: now, TTLSeconds: 3600,
			TunnelTokenHash: hex.EncodeToString(make([]byte, sha256.Size)),
		}},
		{name: "expired", token: token, registration: StoredRegistration{
			UIN: "450860000023", UserID: "usr_test", DeliveryMode: "devtunnel", RenewedAt: now.Add(-time.Hour), TTLSeconds: 60,
			TunnelTokenHash: digest,
		}},
		{name: "disabled", token: token, registration: StoredRegistration{
			UIN: "450860000023", UserID: "usr_test", DeliveryMode: "devtunnel", RenewedAt: now, TTLSeconds: 3600,
			TunnelTokenHash: digest, DisabledAt: func() *time.Time { value := now; return &value }(),
		}},
		{name: "wrong delivery mode", token: token, registration: StoredRegistration{
			UIN: "450860000023", UserID: "usr_test", DeliveryMode: "direct", RenewedAt: now, TTLSeconds: 3600,
			TunnelTokenHash: digest,
		}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			registry := NewMemoryRegistry()
			if tc.registration.UIN != "" {
				if err := registry.Upsert(context.Background(), tc.registration); err != nil {
					t.Fatal(err)
				}
				if tc.registration.DisabledAt != nil {
					if err := registry.Disable(context.Background(), tc.registration.UIN, *tc.registration.DisabledAt); err != nil {
						t.Fatal(err)
					}
				}
			}
			_, err := (CapabilityVerifier{Registry: registry, Now: func() time.Time { return now }}).Verify(context.Background(), tc.token)
			if !errors.Is(err, ErrInvalidCapability) {
				t.Fatalf("Verify() err=%v, want ErrInvalidCapability", err)
			}
		})
	}
}
