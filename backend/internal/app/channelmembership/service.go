// Package channelmembership 实现普通 Channel 的显式加入与退出用例。
package channelmembership

import (
	"context"
	"crypto/sha256"
	"errors"
	"strings"

	"chatserver/internal/apperror"
	channelmembershipport "chatserver/internal/ports/channelmembership"
	clockport "chatserver/internal/ports/clock"
	idport "chatserver/internal/ports/id"

	"github.com/google/uuid"
)

type Command struct {
	AccountID      string
	ServerID       string
	ChannelID      string
	MemberID       string
	IdempotencyKey string
	Action         string
}

type Service struct {
	repository channelmembershipport.Repository
	ids        idport.Generator
	clock      clockport.Clock
}

func NewService(
	repository channelmembershipport.Repository,
	ids idport.Generator,
	clock clockport.Clock,
) (*Service, error) {
	if repository == nil || ids == nil || clock == nil {
		return nil, errors.New("Channel membership 服务配置无效")
	}
	return &Service{repository: repository, ids: ids, clock: clock}, nil
}

func (service *Service) Change(
	ctx context.Context,
	command Command,
) (channelmembershipport.Result, error) {
	if !validID(command.AccountID) || !validID(command.ServerID) ||
		!validID(command.ChannelID) || !validID(command.MemberID) ||
		strings.TrimSpace(command.IdempotencyKey) == "" ||
		(command.Action != "ensure" && command.Action != "remove") {
		return channelmembershipport.Result{},
			apperror.New("invalid_request", "Channel 成员参数无效", nil)
	}
	operationID, err := service.ids.New()
	if err != nil {
		return channelmembershipport.Result{},
			apperror.New("internal_error", "暂时无法变更 Channel 成员", err)
	}
	channelMemberID, err := service.ids.New()
	if err != nil {
		return channelmembershipport.Result{},
			apperror.New("internal_error", "暂时无法变更 Channel 成员", err)
	}
	hash := sha256.Sum256([]byte(
		command.Action + "\x00" + command.ChannelID +
			"\x00" + command.MemberID,
	))
	result, err := service.repository.Change(
		ctx,
		channelmembershipport.Command{
			AccountID: command.AccountID, ServerID: command.ServerID,
			ChannelID: command.ChannelID, MemberID: command.MemberID,
			ChannelMemberID: channelMemberID,
			OperationID:     operationID,
			IdempotencyKey:  strings.TrimSpace(command.IdempotencyKey),
			RequestHash:     hash, Action: command.Action,
			ChangedAt: service.clock.Now().UTC(),
		},
	)
	if err != nil {
		return channelmembershipport.Result{}, mapError(err)
	}
	return result, nil
}

func validID(value string) bool {
	parsed, err := uuid.Parse(value)
	return err == nil && parsed != uuid.Nil && parsed.Version() == 7
}

func mapError(err error) error {
	switch {
	case errors.Is(err, channelmembershipport.ErrServerNotFound):
		return apperror.New("server_not_found", "Server 不存在", err)
	case errors.Is(err, channelmembershipport.ErrChannelNotFound):
		return apperror.New("channel_not_found", "Channel 不存在", err)
	case errors.Is(err, channelmembershipport.ErrMemberNotFound):
		return apperror.New("member_not_found", "成员不存在", err)
	case errors.Is(err, channelmembershipport.ErrPermissionDenied):
		return apperror.New(
			"permission_denied",
			"没有管理 Channel 成员的权限",
			err,
		)
	case errors.Is(err, channelmembershipport.ErrImplicitMembership):
		return apperror.New(
			"implicit_membership",
			"系统 #全员的成员关系由 Server 成员资格隐式提供",
			err,
		)
	case errors.Is(err, channelmembershipport.ErrMembershipNotFound):
		return apperror.New(
			"channel_membership_not_found",
			"成员尚未加入该 Channel",
			err,
		)
	case errors.Is(err, channelmembershipport.ErrIdempotencyConflict):
		return apperror.New(
			"idempotency_conflict",
			"幂等键与原请求不一致",
			err,
		)
	default:
		return apperror.New("internal_error", "Channel 成员变更失败", err)
	}
}
