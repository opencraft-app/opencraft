package shadowbinding

import (
	"context"
	cryptorand "crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"math/big"
	"strings"
	"time"
)

type Options struct {
	Enabled     bool
	Now         func() time.Time
	AuthCodeTTL time.Duration
}

type Service struct {
	store       Store
	client      TencentCloudClient
	enabled     bool
	now         func() time.Time
	authCodeTTL time.Duration
}

func New(store Store, client TencentCloudClient, opts Options) *Service {
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	ttl := opts.AuthCodeTTL
	if ttl <= 0 {
		ttl = 10 * time.Minute
	}
	return &Service{store: store, client: client, enabled: opts.Enabled, now: now, authCodeTTL: ttl}
}

func (s *Service) Enabled() bool { return s != nil && s.enabled }

func (s *Service) GetBindingByUserID(ctx context.Context, userID string) (Binding, error) {
	if s == nil || s.store == nil {
		return Binding{}, ErrNotFound
	}
	return s.store.GetBindingByUserID(ctx, strings.TrimSpace(userID))
}

func (s *Service) GetBindingByShadowUserName(ctx context.Context, shadowUserName string) (Binding, error) {
	if s == nil || s.store == nil {
		return Binding{}, ErrNotFound
	}
	return s.store.GetBindingByShadowUserName(ctx, strings.TrimSpace(shadowUserName))
}

func (s *Service) HasActiveBinding(ctx context.Context, userID string) (Binding, bool, error) {
	binding, err := s.GetBindingByUserID(ctx, userID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return Binding{}, false, nil
		}
		return Binding{}, false, err
	}
	return binding, binding.Status == StatusActive, nil
}

func IsSyntheticBinding(binding Binding) bool {
	return strings.HasPrefix(strings.TrimSpace(binding.ShadowUserName), "mock_")
}

func UsesCloudPhoneChangeCode(binding Binding) bool {
	return binding.Status == StatusActive ||
		(binding.Status == StatusFailed && strings.TrimSpace(binding.LastErrorCode) == "tencentcloud_register_failed")
}

func shouldRegisterForPhoneChange(binding Binding) bool {
	return IsSyntheticBinding(binding) ||
		(binding.Status == StatusFailed && strings.TrimSpace(binding.LastErrorCode) == "tencentcloud_register_failed")
}

func (s *Service) SendPhoneChangeSMS(ctx context.Context, userID string, newPhone string, clientIP string) error {
	binding, err := s.GetBindingByUserID(ctx, userID)
	if err != nil {
		return err
	}
	if !UsesCloudPhoneChangeCode(binding) {
		return ErrNotFound
	}
	return s.SendVerificationSMS(ctx, newPhone, clientIP)
}

func (s *Service) SendVerificationSMS(ctx context.Context, phone string, clientIP string) error {
	if !s.enabled || s.client == nil {
		return errors.New("shadow binding client is not configured")
	}
	return s.client.SendSMSVerifyCode(ctx, CloudSendSMSInput{
		CountryCode: "86",
		Phone:       strings.TrimSpace(phone),
		ClientIP:    strings.TrimSpace(clientIP),
		Lang:        "zh",
	})
}

func (s *Service) BindShadowAccount(ctx context.Context, in BindInput) (Binding, error) {
	if s == nil || s.store == nil {
		return Binding{}, errors.New("shadow binding is not configured")
	}
	userID := strings.TrimSpace(in.UserID)
	if userID == "" {
		return Binding{}, errors.New("user_id is required")
	}
	now := s.now()
	existing, err := s.store.GetBindingByUserID(ctx, userID)
	if err != nil && !errors.Is(err, ErrNotFound) {
		return Binding{}, err
	}
	if err == nil && !in.Force {
		switch existing.Status {
		case StatusActive, StatusPending, StatusDisabled:
			return existing, nil
		}
	}

	shadowUserName := shadowUserNameForUser(userID)
	binding, err := s.store.SavePendingBinding(ctx, userID, shadowUserName, now)
	if err != nil {
		return Binding{}, err
	}
	if !s.enabled || s.client == nil {
		return s.store.MarkBindingFailed(ctx, userID, "shadow_binding_unavailable", "shadow binding client is not configured", now)
	}
	result, err := s.client.RegisterShadowAccount(ctx, CloudRegisterInput{
		UserName:   shadowUserName,
		Phone:      strings.TrimSpace(in.Phone),
		ClientIP:   strings.TrimSpace(in.ClientIP),
		ClientUA:   strings.TrimSpace(in.ClientUA),
		VerifyCode: strings.TrimSpace(in.VerifyCode),
	})
	if err != nil {
		failed, markErr := s.store.MarkBindingFailed(ctx, userID, "tencentcloud_register_failed", err.Error(), now)
		if markErr != nil {
			return binding, fmt.Errorf("register shadow account: %w; mark failed: %v", err, markErr)
		}
		return failed, err
	}
	return s.store.MarkBindingActive(ctx, userID, result.Uin, result.OwnerUin, result.AppID, now)
}

func (s *Service) SyncPhoneChange(ctx context.Context, in PhoneChangeInput) (Binding, error) {
	if s == nil || s.store == nil {
		return Binding{}, errors.New("shadow binding is not configured")
	}
	trimmedUserID := strings.TrimSpace(in.UserID)
	if trimmedUserID == "" {
		return Binding{}, errors.New("user_id is required")
	}
	existing, err := s.store.GetBindingByUserID(ctx, trimmedUserID)
	if err == nil {
		if shouldRegisterForPhoneChange(existing) {
			return s.registerPhoneChangeAccount(ctx, trimmedUserID, in)
		}
		if existing.Status != StatusActive {
			return existing, errors.New("shadow binding is not active")
		}
		authCode, err := s.IssueAuthCode(ctx, trimmedUserID, AuthCodePurposeSaaSCallback)
		if err != nil {
			return Binding{}, err
		}
		if !s.enabled || s.client == nil {
			return existing, errors.New("shadow binding client is not configured")
		}
		if err := s.client.UpdatePhoneByAuthCode(ctx, CloudUpdatePhoneInput{
			OldPhoneCountryCode: "86",
			OldPhoneNumber:      strings.TrimSpace(in.OldPhone),
			NewPhoneCountryCode: "86",
			NewPhoneNumber:      strings.TrimSpace(in.NewPhone),
			AuthCode:            authCode.Code,
			VerifyCode:          strings.TrimSpace(in.VerifyCode),
		}); err != nil {
			return existing, err
		}
		return existing, nil
	}
	if err != nil && !errors.Is(err, ErrNotFound) {
		return Binding{}, err
	}
	return s.BindShadowAccount(ctx, BindInput{
		UserID:     trimmedUserID,
		Phone:      in.NewPhone,
		ClientIP:   in.ClientIP,
		ClientUA:   in.ClientUA,
		VerifyCode: in.VerifyCode,
		Force:      true,
	})
}

func (s *Service) SaveBasicAuth(ctx context.Context, in BasicAuthInput) error {
	if s == nil || s.store == nil {
		return errors.New("shadow binding is not configured")
	}
	userID := strings.TrimSpace(in.UserID)
	if userID == "" {
		return errors.New("user_id is required")
	}
	name := strings.TrimSpace(in.Name)
	if name == "" {
		return errors.New("basic auth name is required")
	}
	binding, err := s.store.GetBindingByUserID(ctx, userID)
	if err != nil {
		return err
	}
	if binding.Status != StatusActive {
		return errors.New("shadow binding is not active")
	}
	if !s.enabled || s.client == nil {
		return errors.New("shadow binding client is not configured")
	}
	accountType := in.AccountType
	if accountType < 0 {
		accountType = 0
	}
	startedAt := time.Now()
	slog.InfoContext(ctx, "shadow binding basic auth sync issuing saas auth code",
		"user_id", userID,
		"shadow_user_name", binding.ShadowUserName,
		"uin", binding.Uin,
		"account_type", accountType,
		"has_id_card", strings.TrimSpace(in.IDCard) != "",
	)
	authCode, err := s.IssueAuthCode(ctx, userID, AuthCodePurposeSaaSCallback)
	if err != nil {
		_, _ = s.store.MarkBasicAuthFailed(ctx, userID, "issue_auth_code_failed", err.Error(), s.now())
		slog.WarnContext(ctx, "shadow binding basic auth sync issue auth code failed",
			"user_id", userID,
			"shadow_user_name", binding.ShadowUserName,
			"err", err,
		)
		return err
	}
	slog.InfoContext(ctx, "shadow binding basic auth sync calling cloud",
		"user_id", userID,
		"shadow_user_name", binding.ShadowUserName,
		"uin", binding.Uin,
		"auth_code_purpose", authCode.Purpose,
		"auth_code_expires_at", authCode.ExpiresAt.UTC().Format(time.RFC3339),
	)
	if err := s.client.SaveBasicAuthForSaaS(ctx, CloudSaveBasicAuthInput{
		AuthCode:    authCode.Code,
		AccountType: accountType,
		Name:        name,
		IDCard:      strings.TrimSpace(in.IDCard),
		ClientIP:    strings.TrimSpace(in.ClientIP),
		ClientUA:    strings.TrimSpace(in.ClientUA),
	}); err != nil {
		_, _ = s.store.MarkBasicAuthFailed(ctx, userID, "save_basic_auth_failed", err.Error(), s.now())
		slog.WarnContext(ctx, "shadow binding basic auth sync cloud call failed",
			"user_id", userID,
			"shadow_user_name", binding.ShadowUserName,
			"uin", binding.Uin,
			"duration_ms", time.Since(startedAt).Milliseconds(),
			"err", err,
		)
		return err
	}
	if _, err := s.store.MarkBasicAuthSucceeded(ctx, userID, s.now()); err != nil {
		slog.WarnContext(ctx, "shadow binding basic auth sync state update failed",
			"user_id", userID,
			"shadow_user_name", binding.ShadowUserName,
			"uin", binding.Uin,
			"err", err,
		)
		return err
	}
	slog.InfoContext(ctx, "shadow binding basic auth sync cloud call succeeded",
		"user_id", userID,
		"shadow_user_name", binding.ShadowUserName,
		"uin", binding.Uin,
		"duration_ms", time.Since(startedAt).Milliseconds(),
	)
	return nil
}

func (s *Service) registerPhoneChangeAccount(ctx context.Context, userID string, in PhoneChangeInput) (Binding, error) {
	if !s.enabled || s.client == nil {
		return Binding{}, errors.New("shadow binding client is not configured")
	}
	shadowUserName := shadowUserNameForUser(userID)
	existing, getErr := s.store.GetBindingByUserID(ctx, userID)
	if getErr != nil {
		return Binding{}, getErr
	}
	if _, err := s.store.SavePendingBinding(ctx, userID, shadowUserName, s.now()); err != nil {
		return Binding{}, err
	}
	result, err := s.client.RegisterShadowAccount(ctx, CloudRegisterInput{
		UserName:   shadowUserName,
		Phone:      strings.TrimSpace(in.NewPhone),
		ClientIP:   strings.TrimSpace(in.ClientIP),
		ClientUA:   strings.TrimSpace(in.ClientUA),
		VerifyCode: strings.TrimSpace(in.VerifyCode),
	})
	if err != nil {
		_ = s.restoreBinding(ctx, existing)
		return existing, err
	}
	if _, err := s.store.SavePendingBinding(ctx, userID, shadowUserName, s.now()); err != nil {
		return Binding{}, err
	}
	return s.store.MarkBindingActive(ctx, userID, result.Uin, result.OwnerUin, result.AppID, s.now())
}

func (s *Service) restoreBinding(ctx context.Context, binding Binding) error {
	if strings.TrimSpace(binding.UserID) == "" {
		return nil
	}
	if _, err := s.store.SavePendingBinding(ctx, binding.UserID, binding.ShadowUserName, s.now()); err != nil {
		return err
	}
	switch binding.Status {
	case StatusActive:
		_, err := s.store.MarkBindingActive(ctx, binding.UserID, binding.Uin, binding.OwnerUin, binding.AppID, s.now())
		return err
	case StatusFailed:
		_, err := s.store.MarkBindingFailed(ctx, binding.UserID, binding.LastErrorCode, binding.LastErrorMessage, s.now())
		return err
	default:
		return nil
	}
}

func (s *Service) IssueAuthCode(ctx context.Context, userID string, purpose string) (AuthCode, error) {
	if s == nil || s.store == nil {
		return AuthCode{}, errors.New("shadow binding is not configured")
	}
	if strings.TrimSpace(purpose) == "" {
		purpose = AuthCodePurposeSaaSCallback
	}
	return s.store.IssueAuthCode(ctx, strings.TrimSpace(userID), strings.TrimSpace(purpose), s.authCodeTTL, s.now())
}

func (s *Service) ConsumeAuthCode(ctx context.Context, code string) (AuthCode, error) {
	if s == nil || s.store == nil {
		return AuthCode{}, ErrNotFound
	}
	return s.store.ConsumeAuthCode(ctx, strings.TrimSpace(code), s.now())
}

func shadowUserNameForUser(userID string) string {
	trimmed := strings.TrimSpace(userID)
	sum := sha256.Sum256([]byte(trimmed))
	number := new(big.Int).SetBytes(sum[:])
	number.Mod(number, big.NewInt(10_000_000_000))
	return fmt.Sprintf("u%010d", number.Int64())
}

func newAuthCode() (string, error) {
	raw := make([]byte, 32)
	if _, err := cryptorand.Read(raw); err != nil {
		return "", err
	}
	return hex.EncodeToString(raw), nil
}
