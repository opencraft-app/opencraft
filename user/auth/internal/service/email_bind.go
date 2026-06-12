package service

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log/slog"
	"net/url"
	"strings"
	"time"
)

const (
	emailBindTokenBytes   = 32
	defaultEmailBindTTL   = 30 * time.Minute
	defaultEmailBindCooldown = time.Minute
)

type EmailBindConfig struct {
	Enabled       bool
	TokenTTL      time.Duration
	Cooldown      time.Duration
	PublicBaseURL string
	FrontendBaseURL string
	Sender        EmailSender
}

func (s *Service) RequestEmailBind(ctx context.Context, sessionToken string, email string) (time.Duration, error) {
	if !s.emailBind.Enabled || s.emailBind.Sender == nil {
		return 0, newError("email_bind_disabled", "邮箱绑定功能暂未开放。", 503)
	}

	trimmedToken := strings.TrimSpace(sessionToken)
	if trimmedToken == "" {
		return 0, newError("unauthorized", "未登录或登录已失效。", 401)
	}

	normalizedEmail := normalizeEmail(email)
	if !isValidEmail(normalizedEmail) {
		return 0, newError("invalid_email", "邮箱格式不正确。", 400)
	}

	user, err := s.store.CurrentProfile(ctx, trimmedToken, s.now())
	if err != nil {
		return 0, err
	}
	if user.EmailVerified && strings.TrimSpace(user.Email) != "" {
		return 0, newError("email_already_bound", "当前账号已绑定邮箱。", 409)
	}

	rawToken, err := newEmailBindToken()
	if err != nil {
		return 0, err
	}
	tokenHash := hashEmailBindToken(rawToken)

	cooldown, err := s.store.RequestEmailBind(ctx, trimmedToken, normalizedEmail, tokenHash, s.now(), s.emailBindTokenTTL(), s.emailBindCooldown())
	if err != nil {
		return 0, err
	}

	confirmURL, err := buildEmailBindConfirmURL(s.emailBind.PublicBaseURL, rawToken)
	if err != nil {
		return 0, newError("email_bind_unavailable", "邮箱绑定服务配置不完整。", 503)
	}
	if err := s.emailBind.Sender.SendEmailBindMagicLink(ctx, normalizedEmail, confirmURL); err != nil {
		slog.WarnContext(ctx, "email bind magic link send failed",
			"user_id", user.ID,
			"email", normalizedEmail,
			"err", err,
		)
		return 0, newError("email_send_failed", "验证邮件发送失败，请稍后重试。", 502)
	}
	return cooldown, nil
}

func (s *Service) ConfirmEmailBind(ctx context.Context, rawToken string) (User, error) {
	if !s.emailBind.Enabled {
		return User{}, newError("email_bind_disabled", "邮箱绑定功能暂未开放。", 503)
	}
	trimmed := strings.TrimSpace(rawToken)
	if trimmed == "" {
		return User{}, newError("invalid_email_bind_token", "绑定链接无效或已过期。", 400)
	}
	return s.store.ConfirmEmailBind(ctx, hashEmailBindToken(trimmed), s.now())
}

func (s *Service) emailBindTokenTTL() time.Duration {
	if s.emailBind.TokenTTL > 0 {
		return s.emailBind.TokenTTL
	}
	return defaultEmailBindTTL
}

func (s *Service) emailBindCooldown() time.Duration {
	if s.emailBind.Cooldown > 0 {
		return s.emailBind.Cooldown
	}
	return defaultEmailBindCooldown
}

func newEmailBindToken() (string, error) {
	var raw [emailBindTokenBytes]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", fmt.Errorf("generate email bind token: %w", err)
	}
	return hex.EncodeToString(raw[:]), nil
}

func hashEmailBindToken(rawToken string) string {
	sum := sha256.Sum256([]byte(strings.TrimSpace(rawToken)))
	return hex.EncodeToString(sum[:])
}

func buildEmailBindConfirmURL(publicBaseURL string, rawToken string) (string, error) {
	base := strings.TrimRight(strings.TrimSpace(publicBaseURL), "/")
	if base == "" {
		return "", fmt.Errorf("missing public base url")
	}
	parsed, err := url.Parse(base + "/auth/email/bind/confirm")
	if err != nil {
		return "", err
	}
	query := parsed.Query()
	query.Set("token", strings.TrimSpace(rawToken))
	parsed.RawQuery = query.Encode()
	return parsed.String(), nil
}

func BuildEmailBindRedirectURL(frontendBaseURL string, queryKey string) string {
	base := strings.TrimRight(strings.TrimSpace(frontendBaseURL), "/")
	if base == "" {
		base = "/"
	}
	parsed, err := url.Parse(base + "/account")
	if err != nil {
		return base + "/account?" + queryKey
	}
	query := parsed.Query()
	parts := strings.SplitN(queryKey, "=", 2)
	if len(parts) == 2 {
		query.Set(parts[0], parts[1])
	}
	parsed.RawQuery = query.Encode()
	return parsed.String()
}
