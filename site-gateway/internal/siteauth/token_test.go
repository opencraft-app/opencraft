package siteauth

import (
	"encoding/base64"
	"strings"
	"testing"
	"time"
)

func TestTokenCodecRoundTripsAllAuthArtifacts(t *testing.T) {
	now := time.Date(2026, 8, 24, 10, 0, 0, 0, time.UTC)
	codec, err := NewTokenCodec(TokenCodecConfig{
		ActiveKeyID: "key-1",
		Keys: map[string][]byte{
			"key-1": []byte("0123456789abcdef0123456789abcdef"),
		},
		Clock: func() time.Time { return now },
	})
	if err != nil {
		t.Fatal(err)
	}

	launchRaw, err := codec.SealLaunch(LaunchClaims{
		SiteID:      "ws-abc",
		SiteHost:    "ws-abc.lightvela.tech",
		ReturnTo:    "/about?tab=security",
		CallbackURL: "https://sites-auth.lightvela.tech/auth/lightvela/callback",
	})
	if err != nil {
		t.Fatal(err)
	}
	launch, err := codec.OpenLaunch(launchRaw)
	if err != nil {
		t.Fatal(err)
	}
	if launch.SiteID != "ws-abc" || launch.SiteHost != "ws-abc.lightvela.tech" || launch.ReturnTo != "/about?tab=security" {
		t.Fatalf("launch = %+v", launch)
	}

	stateRaw, err := codec.SealState(StateClaims{
		SiteID:       launch.SiteID,
		SiteHost:     launch.SiteHost,
		ReturnTo:     launch.ReturnTo,
		CallbackURL:  launch.CallbackURL,
		State:        "state-1",
		PKCEVerifier: "pkce-verifier-1",
		Nonce:        "nonce-1",
		LaunchDigest: DigestToken(launchRaw),
	})
	if err != nil {
		t.Fatal(err)
	}
	state, err := codec.OpenState(stateRaw)
	if err != nil {
		t.Fatal(err)
	}
	if state.SiteID != "ws-abc" || state.State != "state-1" || state.PKCEVerifier != "pkce-verifier-1" || state.LaunchDigest != DigestToken(launchRaw) {
		t.Fatalf("state = %+v", state)
	}

	handoffRaw, err := codec.SealHandoff(HandoffClaims{
		SiteID:   "ws-abc",
		SiteHost: "ws-abc.lightvela.tech",
		UserID:   "user-1",
		Nonce:    "nonce-1",
		ReturnTo: "/about?tab=security",
	})
	if err != nil {
		t.Fatal(err)
	}
	handoff, err := codec.OpenHandoff(handoffRaw, "ws-abc.lightvela.tech")
	if err != nil {
		t.Fatal(err)
	}
	if handoff.SiteID != "ws-abc" || handoff.UserID != "user-1" || handoff.ReturnTo != "/about?tab=security" {
		t.Fatalf("handoff = %+v", handoff)
	}

	sessionRaw, err := codec.SealSession(SessionClaims{
		SiteID:   "ws-abc",
		SiteHost: "ws-abc.lightvela.tech",
		UserID:   "user-1",
		Nonce:    "nonce-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	session, err := codec.OpenSession(sessionRaw, "ws-abc.lightvela.tech")
	if err != nil {
		t.Fatal(err)
	}
	if session.SiteID != "ws-abc" || session.UserID != "user-1" || session.SiteHost != "ws-abc.lightvela.tech" {
		t.Fatalf("session = %+v", session)
	}
}

func TestTokenCodecRejectsTamperingAndSiblingHostReplay(t *testing.T) {
	now := time.Date(2026, 8, 24, 10, 0, 0, 0, time.UTC)
	codec, err := NewTokenCodec(TokenCodecConfig{
		ActiveKeyID: "key-1",
		Keys: map[string][]byte{
			"key-1": []byte("0123456789abcdef0123456789abcdef"),
		},
		Clock: func() time.Time { return now },
	})
	if err != nil {
		t.Fatal(err)
	}

	handoffRaw, err := codec.SealHandoff(HandoffClaims{
		SiteID:   "ws-abc",
		SiteHost: "ws-abc.lightvela.tech",
		UserID:   "user-1",
		Nonce:    "nonce-1",
		ReturnTo: "/",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := codec.OpenHandoff(handoffRaw, "ws-other.lightvela.tech"); err == nil {
		t.Fatal("sibling-host replay unexpectedly succeeded")
	}
	if _, err := codec.OpenHandoff(tamperEncodedPayload(t, handoffRaw), "ws-abc.lightvela.tech"); err == nil {
		t.Fatal("tampered handoff unexpectedly succeeded")
	}
	if _, err := codec.OpenSession(handoffRaw, "ws-abc.lightvela.tech"); err == nil {
		t.Fatal("cross-scope replay unexpectedly succeeded")
	}
}

func TestTokenCodecKeepsShareSessionsSeparateAndGenerationBound(t *testing.T) {
	now := time.Date(2026, 8, 24, 10, 0, 0, 0, time.UTC)
	current := now
	codec, err := NewTokenCodec(TokenCodecConfig{
		ActiveKeyID: "key-1",
		Keys: map[string][]byte{
			"key-1": []byte("0123456789abcdef0123456789abcdef"),
		},
		Clock:      func() time.Time { return current },
		SessionTTL: 5 * time.Minute,
	})
	if err != nil {
		t.Fatal(err)
	}

	raw, err := codec.SealShareSession(ShareSessionClaims{
		SiteID: "ws-abc", SiteHost: "ws-abc.lightvela.tech", Generation: "generation-9", Nonce: "nonce-1",
	}, now.Add(30*24*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	claims, err := codec.OpenShareSession(raw, "ws-abc.lightvela.tech")
	if err != nil {
		t.Fatal(err)
	}
	if claims.SiteID != "ws-abc" || claims.Generation != "generation-9" || claims.Nonce != "nonce-1" {
		t.Fatalf("share claims = %+v", claims)
	}
	if _, err := codec.OpenShareSession(raw, "ws-other.lightvela.tech"); err == nil {
		t.Fatal("share session replay on sibling host unexpectedly succeeded")
	}
	if _, err := codec.OpenSession(raw, "ws-abc.lightvela.tech"); err == nil {
		t.Fatal("share session replayed as owner session")
	}

	current = now.Add(30 * 24 * time.Hour)
	if _, err := codec.OpenShareSession(raw, "ws-abc.lightvela.tech"); err == nil {
		t.Fatal("share session remained valid at its exact expiry")
	}
}

func TestTokenCodecRejectsShareTTLOverThirtyDaysWithoutRelaxingOwnerTTL(t *testing.T) {
	base := TokenCodecConfig{
		ActiveKeyID: "key-1",
		Keys: map[string][]byte{
			"key-1": []byte("0123456789abcdef0123456789abcdef"),
		},
	}
	codec, err := NewTokenCodec(base)
	if err != nil {
		t.Fatal(err)
	}
	claims := ShareSessionClaims{
		SiteID: "ws-abc", SiteHost: "ws-abc.lightvela.tech", Generation: "generation-1", Nonce: "nonce-1",
	}
	if _, err := codec.SealShareSession(claims, time.Now().Add(30*24*time.Hour+time.Second)); err == nil {
		t.Fatal("share TTL over thirty days unexpectedly succeeded")
	}
	if _, err := codec.SealShareSession(claims, time.Time{}); err == nil {
		t.Fatal("zero share TTL unexpectedly succeeded")
	}
	tooLongOwner := base
	tooLongOwner.SessionTTL = 5*time.Minute + time.Second
	if _, err := NewTokenCodec(tooLongOwner); err == nil {
		t.Fatal("owner TTL over five minutes unexpectedly succeeded")
	}
}

func TestShareSessionExpiresAtAbsoluteRedisDeadlineDespiteClockDrift(t *testing.T) {
	base := time.Date(2026, 8, 24, 10, 0, 0, 0, time.UTC)
	current := base.Add(503 * time.Millisecond)
	codec, err := NewTokenCodec(TokenCodecConfig{
		ActiveKeyID: "key-1",
		Keys: map[string][]byte{
			"key-1": []byte("0123456789abcdef0123456789abcdef"),
		},
		Clock:      func() time.Time { return current },
		SessionTTL: 5 * time.Minute,
	})
	if err != nil {
		t.Fatal(err)
	}
	expiresAt := base.Add(2999 * time.Millisecond)
	raw, err := codec.SealShareSession(ShareSessionClaims{
		SiteID: "ws-abc", SiteHost: "ws-abc.lightvela.tech", Generation: "generation-9", Nonce: "nonce-1",
	}, expiresAt)
	if err != nil {
		t.Fatal(err)
	}

	current = expiresAt
	if _, err := codec.OpenShareSession(raw, "ws-abc.lightvela.tech"); err == nil {
		t.Fatal("share session remained valid at the absolute Redis expiry")
	}
}

func tamperEncodedPayload(t *testing.T, raw string) string {
	t.Helper()

	parts := strings.SplitN(raw, ".", 2)
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		t.Fatalf("invalid token format: %q", raw)
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	if len(payload) == 0 {
		t.Fatal("empty token payload")
	}
	payload[len(payload)-1] ^= 0x01
	return parts[0] + "." + base64.RawURLEncoding.EncodeToString(payload)
}
