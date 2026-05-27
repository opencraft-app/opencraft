package service

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/bcrypt"
)

type MemoryStore struct {
	mu              sync.Mutex
	now             func() time.Time
	nextID          int
	usersByID       map[string]User
	usersByEmail    map[string]string
	usersByPhone    map[string]string
	oauthUsers      map[string]string
	subscriptions   map[string]PlanSelection
	passwordHashes  map[string][]byte
	smsChallenges   map[string]smsChallenge
	sessions        map[string]sessionRecord
	invites         map[string]memoryInviteRecord
	realnames       map[string]UpdateRealnameInput
	realnameHistory map[string][]UpdateRealnameInput
}

type memoryInviteRecord struct {
	Code         string
	State        string
	Message      string
	UsedByUserID string
	UsedVia      string
	UsedAt       *time.Time
	CreatedAt    time.Time
	UpdatedAt    time.Time
}

func NewMemoryStore(opts StoreOptions) *MemoryStore {
	now := opts.Now
	if now == nil {
		now = time.Now
	}

	store := &MemoryStore{
		now:             now,
		usersByID:       make(map[string]User),
		usersByEmail:    make(map[string]string),
		usersByPhone:    make(map[string]string),
		oauthUsers:      make(map[string]string),
		subscriptions:   make(map[string]PlanSelection),
		passwordHashes:  make(map[string][]byte),
		smsChallenges:   make(map[string]smsChallenge),
		sessions:        make(map[string]sessionRecord),
		invites:         make(map[string]memoryInviteRecord),
		realnames:       make(map[string]UpdateRealnameInput),
		realnameHistory: make(map[string][]UpdateRealnameInput),
	}
	if opts.SeedDefaultInvites {
		store.seedDefaultInvites()
	}
	if opts.SeedDemoUser {
		store.seedDemoUser()
	}
	return store
}

func (s *MemoryStore) ValidateInvite(_ context.Context, code string) (InviteValidation, error) {
	return InviteValidation{Code: strings.TrimSpace(code), State: "valid", Message: "邀请码校验已关闭。"}, nil
}

func (s *MemoryStore) SendVerificationCode(_ context.Context, phone string, code string, now time.Time, ttl time.Duration, cooldown time.Duration) (time.Duration, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	challenge, exists := s.smsChallenges[phone]
	if exists && challenge.CooldownUntil.After(now) {
		return 0, &Error{
			Code:       "sms_cooldown",
			Message:    "验证码发送过于频繁，请稍后再试。",
			Status:     429,
			RetryAfter: challenge.CooldownUntil.Sub(now),
		}
	}

	s.smsChallenges[phone] = smsChallenge{
		Code:             code,
		ExpiresAt:        now.Add(ttl),
		CooldownUntil:    now.Add(cooldown),
		RemainingRetries: 5,
	}
	return cooldown, nil
}

func (s *MemoryStore) CompleteSMSVerification(_ context.Context, input VerifySMSInput, now time.Time, sessionTTL time.Duration) (*AuthSession, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	user, created := s.findOrCreatePhoneUserLocked(input.Phone, strings.TrimSpace(input.Name), now)
	if created {
		s.usersByID[user.ID] = user
	}
	return s.createSessionLocked(user, now, sessionTTL)
}

func (s *MemoryStore) CreatePasswordSession(_ context.Context, input PasswordSignUpInput, passwordHash []byte, now time.Time, sessionTTL time.Duration) (*AuthSession, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.usersByEmail[input.Email]; exists {
		return nil, newError("email_in_use", "该邮箱已注册，请直接登录。", 409)
	}

	user := s.newUserLocked(strings.TrimSpace(input.Name), input.Email, "", now)
	s.usersByID[user.ID] = user
	s.passwordHashes[user.ID] = append([]byte(nil), passwordHash...)
	return s.createSessionLocked(user, now, sessionTTL)
}

func (s *MemoryStore) GetPasswordUser(_ context.Context, email string) (User, []byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	userID, exists := s.usersByEmail[email]
	if !exists {
		return User{}, nil, newError("invalid_credentials", "账号或密码不正确。", 401)
	}
	user := s.usersByID[userID]
	return user, append([]byte(nil), s.passwordHashes[userID]...), nil
}

func (s *MemoryStore) CreateOAuthSession(_ context.Context, input OAuthSignInInput, now time.Time, sessionTTL time.Duration) (*AuthSession, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	key := oauthIdentityKey(input.Provider, input.ProviderSubject)
	if userID, exists := s.oauthUsers[key]; exists {
		user, ok := s.usersByID[userID]
		if !ok {
			delete(s.oauthUsers, key)
		} else {
			return s.createSessionLocked(user, now, sessionTTL)
		}
	}

	if strings.TrimSpace(input.Email) != "" {
		if userID, exists := s.usersByEmail[input.Email]; exists {
			user, ok := s.usersByID[userID]
			if !ok {
				delete(s.usersByEmail, input.Email)
			} else if input.EmailVerified {
				s.oauthUsers[key] = user.ID
				return s.createSessionLocked(user, now, sessionTTL)
			} else {
				return nil, newError("oauth_email_conflict", "第三方账号邮箱已被使用，请先使用已有方式登录后再绑定。", 409)
			}
		}
	}

	user := s.newUserWithInviteRequirementLocked(input.Name, input.Email, "", false, now)
	s.oauthUsers[key] = user.ID
	return s.createSessionLocked(user, now, sessionTTL)
}

func (s *MemoryStore) ActivateInviteForCurrentUser(_ context.Context, token string, code string, now time.Time) (User, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	record, err := s.getSessionRecordLocked(token, now)
	if err != nil {
		return User{}, err
	}

	user, exists := s.usersByID[record.UserID]
	if !exists {
		return User{}, newError("unauthorized", "未登录或登录已失效。", 401)
	}
	if user.InviteRequired {
		user.InviteRequired = false
		s.usersByID[user.ID] = user
	}
	return user, nil
}

func (s *MemoryStore) BindOAuthSession(_ context.Context, token string, input OAuthSignInInput, now time.Time, sessionTTL time.Duration) (*AuthSession, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	record, err := s.getSessionRecordLocked(token, now)
	if err != nil {
		return nil, err
	}

	user, exists := s.usersByID[record.UserID]
	if !exists {
		return nil, newError("unauthorized", "未登录或登录已失效。", 401)
	}

	key := oauthIdentityKey(input.Provider, input.ProviderSubject)
	if existingUserID, ok := s.oauthUsers[key]; ok && existingUserID != user.ID {
		return nil, newError("oauth_identity_conflict", "第三方账号绑定冲突，请稍后重试。", 409)
	}
	s.oauthUsers[key] = user.ID
	return s.createSessionLocked(user, now, sessionTTL)
}

func (s *MemoryStore) CreateSession(_ context.Context, user User, now time.Time, sessionTTL time.Duration) (*AuthSession, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	return s.createSessionLocked(user, now, sessionTTL)
}

func (s *MemoryStore) CreateImpersonationSession(_ context.Context, user User, reason string, now time.Time, sessionTTL time.Duration) (*AuthSession, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	return s.createSessionWithMetadataLocked(user, now, sessionTTL, true, strings.TrimSpace(reason))
}

func (s *MemoryStore) CurrentSession(_ context.Context, token string, now time.Time) (*AuthSession, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	return s.getSessionLocked(token, now)
}

func (s *MemoryStore) CurrentProfile(_ context.Context, token string, now time.Time) (User, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	record, err := s.getSessionRecordLocked(token, now)
	if err != nil {
		return User{}, err
	}
	user, exists := s.usersByID[record.UserID]
	if !exists {
		return User{}, newError("unauthorized", "未登录或登录已失效。", 401)
	}
	return user, nil
}

func (s *MemoryStore) FindUserByID(_ context.Context, userID string) (User, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	user, exists := s.usersByID[strings.TrimSpace(userID)]
	if !exists {
		return User{}, newError("user_not_found", "用户不存在。", 404)
	}
	return user, nil
}

func (s *MemoryStore) UpdateRealname(_ context.Context, token string, input UpdateRealnameInput) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	record, err := s.getSessionRecordLocked(token, s.now())
	if err != nil {
		return err
	}
	user, exists := s.usersByID[record.UserID]
	if !exists {
		return newError("unauthorized", "未登录或登录已失效。", 401)
	}
	user.RealnameVerified = true
	s.usersByID[user.ID] = user
	s.realnames[user.ID] = input
	s.realnameHistory[user.ID] = append(s.realnameHistory[user.ID], input)
	return nil
}

func (s *MemoryStore) UpdateProfile(_ context.Context, token string, name string, now time.Time) (User, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	record, err := s.getSessionRecordLocked(token, now)
	if err != nil {
		return User{}, err
	}
	user, exists := s.usersByID[record.UserID]
	if !exists {
		return User{}, newError("unauthorized", "未登录或登录已失效。", 401)
	}
	user.Name = strings.TrimSpace(name)
	s.usersByID[user.ID] = user
	return user, nil
}

func (s *MemoryStore) SetUserAvatar(_ context.Context, userID string, objectKey string, source string, _ time.Time) (User, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	user, exists := s.usersByID[userID]
	if !exists {
		return User{}, newError("user_not_found", "用户不存在。", 404)
	}
	user.AvatarObjectKey = strings.TrimSpace(objectKey)
	user.AvatarSource = strings.TrimSpace(source)
	s.usersByID[userID] = user
	return user, nil
}

func (s *MemoryStore) CurrentSubscription(_ context.Context, token string, now time.Time) (*PlanSelection, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	record, err := s.getSessionRecordLocked(token, now)
	if err != nil {
		return nil, err
	}

	return s.currentPlanSelectionLocked(record.UserID), nil
}

func (s *MemoryStore) UpdateSubscription(_ context.Context, token string, tier string, now time.Time) (*PlanSelection, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	record, err := s.getSessionRecordLocked(token, now)
	if err != nil {
		return nil, err
	}

	plan := &PlanSelection{
		Tier:        tier,
		ConfirmedAt: now,
	}
	s.subscriptions[record.UserID] = *plan
	return plan, nil
}

func (s *MemoryStore) ConfirmFreePlan(_ context.Context, token string, now time.Time) (*PlanSelection, error) {
	return s.UpdateSubscription(context.Background(), token, "free", now)
}

func (s *MemoryStore) DeleteSession(_ context.Context, token string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	delete(s.sessions, strings.TrimSpace(token))
	return nil
}

func (s *MemoryStore) DeleteCurrentUser(_ context.Context, token string, now time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	record, err := s.getSessionRecordLocked(token, now)
	if err != nil {
		return err
	}

	user, exists := s.usersByID[record.UserID]
	if !exists {
		return newError("unauthorized", "未登录或登录已失效。", 401)
	}

	delete(s.usersByID, user.ID)
	if user.Email != "" {
		delete(s.usersByEmail, user.Email)
	}
	if user.Phone != "" {
		delete(s.usersByPhone, user.Phone)
	}
	delete(s.passwordHashes, user.ID)
	delete(s.subscriptions, user.ID)
	delete(s.realnames, user.ID)
	delete(s.realnameHistory, user.ID)

	for key, mappedUserID := range s.oauthUsers {
		if mappedUserID == user.ID {
			delete(s.oauthUsers, key)
		}
	}
	for sessionToken, sessionRecord := range s.sessions {
		if sessionRecord.UserID == user.ID {
			delete(s.sessions, sessionToken)
		}
	}

	return nil
}

func (s *MemoryStore) DeleteAdminUser(_ context.Context, userID string, _ time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	user, exists := s.usersByID[strings.TrimSpace(userID)]
	if !exists {
		return newError("user_not_found", "用户不存在。", 404)
	}

	delete(s.usersByID, user.ID)
	if user.Email != "" {
		delete(s.usersByEmail, user.Email)
	}
	if user.Phone != "" {
		delete(s.usersByPhone, user.Phone)
	}
	delete(s.passwordHashes, user.ID)
	delete(s.subscriptions, user.ID)
	delete(s.realnames, user.ID)
	delete(s.realnameHistory, user.ID)

	for key, mappedUserID := range s.oauthUsers {
		if mappedUserID == user.ID {
			delete(s.oauthUsers, key)
		}
	}
	for sessionToken, sessionRecord := range s.sessions {
		if sessionRecord.UserID == user.ID {
			delete(s.sessions, sessionToken)
		}
	}

	return nil
}

func (s *MemoryStore) ListAdminUsers(_ context.Context, search string, limit int) ([]AdminUser, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	search = strings.ToLower(strings.TrimSpace(search))
	items := make([]AdminUser, 0, len(s.usersByID))
	for _, user := range s.usersByID {
		if search != "" {
			haystack := strings.ToLower(strings.Join([]string{user.ID, user.Name, user.Email, user.Phone}, " "))
			if !strings.Contains(haystack, search) {
				continue
			}
		}
		items = append(items, AdminUser{
			ID:             user.ID,
			Name:           user.Name,
			Email:          user.Email,
			Phone:          user.Phone,
			AuthMethods:    adminUserAuthMethods(user.Email, user.Phone, s.findOAuthSubjectLocked(user.ID, "qq"), s.findOAuthSubjectLocked(user.ID, "wechat")),
			QQOpenID:       s.findOAuthSubjectLocked(user.ID, "qq"),
			WeChatSubject:  s.findOAuthSubjectLocked(user.ID, "wechat"),
			InviteRequired: user.InviteRequired,
			CreatedAt:      user.CreatedAt,
			UpdatedAt:      user.CreatedAt,
		})
	}
	sort.Slice(items, func(i, j int) bool {
		return items[i].CreatedAt.After(items[j].CreatedAt)
	})
	if len(items) > limit {
		items = items[:limit]
	}
	return items, nil
}

func (s *MemoryStore) ListAdminSMSChallenges(_ context.Context, search string, limit int) ([]AdminSMSChallenge, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	search = strings.TrimSpace(search)
	items := make([]AdminSMSChallenge, 0, len(s.smsChallenges))
	for phone, challenge := range s.smsChallenges {
		if search != "" && !strings.Contains(phone, search) {
			continue
		}
		items = append(items, AdminSMSChallenge{
			Phone:            phone,
			Code:             challenge.Code,
			ExpiresAt:        challenge.ExpiresAt,
			CooldownUntil:    challenge.CooldownUntil,
			RemainingRetries: challenge.RemainingRetries,
			CreatedAt:        challenge.CooldownUntil.Add(-time.Minute),
			UpdatedAt:        challenge.CooldownUntil.Add(-time.Minute),
		})
	}
	sort.Slice(items, func(i, j int) bool {
		return items[i].Phone < items[j].Phone
	})
	if len(items) > limit {
		items = items[:limit]
	}
	return items, nil
}

func (s *MemoryStore) DeleteAdminSMSChallenge(_ context.Context, phone string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	delete(s.smsChallenges, phone)
	return nil
}

func (s *MemoryStore) ListAdminInvites(_ context.Context, search string, state string, limit int) ([]AdminInvite, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	search = strings.ToLower(strings.TrimSpace(search))
	state = strings.ToLower(strings.TrimSpace(state))
	items := make([]AdminInvite, 0, len(s.invites))
	for _, invite := range s.invites {
		if state != "" && strings.ToLower(invite.State) != state {
			continue
		}
		if search != "" {
			haystack := strings.ToLower(strings.Join([]string{invite.Code, invite.State, invite.Message}, " "))
			if !strings.Contains(haystack, search) {
				continue
			}
		}
		items = append(items, AdminInvite{
			Code:         invite.Code,
			State:        invite.State,
			Message:      invite.Message,
			UsedByUserID: invite.UsedByUserID,
			UsedVia:      invite.UsedVia,
			UsedAt:       invite.UsedAt,
			CreatedAt:    invite.CreatedAt,
			UpdatedAt:    invite.UpdatedAt,
		})
	}
	sort.Slice(items, func(i, j int) bool {
		return items[i].Code < items[j].Code
	})
	if len(items) > limit {
		items = items[:limit]
	}
	return items, nil
}

func (s *MemoryStore) CreateAdminInvite(_ context.Context, code string, message string, _ time.Time) (*AdminInvite, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	normalizedCode := normalizeInvite(code)
	if _, exists := s.invites[normalizedCode]; exists {
		return nil, newError("invite_exists", "邀请码已存在。", 409)
	}
	now := s.now()
	invite := memoryInviteRecord{
		Code:      normalizedCode,
		State:     "valid",
		Message:   message,
		CreatedAt: now,
		UpdatedAt: now,
	}
	s.invites[normalizedCode] = invite
	return &AdminInvite{
		Code:      invite.Code,
		State:     invite.State,
		Message:   invite.Message,
		CreatedAt: invite.CreatedAt,
		UpdatedAt: invite.UpdatedAt,
	}, nil
}

func (s *MemoryStore) DisableAdminInvite(_ context.Context, code string, _ time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	invite, exists := s.invites[code]
	if !exists {
		return newError("invite_not_found", "邀请码不存在。", 404)
	}
	invite.State = "disabled"
	invite.Message = "邀请码已禁用。"
	invite.UpdatedAt = s.now()
	s.invites[code] = invite
	return nil
}

func (s *MemoryStore) getSessionRecordLocked(token string, now time.Time) (sessionRecord, error) {
	normalized := strings.TrimSpace(token)
	if normalized == "" {
		return sessionRecord{}, newError("unauthorized", "未登录或登录已失效。", 401)
	}

	record, exists := s.sessions[normalized]
	if !exists {
		return sessionRecord{}, newError("unauthorized", "未登录或登录已失效。", 401)
	}
	if record.ExpiresAt.Before(now) {
		delete(s.sessions, normalized)
		return sessionRecord{}, newError("session_expired", "登录已过期，请重新登录。", 401)
	}
	return record, nil
}

func (s *MemoryStore) getSessionLocked(token string, now time.Time) (*AuthSession, error) {
	record, err := s.getSessionRecordLocked(token, now)
	if err != nil {
		return nil, err
	}

	user, exists := s.usersByID[record.UserID]
	if !exists {
		delete(s.sessions, record.Token)
		return nil, newError("unauthorized", "未登录或登录已失效。", 401)
	}

	return &AuthSession{
		Token:               record.Token,
		User:                user,
		AuthenticatedAt:     record.AuthenticatedAt,
		ExpiresAt:           record.ExpiresAt,
		Impersonated:        record.Impersonated,
		ImpersonationReason: record.ImpersonationReason,
	}, nil
}

func (s *MemoryStore) createSessionLocked(user User, now time.Time, sessionTTL time.Duration) (*AuthSession, error) {
	return s.createSessionWithMetadataLocked(user, now, sessionTTL, false, "")
}

func (s *MemoryStore) createSessionWithMetadataLocked(user User, now time.Time, sessionTTL time.Duration, impersonated bool, reason string) (*AuthSession, error) {
	token, err := newOpaqueToken()
	if err != nil {
		return nil, fmt.Errorf("create session token: %w", err)
	}

	record := sessionRecord{
		Token:               token,
		UserID:              user.ID,
		AuthenticatedAt:     now,
		ExpiresAt:           now.Add(sessionTTL),
		Impersonated:        impersonated,
		ImpersonationReason: strings.TrimSpace(reason),
	}
	s.sessions[token] = record

	return &AuthSession{
		Token:               token,
		User:                user,
		AuthenticatedAt:     now,
		ExpiresAt:           record.ExpiresAt,
		Impersonated:        impersonated,
		ImpersonationReason: record.ImpersonationReason,
	}, nil
}

func (s *MemoryStore) currentPlanSelectionLocked(userID string) *PlanSelection {
	plan, exists := s.subscriptions[userID]
	if !exists {
		return nil
	}
	return clonePlan(&plan)
}

func (s *MemoryStore) findOrCreatePhoneUserLocked(phone string, name string, now time.Time) (User, bool) {
	if userID, exists := s.usersByPhone[phone]; exists {
		user := s.usersByID[userID]
		if name != "" && user.Name != name {
			user.Name = name
			s.usersByID[userID] = user
		}
		return user, false
	}

	fallbackName := name
	if fallbackName == "" {
		fallbackName = "用户" + phone[len(phone)-4:]
	}
	return s.newUserLocked(fallbackName, "", phone, now), true
}

func (s *MemoryStore) newUserLocked(name string, email string, phone string, now time.Time) User {
	return s.newUserWithInviteRequirementLocked(name, email, phone, false, now)
}

func (s *MemoryStore) newUserWithInviteRequirementLocked(name string, email string, phone string, inviteRequired bool, now time.Time) User {
	s.nextID++
	user := User{
		ID:             fmt.Sprintf("usr_%06d", s.nextID),
		Name:           name,
		Email:          email,
		Phone:          phone,
		InviteRequired: inviteRequired,
		CreatedAt:      now,
	}
	s.usersByID[user.ID] = user
	if email != "" {
		s.usersByEmail[email] = user.ID
	}
	if phone != "" {
		s.usersByPhone[phone] = user.ID
	}
	return user
}

func (s *MemoryStore) ensureInviteValidLocked(code string) error {
	normalized := normalizeInvite(code)
	if normalized == "" {
		return newError("invite_required", "请先输入邀请码。", 400)
	}
	validation, ok := s.invites[normalized]
	if !ok {
		return newError("invite_invalid", "邀请码不存在，请检查输入。", 400)
	}
	if validation.State != "valid" {
		return newError("invite_"+validation.State, validation.Message, 400)
	}
	return nil
}

func (s *MemoryStore) consumeInviteLocked(code string, userID string, via string, now time.Time) error {
	if err := s.ensureInviteValidLocked(code); err != nil {
		return err
	}
	return s.markInviteUsedLocked(code, userID, via, now)
}

func (s *MemoryStore) markInviteUsedLocked(code string, userID string, via string, now time.Time) error {
	normalized := normalizeInvite(code)
	validation, ok := s.invites[normalized]
	if !ok {
		return newError("invite_invalid", "邀请码不存在，请检查输入。", 400)
	}
	validation.State = "used"
	validation.Message = "邀请码已被使用。"
	validation.UsedByUserID = strings.TrimSpace(userID)
	validation.UsedVia = strings.TrimSpace(via)
	usedAt := now
	validation.UsedAt = &usedAt
	validation.UpdatedAt = now
	s.invites[normalized] = validation
	return nil
}

func (s *MemoryStore) seedDefaultInvites() {
	now := s.now()
	s.invites["VALID2026"] = memoryInviteRecord{
		Code:      "VALID2026",
		State:     "valid",
		Message:   "邀请码有效，可加入 Lightclaw 内测。",
		CreatedAt: now,
		UpdatedAt: now,
	}
	s.invites["EXPIRED2026"] = memoryInviteRecord{
		Code:      "EXPIRED2026",
		State:     "expired",
		Message:   "邀请码已过期，请申请新的邀请码。",
		CreatedAt: now,
		UpdatedAt: now,
	}
	s.invites["USED2026"] = memoryInviteRecord{
		Code:      "USED2026",
		State:     "used",
		Message:   "邀请码已被使用。",
		CreatedAt: now,
		UpdatedAt: now,
	}
}

func (s *MemoryStore) seedDemoUser() {
	hash, err := bcrypt.GenerateFromPassword([]byte("demo2026!"), bcrypt.DefaultCost)
	if err != nil {
		panic(err)
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	user := s.newUserLocked("Demo", "demo@lightclaw.ai", "", s.now())
	s.passwordHashes[user.ID] = hash
}

func oauthIdentityKey(provider string, subject string) string {
	return strings.ToLower(strings.TrimSpace(provider)) + "\x00" + strings.TrimSpace(subject)
}

func (s *MemoryStore) findOAuthSubjectLocked(userID string, provider string) string {
	providerPrefix := strings.ToLower(strings.TrimSpace(provider)) + "\x00"
	for key, mappedUserID := range s.oauthUsers {
		if mappedUserID != userID || !strings.HasPrefix(key, providerPrefix) {
			continue
		}
		return strings.TrimPrefix(key, providerPrefix)
	}
	return ""
}
