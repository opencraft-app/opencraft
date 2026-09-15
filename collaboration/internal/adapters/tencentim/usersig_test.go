package tencentim

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/tencentyun/tls-sig-api-v2-golang/tencentyun"
)

type fixedClock struct{ now time.Time }

func (clock fixedClock) Now() time.Time { return clock.now }

func TestUserSigIssuerCreatesVerifiableShortLivedSignature(t *testing.T) {
	now := time.Now().UTC()
	const (
		sdkAppID = 1600000000
		userID   = "u_F5IDF2DMGMGAIHS3OIOZOJZHT4S5E"
		secret   = "local-test-key-not-a-real-tencent-secret"
	)
	issuer, err := NewUserSigIssuer(
		sdkAppID,
		secret,
		fixedClock{now: now},
	)
	if err != nil {
		t.Fatalf("NewUserSigIssuer() error = %v", err)
	}

	issued, err := issuer.Issue(context.Background(), userID, time.Hour)
	if err != nil {
		t.Fatalf("Issue() error = %v", err)
	}
	if issued.Value == "" {
		t.Fatal("Issue() returned empty signature")
	}
	if !issued.ExpiresAt.Equal(now.Add(time.Hour)) {
		t.Fatalf("expiresAt = %v", issued.ExpiresAt)
	}
	if err := tencentyun.VerifyUserSig(
		sdkAppID,
		secret,
		userID,
		issued.Value,
		time.Now(),
	); err != nil {
		t.Fatalf("VerifyUserSig() error = %v", err)
	}
	if err := tencentyun.VerifyUserSig(
		sdkAppID+1,
		secret,
		userID,
		issued.Value,
		time.Now(),
	); err != tencentyun.ErrSdkAppIDNotMatch {
		t.Fatalf("VerifyUserSig(wrong SDKAppID) error = %v", err)
	}
	if err := tencentyun.VerifyUserSig(
		sdkAppID,
		secret,
		"u_DIFFERENT",
		issued.Value,
		time.Now(),
	); err != tencentyun.ErrIdentifierNotMatch {
		t.Fatalf("VerifyUserSig(wrong UserID) error = %v", err)
	}
}

func TestUserSigIssuerRejectsInvalidInputWithoutLeakingSecret(t *testing.T) {
	const secret = "local-test-key-that-must-not-appear-in-errors"
	if _, err := NewUserSigIssuer(0, secret, fixedClock{}); err == nil {
		t.Fatal("NewUserSigIssuer(invalid app id) error = nil")
	}
	issuer, err := NewUserSigIssuer(
		1600000000,
		secret,
		fixedClock{now: time.Now()},
	)
	if err != nil {
		t.Fatal(err)
	}
	for _, formatted := range []string{
		fmt.Sprintf("%v", issuer),
		fmt.Sprintf("%+v", issuer),
		fmt.Sprintf("%#v", issuer),
	} {
		if strings.Contains(formatted, secret) {
			t.Fatalf("issuer formatting leaked secret: %q", formatted)
		}
	}
	for _, test := range []struct {
		userID string
		ttl    time.Duration
	}{
		{userID: "", ttl: time.Hour},
		{userID: "含中文", ttl: time.Hour},
		{userID: strings.Repeat("a", 33), ttl: time.Hour},
		{userID: "valid-user", ttl: 0},
	} {
		_, issueErr := issuer.Issue(context.Background(), test.userID, test.ttl)
		if issueErr == nil {
			t.Fatalf("Issue(%q, %v) error = nil", test.userID, test.ttl)
		}
		if strings.Contains(issueErr.Error(), secret) {
			t.Fatalf("Issue() leaked secret: %v", issueErr)
		}
	}
}
