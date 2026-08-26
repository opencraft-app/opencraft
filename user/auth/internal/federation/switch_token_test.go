package federation

import (
	"bytes"
	"errors"
	"testing"
	"time"
)

func TestCodecIssuesAndParsesSwitchTokenInDedicatedScope(t *testing.T) {
	now := time.Date(2026, 8, 21, 10, 0, 0, 0, time.UTC)
	codec, err := NewCodec(CodecConfig{
		Environment: "test",
		ActiveKeyID: "k1",
		Keys:        map[string][]byte{"k1": bytes.Repeat([]byte{0x11}, 32)},
		NonceKey:    bytes.Repeat([]byte{0x22}, 32),
	})
	if err != nil {
		t.Fatal(err)
	}

	token, err := codec.IssueSwitch(SwitchClaims{
		SourceSessionToken: "old-session",
		UserID:             "user-old",
		IssuedAt:           now,
		ExpiresAt:          now.Add(5 * time.Minute),
	})
	if err != nil {
		t.Fatalf("IssueSwitch: %v", err)
	}
	claims, err := codec.ParseSwitch(token, now.Add(time.Minute))
	if err != nil {
		t.Fatalf("ParseSwitch: %v", err)
	}
	if claims.SourceSessionToken != "old-session" || claims.UserID != "user-old" {
		t.Fatalf("unexpected switch claims: %+v", claims)
	}
	if _, err := codec.ParseHandoff(token, now); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("switch token parsed as handoff: %v", err)
	}
	if _, err := codec.ParseSwitch(token, now.Add(6*time.Minute)); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("expired switch token error = %v, want ErrInvalidToken", err)
	}
}
