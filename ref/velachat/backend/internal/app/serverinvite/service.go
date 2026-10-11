// Package serverinvite 实现一次性 Server 邀请管理。
package serverinvite

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	appservermember "chatserver/internal/app/servermember"
	"chatserver/internal/apperror"
	clockport "chatserver/internal/ports/clock"
	idport "chatserver/internal/ports/id"
	inviteport "chatserver/internal/ports/serverinvite"

	"github.com/google/uuid"
)

const (
	minimumInviteTTL = 5 * time.Minute
	maximumInviteTTL = 30 * 24 * time.Hour
)

// CreateCommand 是 Owner/Admin 创建邀请的输入。
type CreateCommand struct {
	AccountID        string
	ServerID         string
	Role             string
	MaxUses          int64
	LandingChannelID *string
	ExpiresAt        time.Time
}

// RevokeCommand 是 Owner/Admin 撤销邀请的输入。
type RevokeCommand struct {
	AccountID string
	ServerID  string
	InviteID  string
}

// AcceptCommand 是当前 Human 接受一次性邀请的输入。
type AcceptCommand struct {
	AccountID      string
	IdempotencyKey string
	Token          string
}

// AcceptResult 返回新 Member 与 IM membership operation。
type AcceptResult = inviteport.AcceptResult

// InviteToken 只允许响应层显式 Reveal 一次。
type InviteToken string

func (InviteToken) String() string { return "[REDACTED]" }

func (InviteToken) Format(state fmt.State, _ rune) {
	_, _ = io.WriteString(state, "[REDACTED]")
}

func (InviteToken) MarshalJSON() ([]byte, error) {
	return nil, errors.New("邀请 token 禁止通用 JSON 序列化")
}

func (token InviteToken) Reveal() string { return string(token) }

// CreateResult 同时返回可持久元数据和只显示一次的 token。
type CreateResult struct {
	Invite inviteport.Invite
	Token  InviteToken
}

// Service 编排随机 token、哈希和邀请事实。
type Service struct {
	repository inviteport.Repository
	ids        idport.Generator
	clock      clockport.Clock
	random     io.Reader
}

func NewService(
	repository inviteport.Repository,
	ids idport.Generator,
	clock clockport.Clock,
	random io.Reader,
) (*Service, error) {
	if repository == nil || ids == nil || clock == nil || random == nil {
		return nil, errors.New("Server 邀请服务配置无效")
	}
	return &Service{
		repository: repository,
		ids:        ids,
		clock:      clock,
		random:     random,
	}, nil
}

func (service *Service) Create(
	ctx context.Context,
	command CreateCommand,
) (CreateResult, error) {
	now := service.clock.Now().UTC()
	role := strings.TrimSpace(command.Role)
	if !validUUIDv7(command.AccountID) ||
		!validUUIDv7(command.ServerID) ||
		(role != "admin" && role != "member") ||
		command.MaxUses < 1 ||
		command.MaxUses > 1000 ||
		command.ExpiresAt.Before(now.Add(minimumInviteTTL)) ||
		command.ExpiresAt.After(now.Add(maximumInviteTTL)) ||
		(command.LandingChannelID != nil &&
			!validUUIDv7(*command.LandingChannelID)) {
		return CreateResult{},
			apperror.New("invalid_request", "邀请参数无效", nil)
	}
	inviteID, err := service.ids.New()
	if err != nil {
		return CreateResult{},
			apperror.New("internal_error", "暂时无法创建邀请", err)
	}
	serverID, err := uuid.Parse(command.ServerID)
	if err != nil {
		return CreateResult{},
			apperror.New("invalid_request", "邀请参数无效", err)
	}
	payload := make([]byte, 16+32)
	copy(payload, serverID[:])
	secret := payload[16:]
	if _, err := io.ReadFull(service.random, secret); err != nil {
		return CreateResult{},
			apperror.New("internal_error", "暂时无法创建邀请", err)
	}
	rawToken := "rfi_" + base64.RawURLEncoding.EncodeToString(payload)
	tokenHash := sha256.Sum256([]byte(rawToken))
	invite, err := service.repository.Create(
		ctx,
		inviteport.CreateCommand{
			AccountID:        command.AccountID,
			ServerID:         command.ServerID,
			InviteID:         inviteID,
			TokenHash:        tokenHash,
			Role:             role,
			MaxUses:          command.MaxUses,
			LandingChannelID: command.LandingChannelID,
			ExpiresAt:        command.ExpiresAt.UTC(),
			CreatedAt:        now,
		},
	)
	if err != nil {
		return CreateResult{}, mapRepositoryError(err)
	}
	return CreateResult{
		Invite: invite,
		Token:  InviteToken(rawToken),
	}, nil
}

// Accept 解出分片路由键，再原子消费邀请并创建 Human Member。
func (service *Service) Accept(
	ctx context.Context,
	command AcceptCommand,
) (AcceptResult, error) {
	return service.accept(ctx, command, false)
}

// AcceptJoinLink 接受加入链接；已经是成员时仍返回稳定的 Server 落点。
func (service *Service) AcceptJoinLink(
	ctx context.Context,
	command AcceptCommand,
) (AcceptResult, error) {
	return service.accept(ctx, command, true)
}

func (service *Service) accept(
	ctx context.Context,
	command AcceptCommand,
	allowExistingMember bool,
) (AcceptResult, error) {
	serverID, err := serverIDFromToken(command.Token)
	if !validUUIDv7(command.AccountID) ||
		strings.TrimSpace(command.IdempotencyKey) == "" ||
		err != nil {
		return AcceptResult{},
			apperror.New("invalid_request", "邀请接受参数无效", err)
	}
	memberID, err := service.ids.New()
	if err != nil {
		return AcceptResult{},
			apperror.New("internal_error", "暂时无法接受邀请", err)
	}
	operationID, err := service.ids.New()
	if err != nil {
		return AcceptResult{},
			apperror.New("internal_error", "暂时无法接受邀请", err)
	}
	handle, err := appservermember.DeriveHumanHandle(
		command.AccountID,
		memberID,
	)
	if err != nil {
		return AcceptResult{},
			apperror.New("internal_error", "暂时无法接受邀请", err)
	}
	tokenHash := sha256.Sum256([]byte(command.Token))
	result, err := service.repository.Accept(
		ctx,
		inviteport.AcceptCommand{
			AccountID:           command.AccountID,
			ServerID:            serverID,
			MemberID:            memberID,
			OperationID:         operationID,
			IdempotencyKey:      strings.TrimSpace(command.IdempotencyKey),
			RequestHash:         tokenHash,
			TokenHash:           tokenHash,
			Handle:              handle,
			AllowExistingMember: allowExistingMember,
			AcceptedAt:          service.clock.Now().UTC(),
		},
	)
	if err != nil {
		return AcceptResult{}, mapRepositoryError(err)
	}
	return result, nil
}

func serverIDFromToken(token string) (string, error) {
	if !strings.HasPrefix(token, "rfi_") {
		return "", errors.New("邀请 token 前缀无效")
	}
	payload, err := base64.RawURLEncoding.DecodeString(
		strings.TrimPrefix(token, "rfi_"),
	)
	if err != nil || len(payload) != 48 {
		return "", errors.New("邀请 token 载荷无效")
	}
	serverID, err := uuid.FromBytes(payload[:16])
	if err != nil || serverID.Version() != 7 {
		return "", errors.New("邀请 token 路由无效")
	}
	return serverID.String(), nil
}

func (service *Service) List(
	ctx context.Context,
	accountID string,
	serverID string,
) ([]inviteport.Invite, error) {
	if !validUUIDv7(accountID) || !validUUIDv7(serverID) {
		return nil, apperror.New("invalid_request", "邀请列表参数无效", nil)
	}
	values, err := service.repository.List(ctx, accountID, serverID)
	if err != nil {
		return nil, mapRepositoryError(err)
	}
	return values, nil
}

func (service *Service) Revoke(
	ctx context.Context,
	command RevokeCommand,
) error {
	if !validUUIDv7(command.AccountID) ||
		!validUUIDv7(command.ServerID) ||
		!validUUIDv7(command.InviteID) {
		return apperror.New("invalid_request", "邀请撤销参数无效", nil)
	}
	err := service.repository.Revoke(ctx, inviteport.RevokeCommand{
		AccountID: command.AccountID,
		ServerID:  command.ServerID,
		InviteID:  command.InviteID,
		RevokedAt: service.clock.Now().UTC(),
	})
	if err != nil {
		return mapRepositoryError(err)
	}
	return nil
}

func validUUIDv7(value string) bool {
	parsed, err := uuid.Parse(value)
	return err == nil && parsed != uuid.Nil && parsed.Version() == 7
}

func mapRepositoryError(err error) error {
	switch {
	case errors.Is(err, inviteport.ErrPermissionDenied):
		return apperror.New(
			"permission_denied",
			"没有管理邀请的权限",
			err,
		)
	case errors.Is(err, inviteport.ErrInviteNotFound):
		return apperror.New("resource_not_found", "邀请不存在", err)
	case errors.Is(err, inviteport.ErrInviteInvalid):
		return apperror.New("invite_invalid", "邀请无效或已失效", err)
	case errors.Is(err, inviteport.ErrAlreadyMember):
		return apperror.New("already_member", "已经是 Server 成员", err)
	case errors.Is(err, inviteport.ErrAccountNotReady):
		return apperror.New(
			"im_identity_not_ready",
			"账号 IM 身份尚未就绪",
			err,
		)
	case errors.Is(err, inviteport.ErrIdempotency):
		return apperror.New(
			"idempotency_conflict",
			"幂等键与原请求不一致",
			err,
		)
	case errors.Is(err, inviteport.ErrLandingNotFound):
		return apperror.New(
			"resource_not_found",
			"邀请落地 Channel 不存在",
			err,
		)
	default:
		return apperror.New("internal_error", "邀请操作失败", err)
	}
}
