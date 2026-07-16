package service

import (
	"context"
	cryptorand "crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
)

type VerificationChannel string

const (
	VerificationChannelSMS   VerificationChannel = "sms"
	VerificationChannelEmail VerificationChannel = "email"
)

type VerificationPolicy struct {
	CodeDigits        int
	CodeTTL           time.Duration
	SendCooldown      time.Duration
	MaxFailures       int
	RateWindow        time.Duration
	SendIPLimit       int
	VerifyIPLimit     int
	VerifyTargetLimit int
}

func defaultVerificationPolicy() VerificationPolicy {
	return VerificationPolicy{
		CodeDigits:        6,
		CodeTTL:           5 * time.Minute,
		SendCooldown:      time.Minute,
		MaxFailures:       5,
		RateWindow:        time.Minute,
		SendIPLimit:       100,
		VerifyIPLimit:     10,
		VerifyTargetLimit: 10,
	}
}

func normalizeVerificationPolicy(policy VerificationPolicy) VerificationPolicy {
	defaults := defaultVerificationPolicy()
	if policy.CodeDigits <= 0 {
		policy.CodeDigits = defaults.CodeDigits
	}
	policy.CodeTTL = defaultDuration(policy.CodeTTL, defaults.CodeTTL)
	policy.SendCooldown = defaultDuration(policy.SendCooldown, defaults.SendCooldown)
	policy.RateWindow = defaultDuration(policy.RateWindow, defaults.RateWindow)
	if policy.MaxFailures <= 0 {
		policy.MaxFailures = defaults.MaxFailures
	}
	if policy.SendIPLimit <= 0 {
		policy.SendIPLimit = defaults.SendIPLimit
	}
	if policy.VerifyIPLimit <= 0 {
		policy.VerifyIPLimit = defaults.VerifyIPLimit
	}
	if policy.VerifyTargetLimit <= 0 {
		policy.VerifyTargetLimit = defaults.VerifyTargetLimit
	}
	return policy
}

type VerificationRateLimitKey struct {
	Scope       string
	SubjectHash string
}

type verificationRateLimitState struct {
	WindowStartedAt time.Time
	Attempts        int
}

func newNumericVerificationCode(digits int) (string, error) {
	if digits <= 0 {
		return "", fmt.Errorf("verification code digits must be positive")
	}
	code := make([]byte, digits)
	var random [1]byte
	for i := 0; i < digits; {
		if _, err := cryptorand.Read(random[:]); err != nil {
			return "", fmt.Errorf("generate verification code: %w", err)
		}
		if random[0] >= 250 {
			continue
		}
		code[i] = '0' + random[0]%10
		i++
	}
	return string(code), nil
}

func verificationSubjectHash(subject string) string {
	sum := sha256.Sum256([]byte(strings.TrimSpace(subject)))
	return hex.EncodeToString(sum[:])
}

func verificationScope(channel VerificationChannel, action string, subjectKind string) string {
	return strings.Join([]string{string(channel), action, subjectKind}, ":")
}

func (s *Service) enforceVerificationSendLimits(ctx context.Context, channel VerificationChannel, clientIP string) error {
	if strings.TrimSpace(clientIP) == "" {
		return nil
	}
	return s.enforceVerificationRateLimit(ctx, verificationScope(channel, "send", "ip"), clientIP, s.verification.SendIPLimit, "verification_rate_limited")
}

func (s *Service) enforceVerificationCheckLimits(ctx context.Context, channel VerificationChannel, recipient string, clientIP string) error {
	if strings.TrimSpace(clientIP) != "" {
		if err := s.enforceVerificationRateLimit(ctx, verificationScope(channel, "verify", "ip"), clientIP, s.verification.VerifyIPLimit, "verification_rate_limited"); err != nil {
			return err
		}
	}
	return s.enforceVerificationRateLimit(ctx, verificationScope(channel, "verify", "recipient"), recipient, s.verification.VerifyTargetLimit, "verification_rate_limited")
}

func (s *Service) enforceVerificationRateLimit(ctx context.Context, scope string, subject string, limit int, errorCode string) error {
	if strings.TrimSpace(subject) == "" {
		return nil
	}
	attempts, retryAfter, err := s.store.IncrementVerificationRateLimit(ctx, VerificationRateLimitKey{
		Scope:       scope,
		SubjectHash: verificationSubjectHash(subject),
	}, s.now(), s.verification.RateWindow)
	if err != nil {
		return fmt.Errorf("increment verification rate limit: %w", err)
	}
	if attempts <= limit {
		return nil
	}
	return &Error{Code: errorCode, Message: "验证码请求过于频繁，请稍后再试。", Status: http.StatusTooManyRequests, RetryAfter: retryAfter}
}

func (s *Service) reserveExternalSMSChallenge(ctx context.Context, phone string) (ExternalSMSReservation, error) {
	reservationID, err := newOpaqueToken()
	if err != nil {
		return ExternalSMSReservation{}, fmt.Errorf("generate external sms reservation: %w", err)
	}
	return s.store.ReserveExternalSMSChallenge(ctx, phone, reservationID, s.now())
}

func verificationDeliveryError(err error, fallbackCode string, fallbackMessage string) error {
	if err == nil {
		return nil
	}
	var providerError interface{ VerificationHTTPStatus() int }
	if errors.As(err, &providerError) {
		switch providerError.VerificationHTTPStatus() {
		case http.StatusTooManyRequests:
			return newError("verification_provider_rate_limited", "验证码发送过于频繁，请稍后再试。", http.StatusTooManyRequests)
		case http.StatusForbidden:
			return newError("verification_provider_rejected", "当前号码暂时无法接收验证码。", http.StatusForbidden)
		default:
			return newError(fallbackCode, fallbackMessage, http.StatusBadGateway)
		}
	}
	message := strings.ToLower(err.Error())
	switch {
	case strings.Contains(message, "code=limitexceeded"):
		return newError("verification_provider_rate_limited", "验证码发送过于频繁，请稍后再试。", http.StatusTooManyRequests)
	case strings.Contains(message, "code=failedoperation.inblacklist"),
		strings.Contains(message, "code=failedoperation.phonenumberblacklist"):
		return newError("verification_provider_rejected", "当前号码暂时无法接收验证码。", http.StatusForbidden)
	default:
		return newError(fallbackCode, fallbackMessage, http.StatusBadGateway)
	}
}
