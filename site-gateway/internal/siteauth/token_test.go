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
