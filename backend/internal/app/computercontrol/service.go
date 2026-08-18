// Package computercontrol implements the authenticated Vela daemon control plane.
package computercontrol

import (
	"context"
	"errors"
	"strings"
	"time"

	"chatserver/internal/apperror"
	clockport "chatserver/internal/ports/clock"
	computerauthport "chatserver/internal/ports/computerauth"
	computercontrolport "chatserver/internal/ports/computercontrol"
	tokenport "chatserver/internal/ports/token"

	"github.com/google/uuid"
)

type Config struct {
	AccessTTL time.Duration
}

type Session struct {
	AccessToken        string
	ExpiresAt          time.Time
	Computer           computercontrolport.SessionIdentity
	AssignmentVersions []int
}

type Service struct {
	repository computercontrolport.Repository
	tokens     tokenport.Signer
	clock      clockport.Clock
	config     Config
}

func NewService(
	repository computercontrolport.Repository,
	tokens tokenport.Signer,
	clock clockport.Clock,
	config Config,
) (*Service, error) {
	if repository == nil || tokens == nil || clock == nil ||
		config.AccessTTL <= 0 || config.AccessTTL > time.Hour {
		return nil, errors.New("Computer 控制服务配置无效")
	}
	return &Service{repository: repository, tokens: tokens, clock: clock, config: config}, nil
}

func (service *Service) CreateSession(
	ctx context.Context,
	serverID string,
	computerID string,
	credentialVersion uint64,
) (Session, error) {
	if !validV7(serverID) || !validV7(computerID) || credentialVersion == 0 {
		return Session{}, apperror.New("computer_credential_invalid", "Computer 凭证路由无效", nil)
	}
	now := service.clock.Now().UTC()
	route := computerauthport.Route{
		ServerID:   serverID,
		ComputerID: computerID,
		Version:    credentialVersion,
	}
	identity, err := service.repository.UseCurrentCredential(ctx, route, now)
	switch {
	case errors.Is(err, computercontrolport.ErrCredentialNotCurrent):
		return Session{}, apperror.New("computer_credential_revoked", "Computer credential 已失效", err)
	case err != nil:
		return Session{}, apperror.New("internal_error", "暂时无法创建 Computer 会话", err)
	}
	if identity.ServerID != serverID || identity.ComputerID != computerID ||
		identity.CredentialVersion != credentialVersion ||
		!validV7(identity.AssignmentEpoch) || identity.AssignmentRevision < 1 {
		return Session{}, apperror.New("computer_credential_revoked", "Computer credential 已失效", nil)
	}
	expiresAt := now.Add(service.config.AccessTTL)
	claims, err := tokenport.NewComputerClaims(
		serverID,
		computerID,
		credentialVersion,
		now,
		expiresAt,
	)
	if err != nil {
		return Session{}, apperror.New("internal_error", "Computer 身份数据无效", err)
	}
	accessToken, err := service.tokens.Sign(ctx, claims)
	if err != nil || strings.TrimSpace(accessToken) == "" {
		return Session{}, apperror.New("internal_error", "暂时无法签发 Computer 会话", err)
	}
	if err := service.repository.RefreshSessionLease(
		ctx,
		route,
		now,
	); err != nil {
		if errors.Is(err, computercontrolport.ErrCredentialNotCurrent) {
			return Session{}, apperror.New(
				"computer_credential_revoked",
				"Computer credential 已失效",
				err,
			)
		}
		return Session{}, apperror.New(
			"internal_error",
			"暂时无法创建 Computer 会话",
			err,
		)
	}
	return Session{
		AccessToken:        accessToken,
		ExpiresAt:          expiresAt,
		Computer:           identity,
		AssignmentVersions: []int{1},
	}, nil
}

func validV7(value string) bool {
	parsed, err := uuid.Parse(value)
	return err == nil && parsed != uuid.Nil && parsed.Version() == 7
}

func NegotiateAssignmentVersion(client []int, server []int) (int, error) {
	serverVersions := make(map[int]struct{}, len(server))
	for _, version := range server {
		if version > 0 {
			serverVersions[version] = struct{}{}
		}
	}
	selected := 0
	for _, version := range client {
		if version <= selected {
			continue
		}
		if _, ok := serverVersions[version]; ok {
			selected = version
		}
	}
	if selected == 0 {
		return 0, apperror.New(
			"invalid_request",
			"Computer 不支持服务端可用的 Assignment 协议",
			nil,
		)
	}
	return selected, nil
}
