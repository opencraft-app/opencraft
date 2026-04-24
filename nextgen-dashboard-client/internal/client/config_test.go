package client

import "testing"

func TestResolveWebSocketURLFromAdminBase(t *testing.T) {
	t.Parallel()

	target, err := ResolveWebSocketURL("https://lightclaw.tech/admin")
	if err != nil {
		t.Fatalf("ResolveWebSocketURL returned error: %v", err)
	}
	if target != "wss://lightclaw.tech/admin/ws/terminal" {
		t.Fatalf("expected admin websocket url, got %q", target)
	}
}

func TestResolveWebSocketURLPreservesDirectWebSocketTarget(t *testing.T) {
	t.Parallel()

	target, err := ResolveWebSocketURL("wss://lightclaw.tech/admin/ws/terminal")
	if err != nil {
		t.Fatalf("ResolveWebSocketURL returned error: %v", err)
	}
	if target != "wss://lightclaw.tech/admin/ws/terminal" {
		t.Fatalf("expected direct websocket target to be preserved, got %q", target)
	}
}

func TestBuildAuthorizationHeaderUsesBasicAuth(t *testing.T) {
	t.Parallel()

	header := BuildAuthorizationHeader("skipzhang", "hunter2")
	const want = "Basic c2tpcHpoYW5nOmh1bnRlcjI="
	if header != want {
		t.Fatalf("expected %q, got %q", want, header)
	}
}
