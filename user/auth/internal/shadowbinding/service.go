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

	tcerr "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common/errors"
)

type Options struct {
	Enabled             bool
	Now                 func() time.Time
	Wait                func(context.Context, time.Duration) error
	AuthCodeTTL         time.Duration
	AuthCodePrefix      string
	UserNamePrefix      string
	SiteKind            string
	BillingAccount      BillingAccountClient
	BillingInitialDelay time.Duration
	BillingOpenTimeout  time.Duration
	BillingPollInterval time.Duration
}

type Service struct {
	store               Store
	client              TencentCloudClient
	billingAccount      BillingAccountClient
	billingInitialDelay time.Duration
	billingOpenTimeout  time.Duration
	billingPollInterval time.Duration
	wait                func(context.Context, time.Duration) error
	enabled             bool
	now                 func() time.Time
	authCodeTTL         time.Duration
	authCodePrefix      string
	userNamePrefix      string
	siteKind            string
}

func New(store Store, client TencentCloudClient, opts Options) *Service {
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	wait := opts.Wait
	if wait == nil {
		wait = waitForDuration
	}
	ttl := opts.AuthCodeTTL
	if ttl <= 0 {
		ttl = 10 * time.Minute
	}
	billingInitialDelay := opts.BillingInitialDelay
	if billingInitialDelay < 0 {
		billingInitialDelay = 0
	}
	billingOpenTimeout := opts.BillingOpenTimeout
	if billingOpenTimeout <= 0 {
		billingOpenTimeout = time.Minute
	}
	billingPollInterval := opts.BillingPollInterval
	if billingPollInterval <= 0 {
		billingPollInterval = time.Second
	}
	siteKind, err := ParseSiteKind(opts.SiteKind)
	if err != nil {
		siteKind = SiteKindCN
	}
	return &Service{
		store:               store,
		client:              client,
		billingAccount:      opts.BillingAccount,
		billingInitialDelay: billingInitialDelay,
		billingOpenTimeout:  billingOpenTimeout,
		billingPollInterval: billingPollInterval,
		wait:                wait,
		enabled:             opts.Enabled,
		now:                 now,
		authCodeTTL:         ttl,
		authCodePrefix:      strings.Trim(strings.TrimSpace(opts.AuthCodePrefix), "."),
		userNamePrefix:      strings.TrimSpace(opts.UserNamePrefix),
		siteKind:            siteKind,
	}
}

func (s *Service) Enabled() bool { return s != nil && s.enabled }

func (s *Service) Ready() bool {
	if s == nil || !s.enabled || s.store == nil || s.client == nil {
		return false
	}
	if reporter, ok := s.client.(interface{ Available() bool }); ok {
		if !reporter.Available() {
			return false
		}
	}
	if s.siteKind == SiteKindIntl && s.billingAccount == nil {
		return false
	}
	if reporter, ok := s.billingAccount.(interface{ Available() bool }); ok {
		return reporter.Available()
	}
	return true
}

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
		if s.siteKind == SiteKindIntl && existing.Uin > 0 &&
			(existing.Status == StatusPending || existing.Status == StatusFailed) {
			return s.openBillingAccount(ctx, existing, false)
		}
		switch existing.Status {
		case StatusActive, StatusPending, StatusDisabled:
			return existing, nil
		}
	}

	shadowUserName := s.shadowUserNameForUser(userID)
	binding, err := s.store.SavePendingBinding(ctx, userID, shadowUserName, now)
	if err != nil {
		return Binding{}, err
	}
	if s.siteKind == SiteKindIntl && s.billingAccount == nil {
		err := errors.New("billing account client is not configured")
		failed, markErr := s.store.MarkBindingFailed(ctx, userID, "shadow_binding_unavailable", err.Error(), now)
		if markErr != nil {
			return binding, fmt.Errorf("%w; mark failed: %v", err, markErr)
		}
		return failed, err
	}
	if !s.enabled || s.client == nil {
		return s.store.MarkBindingFailed(ctx, userID, "shadow_binding_unavailable", "shadow binding client is not configured", now)
	}
	result, err := s.client.RegisterShadowAccount(ctx, CloudRegisterInput{
		UserName:   shadowUserName,
		Email:      strings.TrimSpace(in.Email),
		Phone:      strings.TrimSpace(in.Phone),
		ClientIP:   strings.TrimSpace(in.ClientIP),
		ClientUA:   strings.TrimSpace(in.ClientUA),
		VerifyCode: strings.TrimSpace(in.VerifyCode),
	})
	if err != nil {
		if s.siteKind == SiteKindIntl {
			recovered, recoveryErr := s.recoverShadowIdentity(ctx, userID, in.ClientIP, in.ClientUA)
			if recoveryErr == nil {
				result = recovered
				err = nil
			} else {
				err = fmt.Errorf("register shadow account: %w; recover existing shadow identity: %v", err, recoveryErr)
			}
		}
		if err != nil {
			failed, markErr := s.store.MarkBindingFailed(ctx, userID, "tencentcloud_register_failed", err.Error(), now)
			if markErr != nil {
				return binding, fmt.Errorf("%w; mark failed: %v", err, markErr)
			}
			return failed, err
		}
	}
	if result.OwnerUin <= 0 {
		result.OwnerUin = result.Uin
	}
	if s.siteKind != SiteKindIntl {
		return s.store.MarkBindingActive(ctx, userID, result.Uin, result.OwnerUin, result.AppID, now)
	}
	registered, err := s.store.MarkBindingRegistered(ctx, userID, result.Uin, result.OwnerUin, result.AppID, now)
	if err != nil {
		return binding, err
	}
	return s.openBillingAccount(ctx, registered, true)
}

func (s *Service) RetryBillingAccountOpening(ctx context.Context, userID string) (Binding, error) {
	if s == nil || s.store == nil {
		return Binding{}, errors.New("shadow binding is not configured")
	}
	binding, err := s.store.GetBindingByUserID(ctx, strings.TrimSpace(userID))
	if err != nil {
		return Binding{}, err
	}
	if binding.Status != StatusFailed ||
		!isBillingRetryableCode(binding.LastErrorCode) ||
		binding.Uin <= 0 {
		return binding, nil
	}
	return s.openBillingAccount(ctx, binding, false)
}

func (s *Service) openBillingAccount(ctx context.Context, binding Binding, waitBeforeFirstAttempt bool) (Binding, error) {
	if s.billingAccount == nil {
		err := errors.New("billing account client is not configured")
		failed, markErr := s.store.MarkBindingFailed(ctx, binding.UserID, "billing_account_open_failed", err.Error(), s.now())
		if markErr != nil {
			return binding, fmt.Errorf("%w; mark failed: %v", err, markErr)
		}
		return failed, err
	}
	openCtx, cancel := context.WithTimeout(ctx, s.billingOpenTimeout)
	defer cancel()
	var err error
	if waitBeforeFirstAttempt {
		err = s.wait(openCtx, s.billingInitialDelay)
	}
	backoff := s.billingPollInterval
	for {
		if err != nil {
			break
		}
		var result BillingAccountResult
		result, err = s.billingAccount.EnsureBillingAccount(openCtx, binding.Uin)
		if err != nil || result.IsOpen {
			break
		}
		if err = s.wait(openCtx, backoff); err != nil {
			break
		}
		if backoff <= s.billingOpenTimeout/2 {
			backoff *= 2
		}
	}
	if err != nil {
		failureCode := "billing_account_open_failed"
		if isBillingCardRequired(err) {
			failureCode = "billing_account_card_required"
		}
		failed, markErr := s.store.MarkBindingFailed(ctx, binding.UserID, failureCode, err.Error(), s.now())
		if markErr != nil {
			return binding, fmt.Errorf("open billing account: %w; mark failed: %v", err, markErr)
		}
		return failed, err
	}
	return s.store.MarkBindingActive(ctx, binding.UserID, binding.Uin, binding.OwnerUin, binding.AppID, s.now())
}

func waitForDuration(ctx context.Context, delay time.Duration) error {
	if delay <= 0 {
		return nil
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func (s *Service) recoverShadowIdentity(ctx context.Context, userID, clientIP, clientUA string) (CloudRegisterResult, error) {
	recoveryClient, ok := s.client.(ShadowIdentityRecoveryClient)
	if !ok {
		return CloudRegisterResult{}, errors.New("shadow identity recovery client is not configured")
	}
	authCode, err := s.IssueExternalAuthCode(ctx, userID, AuthCodePurposeSaaSCallback)
	if err != nil {
		return CloudRegisterResult{}, err
	}
	identity, err := recoveryClient.RecoverShadowIdentityForSaaS(ctx, CloudTemporaryCredentialsInput{
		AuthCode: authCode.Code,
		ClientIP: strings.TrimSpace(clientIP),
		ClientUA: strings.TrimSpace(clientUA),
	})
	if err != nil {
		return CloudRegisterResult{}, err
	}
	if identity.Uin <= 0 {
		return CloudRegisterResult{}, errors.New("GetTokenByAuthCodeForSaaS returned empty uin")
	}
	ownerUin := identity.OwnerUin
	if ownerUin <= 0 {
		ownerUin = identity.Uin
	}
	return CloudRegisterResult{Uin: identity.Uin, OwnerUin: ownerUin}, nil
}

func isBillingCardRequired(err error) bool {
	var sdkErr *tcerr.TencentCloudSDKError
	return errors.As(err, &sdkErr) && sdkErr.Code == "FailedOperation.UinNeedBindCard"
}

func isBillingRetryableCode(code string) bool {
	switch strings.TrimSpace(code) {
	case "billing_account_open_failed", "billing_account_card_required":
		return true
	default:
		return false
	}
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
			AuthCode:            s.externalAuthCode(authCode.Code),
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
	if binding.BasicAuthStatus == BasicAuthStatusSucceeded &&
		binding.BasicAuthSourceAttemptID == strings.TrimSpace(in.SourceAttemptID) &&
		binding.BasicAuthIdentityHash == strings.TrimSpace(in.IdentityHash) &&
		binding.BasicAuthPhoneHash == strings.TrimSpace(in.PhoneHash) {
		return nil
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
		AuthCode:    s.externalAuthCode(authCode.Code),
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
	if _, err := s.store.MarkBasicAuthSucceeded(
		ctx,
		userID,
		strings.TrimSpace(in.SourceAttemptID),
		strings.TrimSpace(in.IdentityHash),
		strings.TrimSpace(in.PhoneHash),
		s.now(),
	); err != nil {
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
	shadowUserName := s.shadowUserNameForUser(userID)
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

func (s *Service) IssueExternalAuthCode(ctx context.Context, userID string, purpose string) (AuthCode, error) {
	code, err := s.IssueAuthCode(ctx, userID, purpose)
	if err != nil {
		return AuthCode{}, err
	}
	code.Code = s.externalAuthCode(code.Code)
	return code, nil
}

func (s *Service) IssueTemporaryCredentials(ctx context.Context, userID, clientIP, clientUA string) (CloudTemporaryCredentials, error) {
	if s == nil || s.store == nil || !s.enabled || s.client == nil {
		return CloudTemporaryCredentials{}, errors.New("shadow binding is not configured")
	}
	credentialsClient, ok := s.client.(TemporaryCredentialsClient)
	if !ok {
		return CloudTemporaryCredentials{}, errors.New("shadow temporary credential client is not configured")
	}
	binding, err := s.store.GetBindingByUserID(ctx, strings.TrimSpace(userID))
	if err != nil {
		return CloudTemporaryCredentials{}, err
	}
	if !CanIssueTemporaryCredentials(binding) {
		return CloudTemporaryCredentials{}, errors.New("shadow binding is not active")
	}
	authCode, err := s.IssueExternalAuthCode(ctx, binding.UserID, AuthCodePurposeSaaSCallback)
	if err != nil {
		return CloudTemporaryCredentials{}, err
	}
	credentials, err := credentialsClient.GetTemporaryCredentialsForSaaS(ctx, CloudTemporaryCredentialsInput{
		AuthCode: authCode.Code,
		ClientIP: strings.TrimSpace(clientIP),
		ClientUA: strings.TrimSpace(clientUA),
	})
	if err != nil {
		return CloudTemporaryCredentials{}, err
	}
	if credentials.Uin != binding.Uin || credentials.OwnerUin != binding.OwnerUin {
		return CloudTemporaryCredentials{}, fmt.Errorf(
			"shadow temporary credential uin mismatch: binding_uin=%d binding_owner_uin=%d credential_uin=%d credential_owner_uin=%d",
			binding.Uin, binding.OwnerUin, credentials.Uin, credentials.OwnerUin,
		)
	}
	if strings.TrimSpace(credentials.TmpSecretID) == "" ||
		strings.TrimSpace(credentials.TmpSecretKey) == "" ||
		strings.TrimSpace(credentials.Token) == "" {
		return CloudTemporaryCredentials{}, errors.New("shadow temporary credentials are incomplete")
	}
	if credentials.ExpiredTime.IsZero() || !credentials.ExpiredTime.After(s.now()) {
		return CloudTemporaryCredentials{}, errors.New("shadow temporary credentials are expired")
	}
	return credentials, nil
}

func CanIssueTemporaryCredentials(binding Binding) bool {
	return binding.Status == StatusActive ||
		(binding.Status == StatusFailed &&
			strings.TrimSpace(binding.LastErrorCode) == "billing_account_card_required" &&
			binding.Uin > 0)
}

// externalAuthCode decorates the opaque code only while it travels through
// TencentCloud. The raw code remains the value persisted and consumed locally.
func (s *Service) externalAuthCode(code string) string {
	if s == nil || s.authCodePrefix == "" {
		return code
	}
	return s.authCodePrefix + "." + code
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

func (s *Service) shadowUserNameForUser(userID string) string {
	return s.userNamePrefix + shadowUserNameForUser(userID)
}

func newAuthCode() (string, error) {
	raw := make([]byte, 32)
	if _, err := cryptorand.Read(raw); err != nil {
		return "", err
	}
	return hex.EncodeToString(raw), nil
}
