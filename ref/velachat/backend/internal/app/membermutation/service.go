// Package membermutation 实现 Server Member 资料、角色与移除用例。
package membermutation

import (
	"context"
	"crypto/sha256"
	"errors"
	"strconv"
	"strings"

	"chatserver/internal/apperror"
	clockport "chatserver/internal/ports/clock"
	idport "chatserver/internal/ports/id"
	membermutationport "chatserver/internal/ports/membermutation"

	"github.com/google/uuid"
)

type UpdateCommand struct {
	AccountID        string
	ServerID         string
	MemberID         string
	ExpectedRevision int64
	IdempotencyKey   string
	DisplayName      *string
	Role             *string
}

type RemoveCommand struct {
	AccountID      string
	ServerID       string
	MemberID       string
	IdempotencyKey string
}

type Service struct {
	repository membermutationport.Repository
	ids        idport.Generator
	clock      clockport.Clock
}

func NewService(
	repository membermutationport.Repository,
	ids idport.Generator,
	clock clockport.Clock,
) (*Service, error) {
	if repository == nil || ids == nil || clock == nil {
		return nil, errors.New("成员变更服务配置无效")
	}
	return &Service{repository: repository, ids: ids, clock: clock}, nil
}

func (service *Service) Update(
	ctx context.Context,
	command UpdateCommand,
) (membermutationport.UpdateResult, error) {
	if !validID(command.AccountID) || !validID(command.ServerID) ||
		!validID(command.MemberID) || command.ExpectedRevision < 1 ||
		strings.TrimSpace(command.IdempotencyKey) == "" ||
		(command.DisplayName == nil && command.Role == nil) {
		return membermutationport.UpdateResult{},
			apperror.New("invalid_request", "成员变更参数无效", nil)
	}
	if command.DisplayName != nil {
		value := strings.TrimSpace(*command.DisplayName)
		if value == "" || len([]rune(value)) > 100 {
			return membermutationport.UpdateResult{},
				apperror.New("invalid_request", "成员显示名无效", nil)
		}
		command.DisplayName = &value
	}
	if command.Role != nil {
		value := strings.TrimSpace(*command.Role)
		if value != "admin" && value != "member" {
			return membermutationport.UpdateResult{},
				apperror.New("invalid_request", "成员角色无效", nil)
		}
		command.Role = &value
	}
	result, err := service.repository.Update(
		ctx,
		membermutationport.UpdateCommand{
			AccountID: command.AccountID, ServerID: command.ServerID,
			MemberID:         command.MemberID,
			ExpectedRevision: command.ExpectedRevision,
			IdempotencyKey:   strings.TrimSpace(command.IdempotencyKey),
			RequestHash:      updateHash(command),
			DisplayName:      command.DisplayName, Role: command.Role,
			UpdatedAt: service.clock.Now().UTC(),
		},
	)
	if err != nil {
		return membermutationport.UpdateResult{}, mapError(err)
	}
	return result, nil
}

func (service *Service) Remove(
	ctx context.Context,
	command RemoveCommand,
) (membermutationport.RemoveResult, error) {
	if !validID(command.AccountID) || !validID(command.ServerID) ||
		!validID(command.MemberID) ||
		strings.TrimSpace(command.IdempotencyKey) == "" {
		return membermutationport.RemoveResult{},
			apperror.New("invalid_request", "成员移除参数无效", nil)
	}
	operationID, err := service.ids.New()
	if err != nil {
		return membermutationport.RemoveResult{},
			apperror.New("internal_error", "暂时无法移除成员", err)
	}
	result, err := service.repository.Remove(
		ctx,
		membermutationport.RemoveCommand{
			AccountID: command.AccountID, ServerID: command.ServerID,
			MemberID: command.MemberID, OperationID: operationID,
			IdempotencyKey: strings.TrimSpace(command.IdempotencyKey),
			RequestHash:    sha256.Sum256([]byte(command.MemberID)),
			RemovedAt:      service.clock.Now().UTC(),
		},
	)
	if err != nil {
		return membermutationport.RemoveResult{}, mapError(err)
	}
	return result, nil
}

func updateHash(command UpdateCommand) [32]byte {
	value := strconv.FormatInt(command.ExpectedRevision, 10)
	if command.DisplayName != nil {
		value += "\x00name\x00" + *command.DisplayName
	}
	if command.Role != nil {
		value += "\x00role\x00" + *command.Role
	}
	return sha256.Sum256([]byte(value))
}

func validID(value string) bool {
	parsed, err := uuid.Parse(value)
	return err == nil && parsed != uuid.Nil && parsed.Version() == 7
}

func mapError(err error) error {
	switch {
	case errors.Is(err, membermutationport.ErrMemberNotFound):
		return apperror.New("member_not_found", "成员不存在", err)
	case errors.Is(err, membermutationport.ErrPermissionDenied):
		return apperror.New("permission_denied", "没有管理成员的权限", err)
	case errors.Is(err, membermutationport.ErrOwnerImmutable):
		return apperror.New(
			"owner_immutable",
			"Owner 不能通过成员接口变更",
			err,
		)
	case errors.Is(err, membermutationport.ErrRevisionConflict):
		return apperror.New("revision_conflict", "成员版本已变化", err)
	case errors.Is(err, membermutationport.ErrIdempotencyConflict):
		return apperror.New(
			"idempotency_conflict",
			"幂等键与原请求不一致",
			err,
		)
	default:
		return apperror.New("internal_error", "成员变更失败", err)
	}
}
