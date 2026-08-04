// Package operationquery 实现 Human 可见的腾讯云操作查询。
package operationquery

import (
	"context"
	"errors"

	"chatserver/internal/apperror"
	operationport "chatserver/internal/ports/operation"

	"github.com/google/uuid"
)

type Service struct{ repository operationport.Repository }

func NewService(repository operationport.Repository) (*Service, error) {
	if repository == nil {
		return nil, errors.New("Operation 查询 Repository 不能为空")
	}
	return &Service{repository: repository}, nil
}

func (service *Service) Get(
	ctx context.Context,
	accountID string,
	serverID string,
	operationID string,
) (operationport.Operation, error) {
	if !validUUIDv7(accountID) || !validUUIDv7(serverID) ||
		!validUUIDv7(operationID) {
		return operationport.Operation{},
			apperror.New("invalid_request", "Operation 查询参数无效", nil)
	}
	value, err := service.repository.Get(
		ctx,
		accountID,
		serverID,
		operationID,
	)
	switch {
	case errors.Is(err, operationport.ErrServerNotFound):
		return operationport.Operation{},
			apperror.New("server_not_found", "Server 不存在", err)
	case errors.Is(err, operationport.ErrOperationNotFound):
		return operationport.Operation{},
			apperror.New("operation_not_found", "Operation 不存在", err)
	case err != nil:
		return operationport.Operation{},
			apperror.New("internal_error", "暂时无法查询 Operation", err)
	default:
		return value, nil
	}
}

func validUUIDv7(value string) bool {
	parsed, err := uuid.Parse(value)
	return err == nil && parsed != uuid.Nil && parsed.Version() == 7
}
