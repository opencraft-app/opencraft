package service

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/openclaw/openclaw/mono/backend/auth/internal/shadowbinding"
)

type RealnameAssuranceMode string

const (
	RealnameAssuranceModeLegacy       RealnameAssuranceMode = "legacy"
	RealnameAssuranceModeObserve      RealnameAssuranceMode = "observe"
	RealnameAssuranceModeFaceRequired RealnameAssuranceMode = "face_required"
)

func isActiveRealnameFaceIDState(state string) bool {
	switch state {
	case RealnameFaceIDStateCreated,
		RealnameFaceIDStatePending,
		RealnameFaceIDStateChecking,
		RealnameFaceIDStateFaceSucceeded,
		RealnameFaceIDStatePhonePending,
		RealnameFaceIDStateShadowPending:
		return true
	default:
		return false
	}
}

const (
	RealnameFaceIDStateCreated       = "created"
	RealnameFaceIDStatePending       = "pending"
	RealnameFaceIDStateChecking      = "checking"
	RealnameFaceIDStateFaceSucceeded = "face_succeeded"
	RealnameFaceIDStatePhonePending  = "phone_pending"
	RealnameFaceIDStateShadowPending = "shadow_pending"
	RealnameFaceIDStateSucceeded     = "succeeded"
	RealnameFaceIDStateFailed        = "failed"
	RealnameFaceIDStateExpired       = "expired"
	RealnameFaceIDStateLateIgnored   = "late_ignored"
	RealnameFaceIDStateRevoked       = "revoked"
)

type RealnameFaceIDConfig struct {
	Mode        RealnameAssuranceMode
	RuleID      string
	AccountID   string
	RedirectURL string
	DigestKey   []byte
	DailyQuota  int
	AttemptTTL  time.Duration
	LeaseTTL    time.Duration
}

type RealnameFaceIDStartInput struct {
	Name            string
	IDCard          string
	ClientIP        string
	ClientUA        string
	ConsentAccepted bool
}

type RealnameFaceIDStartResult struct {
	AttemptID string
	VerifyURL string
	Reused    bool
}

type RealnameFaceIDPhoneProofInput struct {
	AttemptID string
	Code      string
	ClientIP  string
	ClientUA  string
}

type RealnameFaceIDFinalizeInput struct {
	AttemptID string
	ClientIP  string
	ClientUA  string
}

type RealnameFaceIDDetectAuthInput struct {
	Name        string
	IDCard      string
	RuleID      string
	RedirectURL string
	Extra       string
	AccountID   string
}

type RealnameFaceIDDetectAuthResult struct {
	BizToken  string
	VerifyURL string
	RequestID string
}

type RealnameFaceIDGetDetectInfoInput struct {
	BizToken     string
	RuleID       string
	AccountID    string
	AttemptID    string
	IdentityHash string
	DigestKey    []byte
}

type RealnameFaceIDGetDetectInfoExpectation struct {
	RuleID       string
	AccountID    string
	AttemptID    string
	IdentityHash string
	DigestKey    []byte
}

type RealnameFaceIDProviderCheckResult struct {
	Completed      bool
	Success        bool
	RequestID      string
	ProviderExtra  string
	FailureCode    string
	FailureMessage string
}

type RealnameFaceIDProviderIntegrityError struct {
	RequestID string
	Reason    string
}

func (e *RealnameFaceIDProviderIntegrityError) Error() string {
	if e == nil || strings.TrimSpace(e.Reason) == "" {
		return "invalid FaceID provider response"
	}
	return "invalid FaceID provider response: " + strings.TrimSpace(e.Reason)
}

type RealnameFaceIDProviderRequestError struct {
	Code      string
	Message   string
	RequestID string
}

func (e *RealnameFaceIDProviderRequestError) Error() string {
	if e == nil {
		return "FaceID provider request failed"
	}
	return fmt.Sprintf("FaceID provider request failed: %s: %s", strings.TrimSpace(e.Code), strings.TrimSpace(e.Message))
}

func (e *RealnameFaceIDProviderRequestError) InvalidBizToken() bool {
	if e == nil {
		return false
	}
	code := strings.ToLower(strings.TrimSpace(e.Code))
	detail := strings.ToLower(strings.TrimSpace(e.Code + " " + e.Message))
	return strings.Contains(code, "invalidparameter") && strings.Contains(detail, "biztoken")
}

type RealnameFaceIDVerifier interface {
	DetectAuth(ctx context.Context, in RealnameFaceIDDetectAuthInput) (RealnameFaceIDDetectAuthResult, error)
	GetDetectInfoEnhanced(ctx context.Context, in RealnameFaceIDGetDetectInfoInput) (RealnameFaceIDProviderCheckResult, error)
}

type RealnameFaceIDAttempt struct {
	AttemptID            string
	UserID               string
	State                string
	NameCiphertext       string
	IDCardCiphertext     string
	NameMasked           string
	IDCardMasked         string
	IdentityHash         string
	CurrentPhoneHash     string
	PhoneVerifiedHash    string
	BizTokenCiphertext   string
	BizTokenHash         string
	VerifyURLCiphertext  string
	VerifyURL            string
	RuleID               string
	AccountID            string
	ProviderExtra        string
	DetectAuthRequestID  string
	LastGetInfoRequestID string
	FaceVerifiedAt       *time.Time
	PhoneVerifiedAt      *time.Time
	BusinessExpiresAt    time.Time
	LeaseOwner           string
	LeaseUntil           *time.Time
	LeaseVersion         int64
	ClientIPCiphertext   string
	ClientUACiphertext   string
	ScrubbedAt           *time.Time
	CreatedAt            time.Time
	UpdatedAt            time.Time
}

type RealnameFaceIDAuditEvent struct {
	AttemptID    string
	UserID       string
	EventType    string
	State        string
	RuleID       string
	AccountID    string
	RequestID    string
	IdentityHash string
	PhoneHash    string
	BizTokenHash string
	CreatedAt    time.Time
}

type faceIDStore interface {
	FindReusableRealnameFaceIDAttempt(ctx context.Context, userID string, identityHash string, phoneHash string, now time.Time) (RealnameFaceIDAttempt, error)
	FindCurrentRealnameFaceIDAttempt(ctx context.Context, userID string, now time.Time) (RealnameFaceIDAttempt, error)
	CountNewRealnameFaceIDAttempts(ctx context.Context, userID string, windowStart time.Time, windowEnd time.Time) (int, error)
	CreateRealnameFaceIDAttempt(ctx context.Context, attempt RealnameFaceIDAttempt) error
	ApplyRealnameFaceIDTransitionWithAudit(ctx context.Context, attempt RealnameFaceIDAttempt, expectedState string, expectedLeaseVersion int64, event RealnameFaceIDAuditEvent) (bool, error)
	ApplyRealnameFaceIDReconcile(ctx context.Context, attempt RealnameFaceIDAttempt, expectedLeaseVersion int64, expectedLeaseOwner string) (bool, error)
	GetRealnameFaceIDAttempt(ctx context.Context, attemptID string) (RealnameFaceIDAttempt, error)
	ClaimRealnameFaceIDAttempt(ctx context.Context, attemptID string, bizTokenHash string, owner string, leaseTTL time.Duration, now time.Time) (RealnameFaceIDAttempt, bool, error)
	ListReconcileableRealnameFaceIDAttempts(ctx context.Context, now time.Time, limit int) ([]RealnameFaceIDAttempt, error)
	ExpireRealnameFaceIDAttempts(ctx context.Context, now time.Time, limit int) (int, error)
	AppendRealnameFaceIDAuditEvent(ctx context.Context, event RealnameFaceIDAuditEvent) error
	ApplyRealnameFaceIDReconcileWithAudit(ctx context.Context, attempt RealnameFaceIDAttempt, expectedLeaseVersion int64, expectedLeaseOwner string, event RealnameFaceIDAuditEvent) (bool, error)
	ActivateRealnameFaceIDAttempt(ctx context.Context, userID string, attemptID string, currentPhone string, identityHash string, phoneHash string, faceVerifiedAt time.Time, phoneVerifiedAt time.Time, now time.Time) (User, RealnameFaceIDAttempt, error)
}

func ValidateRealnameFaceIDStartup(cfg RealnameFaceIDConfig, verifier RealnameFaceIDVerifier, cipher RealnameCipher, binding *shadowbinding.Service, shadowBasicAuthSyncEnabled bool, durableStore bool) error {
	if cfg.Mode == RealnameAssuranceModeLegacy {
		return nil
	}
	if cfg.Mode != RealnameAssuranceModeObserve && cfg.Mode != RealnameAssuranceModeFaceRequired {
		return fmt.Errorf("unsupported realname assurance mode %q", cfg.Mode)
	}
	missing := make([]string, 0, 7)
	if verifier == nil {
		missing = append(missing, "Tencent FaceID client")
	}
	if cipher == nil {
		missing = append(missing, "realname cipher")
	}
	if strings.TrimSpace(cfg.RuleID) == "" {
		missing = append(missing, "FaceID rule ID")
	}
	if strings.TrimSpace(cfg.AccountID) == "" {
		missing = append(missing, "Tencent account ID")
	}
	if strings.TrimSpace(cfg.RedirectURL) == "" {
		missing = append(missing, "FaceID redirect URL")
	}
	if len(cfg.DigestKey) != 32 {
		missing = append(missing, "32-byte digest key")
	}
	if binding == nil || !binding.Ready() {
		missing = append(missing, "Shadow binding")
	}
	if !shadowBasicAuthSyncEnabled {
		missing = append(missing, "Shadow basic-auth sync")
	}
	if !durableStore {
		missing = append(missing, "MySQL store")
	}
	if len(missing) > 0 {
		return fmt.Errorf("realname FaceID startup config incomplete: %s", strings.Join(missing, ", "))
	}
	return nil
}

func normalizeRealnameFaceIDConfig(cfg RealnameFaceIDConfig) RealnameFaceIDConfig {
	switch cfg.Mode {
	case RealnameAssuranceModeObserve, RealnameAssuranceModeFaceRequired:
	default:
		cfg.Mode = RealnameAssuranceModeLegacy
	}
	if cfg.DailyQuota <= 0 {
		cfg.DailyQuota = 5
	}
	if cfg.AttemptTTL <= 0 {
		cfg.AttemptTTL = 2 * time.Hour
	}
	if cfg.LeaseTTL <= 0 {
		cfg.LeaseTTL = 30 * time.Second
	}
	cfg.RuleID = strings.TrimSpace(cfg.RuleID)
	cfg.AccountID = strings.TrimSpace(cfg.AccountID)
	cfg.RedirectURL = strings.TrimSpace(cfg.RedirectURL)
	cfg.DigestKey = append([]byte(nil), cfg.DigestKey...)
	return cfg
}

func HashRealnameIdentityWithKey(key []byte, name string, idCard string) string {
	normalized := strings.TrimSpace(name) + "\n" + strings.ToUpper(strings.TrimSpace(idCard))
	return keyedRealnameDigest(key, normalized)
}

func keyedRealnameDigest(key []byte, value string) string {
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(value))
	return hex.EncodeToString(mac.Sum(nil))
}

func (s *Service) hashRealnamePhone(phone string) string {
	return keyedRealnameDigest(s.realnameFaceID.DigestKey, normalizePhone(phone))
}

func (s *Service) faceIDStore() (faceIDStore, error) {
	store, ok := s.store.(faceIDStore)
	if !ok {
		return nil, errors.New("realname faceid store is not configured")
	}
	return store, nil
}

func (s *Service) StartRealnameFaceIDAttempt(ctx context.Context, token string, input RealnameFaceIDStartInput) (RealnameFaceIDStartResult, error) {
	if s.realnameFaceID.Mode == RealnameAssuranceModeLegacy {
		return RealnameFaceIDStartResult{}, newError("realname_faceid_disabled", "人脸实名认证暂未启用。", http.StatusServiceUnavailable)
	}
	if !input.ConsentAccepted {
		return RealnameFaceIDStartResult{}, newError("realname_faceid_consent_required", "请先确认实名授权。", http.StatusBadRequest)
	}
	if s.realnameCipher == nil || s.realnameFaceIDVerifier == nil || s.realnameFaceID.RuleID == "" || s.realnameFaceID.RedirectURL == "" || len(s.realnameFaceID.DigestKey) < 32 {
		return RealnameFaceIDStartResult{}, newError("realname_faceid_unavailable", "人脸实名认证服务暂不可用。", http.StatusServiceUnavailable)
	}
	store, err := s.faceIDStore()
	if err != nil {
		return RealnameFaceIDStartResult{}, err
	}
	session, err := s.store.CurrentSession(ctx, strings.TrimSpace(token), s.now())
	if err != nil {
		return RealnameFaceIDStartResult{}, err
	}
	name := strings.TrimSpace(input.Name)
	idCard := strings.ToUpper(strings.TrimSpace(input.IDCard))
	if name == "" {
		return RealnameFaceIDStartResult{}, newError("invalid_realname", "姓名不能为空。", http.StatusBadRequest)
	}
	if !isValidMainlandIDCard(idCard) {
		return RealnameFaceIDStartResult{}, newError("invalid_id_card", "身份证号格式不正确。", http.StatusBadRequest)
	}
	if strings.TrimSpace(session.User.Phone) == "" {
		return RealnameFaceIDStartResult{}, newError("phone_required", "当前账号未绑定手机号。", http.StatusBadRequest)
	}
	now := s.now()
	identityHash := HashRealnameIdentityWithKey(s.realnameFaceID.DigestKey, name, idCard)
	phoneHash := s.hashRealnamePhone(session.User.Phone)
	if reusable, err := store.FindReusableRealnameFaceIDAttempt(ctx, session.User.ID, identityHash, phoneHash, now); err == nil {
		if reusable.State == RealnameFaceIDStatePending || reusable.State == RealnameFaceIDStateChecking {
			reconciled, reconcileErr := s.ReconcileRealnameFaceIDAttempt(ctx, reusable.AttemptID, "", "start:"+session.User.ID)
			if reconcileErr != nil {
				return RealnameFaceIDStartResult{}, reconcileErr
			}
			if reconciled.State != RealnameFaceIDStateFailed {
				reusable = reconciled
			} else {
				reusable = RealnameFaceIDAttempt{}
			}
		}
		if reusable.AttemptID != "" {
			if err := s.hydrateAttemptVerifyURL(&reusable); err != nil {
				return RealnameFaceIDStartResult{}, err
			}
			return RealnameFaceIDStartResult{AttemptID: reusable.AttemptID, VerifyURL: reusable.VerifyURL, Reused: true}, nil
		}
	}
	windowStart := now.UTC().Truncate(24 * time.Hour)
	windowEnd := windowStart.Add(24 * time.Hour)
	count, err := store.CountNewRealnameFaceIDAttempts(ctx, session.User.ID, windowStart, windowEnd)
	if err != nil {
		return RealnameFaceIDStartResult{}, err
	}
	if count >= s.realnameFaceID.DailyQuota {
		return RealnameFaceIDStartResult{}, &Error{Code: "realname_faceid_quota_exceeded", Message: "今日实名认证尝试次数已达上限。", Status: http.StatusTooManyRequests}
	}
	attemptID, err := newPrefixedID("rfid")
	if err != nil {
		return RealnameFaceIDStartResult{}, fmt.Errorf("generate realname faceid attempt id: %w", err)
	}
	nameCiphertext, err := s.realnameCipher.Encrypt(name)
	if err != nil {
		return RealnameFaceIDStartResult{}, fmt.Errorf("encrypt faceid candidate name: %w", err)
	}
	idCardCiphertext, err := s.realnameCipher.Encrypt(idCard)
	if err != nil {
		return RealnameFaceIDStartResult{}, fmt.Errorf("encrypt faceid candidate id card: %w", err)
	}
	clientIPCiphertext := ""
	if strings.TrimSpace(input.ClientIP) != "" {
		clientIPCiphertext, err = s.realnameCipher.Encrypt(strings.TrimSpace(input.ClientIP))
		if err != nil {
			return RealnameFaceIDStartResult{}, fmt.Errorf("encrypt faceid client ip: %w", err)
		}
	}
	clientUACiphertext := ""
	if strings.TrimSpace(input.ClientUA) != "" {
		clientUACiphertext, err = s.realnameCipher.Encrypt(strings.TrimSpace(input.ClientUA))
		if err != nil {
			return RealnameFaceIDStartResult{}, fmt.Errorf("encrypt faceid client ua: %w", err)
		}
	}
	attempt := RealnameFaceIDAttempt{
		AttemptID:          attemptID,
		UserID:             session.User.ID,
		State:              RealnameFaceIDStateCreated,
		NameCiphertext:     nameCiphertext,
		IDCardCiphertext:   idCardCiphertext,
		NameMasked:         maskRealname(name),
		IDCardMasked:       maskIDCard(idCard),
		IdentityHash:       identityHash,
		CurrentPhoneHash:   phoneHash,
		RuleID:             s.realnameFaceID.RuleID,
		AccountID:          s.realnameFaceID.AccountID,
		ProviderExtra:      attemptID,
		BusinessExpiresAt:  now.Add(s.realnameFaceID.AttemptTTL),
		ClientIPCiphertext: clientIPCiphertext,
		ClientUACiphertext: clientUACiphertext,
		CreatedAt:          now,
		UpdatedAt:          now,
	}
	if err := store.CreateRealnameFaceIDAttempt(ctx, attempt); err != nil {
		return RealnameFaceIDStartResult{}, err
	}
	_ = store.AppendRealnameFaceIDAuditEvent(ctx, RealnameFaceIDAuditEvent{
		AttemptID:    attempt.AttemptID,
		UserID:       attempt.UserID,
		EventType:    "start_created",
		State:        attempt.State,
		RuleID:       attempt.RuleID,
		AccountID:    attempt.AccountID,
		IdentityHash: attempt.IdentityHash,
		PhoneHash:    attempt.CurrentPhoneHash,
		CreatedAt:    now,
	})
	providerResult, err := s.realnameFaceIDVerifier.DetectAuth(ctx, RealnameFaceIDDetectAuthInput{
		Name:        name,
		IDCard:      idCard,
		RuleID:      attempt.RuleID,
		RedirectURL: s.realnameFaceID.RedirectURL,
		Extra:       attempt.ProviderExtra,
		AccountID:   attempt.AccountID,
	})
	if err != nil {
		attempt.State = RealnameFaceIDStateFailed
		s.scrubAttempt(&attempt, now)
		_, _ = store.ApplyRealnameFaceIDTransitionWithAudit(ctx, attempt, RealnameFaceIDStateCreated, attempt.LeaseVersion, RealnameFaceIDAuditEvent{
			AttemptID:    attempt.AttemptID,
			UserID:       attempt.UserID,
			EventType:    "start_failed",
			State:        attempt.State,
			RuleID:       attempt.RuleID,
			AccountID:    attempt.AccountID,
			IdentityHash: attempt.IdentityHash,
			PhoneHash:    attempt.CurrentPhoneHash,
			CreatedAt:    now,
		})
		return RealnameFaceIDStartResult{}, &Error{Code: "realname_faceid_start_failed", Message: "人脸实名认证服务异常，请稍后再试。", Status: http.StatusBadGateway}
	}
	attempt.State = RealnameFaceIDStatePending
	verifyURL := strings.TrimSpace(providerResult.VerifyURL)
	if verifyURL == "" {
		attempt.State = RealnameFaceIDStateFailed
		s.scrubAttempt(&attempt, now)
		_, _ = store.ApplyRealnameFaceIDTransitionWithAudit(ctx, attempt, RealnameFaceIDStateCreated, attempt.LeaseVersion, RealnameFaceIDAuditEvent{
			AttemptID: attempt.AttemptID, UserID: attempt.UserID, EventType: "start_failed", State: attempt.State,
			RuleID: attempt.RuleID, AccountID: attempt.AccountID, RequestID: strings.TrimSpace(providerResult.RequestID),
			IdentityHash: attempt.IdentityHash, PhoneHash: attempt.CurrentPhoneHash, CreatedAt: now,
		})
		return RealnameFaceIDStartResult{}, newError("realname_faceid_start_failed", "人脸实名认证服务异常，请稍后再试。", http.StatusBadGateway)
	}
	attempt.VerifyURLCiphertext, err = s.realnameCipher.Encrypt(verifyURL)
	if err != nil {
		s.failStartedRealnameFaceIDAttempt(ctx, store, &attempt, now, "start_storage_failed")
		return RealnameFaceIDStartResult{}, fmt.Errorf("encrypt faceid verify url: %w", err)
	}
	attempt.DetectAuthRequestID = strings.TrimSpace(providerResult.RequestID)
	attempt.UpdatedAt = now
	if strings.TrimSpace(providerResult.BizToken) != "" {
		attempt.BizTokenCiphertext, err = s.realnameCipher.Encrypt(strings.TrimSpace(providerResult.BizToken))
		if err != nil {
			s.failStartedRealnameFaceIDAttempt(ctx, store, &attempt, now, "start_storage_failed")
			return RealnameFaceIDStartResult{}, fmt.Errorf("encrypt faceid biztoken: %w", err)
		}
		sum := sha256.Sum256([]byte(strings.TrimSpace(providerResult.BizToken)))
		attempt.BizTokenHash = hex.EncodeToString(sum[:])
	}
	applied, err := store.ApplyRealnameFaceIDTransitionWithAudit(ctx, attempt, RealnameFaceIDStateCreated, attempt.LeaseVersion, RealnameFaceIDAuditEvent{
		AttemptID:    attempt.AttemptID,
		UserID:       attempt.UserID,
		EventType:    "start_issued",
		State:        attempt.State,
		RuleID:       attempt.RuleID,
		AccountID:    attempt.AccountID,
		RequestID:    attempt.DetectAuthRequestID,
		IdentityHash: attempt.IdentityHash,
		PhoneHash:    attempt.CurrentPhoneHash,
		BizTokenHash: attempt.BizTokenHash,
		CreatedAt:    now,
	})
	if err != nil {
		return RealnameFaceIDStartResult{}, err
	}
	if !applied {
		return RealnameFaceIDStartResult{}, newError("realname_faceid_state_changed", "本次实名认证状态已变更，请重新开始。", http.StatusConflict)
	}
	return RealnameFaceIDStartResult{AttemptID: attempt.AttemptID, VerifyURL: verifyURL}, nil
}

func (s *Service) failStartedRealnameFaceIDAttempt(ctx context.Context, store faceIDStore, attempt *RealnameFaceIDAttempt, now time.Time, eventType string) {
	if attempt == nil {
		return
	}
	attempt.State = RealnameFaceIDStateFailed
	attempt.UpdatedAt = now
	s.scrubAttempt(attempt, now)
	_, _ = store.ApplyRealnameFaceIDTransitionWithAudit(ctx, *attempt, RealnameFaceIDStateCreated, attempt.LeaseVersion, RealnameFaceIDAuditEvent{
		AttemptID: attempt.AttemptID, UserID: attempt.UserID, EventType: eventType, State: attempt.State,
		RuleID: attempt.RuleID, AccountID: attempt.AccountID, RequestID: attempt.DetectAuthRequestID,
		IdentityHash: attempt.IdentityHash, PhoneHash: attempt.CurrentPhoneHash, BizTokenHash: attempt.BizTokenHash, CreatedAt: now,
	})
}

func (s *Service) SendRealnameFaceIDPhoneCode(ctx context.Context, token string, attemptID string, clientIP string) (time.Duration, error) {
	store, err := s.faceIDStore()
	if err != nil {
		return 0, err
	}
	session, err := s.store.CurrentSession(ctx, strings.TrimSpace(token), s.now())
	if err != nil {
		return 0, err
	}
	attempt, err := store.GetRealnameFaceIDAttempt(ctx, strings.TrimSpace(attemptID))
	if err != nil {
		return 0, err
	}
	if attempt.UserID != session.User.ID {
		return 0, newError("realname_faceid_not_found", "实名认证尝试不存在。", http.StatusNotFound)
	}
	now := s.now()
	if !attempt.BusinessExpiresAt.After(now) {
		return 0, newError("realname_faceid_expired", "本次实名认证已过期，请重新开始。", http.StatusConflict)
	}
	if attempt.FaceVerifiedAt == nil || attempt.State != RealnameFaceIDStateFaceSucceeded {
		return 0, newError("realname_faceid_face_required", "请先完成人脸核身。", http.StatusForbidden)
	}
	if s.hashRealnamePhone(session.User.Phone) != attempt.CurrentPhoneHash {
		return 0, newError("realname_phone_mismatch", "当前手机号已变更，请重新开始实名认证。", http.StatusConflict)
	}
	if s.shadowBinding == nil || !s.shadowBinding.Enabled() {
		return 0, newError("shadow_binding_disabled", "Lightvela 账号同步暂未启用。", http.StatusServiceUnavailable)
	}
	if _, reused, reuseErr := s.reuseActiveShadowPhoneProof(ctx, store, session.User.ID, session.User.Phone, attempt); reuseErr != nil {
		return 0, reuseErr
	} else if reused {
		return 0, nil
	}
	return s.SendShadowBindingCode(ctx, session.User.Phone, clientIP)
}

func (s *Service) VerifyRealnameFaceIDPhone(ctx context.Context, token string, input RealnameFaceIDPhoneProofInput) (RealnameFaceIDAttempt, error) {
	store, err := s.faceIDStore()
	if err != nil {
		return RealnameFaceIDAttempt{}, err
	}
	session, err := s.store.CurrentSession(ctx, strings.TrimSpace(token), s.now())
	if err != nil {
		return RealnameFaceIDAttempt{}, err
	}
	attempt, err := store.GetRealnameFaceIDAttempt(ctx, strings.TrimSpace(input.AttemptID))
	if err != nil {
		return RealnameFaceIDAttempt{}, err
	}
	if attempt.UserID != session.User.ID {
		return RealnameFaceIDAttempt{}, newError("realname_faceid_not_found", "实名认证尝试不存在。", http.StatusNotFound)
	}
	now := s.now()
	if !attempt.BusinessExpiresAt.After(now) {
		return RealnameFaceIDAttempt{}, newError("realname_faceid_expired", "本次实名认证已过期，请重新开始。", http.StatusConflict)
	}
	if attempt.FaceVerifiedAt == nil || attempt.State != RealnameFaceIDStateFaceSucceeded {
		return RealnameFaceIDAttempt{}, newError("realname_faceid_face_required", "请先完成人脸核身。", http.StatusForbidden)
	}
	currentPhoneHash := s.hashRealnamePhone(session.User.Phone)
	if currentPhoneHash != attempt.CurrentPhoneHash {
		return RealnameFaceIDAttempt{}, newError("realname_phone_mismatch", "当前手机号已变更，请重新开始实名认证。", http.StatusConflict)
	}
	if s.shadowBinding == nil || !s.shadowBinding.Enabled() {
		return RealnameFaceIDAttempt{}, newError("shadow_binding_disabled", "Lightvela 账号同步暂未启用。", http.StatusServiceUnavailable)
	}
	if reused, ok, reuseErr := s.reuseActiveShadowPhoneProof(ctx, store, session.User.ID, session.User.Phone, attempt); reuseErr != nil {
		return RealnameFaceIDAttempt{}, reuseErr
	} else if ok {
		return reused, nil
	}
	code := strings.TrimSpace(input.Code)
	if code == "" {
		return RealnameFaceIDAttempt{}, newError("invalid_sms_code", "验证码不能为空。", http.StatusBadRequest)
	}
	binding, err := s.shadowBinding.BindShadowAccount(ctx, shadowbinding.BindInput{
		UserID:     session.User.ID,
		Phone:      session.User.Phone,
		ClientIP:   strings.TrimSpace(input.ClientIP),
		ClientUA:   strings.TrimSpace(input.ClientUA),
		VerifyCode: code,
	})
	if err != nil {
		return RealnameFaceIDAttempt{}, shadowBindingError(ctx, err, session.User.ID)
	}
	if binding.Status != shadowbinding.StatusActive {
		return RealnameFaceIDAttempt{}, newError("shadow_binding_incomplete", "影子账号绑定尚未完成，请稍后重试。", http.StatusBadGateway)
	}
	attempt.PhoneVerifiedHash = currentPhoneHash
	attempt.PhoneVerifiedAt = &now
	attempt.State = RealnameFaceIDStateShadowPending
	attempt.UpdatedAt = now
	applied, err := store.ApplyRealnameFaceIDTransitionWithAudit(ctx, attempt, RealnameFaceIDStateFaceSucceeded, attempt.LeaseVersion, RealnameFaceIDAuditEvent{
		AttemptID:    attempt.AttemptID,
		UserID:       attempt.UserID,
		EventType:    "phone_verified_via_shadow",
		State:        attempt.State,
		RuleID:       attempt.RuleID,
		AccountID:    attempt.AccountID,
		IdentityHash: attempt.IdentityHash,
		PhoneHash:    attempt.PhoneVerifiedHash,
		BizTokenHash: attempt.BizTokenHash,
		CreatedAt:    now,
	})
	if err != nil {
		return RealnameFaceIDAttempt{}, err
	}
	if !applied {
		return RealnameFaceIDAttempt{}, newError("realname_faceid_state_changed", "本次实名认证状态已变更，请重新开始。", http.StatusConflict)
	}
	return attempt, nil
}

func (s *Service) reuseActiveShadowPhoneProof(ctx context.Context, store faceIDStore, userID string, phone string, attempt RealnameFaceIDAttempt) (RealnameFaceIDAttempt, bool, error) {
	now := s.now()
	if attempt.State != RealnameFaceIDStateFaceSucceeded || attempt.FaceVerifiedAt == nil || !attempt.BusinessExpiresAt.After(now) || s.shadowBinding == nil || !s.shadowBinding.Enabled() {
		return attempt, false, nil
	}
	_, active, err := s.shadowBinding.HasActiveBinding(ctx, userID)
	if err != nil {
		return RealnameFaceIDAttempt{}, false, err
	}
	if !active {
		return attempt, false, nil
	}
	phoneHash := s.hashRealnamePhone(phone)
	if phoneHash != attempt.CurrentPhoneHash {
		return RealnameFaceIDAttempt{}, false, newError("realname_phone_mismatch", "当前手机号已变更，请重新开始实名认证。", http.StatusConflict)
	}
	attempt.PhoneVerifiedHash = phoneHash
	attempt.PhoneVerifiedAt = &now
	attempt.State = RealnameFaceIDStateShadowPending
	attempt.UpdatedAt = now
	applied, err := store.ApplyRealnameFaceIDTransitionWithAudit(ctx, attempt, RealnameFaceIDStateFaceSucceeded, attempt.LeaseVersion, RealnameFaceIDAuditEvent{
		AttemptID: attempt.AttemptID, UserID: attempt.UserID, EventType: "phone_proof_reused_from_shadow", State: attempt.State,
		RuleID: attempt.RuleID, AccountID: attempt.AccountID, IdentityHash: attempt.IdentityHash,
		PhoneHash: attempt.PhoneVerifiedHash, BizTokenHash: attempt.BizTokenHash, CreatedAt: now,
	})
	if err != nil {
		return RealnameFaceIDAttempt{}, false, err
	}
	if !applied {
		current, getErr := store.GetRealnameFaceIDAttempt(ctx, attempt.AttemptID)
		return current, current.State == RealnameFaceIDStateShadowPending, getErr
	}
	return attempt, true, nil
}

func (s *Service) FinalizeRealnameFaceIDAttempt(ctx context.Context, token string, input RealnameFaceIDFinalizeInput) (RealnameVerifyResult, error) {
	store, err := s.faceIDStore()
	if err != nil {
		return RealnameVerifyResult{}, err
	}
	session, err := s.store.CurrentSession(ctx, strings.TrimSpace(token), s.now())
	if err != nil {
		return RealnameVerifyResult{}, err
	}
	attempt, err := store.GetRealnameFaceIDAttempt(ctx, strings.TrimSpace(input.AttemptID))
	if err != nil {
		return RealnameVerifyResult{}, err
	}
	if attempt.UserID != session.User.ID {
		return RealnameVerifyResult{}, newError("realname_faceid_not_found", "实名认证尝试不存在。", http.StatusNotFound)
	}
	now := s.now()
	if !attempt.BusinessExpiresAt.After(now) {
		return RealnameVerifyResult{}, newError("realname_faceid_expired", "本次实名认证已过期，请重新开始。", http.StatusConflict)
	}
	if attempt.FaceVerifiedAt == nil || attempt.PhoneVerifiedAt == nil {
		return RealnameVerifyResult{}, newError("realname_faceid_incomplete", "实名认证尚未完成。", http.StatusConflict)
	}
	if s.hashRealnamePhone(session.User.Phone) != attempt.PhoneVerifiedHash {
		return RealnameVerifyResult{}, newError("realname_phone_mismatch", "当前手机号已变更，请重新开始实名认证。", http.StatusConflict)
	}
	if s.shadowBinding == nil || !s.shadowBinding.Enabled() {
		return RealnameVerifyResult{}, newError("shadow_binding_disabled", "Lightvela 账号同步暂未启用。", http.StatusServiceUnavailable)
	}
	if !s.shadowBasicAuthSyncEnabled {
		return RealnameVerifyResult{}, newError("shadow_basic_auth_sync_disabled", "Lightvela 实名信息同步暂未启用。", http.StatusServiceUnavailable)
	}
	binding, err := s.shadowBinding.GetBindingByUserID(ctx, session.User.ID)
	if err != nil {
		return RealnameVerifyResult{}, newError("shadow_binding_incomplete", "影子账号绑定尚未完成，请稍后重试。", http.StatusBadGateway)
	}
	correlated := binding.BasicAuthStatus == shadowbinding.BasicAuthStatusSucceeded &&
		strings.TrimSpace(binding.BasicAuthSourceAttemptID) == attempt.AttemptID &&
		strings.TrimSpace(binding.BasicAuthIdentityHash) == attempt.IdentityHash &&
		strings.TrimSpace(binding.BasicAuthPhoneHash) == attempt.PhoneVerifiedHash
	if !correlated {
		if err := s.syncStoredFaceIDShadowBasicAuth(ctx, session.User.ID, attempt, input.ClientIP, input.ClientUA); err != nil {
			return RealnameVerifyResult{}, newError("shadow_basic_auth_failed", "Lightvela 实名信息同步失败，请稍后重试。", http.StatusBadGateway)
		}
		binding, err = s.shadowBinding.GetBindingByUserID(ctx, session.User.ID)
		if err != nil {
			return RealnameVerifyResult{}, newError("shadow_binding_incomplete", "影子账号绑定尚未完成，请稍后重试。", http.StatusBadGateway)
		}
	}
	if binding.BasicAuthStatus != shadowbinding.BasicAuthStatusSucceeded ||
		strings.TrimSpace(binding.BasicAuthSourceAttemptID) != attempt.AttemptID ||
		strings.TrimSpace(binding.BasicAuthIdentityHash) != attempt.IdentityHash ||
		strings.TrimSpace(binding.BasicAuthPhoneHash) != attempt.PhoneVerifiedHash {
		return RealnameVerifyResult{}, newError("shadow_basic_auth_invariant_failed", "Lightvela 实名信息同步状态不匹配，请稍后重试。", http.StatusConflict)
	}
	user, _, err := store.ActivateRealnameFaceIDAttempt(ctx, session.User.ID, attempt.AttemptID, session.User.Phone, attempt.IdentityHash, attempt.PhoneVerifiedHash, *attempt.FaceVerifiedAt, *attempt.PhoneVerifiedAt, now)
	if err != nil {
		return RealnameVerifyResult{}, err
	}
	return RealnameVerifyResult{
		OK:                  true,
		Verified:            true,
		NameMasked:          user.Name,
		RealnameLevel:       user.RealnameLevel,
		ShadowBindingStatus: shadowbinding.StatusActive,
	}, nil
}

func (s *Service) ReconcilePendingRealnameFaceIDAttempts(ctx context.Context, owner string, limit int) (int, error) {
	store, err := s.faceIDStore()
	if err != nil {
		return 0, err
	}
	now := s.now()
	expired, err := store.ExpireRealnameFaceIDAttempts(ctx, now, limit)
	if err != nil {
		return 0, err
	}
	attempts, err := store.ListReconcileableRealnameFaceIDAttempts(ctx, now, limit)
	if err != nil {
		return 0, err
	}
	count := expired
	for _, attempt := range attempts {
		if _, err := s.ReconcileRealnameFaceIDAttempt(ctx, attempt.AttemptID, "", owner); err == nil {
			count++
		}
	}
	return count, nil
}

func (s *Service) GetOwnedRealnameFaceIDAttempt(ctx context.Context, token string, attemptID string, reconcile bool) (RealnameFaceIDAttempt, error) {
	store, err := s.faceIDStore()
	if err != nil {
		return RealnameFaceIDAttempt{}, err
	}
	session, err := s.store.CurrentSession(ctx, strings.TrimSpace(token), s.now())
	if err != nil {
		return RealnameFaceIDAttempt{}, err
	}
	attempt, err := store.GetRealnameFaceIDAttempt(ctx, strings.TrimSpace(attemptID))
	if err != nil || attempt.UserID != session.User.ID {
		return RealnameFaceIDAttempt{}, newError("realname_faceid_not_found", "实名认证尝试不存在。", http.StatusNotFound)
	}
	if reconcile && (attempt.State == RealnameFaceIDStatePending || attempt.State == RealnameFaceIDStateChecking) {
		attempt, err = s.ReconcileRealnameFaceIDAttempt(ctx, attempt.AttemptID, "", "poll:"+session.User.ID)
		if err != nil {
			return RealnameFaceIDAttempt{}, err
		}
	}
	if attempt.State == RealnameFaceIDStateFaceSucceeded {
		attempt, _, err = s.reuseActiveShadowPhoneProof(ctx, store, session.User.ID, session.User.Phone, attempt)
		if err != nil {
			return RealnameFaceIDAttempt{}, err
		}
	}
	if err := s.hydrateAttemptVerifyURL(&attempt); err != nil {
		return RealnameFaceIDAttempt{}, err
	}
	return attempt, nil
}

func (s *Service) GetCurrentRealnameFaceIDAttempt(ctx context.Context, token string) (RealnameFaceIDAttempt, error) {
	store, err := s.faceIDStore()
	if err != nil {
		return RealnameFaceIDAttempt{}, err
	}
	session, err := s.store.CurrentSession(ctx, strings.TrimSpace(token), s.now())
	if err != nil {
		return RealnameFaceIDAttempt{}, err
	}
	attempt, err := store.FindCurrentRealnameFaceIDAttempt(ctx, session.User.ID, s.now())
	if err != nil {
		return RealnameFaceIDAttempt{}, err
	}
	return s.GetOwnedRealnameFaceIDAttempt(ctx, token, attempt.AttemptID, true)
}

func (s *Service) hydrateAttemptVerifyURL(attempt *RealnameFaceIDAttempt) error {
	if attempt == nil || attempt.VerifyURLCiphertext == "" {
		return nil
	}
	verifyURL, err := s.realnameCipher.Decrypt(attempt.VerifyURLCiphertext)
	if err != nil {
		return fmt.Errorf("decrypt faceid verify url: %w", err)
	}
	attempt.VerifyURL = verifyURL
	return nil
}

func (s *Service) ReconcileRealnameFaceIDAttempt(ctx context.Context, attemptID string, bizToken string, owner string) (RealnameFaceIDAttempt, error) {
	store, err := s.faceIDStore()
	if err != nil {
		return RealnameFaceIDAttempt{}, err
	}
	now := s.now()
	claimed, ok, err := store.ClaimRealnameFaceIDAttempt(ctx, strings.TrimSpace(attemptID), bizTokenHash(strings.TrimSpace(bizToken)), strings.TrimSpace(owner), s.realnameFaceID.LeaseTTL, now)
	if err != nil {
		return RealnameFaceIDAttempt{}, err
	}
	if !ok {
		return claimed, nil
	}
	leaseVersion := claimed.LeaseVersion
	leaseOwner := claimed.LeaseOwner
	if !claimed.BusinessExpiresAt.After(now) {
		return s.expireClaimedRealnameFaceIDAttempt(ctx, store, claimed, leaseVersion, leaseOwner)
	}
	if strings.TrimSpace(claimed.RuleID) != strings.TrimSpace(s.realnameFaceID.RuleID) ||
		strings.TrimSpace(claimed.AccountID) != strings.TrimSpace(s.realnameFaceID.AccountID) {
		return s.rejectRealnameFaceIDProviderIntegrity(ctx, store, claimed, leaseVersion, leaseOwner, "")
	}
	if claimed.BizTokenCiphertext == "" {
		claimed.LeaseOwner = ""
		claimed.LeaseUntil = nil
		claimed.UpdatedAt = now
		_, _ = store.ApplyRealnameFaceIDReconcile(ctx, claimed, leaseVersion, leaseOwner)
		return claimed, newError("realname_faceid_biztoken_missing", "实名认证状态暂不可查询。", http.StatusConflict)
	}
	providerBizToken, err := s.realnameCipher.Decrypt(claimed.BizTokenCiphertext)
	if err != nil {
		return RealnameFaceIDAttempt{}, fmt.Errorf("decrypt realname faceid biztoken: %w", err)
	}
	checkResult, err := s.realnameFaceIDVerifier.GetDetectInfoEnhanced(ctx, RealnameFaceIDGetDetectInfoInput{
		BizToken:     providerBizToken,
		RuleID:       claimed.RuleID,
		AccountID:    claimed.AccountID,
		AttemptID:    claimed.AttemptID,
		IdentityHash: claimed.IdentityHash,
		DigestKey:    s.realnameFaceID.DigestKey,
	})
	if err != nil {
		var integrityErr *RealnameFaceIDProviderIntegrityError
		if errors.As(err, &integrityErr) {
			return s.rejectRealnameFaceIDProviderIntegrity(ctx, store, claimed, leaseVersion, leaseOwner, integrityErr.RequestID)
		}
		var providerErr *RealnameFaceIDProviderRequestError
		if errors.As(err, &providerErr) && providerErr.InvalidBizToken() {
			return s.invalidateRealnameFaceIDBizToken(ctx, store, claimed, leaseVersion, leaseOwner, providerErr.RequestID)
		}
		claimed.LeaseOwner = ""
		claimed.LeaseUntil = nil
		claimed.UpdatedAt = now
		_, _ = store.ApplyRealnameFaceIDReconcile(ctx, claimed, leaseVersion, leaseOwner)
		return claimed, newError("realname_faceid_result_unavailable", "刷脸结果暂不可查询，请稍后重试。", http.StatusBadGateway)
	}
	claimed.LastGetInfoRequestID = strings.TrimSpace(checkResult.RequestID)
	claimed.LeaseOwner = ""
	claimed.LeaseUntil = nil
	claimed.UpdatedAt = now
	switch {
	case !checkResult.Completed:
		claimed.State = RealnameFaceIDStatePending
	case !checkResult.Success:
		claimed.State = RealnameFaceIDStateFailed
		s.scrubAttempt(&claimed, now)
	default:
		if !claimed.BusinessExpiresAt.After(now) {
			claimed.State = RealnameFaceIDStateLateIgnored
			s.scrubAttempt(&claimed, now)
		} else {
			claimed.State = RealnameFaceIDStateFaceSucceeded
			claimed.FaceVerifiedAt = &now
		}
	}
	event := RealnameFaceIDAuditEvent{
		AttemptID: claimed.AttemptID, UserID: claimed.UserID, EventType: "provider_reconciled", State: claimed.State,
		RuleID: claimed.RuleID, AccountID: claimed.AccountID, RequestID: claimed.LastGetInfoRequestID,
		IdentityHash: claimed.IdentityHash, PhoneHash: claimed.CurrentPhoneHash, BizTokenHash: claimed.BizTokenHash, CreatedAt: now,
	}
	applied, err := store.ApplyRealnameFaceIDReconcileWithAudit(ctx, claimed, leaseVersion, leaseOwner, event)
	if err != nil {
		return RealnameFaceIDAttempt{}, err
	}
	if !applied {
		return store.GetRealnameFaceIDAttempt(ctx, claimed.AttemptID)
	}
	return claimed, nil
}

func (s *Service) invalidateRealnameFaceIDBizToken(ctx context.Context, store faceIDStore, claimed RealnameFaceIDAttempt, leaseVersion int64, leaseOwner string, requestID string) (RealnameFaceIDAttempt, error) {
	now := s.now()
	claimed.State = RealnameFaceIDStateFailed
	claimed.LastGetInfoRequestID = strings.TrimSpace(requestID)
	claimed.LeaseOwner = ""
	claimed.LeaseUntil = nil
	claimed.UpdatedAt = now
	s.scrubAttempt(&claimed, now)
	event := RealnameFaceIDAuditEvent{
		AttemptID: claimed.AttemptID, UserID: claimed.UserID, EventType: "provider_biztoken_invalidated", State: claimed.State,
		RuleID: claimed.RuleID, AccountID: claimed.AccountID, RequestID: claimed.LastGetInfoRequestID,
		IdentityHash: claimed.IdentityHash, PhoneHash: claimed.CurrentPhoneHash, BizTokenHash: claimed.BizTokenHash, CreatedAt: now,
	}
	applied, err := store.ApplyRealnameFaceIDReconcileWithAudit(ctx, claimed, leaseVersion, leaseOwner, event)
	if err != nil {
		return RealnameFaceIDAttempt{}, err
	}
	if !applied {
		return store.GetRealnameFaceIDAttempt(ctx, claimed.AttemptID)
	}
	return claimed, nil
}

func (s *Service) expireClaimedRealnameFaceIDAttempt(ctx context.Context, store faceIDStore, claimed RealnameFaceIDAttempt, leaseVersion int64, leaseOwner string) (RealnameFaceIDAttempt, error) {
	now := s.now()
	claimed.State = RealnameFaceIDStateExpired
	claimed.LeaseOwner = ""
	claimed.LeaseUntil = nil
	claimed.UpdatedAt = now
	s.scrubAttempt(&claimed, now)
	event := RealnameFaceIDAuditEvent{
		AttemptID: claimed.AttemptID, UserID: claimed.UserID, EventType: "attempt_expired", State: claimed.State,
		RuleID: claimed.RuleID, AccountID: claimed.AccountID, RequestID: claimed.LastGetInfoRequestID,
		IdentityHash: claimed.IdentityHash, PhoneHash: claimed.CurrentPhoneHash, BizTokenHash: claimed.BizTokenHash, CreatedAt: now,
	}
	applied, err := store.ApplyRealnameFaceIDReconcileWithAudit(ctx, claimed, leaseVersion, leaseOwner, event)
	if err != nil {
		return RealnameFaceIDAttempt{}, err
	}
	if !applied {
		return store.GetRealnameFaceIDAttempt(ctx, claimed.AttemptID)
	}
	return claimed, nil
}

func (s *Service) rejectRealnameFaceIDProviderIntegrity(ctx context.Context, store faceIDStore, claimed RealnameFaceIDAttempt, leaseVersion int64, leaseOwner string, requestID string) (RealnameFaceIDAttempt, error) {
	now := s.now()
	claimed.State = RealnameFaceIDStateFailed
	claimed.LastGetInfoRequestID = strings.TrimSpace(requestID)
	claimed.LeaseOwner = ""
	claimed.LeaseUntil = nil
	claimed.UpdatedAt = now
	s.scrubAttempt(&claimed, now)
	event := RealnameFaceIDAuditEvent{
		AttemptID: claimed.AttemptID, UserID: claimed.UserID, EventType: "provider_integrity_rejected", State: claimed.State,
		RuleID: claimed.RuleID, AccountID: claimed.AccountID, RequestID: claimed.LastGetInfoRequestID,
		IdentityHash: claimed.IdentityHash, PhoneHash: claimed.CurrentPhoneHash, BizTokenHash: claimed.BizTokenHash, CreatedAt: now,
	}
	applied, err := store.ApplyRealnameFaceIDReconcileWithAudit(ctx, claimed, leaseVersion, leaseOwner, event)
	if err != nil {
		return RealnameFaceIDAttempt{}, err
	}
	if !applied {
		current, getErr := store.GetRealnameFaceIDAttempt(ctx, claimed.AttemptID)
		if getErr != nil {
			return RealnameFaceIDAttempt{}, getErr
		}
		return current, newError("realname_faceid_provider_integrity_failed", "刷脸结果校验失败，请重新认证。", http.StatusConflict)
	}
	return claimed, newError("realname_faceid_provider_integrity_failed", "刷脸结果校验失败，请重新认证。", http.StatusConflict)
}

func (s *Service) syncStoredFaceIDShadowBasicAuth(ctx context.Context, userID string, attempt RealnameFaceIDAttempt, clientIP string, clientUA string) error {
	if !s.shadowBasicAuthSyncEnabled {
		return errors.New("shadow basic auth sync is disabled")
	}
	if s.realnameCipher == nil {
		return errors.New("realname cipher is not configured")
	}
	name, err := s.realnameCipher.Decrypt(attempt.NameCiphertext)
	if err != nil {
		return fmt.Errorf("decrypt faceid attempt name: %w", err)
	}
	idCard, err := s.realnameCipher.Decrypt(attempt.IDCardCiphertext)
	if err != nil {
		return fmt.Errorf("decrypt faceid attempt id card: %w", err)
	}
	return s.shadowBinding.SaveBasicAuth(ctx, shadowbinding.BasicAuthInput{
		UserID:          userID,
		AccountType:     0,
		Name:            name,
		IDCard:          idCard,
		ClientIP:        strings.TrimSpace(clientIP),
		ClientUA:        strings.TrimSpace(clientUA),
		SourceAttemptID: attempt.AttemptID,
		IdentityHash:    attempt.IdentityHash,
		PhoneHash:       attempt.PhoneVerifiedHash,
	})
}

func (s *Service) projectUserForAssuranceMode(ctx context.Context, user User) User {
	user.RealnameAssuranceMode = string(s.realnameFaceID.Mode)
	if s.realnameFaceID.Mode != RealnameAssuranceModeFaceRequired {
		return user
	}
	projected := user
	projected.RealnameVerified = false
	projected.RealnameLevel = RealnameLevelNone
	if projected.realnameFinalAttemptID == "" || projected.realnameVerifiedAt == nil || projected.realnameFaceVerifiedAt == nil || projected.realnamePhoneVerifiedAt == nil {
		return projected
	}
	currentPhoneHash := s.hashRealnamePhone(projected.Phone)
	if currentPhoneHash == "" || currentPhoneHash != projected.realnamePhoneHash {
		return projected
	}
	if s.shadowBinding == nil {
		return projected
	}
	binding, err := s.shadowBinding.GetBindingByUserID(ctx, projected.ID)
	if err != nil {
		return projected
	}
	if binding.BasicAuthStatus != shadowbinding.BasicAuthStatusSucceeded ||
		binding.BasicAuthSourceAttemptID != projected.realnameFinalAttemptID ||
		binding.BasicAuthIdentityHash != projected.realnameIdentityHash ||
		binding.BasicAuthPhoneHash != projected.realnamePhoneHash {
		return projected
	}
	projected.RealnameVerified = true
	projected.RealnameLevel = RealnameLevelPhone3FA
	projected.RealnameSyncStatus = RealnameSyncStatusSucceeded
	return projected
}

func (s *Service) scrubAttempt(attempt *RealnameFaceIDAttempt, now time.Time) {
	attempt.BizTokenCiphertext = ""
	attempt.VerifyURLCiphertext = ""
	attempt.VerifyURL = ""
	attempt.NameCiphertext = ""
	attempt.IDCardCiphertext = ""
	attempt.ClientIPCiphertext = ""
	attempt.ClientUACiphertext = ""
	attempt.ScrubbedAt = &now
	attempt.UpdatedAt = now
}

func bizTokenHash(token string) string {
	trimmed := strings.TrimSpace(token)
	if trimmed == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(trimmed))
	return hex.EncodeToString(sum[:])
}
