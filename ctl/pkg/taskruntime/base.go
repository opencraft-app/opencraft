// Package taskruntime ...
package taskruntime

import (
	"fmt"
	"os"
	"time"

	logfields "ctl/pkg/log"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
	"go.uber.org/zap"
	"gorm.io/gorm"

	"ctl/pkg/taskflow"
	"ctl/pkg/tracing"

	daoFactory "ctl/pkg/model/factory"

	"ctl/pkg/context"
	"ctl/pkg/logic/factory"
	"ctl/pkg/logic/lock"
	"ctl/pkg/metric"
	"ctl/pkg/model/task"
	"ctl/pkg/tasks"
)

const (
	StepKeyLockTask            = "LockTask"
	StepKeyLockTaskWithAppid   = "LockTaskWithAppid"
	StepKeyCheckTask           = "CheckTask"
	StepKeyUpdateTaskExecute   = "UpdateTaskExecute"
	StepKeyUnLockTaskWithAppid = "UnlockTaskWithAppid"
	StepKeyUnlockTask          = "UnlockTask"
)

const timeGeneralLayout = "2006-01-02 15:04:05"

// ServiceTask ...
type ServiceTask interface {
	tasks.Task

	SetTaskId(taskId string)
}

// BaseTask ...
type BaseTask struct {
	*tasks.BaseTask

	TaskId string

	LockLogic       lock.Logic
	TaskLockSeconds int64

	TaskEntity *task.Entity

	ExceedMaxExecuteCountFunc taskflow.StepFunc[context.Context]
}

// NewBaseTask ...
func NewBaseTask() *BaseTask {
	t := &BaseTask{
		BaseTask:   tasks.NewBaseTask(),
		TaskEntity: new(task.Entity),
	}

	t.LockLogic = factory.DefaultLogicFactory.LockLogic()

	return t
}

// SetTaskId ...
func (t *BaseTask) SetTaskId(taskId string) {
	t.TaskId = taskId
}

func (t *BaseTask) exceedMaxExecuteCount(ctx context.Context) (string, error) {
	daoFactory.DefaultDaoFactory.TaskDao(ctx).UpdateByKeyColumn(map[string]interface{}{
		task.ColumnTaskState:   task.StateFailed,
		task.ColumnTaskMessage: "ExecuteCount greater than or equal to MaxExecuteCount",
	}, t.TaskId)

	return "", fmt.Errorf("ExecuteCount greater than or equal to MaxExecuteCount, taskId %s", t.TaskId)
}

// LockTask ...
func (t *BaseTask) LockTask(ctx context.Context) (string, error) {
	success, err := t.LockLogic.LockTask(ctx, t.TaskId, t.TaskLockSeconds)
	if err != nil {
		ctx.Logger().Error("LockLogic.LockTask error", zap.Error(err))
	}
	if !success {
		ctx.Logger().Warn("task lock not acquired",
			zap.String(logfields.FieldTaskID, t.TaskId),
			zap.String(logfields.FieldTaskName, t.TaskEntity.TaskName),
			zap.Int64("task_lock_seconds", t.TaskLockSeconds),
			zap.String("pod_name", currentPodName()),
		)
		return "", fmt.Errorf("LockLogic.LockTask failed")
	}
	ctx.Logger().Info("task lock acquired",
		zap.String(logfields.FieldTaskID, t.TaskId),
		zap.String(logfields.FieldTaskName, t.TaskEntity.TaskName),
		zap.Int64("task_lock_seconds", t.TaskLockSeconds),
		zap.String("pod_name", currentPodName()),
	)

	return taskflow.StepCodeSuccess, nil
}

// CheckTask ...
func (t *BaseTask) CheckTask(ctx context.Context) (string, error) {
	err := daoFactory.DefaultDaoFactory.TaskDao(ctx).SelectByKeyColumn(t.TaskId, t.TaskEntity)
	if err != nil {
		return "", fmt.Errorf("TaskDao.SelectByKeyColumn error: %w", err)
	}

	if task.TaskCompleted(t.TaskEntity.TaskState) {
		return "", fmt.Errorf("task has been completed")
	}

	if t.TaskEntity.ExecuteCount >= t.TaskEntity.MaxExecuteCount {
		ctx.Logger().Warn("ExecuteCount greater than or equal to MaxExecuteCount")
		// 在 Span 上记录事件，便于链路追踪定位
		span := trace.SpanFromContext(ctx)
		span.AddEvent("task_exceeded_max_execute_count", trace.WithAttributes(
			attribute.Int("execute_count", t.TaskEntity.ExecuteCount),
			attribute.Int("max_execute_count", t.TaskEntity.MaxExecuteCount),
		))
		if t.ExceedMaxExecuteCountFunc != nil {
			return t.ExceedMaxExecuteCountFunc(ctx)
		}
		return t.exceedMaxExecuteCount(ctx)
	}

	return taskflow.StepCodeSuccess, nil
}

// UpdateTaskExecute ...
func (t *BaseTask) UpdateTaskExecute(ctx context.Context) (string, error) {
	now := time.Now().UTC()
	prevExecuteCount := t.TaskEntity.ExecuteCount
	result := daoFactory.DefaultDaoFactory.TaskDao(ctx).DB().
		Where("task_id = ?", t.TaskId).
		Where("task_state IN ?", task.UnCompletedTaskStates()).
		Updates(map[string]interface{}{
			task.ColumnExecuteCount:    gorm.Expr("execute_count + ?", 1),
			task.ColumnLastExecuteTime: now.Format(timeGeneralLayout),
			task.ColumnTaskState:       task.StateRunning,
		})
	if result.Error != nil {
		return "", fmt.Errorf("TaskDao.UpdateTaskExecute error: %w", result.Error)
	}
	if result.RowsAffected != 1 {
		return "", fmt.Errorf("TaskDao.UpdateTaskExecute rejected: task %s is missing or terminal", t.TaskId)
	}

	t.TaskEntity.ExecuteCount++
	t.TaskEntity.TaskState = task.StateRunning
	t.TaskEntity.LastExecuteTime = now
	ctx.Logger().Info("task execute counter advanced",
		zap.String(logfields.FieldTaskID, t.TaskId),
		zap.String(logfields.FieldTaskName, t.TaskEntity.TaskName),
		zap.Int("prev_execute_count", prevExecuteCount),
		zap.Int("next_execute_count", t.TaskEntity.ExecuteCount),
		zap.String(logfields.FieldTaskState, t.TaskEntity.TaskState),
		zap.Time("last_execute_time", t.TaskEntity.LastExecuteTime),
		zap.String("pod_name", currentPodName()),
	)

	return taskflow.StepCodeSuccess, nil
}

// UnlockTask ...
func (t *BaseTask) UnlockTask(ctx context.Context) (string, error) {
	defer t.setTelemetry(ctx)

	deled, err := t.LockLogic.UnlockTask(ctx, t.TaskId)
	if err != nil {
		ctx.Logger().Error("LockLogic.UnlockTask error", zap.Error(err))
	}
	if !deled {
		ctx.Logger().Warn("LockLogic.UnlockTask not del")
	}

	return taskflow.StepCodeSuccess, nil
}

func currentPodName() string {
	if name := os.Getenv("POD_NAME"); name != "" {
		return name
	}
	if name, err := os.Hostname(); err == nil && name != "" {
		return name
	}
	return "unknown"
}

func (t *BaseTask) setTelemetry(ctx context.Context) {
	err := daoFactory.DefaultDaoFactory.TaskDao(ctx).SelectByKeyColumn(t.TaskId, t.TaskEntity)
	if err != nil {
		ctx.Logger().Error("setTelemetry error: TaskDao.SelectByKeyColumn error", zap.Error(err))
		return
	}

	_, span := tracing.StartTrace(ctx, fmt.Sprintf("Run task %s end", t.TaskEntity.TaskName))
	span.SetAttributes(attribute.String(tracing.SpanAttributeKeyTaskName, t.TaskEntity.TaskName),
		attribute.String(tracing.SpanAttributeKeyTaskState, t.TaskEntity.TaskState))
	defer func() { span.EndWithError(nil) }()

	if !task.TaskCompleted(t.TaskEntity.TaskState) {
		return
	}

	fields := []zap.Field{
		zap.String(logfields.FieldTaskID, t.TaskId),
		zap.String(logfields.FieldTaskName, t.TaskEntity.TaskName),
		zap.String(logfields.FieldTaskState, t.TaskEntity.TaskState),
	}
	if t.TaskEntity.TaskState != task.StateSuccess && t.TaskEntity.TaskMessage != "" {
		fields = append(fields, zap.String(logfields.FieldError, t.TaskEntity.TaskMessage))
	}
	if t.TaskEntity.TaskState == task.StateSuccess {
		ctx.Logger().Info("task terminal state", fields...)
	} else {
		ctx.Logger().Error("task terminal state", fields...)
	}

	cost := time.Since(*t.TaskEntity.CreatedTime) / time.Second
	metric.TaskDurationHistogramVec.WithLabelValues(t.TaskEntity.TaskName).Observe(float64(cost))

	if t.TaskEntity.TaskState != task.StateSuccess {
		metric.TaskFailedTotalCounterVec.WithLabelValues(t.TaskEntity.TaskName).Inc()
	} else {
		metric.TaskSuccessTotalCounterVec.WithLabelValues(t.TaskEntity.TaskName).Inc()
	}
}

// LockTaskWithUserID locks the same user's same task type.
func (t *BaseTask) LockTaskWithUserID(ctx context.Context) (string, error) {
	success, err := t.LockLogic.LockTaskWithUserID(ctx, ctx.GetUserID(), t.TaskEntity.TaskName, t.TaskLockSeconds)
	if err != nil {
		ctx.Logger().Error("LockLogic.LockTaskWithUserID error", zap.Error(err))
	}
	if !success {
		return "", fmt.Errorf("LockLogic.LockTaskWithUserID failed")
	}
	return taskflow.StepCodeSuccess, nil
}

// UnlockTaskWithUserID unlocks the same user's same task type.
func (t *BaseTask) UnlockTaskWithUserID(ctx context.Context) (string, error) {
	defer t.setTelemetry(ctx)

	success, err := t.LockLogic.UnlockTaskWithUserID(ctx, ctx.GetUserID(), t.TaskEntity.TaskName)
	if err != nil {
		ctx.Logger().Error("LockLogic.UnlockTaskWithUserID error", zap.Error(err))
	}
	if !success {
		ctx.Logger().Warn("LockLogic.UnlockTaskWithUserID failed")
	}
	return taskflow.StepCodeSuccess, nil
}
