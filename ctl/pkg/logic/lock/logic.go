// Package lock ...
package lock

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"

	pcontext "ctl/pkg/context"
	"ctl/pkg/resource"
)

// Logic ...
type Logic interface {
	LockTask(ctx pcontext.Context, taskId string, expireSeconds int64) (bool, error)
	UnlockTask(ctx pcontext.Context, taskId string) (bool, error)
	IsTaskLocked(ctx pcontext.Context, taskId string) (bool, error)

	LockBypass(ctx pcontext.Context, name string, expireSeconds int64) (bool, error)
	UnlockBypass(ctx pcontext.Context, name string) (bool, error)

	LockTaskWithUserID(ctx pcontext.Context, userID, task string, expireSeconds int64) (bool, error)
	UnlockTaskWithUserID(ctx pcontext.Context, userID, task string) (bool, error)
}

type logic struct {
}

// NewLogic ...
func NewLogic() Logic {
	return &logic{}
}

const defaultLockExpireSeconds int64 = 300

func (l *logic) lock(ctx pcontext.Context, key string, expireSeconds int64) (bool, error) {
	if expireSeconds <= 0 {
		return false, fmt.Errorf("expireSeconds must be positive, got %d", expireSeconds)
	}

	client := l.client()
	bgCtx := context.Background()

	ok, err := client.SetNX(bgCtx, key, ctx.GetRequestId(), time.Duration(expireSeconds)*time.Second).Result()
	if err != nil {
		return false, fmt.Errorf("client.SetNX error: %w", err)
	}

	return ok, nil
}

var unlockScript = redis.NewScript(`
if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
else
    return 0
end
`)

func (l *logic) unlock(ctx pcontext.Context, key string) (bool, error) {
	client := l.client()
	bgCtx := context.Background()

	result, err := unlockScript.Run(bgCtx, client, []string{key}, ctx.GetRequestId()).Int()
	if err != nil {
		return false, fmt.Errorf("unlockScript.Run error: %w", err)
	}

	return result > 0, nil
}

func (l *logic) client() *redis.Client {
	return resource.RedisMainClient
}

func (l *logic) lockTaskKey(taskId string) string {
	return fmt.Sprintf("lock-task-%s", taskId)
}

// LockTask ...
func (l *logic) LockTask(ctx pcontext.Context, taskId string, expireSeconds int64) (bool, error) {
	success, err := l.lock(ctx, l.lockTaskKey(taskId), expireSeconds)
	if err != nil {
		return false, fmt.Errorf("lock error: %w", err)
	}

	return success, nil
}

// UnlockTask ...
func (l *logic) UnlockTask(ctx pcontext.Context, taskId string) (bool, error) {
	deled, err := l.unlock(ctx, l.lockTaskKey(taskId))
	if err != nil {
		return false, fmt.Errorf("unlock error: %w", err)
	}

	return deled, nil
}

// IsTaskLocked 检查指定 taskId 的锁是否存在（Redis EXISTS）。
// 用于 bypass 判定达到 max_execute_count 的任务是否仍有执行在跑。
func (l *logic) IsTaskLocked(_ pcontext.Context, taskId string) (bool, error) {
	client := l.client()
	bgCtx := context.Background()

	result, err := client.Exists(bgCtx, l.lockTaskKey(taskId)).Result()
	if err != nil {
		return false, fmt.Errorf("client.Exists error: %w", err)
	}

	return result > 0, nil
}

func (l *logic) lockBypassKey(name string) string {
	return fmt.Sprintf("lock-bypass-%s", name)
}

// LockBypass ...
func (l *logic) LockBypass(ctx pcontext.Context, name string, expireSeconds int64) (bool, error) {
	success, err := l.lock(ctx, l.lockBypassKey(name), expireSeconds)
	if err != nil {
		return false, fmt.Errorf("lock error: %w", err)
	}

	return success, nil
}

// UnlockBypass ...
func (l *logic) UnlockBypass(ctx pcontext.Context, name string) (bool, error) {
	deled, err := l.unlock(ctx, l.lockBypassKey(name))
	if err != nil {
		return false, fmt.Errorf("unlock error: %w", err)
	}

	return deled, nil
}

func (l *logic) getTaskWithUserIDKey(userID, task string) string {
	return fmt.Sprintf("user:%s-task:%s", userID, task)
}

func (l *logic) LockTaskWithUserID(ctx pcontext.Context, userID, task string, expireSeconds int64) (bool, error) {
	success, err := l.lock(ctx, l.lockTaskKey(l.getTaskWithUserIDKey(userID, task)), expireSeconds)
	if err != nil {
		return false, fmt.Errorf("LockTaskWithUserID error: %w", err)
	}
	return success, nil
}

func (l *logic) UnlockTaskWithUserID(ctx pcontext.Context, userID, task string) (bool, error) {
	success, err := l.unlock(ctx, l.lockTaskKey(l.getTaskWithUserIDKey(userID, task)))
	if err != nil {
		return false, fmt.Errorf("UnlockTaskWithUserID error: %w", err)
	}
	return success, nil
}
