package service

import (
	"context"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/openclaw/openclaw/mono/backend/auth/internal/shadowbinding"
)

const maxDeveloperTestAccountLeaseTTL = 24 * time.Hour

func (s *Service) AcquireDeveloperTestAccount(
	ctx context.Context,
	candidateUserIDs []string,
	leaseOwner string,
	targetIP string,
	ttl time.Duration,
	renewalToken string,
) (DeveloperTestAccountLease, *AuthSession, error) {
	if s == nil || s.store == nil || s.shadowBinding == nil {
		return DeveloperTestAccountLease{}, nil, newError("developer_test_account_pool_disabled", "个人测试账号池未启用。", http.StatusServiceUnavailable)
	}
	owner := strings.TrimSpace(leaseOwner)
	ip := strings.TrimSpace(targetIP)
	if owner == "" || ip == "" {
		return DeveloperTestAccountLease{}, nil, newError("invalid_developer_test_account_request", "测试账号租约身份不完整。", http.StatusBadRequest)
	}
	if ttl < time.Minute || ttl > maxDeveloperTestAccountLeaseTTL {
		return DeveloperTestAccountLease{}, nil, newError("invalid_developer_test_account_ttl", "测试账号租约 TTL 必须在 1 分钟到 24 小时之间。", http.StatusBadRequest)
	}

	unique := make(map[string]struct{}, len(candidateUserIDs))
	eligible := make([]string, 0, len(candidateUserIDs))
	for _, rawUserID := range candidateUserIDs {
		userID := strings.TrimSpace(rawUserID)
		if userID == "" {
			continue
		}
		if _, exists := unique[userID]; exists {
			continue
		}
		unique[userID] = struct{}{}
		binding, err := s.shadowBinding.GetBindingByUserID(ctx, userID)
		if err != nil || binding.Status != shadowbinding.StatusActive || binding.Uin <= 0 || binding.OwnerUin <= 0 || binding.AppID <= 0 {
			continue
		}
		user, err := s.store.FindUserByID(ctx, userID)
		if err != nil || (s.siteKind == shadowbinding.SiteKindCN && !user.RealnameVerified) {
			continue
		}
		eligible = append(eligible, userID)
	}
	if len(eligible) == 0 {
		message := "没有可租用的 testing 账号。"
		if s.siteKind == shadowbinding.SiteKindCN {
			message = "没有可租用的已实名 testing 账号。"
		}
		return DeveloperTestAccountLease{}, nil, newError("developer_test_account_unavailable", message, http.StatusServiceUnavailable)
	}
	sort.Strings(eligible)
	renewalUserID := ""
	if token := strings.TrimSpace(renewalToken); token != "" {
		session, sessionErr := s.store.CurrentSession(ctx, token, s.now())
		if sessionErr != nil {
			return DeveloperTestAccountLease{}, nil, sessionErr
		}
		if session.AuthMethod != AuthMethodDeveloperLease {
			return DeveloperTestAccountLease{}, nil, newError("unauthorized", "未登录或登录已失效。", http.StatusUnauthorized)
		}
		renewalUserID = session.User.ID
	}
	lease, session, err := s.store.AcquireDeveloperTestAccount(ctx, eligible, owner, ip, s.now(), ttl, renewalUserID)
	if err != nil {
		return DeveloperTestAccountLease{}, nil, err
	}
	return lease, session, nil
}

func (s *Service) ReleaseDeveloperTestAccount(ctx context.Context, token string, leaseOwner string) (DeveloperTestAccountLease, error) {
	trimmedToken := strings.TrimSpace(token)
	owner := strings.TrimSpace(leaseOwner)
	if trimmedToken == "" {
		return DeveloperTestAccountLease{}, newError("unauthorized", "未登录或登录已失效。", http.StatusUnauthorized)
	}
	if owner == "" {
		return DeveloperTestAccountLease{}, newError("invalid_developer_test_account_request", "测试账号租约身份不完整。", http.StatusBadRequest)
	}
	session, err := s.store.CurrentSession(ctx, trimmedToken, s.now())
	if err != nil {
		return DeveloperTestAccountLease{}, err
	}
	if session.AuthMethod != AuthMethodDeveloperLease {
		return DeveloperTestAccountLease{}, newError("unauthorized", "未登录或登录已失效。", http.StatusUnauthorized)
	}
	lease, err := s.store.ReleaseDeveloperTestAccount(ctx, session.User.ID, owner, s.now())
	if err != nil {
		return DeveloperTestAccountLease{}, err
	}
	return lease, nil
}
