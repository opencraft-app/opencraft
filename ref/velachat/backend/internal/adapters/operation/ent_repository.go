// Package operation 提供 Human Operation 查询的 Ent Repository。
package operation

import (
	"context"
	"errors"

	"chatserver/internal/database"
	"chatserver/internal/ent"
	"chatserver/internal/ent/accountservermembership"
	"chatserver/internal/ent/tencentoperation"
	operationport "chatserver/internal/ports/operation"
)

type EntRepository struct{ handle *database.Handle }

func NewEntRepository(handle *database.Handle) (*EntRepository, error) {
	if handle == nil || handle.Client() == nil {
		return nil, errors.New("Operation Repository 缺少数据库 Handle")
	}
	return &EntRepository{handle: handle}, nil
}

func (repository *EntRepository) Get(
	ctx context.Context,
	accountID string,
	serverID string,
	operationID string,
) (operationport.Operation, error) {
	exists, err := repository.handle.Client().
		AccountServerMembership.Query().
		Where(
			accountservermembership.AccountIDEQ(accountID),
			accountservermembership.ServerIDEQ(serverID),
			accountservermembership.StatusEQ("active"),
		).
		Exist(ctx)
	if err != nil {
		return operationport.Operation{}, err
	}
	if !exists {
		return operationport.Operation{}, operationport.ErrServerNotFound
	}
	entity, err := repository.handle.Client().TencentOperation.Query().
		Where(
			tencentoperation.IDEQ(operationID),
			tencentoperation.PartitionKeyEQ(serverID),
			tencentoperation.ServerIDEQ(serverID),
		).
		Only(ctx)
	if ent.IsNotFound(err) {
		return operationport.Operation{}, operationport.ErrOperationNotFound
	}
	if err != nil {
		return operationport.Operation{}, err
	}
	server := ""
	if entity.ServerID != nil {
		server = *entity.ServerID
	}
	code := ""
	if entity.LastErrorCode != nil {
		code = *entity.LastErrorCode
	}
	return operationport.Operation{
		ID: entity.ID, ServerID: server,
		Service: entity.Service, Kind: entity.Kind, State: entity.State,
		CreatedAt: entity.CreatedAt, CompletedAt: entity.CompletedAt,
		LastErrorCode: code,
	}, nil
}

var _ operationport.Repository = (*EntRepository)(nil)
