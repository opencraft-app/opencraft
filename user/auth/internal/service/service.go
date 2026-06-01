package service

import (
	"context"
	cryptorand "crypto/rand"
	"encoding/hex"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"
)

var (
	chinaMainlandPhonePattern = regexp.MustCompile(`^1\d{10}$`)
	emailPattern              = regexp.MustCompile(`^[^@\s]+@[^@\s]+\.[^@\s]+$`)
	mainlandIDCardPattern     = regexp.MustCompile(`^\d{17}[\dXx]$`)
)

type Options struct {
	Now                func() time.Time
	SMSCooldown        time.Duration
	SMSCodeTTL         time.Duration
	SessionTTL         time.Duration
	DefaultSMSCode     string
	SeedDemoUser       bool
	RealnameVerifier   RealnameVerifier
	RealnameCipher     RealnameCipher
	ContentAudit       ContentAuditConfig
	ContentAuditClient ContentAuditClient
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
	CreatedAt              time.Time
}

type RealnameVerifyInput struct {
	Name   string
	IDCard string
}

type RealnameVerifyResult struct {
	OK           bool
	Verified     bool
	NameMasked   string
	IDCardMasked string
	RequestID    string
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
}

const impersonationSessionTTL = 30 * time.Minute

type VerifySMSInput struct {
	Name       string
	Phone      string
	Code       string
	InviteCode string
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
	now                func() time.Time
	smsCooldown        time.Duration
	smsCodeTTL         time.Duration
	sessionTTL         time.Duration
	defaultSMSCode     string
	store              Store
	realnameVerifier   RealnameVerifier
	realnameCipher     RealnameCipher
	contentAudit       ContentAuditConfig
	contentAuditClient ContentAuditClient
}

type smsChallenge struct {
	Code             string
	ExpiresAt        time.Time
	CooldownUntil    time.Time
	RemainingRetries int
}

type sessionRecord struct {
	Token               string
	UserID              string
	PlanSelection       *PlanSelection
	AuthenticatedAt     time.Time
	ExpiresAt           time.Time
	Impersonated        bool
	ImpersonationReason string
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

	return &Service{
		now:                now,
		smsCooldown:        defaultDuration(opts.SMSCooldown, time.Minute),
		smsCodeTTL:         defaultDuration(opts.SMSCodeTTL, 5*time.Minute),
		sessionTTL:         defaultDuration(opts.SessionTTL, 30*24*time.Hour),
		defaultSMSCode:     normalizeFixedSMSCode(opts.DefaultSMSCode),
		store:              store,
		realnameVerifier:   opts.RealnameVerifier,
		realnameCipher:     opts.RealnameCipher,
		contentAudit:       opts.ContentAudit,
		contentAuditClient: opts.ContentAuditClient,
	}
}

func (s *Service) SendVerificationCode(ctx context.Context, phone string) (time.Duration, error) {
	normalized := normalizePhone(phone)
	if !isValidPhone(normalized) {
		return 0, newError("invalid_phone", "手机号格式不正确。", 400)
	}
	code, err := s.issueSMSCode()
	if err != nil {
		return 0, err
	}
	return s.store.SendVerificationCode(ctx, normalized, code, s.now(), s.smsCodeTTL, s.smsCooldown)
}

func (s *Service) VerifySMS(ctx context.Context, input VerifySMSInput) (*AuthSession, error) {
	input.Phone = normalizePhone(input.Phone)
	if !isValidPhone(input.Phone) {
		return nil, newError("invalid_phone", "手机号格式不正确。", 400)
	}

	return s.store.CompleteSMSVerification(ctx, input, s.now(), s.sessionTTL)
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
	return s.store.CurrentSession(ctx, token, s.now())
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
	return result, nil
}

func (s *Service) CurrentProfile(ctx context.Context, token string) (User, error) {
	return s.store.CurrentProfile(ctx, token, s.now())
}

func (s *Service) FindUserByID(ctx context.Context, userID string) (User, error) {
	trimmedUserID := strings.TrimSpace(userID)
	if trimmedUserID == "" {
		return User{}, newError("user_not_found", "用户不存在。", 404)
	}
	return s.store.FindUserByID(ctx, trimmedUserID)
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
	if s.defaultSMSCode != "" {
		return s.defaultSMSCode, nil
	}
	var raw [3]byte
	if _, err := cryptorand.Read(raw[:]); err != nil {
		return "", fmt.Errorf("generate sms code: %w", err)
	}

	value := int(raw[0])<<16 | int(raw[1])<<8 | int(raw[2])
	return fmt.Sprintf("%06d", value%1_000_000), nil
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

func normalizeFixedSMSCode(value string) string {
	trimmed := strings.TrimSpace(value)
	if len(trimmed) != 6 {
		return ""
	}
	for _, r := range trimmed {
		if r < '0' || r > '9' {
			return ""
		}
	}
	return trimmed
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
