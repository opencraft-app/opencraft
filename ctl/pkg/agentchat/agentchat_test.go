package agentchat

import (
	"testing"
	"time"
)

func testConfig() Config {
	return Config{
		BusinessCode:      "lightvela",
		SecretID:          "lightvela_2026",
		SecretKey:         "lightvela_ai_A6zP39qL",
		LaunchTokenSecret: "launch-secret",
		LaunchTokenTTL:    5 * time.Minute,
		TimestampSkew:     5 * time.Minute,
	}
}

func TestLaunchTokenRoundTrip(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	token, expiresAt, err := IssueLaunchToken(testConfig(), "user-1", "ins-1", now)
	if err != nil {
		t.Fatalf("issue token: %v", err)
	}
	if expiresAt != now.Add(5*time.Minute).Unix() {
		t.Fatalf("unexpected expiry: %d", expiresAt)
	}

	claims, err := VerifyLaunchToken(testConfig(), token, now.Add(time.Minute))
	if err != nil {
		t.Fatalf("verify token: %v", err)
	}
	if claims.UserID != "user-1" || claims.InstanceID != "ins-1" || claims.BusinessCode != "lightvela" {
		t.Fatalf("unexpected claims: %+v", claims)
	}
}

func TestLaunchTokenRejectsTamperAndExpiry(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	token, _, err := IssueLaunchToken(testConfig(), "user-1", "ins-1", now)
	if err != nil {
		t.Fatalf("issue token: %v", err)
	}

	if _, err := VerifyLaunchToken(testConfig(), token+"x", now); err != ErrInvalidToken {
		t.Fatalf("expected invalid token for tamper, got %v", err)
	}
	if _, err := VerifyLaunchToken(testConfig(), token, now.Add(6*time.Minute)); err != ErrExpiredToken {
		t.Fatalf("expected expired token, got %v", err)
	}
}

func TestCallbackSignatureMatchesPartnerAlgorithm(t *testing.T) {
	cfg := testConfig()
	params := map[string]string{
		"timestamp":    "1800000000",
		"businessCode": "lightvela",
		"launch_token": "token-1",
	}
	sign := GenerateCallbackSign(cfg, params)

	err := VerifyCallbackSignature(cfg, CallbackRequest{
		LaunchToken:  "token-1",
		BusinessCode: "lightvela",
		Timestamp:    1_800_000_000,
		Sign:         sign,
	}, time.Unix(1_800_000_060, 0))
	if err != nil {
		t.Fatalf("verify callback sign: %v", err)
	}
}

func TestCallbackSignatureRejectsWrongCaseAndSkew(t *testing.T) {
	cfg := testConfig()
	sign := GenerateCallbackSign(cfg, map[string]string{
		"timestamp":    "1800000000",
		"businessCode": "lightvela",
		"launch_token": "token-1",
	})

	if err := VerifyCallbackSignature(cfg, CallbackRequest{
		LaunchToken:  "token-1",
		BusinessCode: "lightvela",
		Timestamp:    1_800_000_000,
		Sign:         sign[:1] + "A" + sign[2:],
	}, time.Unix(1_800_000_000, 0)); err != ErrInvalidSignature {
		t.Fatalf("expected invalid signature for uppercase, got %v", err)
	}
	if err := VerifyCallbackSignature(cfg, CallbackRequest{
		LaunchToken:  "token-1",
		BusinessCode: "lightvela",
		Timestamp:    1_800_000_000,
		Sign:         sign,
	}, time.Unix(1_800_000_600, 0)); err != ErrInvalidSignature {
		t.Fatalf("expected invalid signature for skew, got %v", err)
	}
}
