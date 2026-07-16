package service

import (
	"context"
	cryptorand "crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"

	"github.com/openclaw/openclaw/mono/backend/auth/internal/shadowbinding"
)

const (
	RealnameLevelNone      = "none"
	RealnameLevelIDCard2FA = "idcard_2fa"
	RealnameLevelPhone3FA  = "phone_3fa"

	RealnameSyncStatusPending   = "pending"
	RealnameSyncStatusFailed    = "failed"
	RealnameSyncStatusSucceeded = "succeeded"

	AuthMethodUnknown       = "unknown"
	AuthMethodSMS           = "sms"
	AuthMethodOAuth         = "oauth"
	AuthMethodPassword      = "password"
	AuthMethodImpersonation = "impersonation"

	PhoneAuthFlowExistingUserLocal = "existing_user_local"
	PhoneAuthFlowNewUserShadow     = "new_user_shadow"
)

var (
	chinaMainlandPhonePattern = regexp.MustCompile(`^1\d{10}$`)
	emailPattern              = regexp.MustCompile(`^[^@\s]+@[^@\s]+\.[^@\s]+$`)
	mainlandIDCardPattern     = regexp.MustCompile(`^\d{17}[\dXx]$`)
)

type Options struct {
	Now                       func() time.Time
	SMSCooldown               time.Duration
	SMSCodeTTL                time.Duration
	SessionTTL                time.Duration
	VerificationCodeGenerator func(int) (string, error)
	PhoneAuth                 PhoneAuthConfig
	Verification              VerificationPolicy
	SeedDemoUser              bool
	RealnameVerifier          RealnameVerifier
	RealnameFaceIDVerifier    RealnameFaceIDVerifier
	RealnameCipher            RealnameCipher
	RealnameFaceID            RealnameFaceIDConfig
	ContentAudit              ContentAuditConfig
	ContentAuditClient        ContentAuditClient
	ShadowBinding             *shadowbinding.Service
	// ShadowBasicAuthSyncEnabled gates the external SaveBasicAuthForSaaS side
	// effect and the user-facing sync status. Keep it off by default so the
	// shadow binding code can land before product rollout.
	ShadowBasicAuthSyncEnabled bool
	EmailBind                  EmailBindConfig
}

type PhoneAuthSMSSender interface {
	SendVerificationCode(ctx context.Context, phone string, code string, expiryMinutes int) error
}

type PhoneAuthConfig struct {
	Enabled   bool
	SMSSender PhoneAuthSMSSender
}

type Error struct {
	Code       string
	Message    string
	Status     int
	RetryAfter time.Duration
}

func (e *Error) Error() string {
	return e.Message
}

type User struct {
	ID                     string
	Name                   string
	PendingName            string
	NameAuditStatus        string
	Email                  string
	Phone                  string
	AvatarObjectKey        string
	AvatarSource           string
	PendingAvatarObjectKey string
	PendingAvatarSource    string
	AvatarAuditStatus      string
	InviteRequired         bool
	RealnameVerified       bool
	EmailVerified          bool
	RealnameLevel          string
	RealnameSyncStatus     string
	RealnameAssuranceMode  string
	CreatedAt              time.Time
	UpdatedAt              time.Time

	realnameVerifiedAt      *time.Time
	realnameFinalAttemptID  string
	realnameFaceVerifiedAt  *time.Time
	realnamePhoneVerifiedAt *time.Time
	realnameIdentityHash    string
	realnamePhoneHash       string
}

type RealnameVerifyInput struct {
	Name     string
	IDCard   string
	ClientIP string
	ClientUA string
}

type RealnameVerifyResult struct {
	OK                        bool
	Verified                  bool
	NameMasked                string
	IDCardMasked              string
	RequestID                 string
	PhoneVerificationRequired bool
	PhoneVerificationSkipped  bool
	RealnameLevel             string
	ShadowBindingStatus       string
}

type RealnamePhoneVerifyInput struct {
	Code     string
	ClientIP string
	ClientUA string
}

type PhoneChangeVerifyInput struct {
	Phone    string
	Code     string
	ClientIP string
	ClientUA string
}

type PhoneChangeVerifyResult struct {
	OK                  bool
	User                User
	ShadowBindingStatus string
}

type RealnamePhoneVerifyResult struct {
	OK                  bool
	RealnameLevel       string
	RealnameSyncStatus  string
	ShadowBindingStatus string
}

type RealnameSyncRetryResult struct {
	OK                  bool
	User                User
	RealnameSyncStatus  string
	ShadowBindingStatus string
}

type ShadowBindingResult struct {
	UserID                    string
	ShadowUserName            string
	Uin                       int64
	OwnerUin                  int64
	AppID                     int64
	Status                    string
	LastErrorCode             string
	LastErrorMessage          string
	BasicAuthStatus           string
	BasicAuthSyncedAt         *time.Time
	BasicAuthLastErrorCode    string
	BasicAuthLastErrorMessage string
	CreatedAt                 time.Time
	UpdatedAt                 time.Time
}

type RealnameProviderResult struct {
	Result      string
	Description string
	RequestID   string
}

type RealnameVerifier interface {
	Verify(ctx context.Context, name string, idCard string) (RealnameProviderResult, error)
}

type RealnameCipher interface {
	Encrypt(plaintext string) (string, error)
	Decrypt(ciphertext string) (string, error)
}

type ContentAuditConfig struct {
	Enabled            bool
	NameAuditEnabled   bool
	AvatarAuditEnabled bool
	ProductID          string
	UserSID            string
}

// Ready reports whether the config has enough information to submit audit requests.
func (c ContentAuditConfig) Ready() bool {
	return c.ready()
}

func (c ContentAuditConfig) ready() bool {
	if !c.Enabled {
		return false
	}
	return strings.TrimSpace(c.ProductID) != "" && strings.TrimSpace(c.UserSID) != ""
}

func (c ContentAuditConfig) nameAuditEnabled() bool {
	if !c.Enabled {
		return false
	}
	// Backward compatibility: existing tests and deployments used Enabled=true
	// to mean nickname audit is enabled before per-media switches existed.
	return c.NameAuditEnabled || !c.AvatarAuditEnabled
}

func (c ContentAuditConfig) avatarAuditEnabled() bool {
	return c.Enabled && c.AvatarAuditEnabled
}

type UpdateRealnameInput struct {
	Provider         string
	Result           string
	RequestID        string
	NameCiphertext   string
	IDCardCiphertext string
	NameMasked       string
	IDCardMasked     string
	VerifiedAt       time.Time
}

type StoredRealname struct {
	NameCiphertext   string
	IDCardCiphertext string
}

type PlanSelection struct {
	Tier        string
	ConfirmedAt time.Time
}

type InviteValidation struct {
	Code    string
	State   string
	Message string
}

type AdminUser struct {
	ID             string
	Name           string
	Email          string
	Phone          string
	AuthMethods    []string
	QQOpenID       string
	WeChatSubject  string
	InviteRequired bool
	CreatedAt      time.Time
	UpdatedAt      time.Time
}

type AdminSMSChallenge struct {
	Phone            string
	Code             string
	ExpiresAt        time.Time
	CooldownUntil    time.Time
	RemainingRetries int
	CreatedAt        time.Time
	UpdatedAt        time.Time
}

type AdminInvite struct {
	Code         string
	State        string
	Message      string
	UsedByUserID string
	UsedVia      string
	UsedAt       *time.Time
	CreatedAt    time.Time
	UpdatedAt    time.Time
}

type AuthSession struct {
	Token               string
	User                User
	PlanSelection       *PlanSelection
	AuthenticatedAt     time.Time
	ExpiresAt           time.Time
	Impersonated        bool
	ImpersonationReason string
	AuthMethod          string
}

type PhoneAuthChallenge struct {
	Phone            string
	UserID           string
	Flow             string
	CodeHash         string
	ExpiresAt        time.Time
	CooldownUntil    time.Time
	RemainingRetries int
	Generation       int64
	ReservationID    string
	CreatedAt        time.Time
	UpdatedAt        time.Time
}

const impersonationSessionTTL = 30 * time.Minute

type VerifySMSInput struct {
	Name       string
	Phone      string
	Code       string
	InviteCode string
	ClientIP   string
}

type PasswordSignUpInput struct {
	Name       string
	Email      string
	Password   string
	InviteCode string
}

type OAuthSignInInput struct {
	Provider        string
	ProviderSubject string
	Email           string
	EmailVerified   bool
	Name            string
	AvatarURL       string
	InviteCode      string
}

type Service struct {
	now                        func() time.Time
	smsCooldown                time.Duration
	smsCodeTTL                 time.Duration
	sessionTTL                 time.Duration
	verificationCodeGenerator  func(int) (string, error)
	verification               VerificationPolicy
	phoneAuth                  PhoneAuthConfig
	store                      Store
	realnameVerifier           RealnameVerifier
	realnameFaceIDVerifier     RealnameFaceIDVerifier
	realnameCipher             RealnameCipher
	realnameFaceID             RealnameFaceIDConfig
	contentAudit               ContentAuditConfig
	contentAuditClient         ContentAuditClient
	shadowBinding              *shadowbinding.Service
	shadowBasicAuthSyncEnabled bool
	emailBind                  EmailBindConfig
}

type smsChallenge struct {
	Code             string
	ExpiresAt        time.Time
	CooldownUntil    time.Time
	RemainingRetries int
	Generation       int64
	ReservationID    string
}

type sessionRecord struct {
	Token               string
	UserID              string
	PlanSelection       *PlanSelection
	AuthenticatedAt     time.Time
	ExpiresAt           time.Time
	Impersonated        bool
	ImpersonationReason string
	AuthMethod          string
}

func New(opts Options) *Service {
	now := opts.Now
	if now == nil {
		now = time.Now
	}

	store := NewMemoryStore(StoreOptions{
		Now:                now,
		SeedDefaultInvites: true,
		SeedDemoUser:       opts.SeedDemoUser,
	})
	return NewWithStore(store, opts)
}

func NewWithStore(store Store, opts Options) *Service {
	now := opts.Now
	if now == nil {
		now = time.Now
	}

	verificationPolicy := normalizeVerificationPolicy(opts.Verification)
	if opts.SMSCooldown > 0 {
		verificationPolicy.SendCooldown = opts.SMSCooldown
	}
	if opts.SMSCodeTTL > 0 {
		verificationPolicy.CodeTTL = opts.SMSCodeTTL
	}
	codeGenerator := opts.VerificationCodeGenerator
	if codeGenerator == nil {
		codeGenerator = newNumericVerificationCode
	}

	return &Service{
		now:                        now,
		smsCooldown:                verificationPolicy.SendCooldown,
		smsCodeTTL:                 verificationPolicy.CodeTTL,
		sessionTTL:                 defaultDuration(opts.SessionTTL, 30*24*time.Hour),
		verificationCodeGenerator:  codeGenerator,
		verification:               verificationPolicy,
		phoneAuth:                  opts.PhoneAuth,
		store:                      store,
		realnameVerifier:           opts.RealnameVerifier,
		realnameFaceIDVerifier:     opts.RealnameFaceIDVerifier,
		realnameCipher:             opts.RealnameCipher,
		realnameFaceID:             normalizeRealnameFaceIDConfig(opts.RealnameFaceID),
		contentAudit:               opts.ContentAudit,
		contentAuditClient:         opts.ContentAuditClient,
		shadowBinding:              opts.ShadowBinding,
		shadowBasicAuthSyncEnabled: opts.ShadowBasicAuthSyncEnabled,
		emailBind:                  opts.EmailBind,
	}
}

func (s *Service) SendVerificationCode(ctx context.Context, phone string) (time.Duration, error) {
	return s.SendVerificationCodeForClient(ctx, phone, "")
}

func (s *Service) SendVerificationCodeForClient(ctx context.Context, phone string, clientIP string) (time.Duration, error) {
	normalized := normalizePhone(phone)
	if !isValidPhone(normalized) {
		return 0, newError("invalid_phone", "手机号格式不正确。", 400)
	}
	if err := s.enforceVerificationSendLimits(ctx, VerificationChannelSMS, clientIP); err != nil {
		return 0, err
	}
	if s.phoneAuth.Enabled {
		return s.sendPhoneAuthVerificationCode(ctx, normalized, clientIP)
	}
	code, err := s.issueSMSCode()
	if err != nil {
		return 0, err
	}
	return s.store.SendVerificationCode(ctx, normalized, code, s.now(), s.smsCodeTTL, s.smsCooldown, s.verification.MaxFailures)
}

func (s *Service) SendShadowBindingCode(ctx context.Context, phone string, clientIP string) (time.Duration, error) {
	normalized := normalizePhone(phone)
	if !isValidPhone(normalized) {
		return 0, newError("invalid_phone", "手机号格式不正确。", 400)
	}
	if err := s.enforceVerificationSendLimits(ctx, VerificationChannelSMS, clientIP); err != nil {
		return 0, err
	}
	code, err := s.issueSMSCode()
	if err != nil {
		return 0, err
	}
	cooldown, err := s.store.SendVerificationCode(ctx, normalized, code, s.now(), s.smsCodeTTL, s.smsCooldown, s.verification.MaxFailures)
	if err != nil {
		return 0, err
	}
	if s.cloudPhoneCodesEnabled() {
		if err := s.shadowBinding.SendVerificationSMS(ctx, normalized, clientIP); err != nil {
			_ = s.store.DeleteAdminSMSChallenge(ctx, normalized)
			return 0, verificationDeliveryError(err, "shadow_sms_failed", "发送 Lightvela 安全手机验证码失败，请稍后重试。")
		}
	}
	return cooldown, nil
}

func (s *Service) SendPhoneChangeCode(ctx context.Context, token string, phone string, clientIP string) (time.Duration, error) {
	trimmedToken := strings.TrimSpace(token)
	if trimmedToken == "" {
		return 0, newError("unauthorized", "未登录或登录已失效。", http.StatusUnauthorized)
	}
	normalized := normalizePhone(phone)
	if !isValidPhone(normalized) {
		return 0, newError("invalid_phone", "手机号格式不正确。", 400)
	}
	if _, err := s.store.CurrentSession(ctx, trimmedToken, s.now()); err != nil {
		return 0, err
	}
	if err := s.enforceVerificationSendLimits(ctx, VerificationChannelSMS, clientIP); err != nil {
		return 0, err
	}
	code, err := s.issueSMSCode()
	if err != nil {
		return 0, err
	}
	if s.cloudPhoneCodesEnabled() {
		user, err := s.store.ValidatePhoneChangeTarget(ctx, trimmedToken, normalized, s.now())
		if err != nil {
			return 0, err
		}
		binding, err := s.shadowBinding.GetBindingByUserID(ctx, user.ID)
		if err != nil && !errors.Is(err, shadowbinding.ErrNotFound) {
			return 0, err
		}
		if err == nil && !shadowbinding.UsesCloudPhoneChangeCode(binding) {
			return 0, newError("shadow_binding_incomplete", "影子账号绑定尚未完成，请稍后重试。", http.StatusBadGateway)
		}
		cooldown, err := s.store.SendVerificationCode(ctx, normalized, code, s.now(), s.smsCodeTTL, s.smsCooldown, s.verification.MaxFailures)
		if err != nil {
			return 0, err
		}
		if err := s.shadowBinding.SendVerificationSMS(ctx, normalized, clientIP); err != nil {
			_ = s.store.DeleteAdminSMSChallenge(ctx, normalized)
			return 0, verificationDeliveryError(err, "shadow_sms_failed", "发送 Lightvela 安全手机验证码失败，请稍后重试。")
		}
		return cooldown, nil
	}
	return s.store.SendVerificationCode(ctx, normalized, code, s.now(), s.smsCodeTTL, s.smsCooldown, s.verification.MaxFailures)
}

func (s *Service) VerifySMS(ctx context.Context, input VerifySMSInput) (*AuthSession, error) {
	input.Phone = normalizePhone(input.Phone)
	if !isValidPhone(input.Phone) {
		return nil, newError("invalid_phone", "手机号格式不正确。", 400)
	}
	if err := s.enforceVerificationCheckLimits(ctx, VerificationChannelSMS, input.Phone, input.ClientIP); err != nil {
		return nil, err
	}
	if s.phoneAuth.Enabled {
		return s.verifyPhoneAuthSMS(ctx, input)
	}

	return s.store.CompleteSMSVerification(ctx, input, s.now(), s.sessionTTL)
}

func (s *Service) sendPhoneAuthVerificationCode(ctx context.Context, phone string, clientIP string) (time.Duration, error) {
	user, err := s.store.FindUserByPhone(ctx, phone)
	switch {
	case err == nil:
		useShadow, shadowErr := s.shouldUseShadowPhoneAuth(ctx, user.ID)
		if shadowErr != nil {
			return 0, shadowErr
		}
		if useShadow {
			return s.sendNewUserPhoneAuthCode(ctx, phone, user.ID, clientIP)
		}
		return s.sendExistingUserPhoneAuthCode(ctx, user)
	case isUserNotFound(err):
		return s.sendNewUserPhoneAuthCode(ctx, phone, "", clientIP)
	default:
		return 0, err
	}
}

func (s *Service) shouldUseShadowPhoneAuth(ctx context.Context, userID string) (bool, error) {
	if s.shadowBinding == nil {
		return false, nil
	}
	binding, err := s.shadowBinding.GetBindingByUserID(ctx, userID)
	if err != nil {
		if errors.Is(err, shadowbinding.ErrNotFound) {
			return false, nil
		}
		return false, err
	}
	return binding.Status != shadowbinding.StatusActive, nil
}

func (s *Service) sendExistingUserPhoneAuthCode(ctx context.Context, user User) (time.Duration, error) {
	if s.phoneAuth.SMSSender == nil {
		return 0, newError("phone_auth_unavailable", "手机号登录短信服务暂不可用。", http.StatusServiceUnavailable)
	}
	code, err := s.issueSMSCode()
	if err != nil {
		return 0, err
	}
	codeHash, err := bcrypt.GenerateFromPassword([]byte(code), bcrypt.DefaultCost)
	if err != nil {
		return 0, fmt.Errorf("hash phone auth sms code: %w", err)
	}
	cooldown, err := s.store.SendPhoneAuthChallenge(ctx, PhoneAuthChallenge{
		Phone:    user.Phone,
		UserID:   user.ID,
		Flow:     PhoneAuthFlowExistingUserLocal,
		CodeHash: string(codeHash),
	}, s.now(), s.smsCodeTTL, s.smsCooldown, s.verification.MaxFailures)
	if err != nil {
		return 0, err
	}
	if err := s.phoneAuth.SMSSender.SendVerificationCode(ctx, user.Phone, code, ceilMinutes(s.smsCodeTTL)); err != nil {
		_ = s.store.DeletePhoneAuthChallenge(ctx, user.Phone)
		return 0, verificationDeliveryError(err, "phone_auth_sms_failed", "登录验证码发送失败，请稍后重试。")
	}
	return cooldown, nil
}

func (s *Service) sendNewUserPhoneAuthCode(ctx context.Context, phone string, userID string, clientIP string) (time.Duration, error) {
	if s.shadowBinding == nil || !s.shadowBinding.Enabled() {
		return 0, newError("phone_auth_unavailable", "手机号登录暂未启用。", http.StatusServiceUnavailable)
	}
	cooldown, err := s.store.SendPhoneAuthChallenge(ctx, PhoneAuthChallenge{
		Phone:  phone,
		UserID: userID,
		Flow:   PhoneAuthFlowNewUserShadow,
	}, s.now(), s.smsCodeTTL, s.smsCooldown, s.verification.MaxFailures)
	if err != nil {
		return 0, err
	}
	if err := s.shadowBinding.SendVerificationSMS(ctx, phone, clientIP); err != nil {
		_ = s.store.DeletePhoneAuthChallenge(ctx, phone)
		return 0, verificationDeliveryError(err, "shadow_sms_failed", "发送 Lightvela 安全手机验证码失败，请稍后重试。")
	}
	return cooldown, nil
}

func (s *Service) verifyPhoneAuthSMS(ctx context.Context, input VerifySMSInput) (*AuthSession, error) {
	challenge, err := s.store.GetPhoneAuthChallenge(ctx, input.Phone)
	if err != nil {
		return nil, err
	}
	switch challenge.Flow {
	case PhoneAuthFlowExistingUserLocal:
		return s.verifyExistingUserPhoneAuthSMS(ctx, input)
	case PhoneAuthFlowNewUserShadow:
		return s.verifyNewUserPhoneAuthSMS(ctx, input)
	default:
		return nil, newError("sms_code_not_found", "请先获取验证码。", http.StatusBadRequest)
	}
}

func (s *Service) verifyExistingUserPhoneAuthSMS(ctx context.Context, input VerifySMSInput) (*AuthSession, error) {
	challenge, err := s.store.VerifyAndConsumePhoneAuthChallenge(ctx, input.Phone, input.Code, s.now())
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(challenge.UserID) != "" {
		user, err := s.store.FindUserByID(ctx, challenge.UserID)
		if err != nil {
			return nil, err
		}
		return s.store.CreateSession(ctx, user, s.now(), s.sessionTTL)
	}
	user, err := s.store.FindUserByPhone(ctx, input.Phone)
	if err != nil {
		return nil, err
	}
	return s.store.CreateSession(ctx, user, s.now(), s.sessionTTL)
}

func (s *Service) verifyNewUserPhoneAuthSMS(ctx context.Context, input VerifySMSInput) (*AuthSession, error) {
	reservationID, err := newOpaqueToken()
	if err != nil {
		return nil, fmt.Errorf("generate external phone auth reservation: %w", err)
	}
	challenge, err := s.store.ReserveExternalPhoneAuthChallenge(ctx, input.Phone, reservationID, s.now())
	if err != nil {
		return nil, err
	}
	if challenge.Flow != PhoneAuthFlowNewUserShadow {
		_ = s.store.RejectExternalPhoneAuthChallenge(ctx, challenge, s.now())
		return nil, newError("sms_code_not_found", "验证码流程已更新，请重新验证。", http.StatusBadRequest)
	}
	if s.shadowBinding == nil || !s.shadowBinding.Enabled() {
		_ = s.store.RejectExternalPhoneAuthChallenge(ctx, challenge, s.now())
		return nil, newError("phone_auth_unavailable", "手机号登录暂未启用。", http.StatusServiceUnavailable)
	}
	userID := strings.TrimSpace(challenge.UserID)
	user, err := s.store.FindOrCreatePhoneAuthUser(ctx, input.Phone, input.Name, s.now())
	if err != nil {
		return nil, err
	}
	if userID != "" && user.ID != userID {
		user, err = s.store.FindUserByID(ctx, userID)
		if err != nil {
			return nil, err
		}
	}
	binding, err := s.shadowBinding.BindShadowAccount(ctx, shadowbinding.BindInput{
		UserID:     user.ID,
		Phone:      input.Phone,
		VerifyCode: input.Code,
		Force:      true,
	})
	if err != nil {
		_ = s.store.RejectExternalPhoneAuthChallenge(ctx, challenge, s.now())
		if isCloudVerifyCodeMismatch(err) {
			return nil, newError("invalid_sms_code", "验证码不正确。", http.StatusBadRequest)
		}
		return nil, shadowBindingError(ctx, err, user.ID)
	}
	if binding.Status != shadowbinding.StatusActive {
		_ = s.store.RejectExternalPhoneAuthChallenge(ctx, challenge, s.now())
		return nil, newError("shadow_binding_incomplete", "影子账号绑定尚未完成，请稍后重试。", http.StatusBadGateway)
	}
	if err := s.store.ConsumeExternalPhoneAuthChallenge(ctx, challenge); err != nil {
		return nil, err
	}
	return s.store.CreateSession(ctx, user, s.now(), s.sessionTTL)
}

func (s *Service) VerifyPhoneChange(ctx context.Context, token string, input PhoneChangeVerifyInput) (PhoneChangeVerifyResult, error) {
	trimmedToken := strings.TrimSpace(token)
	if trimmedToken == "" {
		return PhoneChangeVerifyResult{}, newError("unauthorized", "未登录或登录已失效。", http.StatusUnauthorized)
	}
	phone := normalizePhone(input.Phone)
	if !isValidPhone(phone) {
		return PhoneChangeVerifyResult{}, newError("invalid_phone", "手机号格式不正确。", 400)
	}
	code := strings.TrimSpace(input.Code)
	if code == "" {
		return PhoneChangeVerifyResult{}, newError("invalid_sms_code", "验证码不能为空。", http.StatusBadRequest)
	}
	if _, err := s.store.CurrentSession(ctx, trimmedToken, s.now()); err != nil {
		return PhoneChangeVerifyResult{}, err
	}
	if err := s.enforceVerificationCheckLimits(ctx, VerificationChannelSMS, phone, input.ClientIP); err != nil {
		return PhoneChangeVerifyResult{}, err
	}
	if s.cloudPhoneCodesEnabled() {
		user, err := s.store.ValidatePhoneChangeTarget(ctx, trimmedToken, phone, s.now())
		if err != nil {
			return PhoneChangeVerifyResult{}, err
		}
		binding, err := s.shadowBinding.GetBindingByUserID(ctx, user.ID)
		if err != nil && !errors.Is(err, shadowbinding.ErrNotFound) {
			return PhoneChangeVerifyResult{}, err
		}
		if err == nil && !shadowbinding.UsesCloudPhoneChangeCode(binding) {
			return PhoneChangeVerifyResult{}, newError("shadow_binding_incomplete", "影子账号绑定尚未完成，请稍后重试。", http.StatusBadGateway)
		}
		reservation, err := s.reserveExternalSMSChallenge(ctx, phone)
		if err != nil {
			return PhoneChangeVerifyResult{}, err
		}
		updatedBinding, err := s.shadowBinding.SyncPhoneChange(ctx, shadowbinding.PhoneChangeInput{
			UserID:     user.ID,
			OldPhone:   user.Phone,
			NewPhone:   phone,
			ClientIP:   input.ClientIP,
			ClientUA:   input.ClientUA,
			VerifyCode: code,
		})
		if err != nil {
			_ = s.store.RejectExternalSMSChallenge(ctx, reservation, s.now())
			return PhoneChangeVerifyResult{}, shadowPhoneChangeError(ctx, err, user.ID, binding)
		}
		if err := s.store.ConsumeExternalSMSChallenge(ctx, reservation); err != nil {
			return PhoneChangeVerifyResult{}, err
		}
		if updatedBinding.Status != shadowbinding.StatusActive {
			return PhoneChangeVerifyResult{}, newError("shadow_binding_incomplete", "影子账号绑定尚未完成，请稍后重试。", http.StatusBadGateway)
		}
		user, err = s.store.UpdateCurrentUserPhone(ctx, trimmedToken, phone, s.now())
		if err != nil {
			return PhoneChangeVerifyResult{}, err
		}
		if s.realnameFaceID.Mode == RealnameAssuranceModeFaceRequired {
			return PhoneChangeVerifyResult{OK: true, User: s.projectUserForAssuranceMode(ctx, user), ShadowBindingStatus: bindingStatusOrDisabled(updatedBinding.Status)}, nil
		}
		if isAtLeastRealnameLevel(user.RealnameLevel, RealnameLevelIDCard2FA) || user.RealnameVerified {
			if err := s.syncStoredShadowBasicAuth(ctx, user.ID, input.ClientIP, input.ClientUA, false); err != nil {
				return PhoneChangeVerifyResult{}, shadowBasicAuthError(ctx, err, user.ID, updatedBinding)
			}
			user, err = s.store.MarkCurrentUserPhoneRealnameVerified(ctx, trimmedToken, s.now())
			if err != nil {
				return PhoneChangeVerifyResult{}, err
			}
		}
		return PhoneChangeVerifyResult{OK: true, User: user, ShadowBindingStatus: bindingStatusOrDisabled(updatedBinding.Status)}, nil
	}
	user, err := s.store.ValidatePhoneChange(ctx, trimmedToken, phone, code, s.now())
	if err != nil {
		return PhoneChangeVerifyResult{}, err
	}
	shadowStatus := shadowbinding.StatusDisabled
	if s.shadowBinding != nil {
		binding, err := s.shadowBinding.SyncPhoneChange(ctx, shadowbinding.PhoneChangeInput{
			UserID:     user.ID,
			OldPhone:   user.Phone,
			NewPhone:   phone,
			ClientIP:   input.ClientIP,
			ClientUA:   input.ClientUA,
			VerifyCode: code,
		})
		if err != nil {
			return PhoneChangeVerifyResult{}, shadowPhoneChangeError(ctx, err, user.ID, binding)
		}
		if binding.Status != shadowbinding.StatusActive {
			return PhoneChangeVerifyResult{}, newError("shadow_binding_incomplete", "影子账号绑定尚未完成，请稍后重试。", http.StatusBadGateway)
		}
		shadowStatus = bindingStatusOrDisabled(binding.Status)
	}
	user, err = s.store.CompletePhoneChange(ctx, trimmedToken, phone, code, s.now())
	if err != nil {
		return PhoneChangeVerifyResult{}, err
	}
	return PhoneChangeVerifyResult{OK: true, User: s.projectUserForAssuranceMode(ctx, user), ShadowBindingStatus: shadowStatus}, nil
}

func (s *Service) cloudPhoneCodesEnabled() bool {
	return s.shadowBinding != nil && s.shadowBinding.Enabled()
}

func shadowPhoneChangeError(ctx context.Context, err error, userID string, binding shadowbinding.Binding) error {
	if isCloudVerifyCodeMismatch(err) {
		return newError("invalid_sms_code", "验证码不正确或已过期，请重新获取。", http.StatusBadRequest)
	}
	if isCloudPhoneBound(err) {
		return newError("phone_in_use", "该手机号已绑定其他 Lightvela 账号，请更换手机号或联系管理员处理。", http.StatusConflict)
	}
	slog.WarnContext(ctx, "shadow phone change sync failed",
		"user_id", userID,
		"binding_status", binding.Status,
		"binding_last_error_code", binding.LastErrorCode,
		"err", err,
	)
	return newError("shadow_binding_failed", "影子账号绑定失败，请稍后重试。", http.StatusBadGateway)
}

func shadowBindingError(ctx context.Context, err error, userID string) error {
	if isCloudVerifyCodeMismatch(err) {
		return newError("invalid_sms_code", "验证码不正确或已过期，请重新获取。", http.StatusBadRequest)
	}
	if isCloudPhoneBound(err) {
		return newError("phone_in_use", "该手机号已绑定其他 Lightvela 账号，请更换手机号或联系管理员处理。", http.StatusConflict)
	}
	slog.WarnContext(ctx, "shadow account binding failed",
		"user_id", userID,
		"err", err,
	)
	return newError("shadow_binding_failed", "影子账号绑定失败，请稍后重试。", http.StatusBadGateway)
}

func shadowBasicAuthError(ctx context.Context, err error, userID string, binding shadowbinding.Binding) error {
	slog.WarnContext(ctx, "shadow basic auth sync failed",
		"user_id", userID,
		"shadow_user_name", binding.ShadowUserName,
		"uin", binding.Uin,
		"binding_status", binding.Status,
		"err", err,
	)
	return newError("shadow_basic_auth_failed", "Lightvela 实名信息同步失败，请稍后重试。", http.StatusBadGateway)
}

func isCloudVerifyCodeMismatch(err error) bool {
	if err == nil {
		return false
	}
	message := err.Error()
	return strings.Contains(message, "VerifyCodeNotMatch") ||
		strings.Contains(message, "phone verify code error")
}

func isCloudPhoneBound(err error) bool {
	if err == nil {
		return false
	}
	message := err.Error()
	return strings.Contains(message, "LimitExceeded.PhoneNumBound") ||
		strings.Contains(message, "Phone number binding exceeds limit")
}

func (s *Service) ValidateInvite(ctx context.Context, code string) (InviteValidation, error) {
	return InviteValidation{
		Code:    strings.TrimSpace(code),
		State:   "valid",
		Message: "邀请码校验已关闭。",
	}, nil
}

func (s *Service) ActivateInvite(ctx context.Context, token string, code string) (User, error) {
	trimmedToken := strings.TrimSpace(token)
	if trimmedToken == "" {
		return User{}, newError("unauthorized", "未登录或登录已失效。", 401)
	}
	return s.store.ActivateInviteForCurrentUser(ctx, trimmedToken, code, s.now())
}

func (s *Service) SignUpWithPassword(ctx context.Context, input PasswordSignUpInput) (*AuthSession, error) {
	input.Email = normalizeEmail(input.Email)
	if !isValidEmail(input.Email) {
		return nil, newError("invalid_email", "邮箱格式不正确。", 400)
	}
	if len(input.Password) < 8 {
		return nil, newError("invalid_password", "密码至少需要 8 位。", 400)
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(input.Password), bcrypt.DefaultCost)
	if err != nil {
		return nil, fmt.Errorf("hash password: %w", err)
	}
	return s.store.CreatePasswordSession(ctx, input, hash, s.now(), s.sessionTTL)
}

func (s *Service) SignInWithPassword(ctx context.Context, email string, password string) (*AuthSession, error) {
	normalizedEmail := normalizeEmail(email)
	if !isValidEmail(normalizedEmail) {
		return nil, newError("invalid_email", "邮箱格式不正确。", 400)
	}
	if len(password) < 8 {
		return nil, newError("invalid_password", "密码至少需要 8 位。", 400)
	}

	user, hash, err := s.store.GetPasswordUser(ctx, normalizedEmail)
	if err != nil {
		return nil, err
	}
	if err := bcrypt.CompareHashAndPassword(hash, []byte(password)); err != nil {
		return nil, newError("invalid_credentials", "账号或密码不正确。", 401)
	}

	return s.store.CreateSession(ctx, user, s.now(), s.sessionTTL)
}

func (s *Service) SignInWithOAuth(ctx context.Context, input OAuthSignInInput) (*AuthSession, error) {
	return s.signInOrBindOAuth(ctx, "", input)
}

func (s *Service) CreateSessionForUser(ctx context.Context, userID string, ttl time.Duration) (*AuthSession, error) {
	trimmedUserID := strings.TrimSpace(userID)
	if trimmedUserID == "" {
		return nil, newError("invalid_user_id", "用户 ID 不能为空。", http.StatusBadRequest)
	}
	if ttl <= 0 {
		return nil, newError("invalid_session_ttl", "session TTL 必须大于 0。", http.StatusBadRequest)
	}
	user, err := s.store.FindUserByID(ctx, trimmedUserID)
	if err != nil {
		return nil, err
	}
	return s.store.CreateSession(ctx, user, s.now(), ttl)
}

func (s *Service) BindOAuthToCurrentSession(ctx context.Context, token string, input OAuthSignInInput) (*AuthSession, error) {
	trimmedToken := strings.TrimSpace(token)
	if trimmedToken == "" {
		return nil, newError("unauthorized", "未登录或登录已失效。", 401)
	}
	return s.signInOrBindOAuth(ctx, trimmedToken, input)
}

func (s *Service) signInOrBindOAuth(ctx context.Context, currentToken string, input OAuthSignInInput) (*AuthSession, error) {
	input.Provider = strings.ToLower(strings.TrimSpace(input.Provider))
	input.ProviderSubject = strings.TrimSpace(input.ProviderSubject)
	input.Email = normalizeEmail(input.Email)
	input.Name = strings.TrimSpace(input.Name)
	input.AvatarURL = strings.TrimSpace(input.AvatarURL)

	if input.Provider == "" || input.ProviderSubject == "" {
		return nil, newError("invalid_oauth_identity", "第三方登录信息不完整。", 400)
	}
	if input.Email != "" && !isValidEmail(input.Email) {
		return nil, newError("invalid_oauth_identity", "第三方账号邮箱格式不正确。", 400)
	}
	if input.Name == "" {
		input.Name = oauthFallbackName(input.Provider)
	}

	if strings.TrimSpace(currentToken) != "" {
		return s.store.BindOAuthSession(ctx, currentToken, input, s.now(), s.sessionTTL)
	}
	return s.store.CreateOAuthSession(ctx, input, s.now(), s.sessionTTL)
}

func (s *Service) ForgotPassword(_ context.Context, email string) error {
	if !isValidEmail(normalizeEmail(email)) {
		return newError("invalid_email", "邮箱格式不正确。", 400)
	}
	return nil
}

func (s *Service) CurrentSession(ctx context.Context, token string) (*AuthSession, error) {
	session, err := s.store.CurrentSession(ctx, token, s.now())
	if err != nil {
		return nil, err
	}
	session.User = s.projectUserForAssuranceMode(ctx, session.User)
	return s.decorateCurrentSessionRealnameSyncStatus(ctx, session), nil
}

func (s *Service) decorateCurrentSessionRealnameSyncStatus(ctx context.Context, session *AuthSession) *AuthSession {
	if session == nil {
		return session
	}
	if !s.shadowBasicAuthSyncEnabled {
		return session
	}
	if session.User.RealnameLevel == RealnameLevelPhone3FA {
		session.User.RealnameSyncStatus = RealnameSyncStatusSucceeded
		return session
	}
	if !s.cloudPhoneCodesEnabled() {
		return session
	}
	if session.User.Phone == "" || session.User.RealnameLevel != RealnameLevelIDCard2FA {
		return session
	}
	binding, active, err := s.shadowBinding.HasActiveBinding(ctx, session.User.ID)
	if err != nil {
		slog.WarnContext(ctx, "realname sync status decoration skipped: get shadow binding failed",
			"user_id", session.User.ID,
			"err", err,
		)
		return session
	}
	if !active {
		return session
	}
	session.User.RealnameSyncStatus = realnameSyncStatusFromShadowBinding(binding, active)
	if session.User.RealnameSyncStatus != RealnameSyncStatusSucceeded {
		slog.InfoContext(ctx, "realname sync status decorated: basic auth not synced",
			"user_id", session.User.ID,
			"shadow_user_name", binding.ShadowUserName,
			"uin", binding.Uin,
			"basic_auth_status", binding.BasicAuthStatus,
			"basic_auth_last_error_code", binding.BasicAuthLastErrorCode,
		)
	}
	return session
}

func (s *Service) CreateImpersonationSession(ctx context.Context, userID string, reason string) (*AuthSession, error) {
	trimmedUserID := strings.TrimSpace(userID)
	if trimmedUserID == "" {
		return nil, newError("user_not_found", "用户不存在。", http.StatusNotFound)
	}
	trimmedReason := strings.TrimSpace(reason)
	if trimmedReason == "" {
		return nil, newError("impersonation_reason_required", "请填写代登原因。", http.StatusBadRequest)
	}
	if len([]rune(trimmedReason)) > 512 {
		return nil, newError("impersonation_reason_too_long", "代登原因不能超过 512 个字符。", http.StatusBadRequest)
	}
	user, err := s.store.FindUserByID(ctx, trimmedUserID)
	if err != nil {
		return nil, err
	}
	return s.store.CreateImpersonationSession(ctx, user, trimmedReason, s.now(), impersonationSessionTTL)
}

func (s *Service) VerifyRealname(ctx context.Context, token string, input RealnameVerifyInput) (RealnameVerifyResult, error) {
	if s.realnameFaceID.Mode == RealnameAssuranceModeFaceRequired {
		return RealnameVerifyResult{}, newError("realname_faceid_required", "请使用人脸实名认证流程完成认证。", http.StatusConflict)
	}
	trimmedToken := strings.TrimSpace(token)
	if trimmedToken == "" {
		return RealnameVerifyResult{}, newError("unauthorized", "未登录或登录已失效。", http.StatusUnauthorized)
	}
	name := strings.TrimSpace(input.Name)
	idCard := strings.ToUpper(strings.TrimSpace(input.IDCard))
	if name == "" {
		return RealnameVerifyResult{}, newError("invalid_realname", "姓名不能为空。", http.StatusBadRequest)
	}
	if !isValidMainlandIDCard(idCard) {
		return RealnameVerifyResult{}, newError("invalid_id_card", "身份证号格式不正确。", http.StatusBadRequest)
	}
	if s.realnameVerifier == nil || s.realnameCipher == nil {
		return RealnameVerifyResult{}, newError("realname_unavailable", "实名认证服务暂不可用。", http.StatusServiceUnavailable)
	}
	if _, err := s.store.CurrentSession(ctx, trimmedToken, s.now()); err != nil {
		return RealnameVerifyResult{}, err
	}
	providerResult, err := s.realnameVerifier.Verify(ctx, name, idCard)
	if err != nil {
		return RealnameVerifyResult{}, &Error{Code: "realname_verify_failed", Message: "实名认证服务异常，请稍后再试。", Status: http.StatusBadGateway}
	}
	if strings.TrimSpace(providerResult.Result) != "0" {
		return RealnameVerifyResult{}, &Error{Code: "realname_mismatch", Message: "证件号不匹配，请重新输入。", Status: http.StatusBadRequest}
	}

	nameCiphertext, err := s.realnameCipher.Encrypt(name)
	if err != nil {
		return RealnameVerifyResult{}, fmt.Errorf("encrypt realname name: %w", err)
	}
	idCardCiphertext, err := s.realnameCipher.Encrypt(idCard)
	if err != nil {
		return RealnameVerifyResult{}, fmt.Errorf("encrypt realname id card: %w", err)
	}

	result := RealnameVerifyResult{
		OK:           true,
		Verified:     true,
		NameMasked:   maskRealname(name),
		IDCardMasked: maskIDCard(idCard),
		RequestID:    strings.TrimSpace(providerResult.RequestID),
	}
	if err := s.store.UpdateRealname(ctx, trimmedToken, UpdateRealnameInput{
		Provider:         "tencent_faceid",
		Result:           providerResult.Result,
		RequestID:        providerResult.RequestID,
		NameCiphertext:   nameCiphertext,
		IDCardCiphertext: idCardCiphertext,
		NameMasked:       result.NameMasked,
		IDCardMasked:     result.IDCardMasked,
		VerifiedAt:       s.now(),
	}); err != nil {
		return RealnameVerifyResult{}, err
	}
	result.PhoneVerificationRequired = true
	phoneResult, skipped, err := s.completeRealnamePhoneIfEligible(ctx, trimmedToken, name, idCard, input.ClientIP, input.ClientUA)
	if err != nil {
		return RealnameVerifyResult{}, err
	}
	if skipped {
		result.PhoneVerificationRequired = false
		result.PhoneVerificationSkipped = true
		result.RealnameLevel = phoneResult.RealnameLevel
		result.ShadowBindingStatus = phoneResult.ShadowBindingStatus
	}
	return result, nil
}

func (s *Service) phoneVerifiedInSession(session *AuthSession) bool {
	if session == nil {
		return false
	}
	if strings.TrimSpace(session.User.Phone) == "" {
		return false
	}
	return session.AuthMethod == AuthMethodSMS
}

func (s *Service) completeRealnamePhoneIfEligible(ctx context.Context, token string, name, idCard, clientIP, clientUA string) (RealnamePhoneVerifyResult, bool, error) {
	session, err := s.store.CurrentSession(ctx, token, s.now())
	if err != nil {
		return RealnamePhoneVerifyResult{}, false, err
	}

	user := session.User
	if user.Phone == "" {
		return RealnamePhoneVerifyResult{}, false, nil
	}
	if !isAtLeastRealnameLevel(user.RealnameLevel, RealnameLevelIDCard2FA) && !user.RealnameVerified {
		return RealnamePhoneVerifyResult{}, false, newError("realname_required", "请先完成实名认证。", http.StatusForbidden)
	}

	if s.cloudPhoneCodesEnabled() {
		_, active, err := s.shadowBinding.HasActiveBinding(ctx, user.ID)
		if err != nil {
			return RealnamePhoneVerifyResult{}, false, err
		}
		if !active {
			return RealnamePhoneVerifyResult{}, false, nil
		}
		binding, err := s.shadowBinding.BindShadowAccount(ctx, shadowbinding.BindInput{
			UserID:   user.ID,
			Phone:    user.Phone,
			ClientIP: strings.TrimSpace(clientIP),
			ClientUA: strings.TrimSpace(clientUA),
		})
		if err != nil {
			return RealnamePhoneVerifyResult{}, false, shadowBindingError(ctx, err, user.ID)
		}
		if binding.Status != shadowbinding.StatusActive {
			return RealnamePhoneVerifyResult{}, false, nil
		}
		if err := s.syncShadowBasicAuth(ctx, user.ID, name, idCard, clientIP, clientUA, true); err != nil {
			_ = shadowBasicAuthError(ctx, err, user.ID, binding)
			return RealnamePhoneVerifyResult{}, false, nil
		}
		updatedUser, err := s.store.MarkCurrentUserPhoneRealnameVerified(ctx, token, s.now())
		if err != nil {
			return RealnamePhoneVerifyResult{}, false, err
		}
		return RealnamePhoneVerifyResult{
			OK:                  true,
			RealnameLevel:       updatedUser.RealnameLevel,
			ShadowBindingStatus: bindingStatusOrDisabled(binding.Status),
		}, true, nil
	}

	if !s.phoneVerifiedInSession(session) {
		return RealnamePhoneVerifyResult{}, false, nil
	}

	updatedUser, err := s.store.MarkCurrentUserPhoneRealnameVerified(ctx, token, s.now())
	if err != nil {
		return RealnamePhoneVerifyResult{}, false, err
	}
	return RealnamePhoneVerifyResult{
		OK:                  true,
		RealnameLevel:       updatedUser.RealnameLevel,
		ShadowBindingStatus: shadowbinding.StatusDisabled,
	}, true, nil
}

func (s *Service) syncStoredShadowBasicAuth(ctx context.Context, userID, clientIP, clientUA string, force bool) error {
	if s.realnameCipher == nil {
		return errors.New("realname cipher is not configured")
	}
	realname, err := s.store.GetUserRealname(ctx, userID)
	if err != nil {
		return err
	}
	name, err := s.realnameCipher.Decrypt(realname.NameCiphertext)
	if err != nil {
		return fmt.Errorf("decrypt realname name: %w", err)
	}
	idCard, err := s.realnameCipher.Decrypt(realname.IDCardCiphertext)
	if err != nil {
		return fmt.Errorf("decrypt realname id card: %w", err)
	}
	return s.syncShadowBasicAuth(ctx, userID, name, idCard, clientIP, clientUA, force)
}

func (s *Service) syncShadowBasicAuth(ctx context.Context, userID, name, idCard, clientIP, clientUA string, force bool) error {
	if s == nil || !s.shadowBasicAuthSyncEnabled {
		slog.InfoContext(ctx, "shadow basic auth sync skipped: feature disabled", "user_id", userID)
		return nil
	}
	if s == nil || s.shadowBinding == nil || !s.shadowBinding.Enabled() {
		slog.InfoContext(ctx, "shadow basic auth sync skipped: shadow binding disabled", "user_id", userID)
		return nil
	}
	binding, active, err := s.shadowBinding.HasActiveBinding(ctx, userID)
	if err != nil {
		slog.WarnContext(ctx, "shadow basic auth sync skipped: get binding failed", "user_id", userID, "err", err)
		return err
	}
	if !active {
		slog.InfoContext(ctx, "shadow basic auth sync skipped: binding is not active",
			"user_id", userID,
			"shadow_user_name", binding.ShadowUserName,
			"status", binding.Status,
			"last_error_code", binding.LastErrorCode,
		)
		return errors.New("shadow binding is not active")
	}
	if !force && shadowBasicAuthSucceeded(binding) {
		return nil
	}
	startedAt := time.Now()
	slog.InfoContext(ctx, "shadow basic auth sync started after realname",
		"user_id", userID,
		"shadow_user_name", binding.ShadowUserName,
		"uin", binding.Uin,
		"account_type", 0,
		"has_id_card", strings.TrimSpace(idCard) != "",
		"has_client_ip", strings.TrimSpace(clientIP) != "",
		"has_client_ua", strings.TrimSpace(clientUA) != "",
	)
	if err := s.shadowBinding.SaveBasicAuth(ctx, shadowbinding.BasicAuthInput{
		UserID:      userID,
		AccountType: 0,
		Name:        name,
		IDCard:      idCard,
		ClientIP:    clientIP,
		ClientUA:    clientUA,
	}); err != nil {
		slog.WarnContext(ctx, "shadow basic auth sync failed after realname",
			"user_id", userID,
			"shadow_user_name", binding.ShadowUserName,
			"uin", binding.Uin,
			"duration_ms", time.Since(startedAt).Milliseconds(),
			"err", err,
		)
		return err
	}
	slog.InfoContext(ctx, "shadow basic auth sync succeeded after realname",
		"user_id", userID,
		"shadow_user_name", binding.ShadowUserName,
		"uin", binding.Uin,
		"duration_ms", time.Since(startedAt).Milliseconds(),
	)
	return nil
}

func (s *Service) VerifyRealnamePhone(ctx context.Context, token string, input RealnamePhoneVerifyInput) (RealnamePhoneVerifyResult, error) {
	if s.realnameFaceID.Mode == RealnameAssuranceModeFaceRequired {
		return RealnamePhoneVerifyResult{}, newError("realname_faceid_required", "请使用人脸实名认证流程完成认证。", http.StatusConflict)
	}
	trimmedToken := strings.TrimSpace(token)
	if trimmedToken == "" {
		return RealnamePhoneVerifyResult{}, newError("unauthorized", "未登录或登录已失效。", http.StatusUnauthorized)
	}
	code := strings.TrimSpace(input.Code)
	if code == "" {
		return RealnamePhoneVerifyResult{}, newError("invalid_sms_code", "验证码不能为空。", http.StatusBadRequest)
	}
	if !s.cloudPhoneCodesEnabled() {
		user, err := s.store.VerifyCurrentUserPhoneChallenge(ctx, trimmedToken, code, s.now())
		if err != nil {
			return RealnamePhoneVerifyResult{}, err
		}
		return RealnamePhoneVerifyResult{OK: true, RealnameLevel: user.RealnameLevel, ShadowBindingStatus: shadowbinding.StatusDisabled}, nil
	}
	session, err := s.store.CurrentSession(ctx, trimmedToken, s.now())
	if err != nil {
		return RealnamePhoneVerifyResult{}, err
	}
	user := session.User
	if user.Phone == "" {
		return RealnamePhoneVerifyResult{}, newError("phone_required", "当前账号未绑定手机号。", http.StatusBadRequest)
	}
	if err := s.enforceVerificationCheckLimits(ctx, VerificationChannelSMS, user.Phone, input.ClientIP); err != nil {
		return RealnamePhoneVerifyResult{}, err
	}
	if !isAtLeastRealnameLevel(user.RealnameLevel, RealnameLevelIDCard2FA) && !user.RealnameVerified {
		return RealnamePhoneVerifyResult{}, newError("realname_required", "请先完成实名认证。", http.StatusForbidden)
	}
	reservation, err := s.reserveExternalSMSChallenge(ctx, user.Phone)
	if err != nil {
		return RealnamePhoneVerifyResult{}, err
	}
	binding, err := s.shadowBinding.BindShadowAccount(ctx, shadowbinding.BindInput{
		UserID:     user.ID,
		Phone:      user.Phone,
		ClientIP:   strings.TrimSpace(input.ClientIP),
		ClientUA:   strings.TrimSpace(input.ClientUA),
		VerifyCode: code,
	})
	if err != nil {
		_ = s.store.RejectExternalSMSChallenge(ctx, reservation, s.now())
		return RealnamePhoneVerifyResult{}, shadowBindingError(ctx, err, user.ID)
	}
	if err := s.store.ConsumeExternalSMSChallenge(ctx, reservation); err != nil {
		return RealnamePhoneVerifyResult{}, err
	}
	if binding.Status != shadowbinding.StatusActive {
		return RealnamePhoneVerifyResult{}, newError("shadow_binding_incomplete", "影子账号绑定尚未完成，请稍后重试。", http.StatusBadGateway)
	}
	if err := s.syncStoredShadowBasicAuth(ctx, user.ID, input.ClientIP, input.ClientUA, false); err != nil {
		return RealnamePhoneVerifyResult{}, shadowBasicAuthError(ctx, err, user.ID, binding)
	}
	updatedUser, err := s.store.MarkCurrentUserPhoneRealnameVerified(ctx, trimmedToken, s.now())
	if err != nil {
		return RealnamePhoneVerifyResult{}, err
	}
	return RealnamePhoneVerifyResult{
		OK:                  true,
		RealnameLevel:       updatedUser.RealnameLevel,
		RealnameSyncStatus:  RealnameSyncStatusSucceeded,
		ShadowBindingStatus: bindingStatusOrDisabled(binding.Status),
	}, nil
}

func (s *Service) RetryRealnameSync(ctx context.Context, token string, clientIP, clientUA string) (RealnameSyncRetryResult, error) {
	if s.realnameFaceID.Mode == RealnameAssuranceModeFaceRequired {
		return RealnameSyncRetryResult{}, newError("realname_faceid_required", "请使用人脸实名认证流程完成认证。", http.StatusConflict)
	}
	trimmedToken := strings.TrimSpace(token)
	if trimmedToken == "" {
		return RealnameSyncRetryResult{}, newError("unauthorized", "未登录或登录已失效。", http.StatusUnauthorized)
	}
	session, err := s.CurrentSession(ctx, trimmedToken)
	if err != nil {
		return RealnameSyncRetryResult{}, err
	}
	user := session.User
	if user.RealnameLevel == RealnameLevelPhone3FA {
		user.RealnameSyncStatus = RealnameSyncStatusSucceeded
		return RealnameSyncRetryResult{
			OK:                  true,
			User:                user,
			RealnameSyncStatus:  RealnameSyncStatusSucceeded,
			ShadowBindingStatus: s.currentShadowBindingStatusOrDisabled(ctx, user.ID),
		}, nil
	}
	if !isAtLeastRealnameLevel(user.RealnameLevel, RealnameLevelIDCard2FA) && !user.RealnameVerified {
		return RealnameSyncRetryResult{}, newError("realname_required", "请先完成实名认证。", http.StatusForbidden)
	}
	if strings.TrimSpace(user.Phone) == "" {
		return RealnameSyncRetryResult{}, newError("phone_required", "当前账号未绑定手机号。", http.StatusBadRequest)
	}
	if !s.shadowBasicAuthSyncEnabled {
		return RealnameSyncRetryResult{}, newError("shadow_basic_auth_sync_disabled", "Lightvela 账号同步暂未启用。", http.StatusServiceUnavailable)
	}
	if s.shadowBinding == nil || !s.shadowBinding.Enabled() {
		return RealnameSyncRetryResult{}, newError("shadow_binding_disabled", "Lightvela 账号同步暂未启用。", http.StatusServiceUnavailable)
	}
	binding, err := s.shadowBinding.GetBindingByUserID(ctx, user.ID)
	if err != nil {
		if errors.Is(err, shadowbinding.ErrNotFound) {
			return RealnameSyncRetryResult{}, newError("shadow_binding_incomplete", "Lightvela 账号绑定尚未完成，请稍后重试。", http.StatusBadGateway)
		}
		return RealnameSyncRetryResult{}, err
	}
	if binding.Status != shadowbinding.StatusActive {
		return RealnameSyncRetryResult{}, newError("shadow_binding_incomplete", "Lightvela 账号绑定尚未完成，请稍后重试。", http.StatusBadGateway)
	}
	if err := s.syncStoredShadowBasicAuth(ctx, user.ID, clientIP, clientUA, true); err != nil {
		return RealnameSyncRetryResult{}, shadowBasicAuthError(ctx, err, user.ID, binding)
	}
	updatedUser, err := s.store.MarkCurrentUserPhoneRealnameVerified(ctx, trimmedToken, s.now())
	if err != nil {
		return RealnameSyncRetryResult{}, err
	}
	updatedUser.RealnameSyncStatus = RealnameSyncStatusSucceeded
	return RealnameSyncRetryResult{
		OK:                  true,
		User:                updatedUser,
		RealnameSyncStatus:  RealnameSyncStatusSucceeded,
		ShadowBindingStatus: bindingStatusOrDisabled(binding.Status),
	}, nil
}

func (s *Service) currentShadowBindingStatusOrDisabled(ctx context.Context, userID string) string {
	if s == nil || s.shadowBinding == nil {
		return shadowbinding.StatusDisabled
	}
	binding, err := s.shadowBinding.GetBindingByUserID(ctx, userID)
	if err != nil {
		return shadowbinding.StatusDisabled
	}
	return bindingStatusOrDisabled(binding.Status)
}

func (s *Service) CurrentShadowBinding(ctx context.Context, token string) (ShadowBindingResult, error) {
	session, err := s.CurrentSession(ctx, token)
	if err != nil {
		return ShadowBindingResult{}, err
	}
	if s.shadowBinding == nil {
		return ShadowBindingResult{UserID: session.User.ID, Status: shadowbinding.StatusDisabled}, nil
	}
	binding, err := s.shadowBinding.GetBindingByUserID(ctx, session.User.ID)
	if err != nil {
		if errors.Is(err, shadowbinding.ErrNotFound) {
			return ShadowBindingResult{UserID: session.User.ID, Status: "missing"}, nil
		}
		return ShadowBindingResult{}, err
	}
	return toShadowBindingResult(binding), nil
}

func (s *Service) RetryShadowBinding(ctx context.Context, token string) (ShadowBindingResult, error) {
	session, err := s.CurrentSession(ctx, token)
	if err != nil {
		return ShadowBindingResult{}, err
	}
	if s.shadowBinding == nil {
		return ShadowBindingResult{UserID: session.User.ID, Status: "disabled"}, nil
	}
	binding, err := s.shadowBinding.BindShadowAccount(ctx, shadowbinding.BindInput{UserID: session.User.ID, Phone: session.User.Phone})
	if err != nil && binding.UserID == "" {
		return ShadowBindingResult{}, err
	}
	return toShadowBindingResult(binding), nil
}

func (s *Service) InternalShadowBinding(ctx context.Context, userID string) (ShadowBindingResult, error) {
	return s.activeShadowBindingByUserID(ctx, userID)
}

func (s *Service) CheckSaaSAccountExist(ctx context.Context, userID string) (bool, error) {
	trimmed := strings.TrimSpace(userID)
	if trimmed == "" {
		return false, nil
	}
	_, err := s.store.FindUserByID(ctx, trimmed)
	if err == nil {
		return true, nil
	}
	if err != nil {
		var authErr *Error
		if !errors.As(err, &authErr) || authErr.Status != http.StatusNotFound {
			return false, err
		}
	}
	if s.shadowBinding != nil {
		if _, err := s.shadowBinding.GetBindingByShadowUserName(ctx, trimmed); err == nil {
			return true, nil
		} else if err != nil && !errors.Is(err, shadowbinding.ErrNotFound) {
			return false, err
		}
	}
	return false, nil
}

func (s *Service) CheckSaaSAuthCode(ctx context.Context, code string) (string, error) {
	if s.shadowBinding == nil {
		slog.InfoContext(ctx, "shadow saas auth code check skipped: shadow binding disabled")
		return "", nil
	}
	record, err := s.shadowBinding.ConsumeAuthCode(ctx, code)
	if err != nil {
		if errors.Is(err, shadowbinding.ErrNotFound) {
			slog.InfoContext(ctx, "shadow saas auth code check returned empty: code not found or expired")
			return "", nil
		}
		slog.WarnContext(ctx, "shadow saas auth code check failed: consume code error", "err", err)
		return "", err
	}
	if binding, err := s.shadowBinding.GetBindingByUserID(ctx, record.UserID); err == nil && strings.TrimSpace(binding.ShadowUserName) != "" {
		slog.InfoContext(ctx, "shadow saas auth code check succeeded",
			"user_id", record.UserID,
			"shadow_user_name", binding.ShadowUserName,
			"purpose", record.Purpose,
			"binding_status", binding.Status,
		)
		return binding.ShadowUserName, nil
	} else if err != nil && !errors.Is(err, shadowbinding.ErrNotFound) {
		slog.WarnContext(ctx, "shadow saas auth code check failed: get binding error", "user_id", record.UserID, "err", err)
		return "", err
	}
	slog.WarnContext(ctx, "shadow saas auth code check fell back to internal user id",
		"user_id", record.UserID,
		"purpose", record.Purpose,
	)
	return record.UserID, nil
}

func (s *Service) activeShadowBindingByUserID(ctx context.Context, userID string) (ShadowBindingResult, error) {
	if s.shadowBinding == nil {
		return ShadowBindingResult{}, newError("shadow_binding_not_found", "影子账号绑定不存在。", http.StatusNotFound)
	}
	binding, err := s.shadowBinding.GetBindingByUserID(ctx, strings.TrimSpace(userID))
	if err != nil {
		if errors.Is(err, shadowbinding.ErrNotFound) {
			return ShadowBindingResult{}, newError("shadow_binding_not_found", "影子账号绑定不存在。", http.StatusNotFound)
		}
		return ShadowBindingResult{}, err
	}
	if binding.Status != shadowbinding.StatusActive {
		return ShadowBindingResult{}, newError("shadow_binding_not_found", "影子账号绑定不存在。", http.StatusNotFound)
	}
	return toShadowBindingResult(binding), nil
}

func toShadowBindingResult(binding shadowbinding.Binding) ShadowBindingResult {
	return ShadowBindingResult{
		UserID:                    binding.UserID,
		ShadowUserName:            binding.ShadowUserName,
		Uin:                       binding.Uin,
		OwnerUin:                  binding.OwnerUin,
		AppID:                     binding.AppID,
		Status:                    binding.Status,
		LastErrorCode:             binding.LastErrorCode,
		LastErrorMessage:          binding.LastErrorMessage,
		BasicAuthStatus:           binding.BasicAuthStatus,
		BasicAuthSyncedAt:         binding.BasicAuthSyncedAt,
		BasicAuthLastErrorCode:    binding.BasicAuthLastErrorCode,
		BasicAuthLastErrorMessage: binding.BasicAuthLastErrorMessage,
		CreatedAt:                 binding.CreatedAt,
		UpdatedAt:                 binding.UpdatedAt,
	}
}

func bindingStatusOrDisabled(status string) string {
	trimmed := strings.TrimSpace(status)
	if trimmed == "" {
		return "disabled"
	}
	return trimmed
}

func shadowBasicAuthSucceeded(binding shadowbinding.Binding) bool {
	return strings.TrimSpace(binding.BasicAuthStatus) == shadowbinding.BasicAuthStatusSucceeded
}

func realnameSyncStatusFromShadowBinding(binding shadowbinding.Binding, active bool) string {
	if !active {
		return ""
	}
	switch strings.TrimSpace(binding.BasicAuthStatus) {
	case shadowbinding.BasicAuthStatusSucceeded:
		return RealnameSyncStatusSucceeded
	case shadowbinding.BasicAuthStatusFailed:
		return RealnameSyncStatusFailed
	default:
		return RealnameSyncStatusPending
	}
}

func (s *Service) CurrentProfile(ctx context.Context, token string) (User, error) {
	session, err := s.CurrentSession(ctx, token)
	if err != nil {
		return User{}, err
	}
	return session.User, nil
}

func (s *Service) FindUserByID(ctx context.Context, userID string) (User, error) {
	trimmedUserID := strings.TrimSpace(userID)
	if trimmedUserID == "" {
		return User{}, newError("user_not_found", "用户不存在。", 404)
	}
	user, err := s.store.FindUserByID(ctx, trimmedUserID)
	if err != nil {
		return User{}, err
	}
	return s.projectUserForAssuranceMode(ctx, user), nil
}

func (s *Service) UpdateProfile(ctx context.Context, token string, name string) (User, error) {
	trimmed := strings.TrimSpace(name)
	if trimmed == "" {
		return User{}, newError("invalid_name", "昵称不能为空。", 400)
	}
	if len([]rune(trimmed)) > 40 {
		return User{}, newError("invalid_name", "昵称不能超过 40 个字符。", 400)
	}
	if s.contentAudit.nameAuditEnabled() {
		if !s.contentAudit.ready() {
			return User{}, newError("content_audit_unavailable", "昵称审核服务暂不可用。", http.StatusServiceUnavailable)
		}
		if s.contentAuditClient != nil {
			current, err := s.CurrentProfile(ctx, token)
			if err != nil {
				return User{}, err
			}
			if err := s.auditNameSynchronously(ctx, current.ID, trimmed); err != nil {
				return User{}, err
			}
			return s.store.UpdateProfile(ctx, token, trimmed, s.now())
		}
		return s.store.QueueNameAudit(ctx, token, CreateNameAuditInput{
			Name:      trimmed,
			ProductID: strings.TrimSpace(s.contentAudit.ProductID),
			SID:       strings.TrimSpace(s.contentAudit.UserSID),
		}, s.now())
	}
	return s.store.UpdateProfile(ctx, token, trimmed, s.now())
}

func (s *Service) SetUserAvatar(ctx context.Context, userID string, objectKey string, source string) (User, error) {
	trimmedUserID := strings.TrimSpace(userID)
	trimmedObjectKey := strings.TrimSpace(objectKey)
	trimmedSource := strings.TrimSpace(source)
	if trimmedUserID == "" || trimmedObjectKey == "" || trimmedSource == "" {
		return User{}, newError("invalid_avatar", "头像信息不完整。", 400)
	}
	return s.store.SetUserAvatar(ctx, trimmedUserID, trimmedObjectKey, trimmedSource, s.now())
}

func (s *Service) AvatarAuditEnabled() bool {
	if s == nil {
		return false
	}
	return s.contentAudit.avatarAuditEnabled()
}

func (s *Service) QueueAvatarAudit(ctx context.Context, userID string, objectKey string, source string, contentURL string) (User, error) {
	trimmedUserID := strings.TrimSpace(userID)
	trimmedObjectKey := strings.TrimSpace(objectKey)
	trimmedSource := strings.TrimSpace(source)
	trimmedContentURL := strings.TrimSpace(contentURL)
	if trimmedUserID == "" || trimmedObjectKey == "" || trimmedSource == "" || trimmedContentURL == "" {
		return User{}, newError("invalid_avatar", "头像信息不完整。", 400)
	}
	if !s.contentAudit.avatarAuditEnabled() {
		return s.store.SetUserAvatar(ctx, trimmedUserID, trimmedObjectKey, trimmedSource, s.now())
	}
	if !s.contentAudit.ready() {
		return User{}, newError("content_audit_unavailable", "头像审核服务暂不可用。", http.StatusServiceUnavailable)
	}
	if s.contentAuditClient != nil {
		if err := s.auditAvatarSynchronously(ctx, trimmedUserID, trimmedObjectKey, trimmedContentURL); err != nil {
			return User{}, err
		}
		return s.store.SetUserAvatar(ctx, trimmedUserID, trimmedObjectKey, trimmedSource, s.now())
	}
	return s.store.QueueAvatarAudit(ctx, trimmedUserID, CreateAvatarAuditInput{
		ObjectKey:  trimmedObjectKey,
		Source:     trimmedSource,
		ContentURL: trimmedContentURL,
		ProductID:  strings.TrimSpace(s.contentAudit.ProductID),
		SID:        strings.TrimSpace(s.contentAudit.UserSID),
	}, s.now())
}

func (s *Service) CurrentSubscription(ctx context.Context, token string) (*PlanSelection, error) {
	return s.store.CurrentSubscription(ctx, token, s.now())
}

func (s *Service) UpdateSubscription(ctx context.Context, token string, tier string) (*PlanSelection, error) {
	normalizedTier := strings.TrimSpace(strings.ToLower(tier))
	switch normalizedTier {
	case "free":
		return s.store.UpdateSubscription(ctx, token, normalizedTier, s.now())
	case "":
		return nil, newError("invalid_tier", "档位不能为空。", 400)
	default:
		return nil, newError("invalid_tier", "当前仅支持 free 档位。", 400)
	}
}

func (s *Service) ConfirmFreePlan(ctx context.Context, token string) (*PlanSelection, error) {
	return s.UpdateSubscription(ctx, token, "free")
}

func (s *Service) SignOut(ctx context.Context, token string) error {
	return s.store.DeleteSession(ctx, token)
}

func (s *Service) DeleteCurrentUser(ctx context.Context, token string) error {
	return s.store.DeleteCurrentUser(ctx, token, s.now())
}

func (s *Service) DeleteAdminUser(ctx context.Context, userID string) error {
	trimmedUserID := strings.TrimSpace(userID)
	if trimmedUserID == "" {
		return newError("invalid_user_id", "用户 ID 不能为空。", 400)
	}
	return s.store.DeleteAdminUser(ctx, trimmedUserID, s.now())
}

func (s *Service) ListAdminUsers(ctx context.Context, search string, limit int) ([]AdminUser, error) {
	return s.store.ListAdminUsers(ctx, strings.TrimSpace(search), normalizeAdminLimit(limit))
}

func (s *Service) ListAdminSMSChallenges(ctx context.Context, search string, limit int) ([]AdminSMSChallenge, error) {
	return s.store.ListAdminSMSChallenges(ctx, strings.TrimSpace(search), normalizeAdminLimit(limit))
}

func (s *Service) DeleteAdminSMSChallenge(ctx context.Context, phone string) error {
	normalized := normalizePhone(phone)
	if normalized == "" {
		return newError("invalid_phone", "手机号不能为空。", 400)
	}
	return s.store.DeleteAdminSMSChallenge(ctx, normalized)
}

func (s *Service) ListAdminInvites(ctx context.Context, search string, state string, limit int) ([]AdminInvite, error) {
	return s.store.ListAdminInvites(ctx, strings.TrimSpace(search), strings.TrimSpace(strings.ToLower(state)), normalizeAdminLimit(limit))
}

func (s *Service) CreateAdminInvite(ctx context.Context, code string, message string) (*AdminInvite, error) {
	normalizedCode := normalizeInvite(code)
	if normalizedCode == "" {
		generated, err := newInviteCode()
		if err != nil {
			return nil, fmt.Errorf("generate invite code: %w", err)
		}
		normalizedCode = generated
	}

	trimmedMessage := strings.TrimSpace(message)
	if trimmedMessage == "" {
		trimmedMessage = "邀请码有效，可加入 Lightclaw 内测。"
	}

	return s.store.CreateAdminInvite(ctx, normalizedCode, trimmedMessage, s.now())
}

func (s *Service) DisableAdminInvite(ctx context.Context, code string) error {
	normalizedCode := normalizeInvite(code)
	if normalizedCode == "" {
		return newError("invalid_invite", "邀请码不能为空。", 400)
	}
	return s.store.DisableAdminInvite(ctx, normalizedCode, s.now())
}

func (s *Service) issueSMSCode() (string, error) {
	return s.verificationCodeGenerator(s.verification.CodeDigits)
}

func ceilMinutes(value time.Duration) int {
	if value <= 0 {
		return 1
	}
	minutes := int(value / time.Minute)
	if value%time.Minute != 0 {
		minutes++
	}
	if minutes <= 0 {
		return 1
	}
	return minutes
}

func isUserNotFound(err error) bool {
	var authErr *Error
	return errors.As(err, &authErr) && authErr.Code == "user_not_found"
}

func clonePlan(plan *PlanSelection) *PlanSelection {
	if plan == nil {
		return nil
	}
	cloned := *plan
	return &cloned
}

func defaultDuration(value time.Duration, fallback time.Duration) time.Duration {
	if value > 0 {
		return value
	}
	return fallback
}

func isActiveAuditStatus(status string) bool {
	switch strings.TrimSpace(status) {
	case "pending", "submitted", "error":
		return true
	default:
		return false
	}
}

func isTerminalAuditStatus(status string) bool {
	switch strings.TrimSpace(status) {
	case "cancelled", "passed", "failed":
		return true
	default:
		return false
	}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func truncateString(value string, maxRunes int) string {
	if maxRunes <= 0 {
		return ""
	}
	runes := []rune(value)
	if len(runes) <= maxRunes {
		return value
	}
	return string(runes[:maxRunes])
}

func newOpaqueToken() (string, error) {
	var raw [32]byte
	if _, err := cryptorand.Read(raw[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(raw[:]), nil
}

func newPrefixedID(prefix string) (string, error) {
	var raw [12]byte
	if _, err := cryptorand.Read(raw[:]); err != nil {
		return "", err
	}
	return prefix + "_" + hex.EncodeToString(raw[:]), nil
}

func newInviteCode() (string, error) {
	var raw [6]byte
	if _, err := cryptorand.Read(raw[:]); err != nil {
		return "", err
	}
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	code := make([]byte, len(raw))
	for i, b := range raw {
		code[i] = alphabet[int(b)%len(alphabet)]
	}
	return string(code), nil
}

func normalizePhone(value string) string {
	normalized := strings.TrimSpace(value)
	normalized = strings.Map(func(r rune) rune {
		if r >= '0' && r <= '9' {
			return r
		}
		return -1
	}, normalized)
	normalized = strings.TrimPrefix(normalized, "86")
	return normalized
}

func normalizeEmail(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

func normalizeInvite(value string) string {
	return strings.ToUpper(strings.TrimSpace(value))
}

func isValidPhone(value string) bool {
	return chinaMainlandPhonePattern.MatchString(value)
}

func isValidEmail(value string) bool {
	return emailPattern.MatchString(value)
}

func isValidMainlandIDCard(value string) bool {
	return mainlandIDCardPattern.MatchString(strings.TrimSpace(value))
}

func isAtLeastRealnameLevel(level string, required string) bool {
	return realnameLevelRank(level) >= realnameLevelRank(required)
}

func realnameLevelRank(level string) int {
	switch normalizeRealnameLevel(level, false) {
	case RealnameLevelPhone3FA:
		return 2
	case RealnameLevelIDCard2FA:
		return 1
	default:
		return 0
	}
}

func normalizeRealnameLevel(level string, verified bool) string {
	trimmed := strings.TrimSpace(level)
	switch trimmed {
	case RealnameLevelPhone3FA, RealnameLevelIDCard2FA, RealnameLevelNone:
		return trimmed
	}
	if verified {
		return RealnameLevelIDCard2FA
	}
	return RealnameLevelNone
}

func maskRealname(name string) string {
	runes := []rune(strings.TrimSpace(name))
	if len(runes) == 0 {
		return ""
	}
	if len(runes) == 1 {
		return "*"
	}
	return string(runes[:1]) + strings.Repeat("*", len(runes)-1)
}

func maskIDCard(idCard string) string {
	trimmed := strings.TrimSpace(idCard)
	if len(trimmed) <= 8 {
		return strings.Repeat("*", len(trimmed))
	}
	return trimmed[:4] + strings.Repeat("*", len(trimmed)-8) + trimmed[len(trimmed)-4:]
}

func newError(code string, message string, status int) *Error {
	return &Error{Code: code, Message: message, Status: status}
}

func normalizeAdminLimit(limit int) int {
	if limit <= 0 {
		return 50
	}
	if limit > 200 {
		return 200
	}
	return limit
}

func adminUserAuthMethods(email string, phone string, qqOpenID string, wechatSubject string) []string {
	methods := make([]string, 0, 4)
	for _, method := range []struct {
		value string
		name  string
	}{
		{value: phone, name: "phone"},
		{value: email, name: "email"},
		{value: qqOpenID, name: "qq"},
		{value: wechatSubject, name: "wechat"},
	} {
		if strings.TrimSpace(method.value) != "" {
			methods = append(methods, method.name)
		}
	}
	return methods
}

func oauthFallbackName(provider string) string {
	switch strings.ToLower(strings.TrimSpace(provider)) {
	case "qq":
		return "QQ用户"
	case "wechat":
		return "微信用户"
	default:
		return "新用户"
	}
}

func canAutoLinkOAuthEmail(input OAuthSignInInput) bool {
	if strings.TrimSpace(input.Email) == "" {
		return false
	}
	if input.EmailVerified {
		return true
	}
	return strings.EqualFold(strings.TrimSpace(input.Provider), "github")
}
