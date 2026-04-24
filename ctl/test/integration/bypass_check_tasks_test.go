//go:build integration

package integration

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
	"go.uber.org/zap/zaptest/observer"

	"ctl/pkg/bypass"
	logfields "ctl/pkg/log"
	taskmodel "ctl/pkg/model/task"
	"ctl/pkg/resource"
)

func TestCheckTasks_ResendStaleTask(t *testing.T) {
	client, streamKey := setupTestEnv(t)
	drainStream(t, client, streamKey)

	taskID := fmt.Sprintf("task-stale-%d", time.Now().UnixNano())
	now := time.Now()
	staleTime := now.Add(-2 * time.Minute) // 远超 execute_interval(30s)

	insertTaskEntity(t, &taskmodel.Entity{
		TaskId:          taskID,
		TaskName:        "CreateInstance",
		TaskState:       taskmodel.StateCreated,
		TaskParams:      `{"instance_id":"ins-stale"}`,
		TraceId:         "trace-stale",
		ExecuteInterval: 30,
		ExecuteCount:    1,
		MaxExecuteCount: 20,
		LastExecuteTime: staleTime,
	})

	ctx := newTestContext(t, "bypass-user")
	bypass.RunCheckTasksOnce(ctx)

	// 验证 Redis Stream 新增了一条消息
	count := streamMessageCount(t, client, streamKey)
	assert.Equal(t, int64(1), count)

	msgs := readStreamMessages(t, client, streamKey, 1)
	parsedTaskID := parseStreamMessageTaskID(t, msgs[0])
	assert.Equal(t, taskID, parsedTaskID)
}

func TestCheckTasks_SkipRecentTask(t *testing.T) {
	client, streamKey := setupTestEnv(t)
	drainStream(t, client, streamKey)

	taskID := fmt.Sprintf("task-recent-%d", time.Now().UnixNano())
	now := time.Now()

	insertTaskEntity(t, &taskmodel.Entity{
		TaskId:          taskID,
		TaskName:        "CreateInstance",
		TaskState:       taskmodel.StateCreated,
		TaskParams:      `{"instance_id":"ins-recent"}`,
		TraceId:         "trace-recent",
		ExecuteInterval: 30,
		ExecuteCount:    1,
		MaxExecuteCount: 20,
		LastExecuteTime: now, // 刚刚更新
	})

	ctx := newTestContext(t, "bypass-user")
	bypass.RunCheckTasksOnce(ctx)

	count := streamMessageCount(t, client, streamKey)
	assert.Equal(t, int64(0), count)
}

func TestCheckTasks_SkipCompletedTask(t *testing.T) {
	client, streamKey := setupTestEnv(t)
	drainStream(t, client, streamKey)

	taskID := fmt.Sprintf("task-completed-%d", time.Now().UnixNano())

	insertTaskEntity(t, &taskmodel.Entity{
		TaskId:          taskID,
		TaskName:        "CreateInstance",
		TaskState:       taskmodel.StateSuccess, // 已完成
		TaskParams:      `{"instance_id":"ins-completed"}`,
		TraceId:         "trace-completed",
		ExecuteInterval: 30,
		ExecuteCount:    1,
		MaxExecuteCount: 20,
		LastExecuteTime: time.Now().Add(-5 * time.Minute),
	})

	ctx := newTestContext(t, "bypass-user")
	bypass.RunCheckTasksOnce(ctx)

	count := streamMessageCount(t, client, streamKey)
	assert.Equal(t, int64(0), count)
}

func TestCheckTasks_ExceedMaxCount_LockHeld_Skip(t *testing.T) {
	client, streamKey := setupTestEnv(t)
	drainStream(t, client, streamKey)

	taskID := fmt.Sprintf("task-maxlock-%d", time.Now().UnixNano())
	staleTime := time.Now().Add(-2 * time.Minute)

	insertTaskEntity(t, &taskmodel.Entity{
		TaskId:          taskID,
		TaskName:        "CreateInstance",
		TaskState:       taskmodel.StateRunning,
		TaskParams:      `{"instance_id":"ins-maxlock"}`,
		TraceId:         "trace-maxlock",
		ExecuteInterval: 30,
		ExecuteCount:    20,
		MaxExecuteCount: 20,
		LastExecuteTime: staleTime,
	})

	// 设置 Redis 锁
	lockKey := fmt.Sprintf("lock-task-%s", taskID)
	err := client.Set(context.Background(), lockKey, "held", 5*time.Minute).Err()
	require.NoError(t, err)

	ctx := newTestContext(t, "bypass-user")
	bypass.RunCheckTasksOnce(ctx)

	count := streamMessageCount(t, client, streamKey)
	assert.Equal(t, int64(0), count)
}

func TestCheckTasks_ExceedMaxCount_LockReleased_Resend(t *testing.T) {
	client, streamKey := setupTestEnv(t)
	drainStream(t, client, streamKey)

	taskID := fmt.Sprintf("task-maxnolck-%d", time.Now().UnixNano())
	staleTime := time.Now().Add(-2 * time.Minute)

	insertTaskEntity(t, &taskmodel.Entity{
		TaskId:          taskID,
		TaskName:        "CreateInstance",
		TaskState:       taskmodel.StateRunning,
		TaskParams:      `{"instance_id":"ins-maxnolck"}`,
		TraceId:         "trace-maxnolck",
		ExecuteInterval: 30,
		ExecuteCount:    20,
		MaxExecuteCount: 20,
		LastExecuteTime: staleTime,
	})

	// 不设置锁

	ctx := newTestContext(t, "bypass-user")
	bypass.RunCheckTasksOnce(ctx)

	count := streamMessageCount(t, client, streamKey)
	assert.Equal(t, int64(1), count)

	msgs := readStreamMessages(t, client, streamKey, 1)
	parsedTaskID := parseStreamMessageTaskID(t, msgs[0])
	assert.Equal(t, taskID, parsedTaskID)
}

func TestCheckTasks_SkipOldTask(t *testing.T) {
	client, streamKey := setupTestEnv(t)
	drainStream(t, client, streamKey)

	taskID := fmt.Sprintf("task-old-%d", time.Now().UnixNano())
	oldTime := time.Now().Add(-8 * 24 * time.Hour) // 8 天前
	staleTime := time.Now().Add(-2 * time.Minute)

	// 需要手动设置 created_time 为 8 天前
	entity := &taskmodel.Entity{
		TaskId:          taskID,
		TaskName:        "CreateInstance",
		TaskState:       taskmodel.StateCreated,
		TaskParams:      `{"instance_id":"ins-old"}`,
		TraceId:         "trace-old",
		ExecuteInterval: 30,
		ExecuteCount:    1,
		MaxExecuteCount: 20,
		LastExecuteTime: staleTime,
	}
	err := resource.GormDB.Table(taskmodel.TableName).Create(entity).Error
	require.NoError(t, err)

	// 手动更新 created_time 到 8 天前
	err = resource.GormDB.Table(taskmodel.TableName).
		Where("task_id = ?", taskID).
		Update("created_time", oldTime).Error
	require.NoError(t, err)

	ctx := newTestContext(t, "bypass-user")
	bypass.RunCheckTasksOnce(ctx)

	count := streamMessageCount(t, client, streamKey)
	assert.Equal(t, int64(0), count)
}

func TestCheckTasks_BatchPagination(t *testing.T) {
	client, streamKey := setupTestEnv(t)
	drainStream(t, client, streamKey)

	staleTime := time.Now().Add(-2 * time.Minute)
	totalTasks := 250

	for i := 0; i < totalTasks; i++ {
		taskID := fmt.Sprintf("task-batch-%d-%d", time.Now().UnixNano(), i)
		insertTaskEntity(t, &taskmodel.Entity{
			TaskId:          taskID,
			TaskName:        "CreateInstance",
			TaskState:       taskmodel.StateCreated,
			TaskParams:      fmt.Sprintf(`{"instance_id":"ins-batch-%d"}`, i),
			TraceId:         "trace-batch",
			ExecuteInterval: 30,
			ExecuteCount:    1,
			MaxExecuteCount: 20,
			LastExecuteTime: staleTime,
		})
	}

	ctx := newTestContext(t, "bypass-user")
	bypass.RunCheckTasksOnce(ctx)

	count := streamMessageCount(t, client, streamKey)
	assert.Equal(t, int64(totalTasks), count, "所有 %d 条任务都应被重投", totalTasks)
}

func TestCheckTasks_UsesTaskTraceIDInCompensationLogs(t *testing.T) {
	client, streamKey := setupTestEnv(t)
	drainStream(t, client, streamKey)

	core, observedLogs := observer.New(zap.InfoLevel)
	resource.ZapLogger = zap.New(core)

	taskID := fmt.Sprintf("task-maxlock-log-%d", time.Now().UnixNano())
	staleTime := time.Now().Add(-2 * time.Minute)

	insertTaskEntity(t, &taskmodel.Entity{
		TaskId:          taskID,
		TaskName:        "CreateInstance",
		TaskState:       taskmodel.StateRunning,
		TaskParams:      `{"instance_id":"ins-maxlock-log"}`,
		TraceId:         "trace-maxlock-log",
		ExecuteInterval: 30,
		ExecuteCount:    20,
		MaxExecuteCount: 20,
		LastExecuteTime: staleTime,
	})

	lockKey := fmt.Sprintf("lock-task-%s", taskID)
	err := client.Set(context.Background(), lockKey, "held", 5*time.Minute).Err()
	require.NoError(t, err)

	ctx := newTestContext(t, "bypass-user")
	bypass.RunCheckTasksOnce(ctx)

	entries := observedLogs.FilterMessage("task reached max_execute_count but lock still held, skip resend").All()
	require.Len(t, entries, 1)
	assert.Equal(t, "trace-maxlock-log", entries[0].ContextMap()[logfields.FieldTraceID])
	assert.Equal(t, taskID, entries[0].ContextMap()[logfields.FieldTaskID])
	assert.Equal(t, "checkTasks", entries[0].ContextMap()[logfields.FieldBypassName])
}
