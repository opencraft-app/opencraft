package lock

import (
	"testing"
	"time"

	"ctl/pkg/logic/factory"
	"ctl/test"
)

func init() {
	test.InitTestResource()
}

func TestLockTask(t *testing.T) {
	taskId := "task-abcd1234"
	var expireSeconds int64 = 3
	ctx := test.Context()
	l := factory.DefaultLogicFactory.LockLogic()

	success, err := l.LockTask(ctx, taskId, expireSeconds)
	t.Log("first lock", success, err)

	success, err = l.LockTask(ctx, taskId, expireSeconds)
	t.Log("second lock", success, err)

	deled, err := l.UnlockTask(ctx, taskId)
	t.Log("after unlock", deled, err)

	success, err = l.LockTask(ctx, taskId, expireSeconds)
	t.Log("lock after unlock", success, err)

	time.Sleep(time.Second * 4)

	success, err = l.LockTask(ctx, taskId, 0)
	t.Log("lock forever", success, err)

	_, _ = l.UnlockTask(ctx, taskId)
}

func TestLockBypass(t *testing.T) {
	name := "bypass-demo"
	var expireSeconds int64 = 3
	ctx := test.Context()
	l := factory.DefaultLogicFactory.LockLogic()

	success, err := l.LockBypass(ctx, name, expireSeconds)
	t.Log("first lock", success, err)

	success, err = l.LockBypass(ctx, name, expireSeconds)
	t.Log("second lock", success, err)

	_, _ = l.UnlockBypass(ctx, name)
	success, err = l.LockBypass(ctx, name, expireSeconds)
	t.Log("lock after unlock", success, err)

	time.Sleep(time.Second * 4)

	success, err = l.LockBypass(ctx, name, 0)
	t.Log("lock forever", success, err)

	_, _ = l.UnlockBypass(ctx, name)
}
