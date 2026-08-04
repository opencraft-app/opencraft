package credentials

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"strings"
	"testing"
)

const (
	refreshAccountID = "01989c24-7540-7f12-a27b-c83243215dd1"
	refreshSessionID = "01989c24-7540-7f12-a27b-c83243215dd2"
)

func TestRefreshTokensRoundTripRouteAndFullDigest(t *testing.T) {
	random := bytes.NewReader(bytes.Repeat([]byte{0x42}, 32))
	codec, err := NewRefreshTokens(random)
	if err != nil {
		t.Fatal(err)
	}

	issued, err := codec.Issue(
		context.Background(),
		refreshAccountID,
		refreshSessionID,
	)
	if err != nil {
		t.Fatalf("Issue() error = %v", err)
	}
	if !strings.HasPrefix(
		issued.Plaintext,
		"rt1."+refreshAccountID+"."+refreshSessionID+".",
	) {
		t.Fatalf("refresh token prefix = %q", issued.Plaintext)
	}
	if want := sha256.Sum256([]byte(issued.Plaintext)); issued.Digest != want {
		t.Fatal("Issue() digest is not full-token SHA-256")
	}

	route, err := codec.Parse(context.Background(), issued.Plaintext)
	if err != nil {
		t.Fatalf("Parse() error = %v", err)
	}
	if route.AccountID != refreshAccountID ||
		route.SessionID != refreshSessionID ||
		route.Digest != issued.Digest {
		t.Fatalf("Parse() route = %#v", route)
	}
}

func TestRefreshTokensRejectMalformedAndRandomFailure(t *testing.T) {
	codec, err := NewRefreshTokens(bytes.NewReader(make([]byte, 32)))
	if err != nil {
		t.Fatal(err)
	}
	for _, value := range []string{
		"",
		"rt1.bad.session.secret",
		"rt2." + refreshAccountID + "." + refreshSessionID + ".secret",
		"rt1." + refreshAccountID + "." + refreshSessionID + ".short",
	} {
		if _, err := codec.Parse(context.Background(), value); err == nil {
			t.Fatalf("Parse(%q) returned nil", value)
		}
	}

	failing, err := NewRefreshTokens(errorReader{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := failing.Issue(
		context.Background(),
		refreshAccountID,
		refreshSessionID,
	); err == nil {
		t.Fatal("Issue(random failure) returned nil")
	}
}

type errorReader struct{}

func (errorReader) Read([]byte) (int, error) {
	return 0, errors.New("random unavailable")
}
