package devroute

import (
	"bytes"
	"context"
	"testing"
	"time"

	"github.com/openclaw/openclaw/mono/cloudladdergateway/internal/tunnelcap"
)

func TestTunnelCapabilityVerifierTracksRegistrationState(t *testing.T) {
	now := time.Date(2026, 9, 8, 10, 0, 0, 0, time.UTC)
	token, digest, err := tunnelcap.Issue("450860000013", bytes.NewReader(bytes.Repeat([]byte{3}, 32)))
	if err != nil {
		t.Fatal(err)
	}
	store := NewMemoryStore()
	registration := Registration{
		UIN: "450860000013", DeliveryMode: DeliveryModeDevtunnel,
		BaseURL: "http://devtunnel.testing", SourceIP: "9.134.214.121", Port: 18084,
		TunnelHost: "uin-450860000013.sg.tunnel.internal", TunnelTokenHash: digest,
		RenewedAt: now, TTL: time.Hour,
	}
	if err := store.Upsert(context.Background(), registration); err != nil {
		t.Fatal(err)
	}
	verifier := TunnelCapabilityVerifier{Store: store, Now: func() time.Time { return now }}
	if err := verifier.Verify(context.Background(), token, registration.TunnelHost); err != nil {
		t.Fatalf("valid capability rejected: %v", err)
	}
	if err := verifier.Verify(context.Background(), token, "uin-450860000014.sg.tunnel.internal"); err == nil {
		t.Fatal("capability was accepted for another tunnel host")
	}
	if err := store.Disable(context.Background(), registration.UIN, now); err != nil {
		t.Fatal(err)
	}
	if err := verifier.Verify(context.Background(), token, registration.TunnelHost); err == nil {
		t.Fatal("disabled registration did not revoke capability")
	}
}
