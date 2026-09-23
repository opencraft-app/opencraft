package service

import (
	"context"
	"net/http"
	"sort"
	"strings"
	"time"
)

func (s *MemoryStore) AcquireDeveloperTestAccount(
	_ context.Context,
	candidateUserIDs []string,
	leaseOwner string,
	targetIP string,
	now time.Time,
	ttl time.Duration,
	renewalUserID string,
) (DeveloperTestAccountLease, *AuthSession, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	owner := strings.TrimSpace(leaseOwner)
	renewalUserID = strings.TrimSpace(renewalUserID)
	candidates := append([]string(nil), candidateUserIDs...)
	sort.Strings(candidates)
	candidateSet := make(map[string]struct{}, len(candidates))
	for _, userID := range candidates {
		candidateSet[userID] = struct{}{}
	}
	selected := ""
	for userID, lease := range s.developerTestAccountLeases {
		if lease.LeaseOwner != owner {
			continue
		}
		if _, eligible := candidateSet[userID]; !eligible {
			return DeveloperTestAccountLease{}, nil, newError("developer_test_account_unavailable", "没有可租用的 testing 账号。", http.StatusServiceUnavailable)
		}
		if lease.LeaseUntil.After(now) {
			if renewalUserID == "" || renewalUserID != userID {
				return DeveloperTestAccountLease{}, nil, newError("developer_test_account_renewal_requires_session", "续租 testing 账号需要当前租约会话。", http.StatusUnauthorized)
			}
		} else if renewalUserID != "" {
			return DeveloperTestAccountLease{}, nil, newError("developer_test_account_lease_not_found", "测试账号租约不存在或已失效。", http.StatusConflict)
		}
		selected = userID
		break
	}
	if selected == "" && renewalUserID != "" {
		return DeveloperTestAccountLease{}, nil, newError("developer_test_account_lease_not_found", "测试账号租约不存在或已失效。", http.StatusConflict)
	}
	if selected == "" {
		for _, userID := range candidates {
			lease, exists := s.developerTestAccountLeases[userID]
			if !exists || !lease.LeaseUntil.After(now) {
				selected = userID
				break
			}
		}
	}
	if selected == "" {
		return DeveloperTestAccountLease{}, nil, newError("developer_test_account_busy", "testing 账号池当前已被占满。", http.StatusConflict)
	}
	user, exists := s.usersByID[selected]
	if !exists {
		return DeveloperTestAccountLease{}, nil, newError("user_not_found", "用户不存在。", http.StatusNotFound)
	}
	previous := s.developerTestAccountLeases[selected]
	lease := DeveloperTestAccountLease{
		UserID: selected, LeaseOwner: owner, TargetIP: strings.TrimSpace(targetIP),
		LeaseUntil: now.Add(ttl), LeaseVersion: previous.LeaseVersion + 1,
	}
	s.developerTestAccountLeases[selected] = lease
	session, err := s.createSessionWithMetadataLocked(user, now, ttl, false, "", AuthMethodDeveloperLease)
	if err != nil {
		return DeveloperTestAccountLease{}, nil, err
	}
	return lease, session, nil
}

func (s *MemoryStore) ReleaseDeveloperTestAccount(_ context.Context, userID string, leaseOwner string, now time.Time) (DeveloperTestAccountLease, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	lease, exists := s.developerTestAccountLeases[strings.TrimSpace(userID)]
	if !exists || lease.LeaseOwner != strings.TrimSpace(leaseOwner) || !lease.LeaseUntil.After(now) {
		return DeveloperTestAccountLease{}, newError("developer_test_account_lease_not_found", "测试账号租约不存在或已失效。", http.StatusConflict)
	}
	lease.LeaseOwner = ""
	lease.TargetIP = ""
	lease.LeaseUntil = now
	lease.LeaseVersion++
	s.developerTestAccountLeases[lease.UserID] = lease
	for token, session := range s.sessions {
		if session.UserID == lease.UserID && session.AuthMethod == AuthMethodDeveloperLease {
			delete(s.sessions, token)
		}
	}
	return lease, nil
}
