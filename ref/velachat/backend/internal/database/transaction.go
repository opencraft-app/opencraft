package database

import (
	"context"
	"errors"

	"chatserver/internal/apperror"
	"chatserver/internal/ent"
)

type transactionContextKey struct{}

// WithTx 在当前 Writer Handle 上执行一个 Ent 事务。
//
// callback 必须使用收到的 context 和 tx；该 context 同时用于识别并拒绝嵌套事务。
// callback 内只允许数据库操作，不应执行网络、文件或其他不可回滚的副作用。
func (h *Handle) WithTx(
	ctx context.Context,
	callback func(context.Context, *ent.Tx) error,
) (returnErr error) {
	if h == nil || h.client == nil || !h.writer {
		return apperror.New("TRANSACTION_UNAVAILABLE", "当前数据库连接不能执行事务", nil)
	}
	if callback == nil {
		return apperror.New("TRANSACTION_INVALID", "事务回调不能为空", nil)
	}
	if ctx == nil {
		return apperror.New("TRANSACTION_INVALID", "事务上下文不能为空", nil)
	}
	if ctx.Value(transactionContextKey{}) != nil {
		return apperror.New("TRANSACTION_NESTED", "不允许嵌套数据库事务", nil)
	}
	if err := ctx.Err(); err != nil {
		return apperror.New("TRANSACTION_CANCELED", "数据库事务已取消", err)
	}

	tx, err := h.client.Tx(ctx)
	if err != nil {
		return apperror.New("TRANSACTION_BEGIN_FAILED", "无法开始数据库事务", err)
	}
	finished := false
	defer func() {
		if finished {
			return
		}
		if recovered := recover(); recovered != nil {
			_ = tx.Rollback()
			panic(recovered)
		}
	}()

	txContext := context.WithValue(ctx, transactionContextKey{}, struct{}{})
	if err := callback(txContext, tx); err != nil {
		finished = true
		return rollbackWithPrimary(tx, callbackTransactionError(err))
	}
	if err := txContext.Err(); err != nil {
		finished = true
		primary := apperror.New("TRANSACTION_CANCELED", "数据库事务已取消", err)
		return rollbackWithPrimary(tx, primary)
	}
	if err := tx.Commit(); err != nil {
		finished = true
		primary := apperror.New("TRANSACTION_COMMIT_FAILED", "数据库事务提交失败", err)
		return rollbackWithPrimary(tx, primary)
	}
	finished = true
	return nil
}

func callbackTransactionError(err error) error {
	if apperror.CodeOf(err) != "" {
		return err
	}
	return apperror.New("TRANSACTION_CALLBACK_FAILED", "事务中的业务操作失败", err)
}

func rollbackWithPrimary(tx *ent.Tx, primary error) error {
	if err := tx.Rollback(); err != nil {
		rollbackErr := apperror.New("TRANSACTION_ROLLBACK_FAILED", "数据库事务回滚失败", err)
		return errors.Join(primary, rollbackErr)
	}
	return primary
}
