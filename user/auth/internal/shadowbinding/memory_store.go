package shadowbinding

import (
	"context"
	"fmt"
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
	for _, binding := range s.bindings {
		if binding.ShadowUserName == shadowUserName {
			return binding, nil
		}
	}
	return Binding{}, ErrNotFound
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
