// Package humanaccount 提供当前自然人账号查询的 Ent 实现。
package humanaccount

import (
	"context"
	"errors"

	"chatserver/internal/database"
	"chatserver/internal/ent"
	"chatserver/internal/ent/account"
	humanaccountport "chatserver/internal/ports/humanaccount"
)

// EntRepository 按全局 accountId 点查账号。
type EntRepository struct {
	handle *database.Handle
}

// NewEntRepository 创建 Human 账号 Repository。
func NewEntRepository(handle *database.Handle) (*EntRepository, error) {
	if handle == nil || handle.Client() == nil {
		return nil, errors.New("Human 账号 Repository 缺少数据库 Handle")
	}
	return &EntRepository{handle: handle}, nil
}

// FindByID 返回账号最新事实。
func (repository *EntRepository) FindByID(
	ctx context.Context,
	accountID string,
) (humanaccountport.Account, error) {
	entity, err := repository.handle.Client().Account.Query().
		Where(account.IDEQ(accountID)).
		Only(ctx)
	if ent.IsNotFound(err) {
		return humanaccountport.Account{}, humanaccountport.ErrNotFound
	}
	if err != nil {
		return humanaccountport.Account{}, err
	}
	tokenVersion := uint64(0)
	revision := uint64(0)
	if entity.TokenVersion >= 0 {
		tokenVersion = uint64(entity.TokenVersion)
	}
	if entity.Revision >= 0 {
		revision = uint64(entity.Revision)
	}
	return humanaccountport.Account{
		ID:           entity.ID,
		Email:        entity.Email,
		DisplayName:  entity.DisplayName,
		IMUserID:     entity.ImUserID,
		IMState:      entity.ImState,
		TokenVersion: tokenVersion,
		Revision:     revision,
	}, nil
}

var _ humanaccountport.Repository = (*EntRepository)(nil)
