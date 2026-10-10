package database

import (
	"context"
	"errors"
	"os"
	"time"

	"chatserver/internal/apperror"

	"github.com/gofrs/flock"
)

type writerLock struct {
	file *flock.Flock
}

func acquireWriterLock(ctx context.Context, path string, timeout time.Duration) (*writerLock, error) {
	lockPath := path + ".writer.lock"
	file := flock.New(lockPath, flock.SetPermissions(0o600))
	lockContext, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	locked, err := file.TryLockContext(lockContext, 10*time.Millisecond)
	if err != nil {
		_ = file.Close()
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
			return nil, apperror.New("DATABASE_IN_USE", "数据库正在被另一个服务进程使用", err)
		}
		return nil, apperror.New("DATABASE_OPEN_FAILED", "无法取得数据库写锁", err)
	}
	if !locked {
		_ = file.Close()
		return nil, apperror.New("DATABASE_IN_USE", "数据库正在被另一个服务进程使用", lockContext.Err())
	}
	if err := os.Chmod(lockPath, 0o600); err != nil {
		_ = file.Unlock()
		_ = file.Close()
		return nil, apperror.New("DATABASE_PERMISSION_UNSAFE", "无法设置数据库锁文件权限", err)
	}
	return &writerLock{file: file}, nil
}

func (l *writerLock) close() error {
	if l == nil || l.file == nil {
		return nil
	}
	unlockErr := l.file.Unlock()
	closeErr := l.file.Close()
	if unlockErr != nil {
		return unlockErr
	}
	return closeErr
}
