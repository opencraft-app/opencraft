package proxyauth

import (
	"testing"
	"time"
)

func TestMintAndValidate(t *testing.T) {
	t.Parallel()

	auth := New("test-secret")
	token, err := auth.Mint("skipzhang", time.Hour)
	if err != nil {
		t.Fatalf("mint token: %v", err)
	}

	username, err := auth.Validate(token)
	if err != nil {
		t.Fatalf("validate token: %v", err)
	}
	if username != "skipzhang" {
		t.Fatalf("expected username skipzhang, got %q", username)
	}
}

func TestValidateRejectsExpiredToken(t *testing.T) {
	t.Parallel()

	auth := New("test-secret")
	token, err := auth.Mint("skipzhang", -time.Minute)
	if err != nil {
		t.Fatalf("mint token: %v", err)
	}

	if _, err := auth.Validate(token); err == nil {
		t.Fatal("expected expired token to be rejected")
	}
}
