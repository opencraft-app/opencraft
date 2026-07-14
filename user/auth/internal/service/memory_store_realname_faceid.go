package service

import (
	"context"
	"net/http"
	"sort"
	"strings"
	"time"
)

func (s *MemoryStore) FindReusableRealnameFaceIDAttempt(_ context.Context, userID string, identityHash string, phoneHash string, now time.Time) (RealnameFaceIDAttempt, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	var attempts []RealnameFaceIDAttempt
	for _, attempt := range s.realnameFaceIDAttempts {
		if attempt.UserID != userID || attempt.IdentityHash != identityHash || attempt.CurrentPhoneHash != phoneHash {
			continue
		}
		if attempt.ScrubbedAt != nil || !attempt.BusinessExpiresAt.After(now) {
			continue
		}
		switch attempt.State {
		case RealnameFaceIDStatePending, RealnameFaceIDStateChecking, RealnameFaceIDStateFaceSucceeded, RealnameFaceIDStatePhonePending, RealnameFaceIDStateShadowPending:
			attempts = append(attempts, attempt)
		}
	}
	if len(attempts) == 0 {
		return RealnameFaceIDAttempt{}, newError("realname_faceid_not_found", "实名认证尝试不存在。", http.StatusNotFound)
	}
	sort.Slice(attempts, func(i, j int) bool { return attempts[i].CreatedAt.After(attempts[j].CreatedAt) })
	return attempts[0], nil
}

func (s *MemoryStore) FindCurrentRealnameFaceIDAttempt(_ context.Context, userID string, now time.Time) (RealnameFaceIDAttempt, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var latest RealnameFaceIDAttempt
	found := false
	for _, attempt := range s.realnameFaceIDAttempts {
		if attempt.UserID != userID || attempt.ScrubbedAt != nil || !attempt.BusinessExpiresAt.After(now) {
			continue
		}
		switch attempt.State {
		case RealnameFaceIDStatePending, RealnameFaceIDStateChecking, RealnameFaceIDStateFaceSucceeded, RealnameFaceIDStatePhonePending, RealnameFaceIDStateShadowPending:
		default:
			continue
		}
		if !found || attempt.CreatedAt.After(latest.CreatedAt) {
			latest = attempt
			found = true
		}
	}
	if !found {
		return RealnameFaceIDAttempt{}, newError("realname_faceid_not_found", "实名认证尝试不存在。", http.StatusNotFound)
	}
	return latest, nil
}

func (s *MemoryStore) CountNewRealnameFaceIDAttempts(_ context.Context, userID string, windowStart time.Time, windowEnd time.Time) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	count := 0
	for _, attempt := range s.realnameFaceIDAttempts {
		if attempt.UserID != userID {
			continue
		}
		if !attempt.CreatedAt.Before(windowStart) && attempt.CreatedAt.Before(windowEnd) {
			count++
		}
	}
	return count, nil
}

func (s *MemoryStore) CreateRealnameFaceIDAttempt(_ context.Context, attempt RealnameFaceIDAttempt) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.realnameFaceIDAttempts[attempt.AttemptID] = attempt
	return nil
}

func (s *MemoryStore) ApplyRealnameFaceIDTransitionWithAudit(_ context.Context, attempt RealnameFaceIDAttempt, expectedState string, expectedLeaseVersion int64, event RealnameFaceIDAuditEvent) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	current, ok := s.realnameFaceIDAttempts[attempt.AttemptID]
	if !ok || current.State != expectedState || current.LeaseVersion != expectedLeaseVersion || current.ScrubbedAt != nil {
		return false, nil
	}
	s.realnameFaceIDAttempts[attempt.AttemptID] = attempt
	s.realnameFaceIDAuditEvents = append(s.realnameFaceIDAuditEvents, event)
	return true, nil
}

func (s *MemoryStore) ApplyRealnameFaceIDReconcile(_ context.Context, attempt RealnameFaceIDAttempt, expectedLeaseVersion int64, expectedLeaseOwner string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	current, ok := s.realnameFaceIDAttempts[attempt.AttemptID]
	if !ok {
		return false, newError("realname_faceid_not_found", "实名认证尝试不存在。", http.StatusNotFound)
	}
	if current.LeaseVersion != expectedLeaseVersion || current.LeaseOwner != strings.TrimSpace(expectedLeaseOwner) {
		return false, nil
	}
	s.realnameFaceIDAttempts[attempt.AttemptID] = attempt
	return true, nil
}

func (s *MemoryStore) GetRealnameFaceIDAttempt(_ context.Context, attemptID string) (RealnameFaceIDAttempt, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	attempt, ok := s.realnameFaceIDAttempts[strings.TrimSpace(attemptID)]
	if !ok {
		return RealnameFaceIDAttempt{}, newError("realname_faceid_not_found", "实名认证尝试不存在。", http.StatusNotFound)
	}
	return attempt, nil
}

func (s *MemoryStore) ClaimRealnameFaceIDAttempt(_ context.Context, attemptID string, hashedBizToken string, owner string, leaseTTL time.Duration, now time.Time) (RealnameFaceIDAttempt, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	var attempt RealnameFaceIDAttempt
	var ok bool
	if strings.TrimSpace(attemptID) != "" {
		attempt, ok = s.realnameFaceIDAttempts[strings.TrimSpace(attemptID)]
	} else {
		for _, item := range s.realnameFaceIDAttempts {
			if item.BizTokenHash == hashedBizToken {
				attempt = item
				ok = true
				break
			}
		}
	}
	if !ok {
		return RealnameFaceIDAttempt{}, false, newError("realname_faceid_not_found", "实名认证尝试不存在。", http.StatusNotFound)
	}
	switch attempt.State {
	case RealnameFaceIDStatePending, RealnameFaceIDStateChecking:
	default:
		return attempt, false, nil
	}
	if attempt.LeaseUntil != nil && attempt.LeaseUntil.After(now) && attempt.LeaseOwner != strings.TrimSpace(owner) {
		return attempt, false, nil
	}
	attempt.State = RealnameFaceIDStateChecking
	attempt.LeaseOwner = strings.TrimSpace(owner)
	leaseUntil := now.Add(leaseTTL)
	attempt.LeaseUntil = &leaseUntil
	attempt.LeaseVersion++
	attempt.UpdatedAt = now
	s.realnameFaceIDAttempts[attempt.AttemptID] = attempt
	return attempt, true, nil
}

func (s *MemoryStore) ListReconcileableRealnameFaceIDAttempts(_ context.Context, now time.Time, limit int) ([]RealnameFaceIDAttempt, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	var attempts []RealnameFaceIDAttempt
	for _, attempt := range s.realnameFaceIDAttempts {
		if attempt.ScrubbedAt != nil || attempt.BizTokenHash == "" {
			continue
		}
		switch attempt.State {
		case RealnameFaceIDStatePending, RealnameFaceIDStateChecking:
		default:
			continue
		}
		if attempt.LeaseUntil != nil && attempt.LeaseUntil.After(now) {
			continue
		}
		attempts = append(attempts, attempt)
	}
	sort.Slice(attempts, func(i, j int) bool { return attempts[i].CreatedAt.Before(attempts[j].CreatedAt) })
	if limit > 0 && len(attempts) > limit {
		attempts = attempts[:limit]
	}
	return attempts, nil
}

func (s *MemoryStore) ExpireRealnameFaceIDAttempts(_ context.Context, now time.Time, limit int) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ids := make([]string, 0)
	for id, attempt := range s.realnameFaceIDAttempts {
		if attempt.ScrubbedAt == nil && isActiveRealnameFaceIDState(attempt.State) && !attempt.BusinessExpiresAt.After(now) {
			ids = append(ids, id)
		}
	}
	sort.Slice(ids, func(i, j int) bool {
		return s.realnameFaceIDAttempts[ids[i]].CreatedAt.Before(s.realnameFaceIDAttempts[ids[j]].CreatedAt)
	})
	if limit > 0 && len(ids) > limit {
		ids = ids[:limit]
	}
	for _, id := range ids {
		attempt := s.realnameFaceIDAttempts[id]
		attempt.State = RealnameFaceIDStateExpired
		attempt.NameCiphertext = ""
		attempt.IDCardCiphertext = ""
		attempt.BizTokenCiphertext = ""
		attempt.VerifyURLCiphertext = ""
		attempt.VerifyURL = ""
		attempt.ClientIPCiphertext = ""
		attempt.ClientUACiphertext = ""
		attempt.LeaseOwner = ""
		attempt.LeaseUntil = nil
		attempt.LeaseVersion++
		attempt.ScrubbedAt = &now
		attempt.UpdatedAt = now
		s.realnameFaceIDAttempts[id] = attempt
		s.realnameFaceIDAuditEvents = append(s.realnameFaceIDAuditEvents, RealnameFaceIDAuditEvent{
			AttemptID: attempt.AttemptID, UserID: attempt.UserID, EventType: "attempt_expired", State: attempt.State,
			RuleID: attempt.RuleID, AccountID: attempt.AccountID, RequestID: attempt.LastGetInfoRequestID,
			IdentityHash: attempt.IdentityHash, PhoneHash: attempt.CurrentPhoneHash, BizTokenHash: attempt.BizTokenHash, CreatedAt: now,
		})
	}
	return len(ids), nil
}

func (s *MemoryStore) AppendRealnameFaceIDAuditEvent(_ context.Context, event RealnameFaceIDAuditEvent) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.realnameFaceIDAuditEvents = append(s.realnameFaceIDAuditEvents, event)
	return nil
}

func (s *MemoryStore) ApplyRealnameFaceIDReconcileWithAudit(_ context.Context, attempt RealnameFaceIDAttempt, expectedLeaseVersion int64, expectedLeaseOwner string, event RealnameFaceIDAuditEvent) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	current, ok := s.realnameFaceIDAttempts[attempt.AttemptID]
	if !ok || current.LeaseVersion != expectedLeaseVersion || current.LeaseOwner != expectedLeaseOwner {
		return false, nil
	}
	s.realnameFaceIDAttempts[attempt.AttemptID] = attempt
	s.realnameFaceIDAuditEvents = append(s.realnameFaceIDAuditEvents, event)
	return true, nil
}

func (s *MemoryStore) ApplyRealnameFaceIDPhoneProof(_ context.Context, attempt RealnameFaceIDAttempt, expectedState string, expectedLeaseVersion int64, phone string, event RealnameFaceIDAuditEvent) (User, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	current, ok := s.realnameFaceIDAttempts[attempt.AttemptID]
	if !ok || current.State != expectedState || current.LeaseVersion != expectedLeaseVersion || current.ScrubbedAt != nil {
		return User{}, false, nil
	}
	user, ok := s.usersByID[attempt.UserID]
	if !ok {
		return User{}, false, newError("user_not_found", "用户不存在。", http.StatusNotFound)
	}
	normalizedPhone := normalizePhone(phone)
	if user.Phone != "" && normalizePhone(user.Phone) != normalizedPhone {
		return User{}, false, newError("realname_phone_mismatch", "当前手机号已变更，请重新开始实名认证。", http.StatusConflict)
	}
	if existingUserID, exists := s.usersByPhone[normalizedPhone]; exists && existingUserID != user.ID {
		return User{}, false, newError("phone_in_use", "该手机号已绑定其他账号。", http.StatusConflict)
	}
	if user.Phone == "" {
		user.Phone = normalizedPhone
		user.UpdatedAt = attempt.UpdatedAt
		s.usersByID[user.ID] = user
		s.usersByPhone[normalizedPhone] = user.ID
	}
	s.realnameFaceIDAttempts[attempt.AttemptID] = attempt
	s.realnameFaceIDAuditEvents = append(s.realnameFaceIDAuditEvents, event)
	return user, true, nil
}

func (s *MemoryStore) ActivateRealnameFaceIDAttempt(_ context.Context, userID string, attemptID string, currentPhone string, identityHash string, phoneHash string, faceVerifiedAt time.Time, phoneVerifiedAt time.Time, now time.Time) (User, RealnameFaceIDAttempt, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	user, ok := s.usersByID[userID]
	if !ok {
		return User{}, RealnameFaceIDAttempt{}, newError("user_not_found", "用户不存在。", http.StatusNotFound)
	}
	attempt, ok := s.realnameFaceIDAttempts[attemptID]
	if !ok {
		return User{}, RealnameFaceIDAttempt{}, newError("realname_faceid_not_found", "实名认证尝试不存在。", http.StatusNotFound)
	}
	if normalizePhone(user.Phone) != normalizePhone(currentPhone) || attempt.UserID != userID || attempt.State != RealnameFaceIDStateShadowPending || attempt.FaceVerifiedAt == nil || attempt.PhoneVerifiedAt == nil || attempt.IdentityHash != identityHash || attempt.PhoneVerifiedHash != phoneHash {
		return User{}, RealnameFaceIDAttempt{}, newError("realname_faceid_activation_invariant_failed", "实名认证状态不匹配，请重新认证。", http.StatusConflict)
	}
	user.RealnameVerified = true
	user.RealnameLevel = RealnameLevelPhone3FA
	user.realnameVerifiedAt = &now
	user.realnameFinalAttemptID = attemptID
	user.realnameFaceVerifiedAt = &faceVerifiedAt
	user.realnamePhoneVerifiedAt = &phoneVerifiedAt
	user.realnameIdentityHash = identityHash
	user.realnamePhoneHash = phoneHash
	user.UpdatedAt = now
	s.usersByID[userID] = user
	realname := UpdateRealnameInput{
		Provider:         "tencent_faceid",
		Result:           "0",
		RequestID:        attempt.LastGetInfoRequestID,
		NameCiphertext:   attempt.NameCiphertext,
		IDCardCiphertext: attempt.IDCardCiphertext,
		NameMasked:       attempt.NameMasked,
		IDCardMasked:     attempt.IDCardMasked,
		VerifiedAt:       now,
	}
	s.realnames[userID] = realname
	s.realnameHistory[userID] = append(s.realnameHistory[userID], realname)

	attempt.State = RealnameFaceIDStateSucceeded
	attempt.UpdatedAt = now
	scrubbedAt := now
	attempt.BizTokenCiphertext = ""
	attempt.VerifyURLCiphertext = ""
	attempt.VerifyURL = ""
	attempt.NameCiphertext = ""
	attempt.IDCardCiphertext = ""
	attempt.ClientIPCiphertext = ""
	attempt.ClientUACiphertext = ""
	attempt.ScrubbedAt = &scrubbedAt
	s.realnameFaceIDAttempts[attemptID] = attempt
	s.realnameFaceIDAuditEvents = append(s.realnameFaceIDAuditEvents, RealnameFaceIDAuditEvent{
		AttemptID: attempt.AttemptID, UserID: attempt.UserID, EventType: "activated", State: attempt.State,
		RuleID: attempt.RuleID, AccountID: attempt.AccountID, RequestID: attempt.LastGetInfoRequestID,
		IdentityHash: attempt.IdentityHash, PhoneHash: attempt.PhoneVerifiedHash, BizTokenHash: attempt.BizTokenHash, CreatedAt: now,
	})
	return user, attempt, nil
}
