package shadowbinding

import (
	"context"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

type MemoryStore struct {
	mu       sync.Mutex
	bindings map[string]Binding
	codes    map[string]AuthCode
}

func NewMemoryStore() *MemoryStore {
	return &MemoryStore{bindings: make(map[string]Binding), codes: make(map[string]AuthCode)}
}

func (s *MemoryStore) SavePendingBinding(_ context.Context, userID string, shadowUserName string, now time.Time) (Binding, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if existing, ok := s.bindings[userID]; ok {
		existing.ShadowUserName = shadowUserName
		existing.Status = StatusPending
		existing.LastErrorCode = ""
		existing.LastErrorMessage = ""
		existing.BasicAuthStatus = ""
		existing.BasicAuthSyncedAt = nil
		existing.BasicAuthSourceAttemptID = ""
		existing.BasicAuthIdentityHash = ""
		existing.BasicAuthPhoneHash = ""
		existing.BasicAuthLastErrorCode = ""
		existing.BasicAuthLastErrorMessage = ""
		existing.UpdatedAt = now
		s.bindings[userID] = existing
		return existing, nil
	}
	binding := Binding{UserID: userID, ShadowUserName: shadowUserName, Status: StatusPending, CreatedAt: now, UpdatedAt: now}
	s.bindings[userID] = binding
	return binding, nil
}

func (s *MemoryStore) GetBindingByUserID(_ context.Context, userID string) (Binding, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	binding, ok := s.bindings[userID]
	if !ok {
		return Binding{}, ErrNotFound
	}
	return binding, nil
}

func (s *MemoryStore) GetBindingByShadowUserName(_ context.Context, shadowUserName string) (Binding, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var disabled Binding
	for _, binding := range s.bindings {
		if binding.ShadowUserName == shadowUserName {
			if binding.Status != StatusDisabled {
				return binding, nil
			}
			disabled = binding
		}
	}
	if disabled.UserID != "" {
		return disabled, nil
	}
	return Binding{}, ErrNotFound
}

func (s *MemoryStore) ListAdminBindings(_ context.Context, search string, limit int, offset int) ([]Binding, int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	needle := strings.ToLower(strings.TrimSpace(search))
	bindings := make([]Binding, 0, len(s.bindings))
	for _, binding := range s.bindings {
		if needle != "" && !adminBindingMatches(binding, needle) {
			continue
		}
		bindings = append(bindings, binding)
	}
	sort.Slice(bindings, func(i, j int) bool {
		if bindings[i].CreatedAt.Equal(bindings[j].CreatedAt) {
			return bindings[i].UserID < bindings[j].UserID
		}
		return bindings[i].CreatedAt.After(bindings[j].CreatedAt)
	})

	total := len(bindings)
	if offset < 0 {
		offset = 0
	}
	if offset >= total {
		return []Binding{}, total, nil
	}
	if limit < 1 {
		limit = 20
	}
	end := offset + limit
	if end > total {
		end = total
	}
	return append([]Binding(nil), bindings[offset:end]...), total, nil
}

func adminBindingMatches(binding Binding, needle string) bool {
	values := []string{
		binding.UserID,
		binding.ShadowUserName,
		strconv.FormatInt(binding.Uin, 10),
		strconv.FormatInt(binding.OwnerUin, 10),
		strconv.FormatInt(binding.AppID, 10),
	}
	for _, value := range values {
		if strings.Contains(strings.ToLower(value), needle) {
			return true
		}
	}
	return false
}

func (s *MemoryStore) UpsertAdminBinding(_ context.Context, requested Binding, now time.Time) (Binding, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if existing, ok := s.bindings[requested.UserID]; ok && existing.Status != StatusDisabled {
		if sameBindingIdentity(existing, requested) && existing.Status == StatusActive {
			return existing, nil
		}
		return Binding{}, ErrBindingConflict
	}
	for userID, existing := range s.bindings {
		if userID == requested.UserID || existing.Status == StatusDisabled {
			continue
		}
		if existing.Uin == requested.Uin || existing.ShadowUserName == requested.ShadowUserName {
			return Binding{}, ErrBindingConflict
		}
	}

	existing, exists := s.bindings[requested.UserID]
	createdAt := now
	if exists {
		createdAt = existing.CreatedAt
	}
	requested.Status = StatusActive
	requested.LastErrorCode = ""
	requested.LastErrorMessage = ""
	requested.BasicAuthStatus = ""
	requested.BasicAuthSyncedAt = nil
	requested.BasicAuthSourceAttemptID = ""
	requested.BasicAuthIdentityHash = ""
	requested.BasicAuthPhoneHash = ""
	requested.BasicAuthLastErrorCode = ""
	requested.BasicAuthLastErrorMessage = ""
	requested.CreatedAt = createdAt
	requested.UpdatedAt = now
	s.bindings[requested.UserID] = requested
	return requested, nil
}

func (s *MemoryStore) DisableAdminBinding(_ context.Context, userID string, now time.Time) (Binding, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	binding, ok := s.bindings[userID]
	if !ok {
		return Binding{}, ErrNotFound
	}
	if binding.Status == StatusDisabled {
		return binding, nil
	}
	binding.Status = StatusDisabled
	binding.LastErrorCode = ""
	binding.LastErrorMessage = ""
	binding.UpdatedAt = now
	s.bindings[userID] = binding
	return binding, nil
}

func sameBindingIdentity(left Binding, right Binding) bool {
	return left.UserID == right.UserID &&
		left.ShadowUserName == right.ShadowUserName &&
		left.Uin == right.Uin &&
		left.OwnerUin == right.OwnerUin &&
		left.AppID == right.AppID
}

func (s *MemoryStore) MarkBindingActive(_ context.Context, userID string, uin, ownerUin, appID int64, now time.Time) (Binding, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	binding, ok := s.bindings[userID]
	if !ok {
		return Binding{}, ErrNotFound
	}
	binding.Uin = uin
	binding.OwnerUin = ownerUin
	binding.AppID = appID
	binding.Status = StatusActive
	binding.LastErrorCode = ""
	binding.LastErrorMessage = ""
	binding.UpdatedAt = now
	s.bindings[userID] = binding
	return binding, nil
}

func (s *MemoryStore) SetBindingAppIDIfMissing(_ context.Context, userID string, uin, ownerUin, appID int64, now time.Time) (Binding, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	binding, ok := s.bindings[userID]
	if !ok {
		return Binding{}, ErrNotFound
	}
	if binding.Uin != uin || binding.OwnerUin != ownerUin {
		return Binding{}, fmt.Errorf("shadow binding identity changed")
	}
	if binding.AppID != 0 && binding.AppID != appID {
		return Binding{}, fmt.Errorf("shadow binding app id changed")
	}
	if binding.AppID == 0 {
		binding.AppID = appID
		binding.UpdatedAt = now
		s.bindings[userID] = binding
	}
	return binding, nil
}

func (s *MemoryStore) MarkBindingRegistered(_ context.Context, userID string, uin, ownerUin, appID int64, now time.Time) (Binding, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	binding, ok := s.bindings[userID]
	if !ok {
		return Binding{}, ErrNotFound
	}
	binding.Uin = uin
	binding.OwnerUin = ownerUin
	binding.AppID = appID
	binding.Status = StatusPending
	binding.LastErrorCode = ""
	binding.LastErrorMessage = ""
	binding.UpdatedAt = now
	s.bindings[userID] = binding
	return binding, nil
}

func (s *MemoryStore) MarkBindingFailed(_ context.Context, userID string, code string, message string, now time.Time) (Binding, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	binding, ok := s.bindings[userID]
	if !ok {
		return Binding{}, ErrNotFound
	}
	binding.Status = StatusFailed
	binding.LastErrorCode = code
	binding.LastErrorMessage = message
	binding.UpdatedAt = now
	s.bindings[userID] = binding
	return binding, nil
}

func (s *MemoryStore) MarkBasicAuthSucceeded(_ context.Context, userID string, sourceAttemptID string, identityHash string, phoneHash string, now time.Time) (Binding, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	binding, ok := s.bindings[userID]
	if !ok {
		return Binding{}, ErrNotFound
	}
	binding.BasicAuthStatus = BasicAuthStatusSucceeded
	binding.BasicAuthSyncedAt = &now
	binding.BasicAuthSourceAttemptID = sourceAttemptID
	binding.BasicAuthIdentityHash = identityHash
	binding.BasicAuthPhoneHash = phoneHash
	binding.BasicAuthLastErrorCode = ""
	binding.BasicAuthLastErrorMessage = ""
	binding.UpdatedAt = now
	s.bindings[userID] = binding
	return binding, nil
}

func (s *MemoryStore) MarkBasicAuthFailed(_ context.Context, userID string, code string, message string, now time.Time) (Binding, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	binding, ok := s.bindings[userID]
	if !ok {
		return Binding{}, ErrNotFound
	}
	binding.BasicAuthStatus = BasicAuthStatusFailed
	binding.BasicAuthSourceAttemptID = ""
	binding.BasicAuthIdentityHash = ""
	binding.BasicAuthPhoneHash = ""
	binding.BasicAuthLastErrorCode = code
	binding.BasicAuthLastErrorMessage = message
	binding.UpdatedAt = now
	s.bindings[userID] = binding
	return binding, nil
}

func (s *MemoryStore) IssueAuthCode(_ context.Context, userID string, purpose string, ttl time.Duration, now time.Time) (AuthCode, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	code, err := newAuthCode()
	if err != nil {
		return AuthCode{}, err
	}
	record := AuthCode{Code: code, UserID: userID, Purpose: purpose, ExpiresAt: now.Add(ttl), CreatedAt: now}
	s.codes[code] = record
	return record, nil
}

func (s *MemoryStore) ConsumeAuthCode(_ context.Context, code string, now time.Time) (AuthCode, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	record, ok := s.codes[code]
	if !ok || record.ConsumedAt != nil || !record.ExpiresAt.After(now) {
		return AuthCode{}, ErrNotFound
	}
	consumedAt := now
	record.ConsumedAt = &consumedAt
	s.codes[code] = record
	return record, nil
}
