package gateway

import "testing"

func TestConfigRejectsNonLoopbackWithoutToken(t *testing.T) {
	cfg := Config{Addr: "0.0.0.0:8765", Command: []string{"hermes", "acp"}}
	expectTokenRequired(t, cfg.Validate())
}

func TestConfigRejectsUnspecifiedBindWithoutToken(t *testing.T) {
	cfg := Config{Addr: ":8765", Command: []string{"hermes", "acp"}}
	expectTokenRequired(t, cfg.Validate())
}

func expectTokenRequired(t *testing.T, err error) {
	t.Helper()
	if err == nil {
		t.Fatal("expected token_required error")
	}
	appErr, ok := err.(AppError)
	if !ok {
		t.Fatalf("expected AppError, got %T", err)
	}
	if appErr.Code != "security" || appErr.Kind != "token_required" {
		t.Fatalf("unexpected error: %+v", appErr)
	}
}

func TestConfigAllowsLoopbackWithoutToken(t *testing.T) {
	cfg := Config{Addr: "127.0.0.1:8765", Command: []string{"hermes", "acp"}}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("expected loopback config to pass: %v", err)
	}
}
