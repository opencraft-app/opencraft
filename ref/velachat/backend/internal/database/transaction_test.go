package database

import (
	"context"
	"errors"
	"path/filepath"
	"testing"

	"chatserver/internal/apperror"
	"chatserver/internal/config"
	"chatserver/internal/database/migration"
	"chatserver/internal/ent"
)

func TestTransaction成功提交(t *testing.T) {
	handle := openTransactionTestHandle(t)

	err := handle.WithTx(context.Background(), func(ctx context.Context, tx *ent.Tx) error {
		return createTransactionTestAccount(ctx, tx, "commit@example.com")
	})
	if err != nil {
		t.Fatalf("WithTx() error = %v", err)
	}
	if got := transactionTestAccountCount(t, handle); got != 1 {
		t.Fatalf("提交后账号数 = %d，期望 1", got)
	}
}

func TestTransaction业务错误触发回滚(t *testing.T) {
	handle := openTransactionTestHandle(t)
	businessErr := errors.New("business rejected")

	err := handle.WithTx(context.Background(), func(ctx context.Context, tx *ent.Tx) error {
		if err := createTransactionTestAccount(ctx, tx, "rollback@example.com"); err != nil {
			return err
		}
		return businessErr
	})
	if code := apperror.CodeOf(err); code != "TRANSACTION_CALLBACK_FAILED" {
		t.Fatalf("错误码 = %q，期望 TRANSACTION_CALLBACK_FAILED；err=%v", code, err)
	}
	if !errors.Is(err, businessErr) {
		t.Fatalf("事务错误没有保留业务 cause：%v", err)
	}
	if got := transactionTestAccountCount(t, handle); got != 0 {
		t.Fatalf("回滚后账号数 = %d，期望 0", got)
	}
}

func TestTransactionPanic回滚并继续抛出(t *testing.T) {
	handle := openTransactionTestHandle(t)
	const panicValue = "transaction panic"

	func() {
		defer func() {
			if recovered := recover(); recovered != panicValue {
				t.Fatalf("recover = %#v，期望 %q", recovered, panicValue)
			}
		}()
		_ = handle.WithTx(context.Background(), func(ctx context.Context, tx *ent.Tx) error {
			if err := createTransactionTestAccount(ctx, tx, "panic@example.com"); err != nil {
				return err
			}
			panic(panicValue)
		})
	}()

	if got := transactionTestAccountCount(t, handle); got != 0 {
		t.Fatalf("panic 回滚后账号数 = %d，期望 0", got)
	}
}

func TestTransactionContext取消触发回滚(t *testing.T) {
	handle := openTransactionTestHandle(t)
	ctx, cancel := context.WithCancel(context.Background())

	err := handle.WithTx(ctx, func(txCtx context.Context, tx *ent.Tx) error {
		if err := createTransactionTestAccount(txCtx, tx, "cancel@example.com"); err != nil {
			return err
		}
		cancel()
		return nil
	})
	if code := apperror.CodeOf(err); code != "TRANSACTION_CANCELED" {
		t.Fatalf("错误码 = %q，期望 TRANSACTION_CANCELED；err=%v", code, err)
	}
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("取消错误没有保留 context cause：%v", err)
	}
	if got := transactionTestAccountCount(t, handle); got != 0 {
		t.Fatalf("取消回滚后账号数 = %d，期望 0", got)
	}
}

func TestTransaction拒绝嵌套(t *testing.T) {
	handle := openTransactionTestHandle(t)

	err := handle.WithTx(context.Background(), func(ctx context.Context, _ *ent.Tx) error {
		return handle.WithTx(ctx, func(context.Context, *ent.Tx) error {
			t.Fatal("嵌套事务 callback 不应执行")
			return nil
		})
	})
	if code := apperror.CodeOf(err); code != "TRANSACTION_NESTED" {
		t.Fatalf("错误码 = %q，期望 TRANSACTION_NESTED；err=%v", code, err)
	}
}

func TestTransaction提交错误有稳定优先级(t *testing.T) {
	handle := openTransactionTestHandle(t)
	commitErr := errors.New("commit hook failed")

	err := handle.WithTx(context.Background(), func(ctx context.Context, tx *ent.Tx) error {
		tx.OnCommit(func(next ent.Committer) ent.Committer {
			return ent.CommitFunc(func(ctx context.Context, tx *ent.Tx) error {
				if err := next.Commit(ctx, tx); err != nil {
					return err
				}
				return commitErr
			})
		})
		return createTransactionTestAccount(ctx, tx, "commit-error@example.com")
	})
	if code := apperror.CodeOf(err); code != "TRANSACTION_COMMIT_FAILED" {
		t.Fatalf("错误码 = %q，期望 TRANSACTION_COMMIT_FAILED；err=%v", code, err)
	}
	if !errors.Is(err, commitErr) {
		t.Fatalf("提交错误没有保留 cause：%v", err)
	}
	if got := transactionTestAccountCount(t, handle); got != 1 {
		t.Fatalf("提交已完成但 hook 报错后的账号数 = %d，期望 1", got)
	}
}

func TestTransaction回滚错误不覆盖业务错误(t *testing.T) {
	handle := openTransactionTestHandle(t)
	businessCause := errors.New("business cause")
	businessErr := apperror.New("BUSINESS_REJECTED", "业务拒绝", businessCause)
	rollbackErr := errors.New("rollback hook failed")

	err := handle.WithTx(context.Background(), func(_ context.Context, tx *ent.Tx) error {
		tx.OnRollback(func(next ent.Rollbacker) ent.Rollbacker {
			return ent.RollbackFunc(func(ctx context.Context, tx *ent.Tx) error {
				if err := next.Rollback(ctx, tx); err != nil {
					return err
				}
				return rollbackErr
			})
		})
		return businessErr
	})
	if code := apperror.CodeOf(err); code != "BUSINESS_REJECTED" {
		t.Fatalf("错误码 = %q，期望 BUSINESS_REJECTED；err=%v", code, err)
	}
	if !errors.Is(err, businessCause) || !errors.Is(err, rollbackErr) {
		t.Fatalf("组合错误没有同时保留业务与回滚 cause：%v", err)
	}
}

func openTransactionTestHandle(t *testing.T) *Handle {
	t.Helper()
	cfg, err := config.NewDatabase(filepath.Join(t.TempDir(), "data", "chatserver.db"))
	if err != nil {
		t.Fatal(err)
	}
	handle, err := OpenWriter(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := handle.Close(); err != nil {
			t.Errorf("关闭数据库：%v", err)
		}
	})
	if err := migration.Apply(context.Background(), handle.SQLDB()); err != nil {
		t.Fatalf("应用 migration：%v", err)
	}
	return handle
}

func createTransactionTestAccount(ctx context.Context, tx *ent.Tx, email string) error {
	return tx.Account.Create().
		SetEmail(email).
		SetEmailNormalized(email).
		SetDisplayName("事务测试").
		SetPasswordHash("not-a-real-password-hash").
		SetTokenVersion(1).
		SetImUserID("test-im-user").
		SetImState("ready").
		SetRevision(1).
		Exec(ctx)
}

func transactionTestAccountCount(t *testing.T, handle *Handle) int {
	t.Helper()
	count, err := handle.Client().Account.Query().Count(context.Background())
	if err != nil {
		t.Fatalf("查询账号数量：%v", err)
	}
	return count
}
