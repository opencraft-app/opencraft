// 设计稿：.tmp/trade-pass-renew-design.md §3.4 失败回滚链路升级（R-MR-5，2026-05-24 用户拍板）
//
// rollbackRenewPassTask 是续费失败回滚 task，由 renewPassTask.finalizeFailure 在检测到
// RenewInstance 终态失败或最大次数兜底时派发。负责把以下已生效的副作用回滚到续费前的基线：
//  1. 已被 RenewInstance 子 task 改 Paused→Running 的 instance（仅 isolated 续费分支）
//  2. isolated 续费恢复阶段创建的长期 AI 权益
//  3. pass.status / expired_time / isolated_time 已被 FinalizeRenewal 推到 active+newExpired+NULL
//     （或还停在 renewing — finalizeFailure 触发时 pass 通常仍是 renewing，本 task 的 CAS
//     WHERE status='renewing' 同样幂等覆盖）
//
// 回滚 task 不是子 task，是顶层 task；不复用父子 task 模型。
package pass

import (
	"context"
	"errors"
	"fmt"
	"time"

	pctx "ctl/pkg/context"
	instanceasync "ctl/pkg/instance"
	logicpass "ctl/pkg/logic/pass"
	daoFactory "ctl/pkg/model/factory"
	modelinstance "ctl/pkg/model/instance"
	modelpass "ctl/pkg/model/pass"
	taskmodel "ctl/pkg/model/task"
	"ctl/pkg/taskflow"
	"ctl/pkg/taskruntime"
	taskcommon "ctl/pkg/taskruntime/common"

	"go.uber.org/zap"
	"gorm.io/gorm"
)

// rollbackRenewPassTask 实现续费失败回滚的顶层 task。
//
// step config 复用 isolatePassTaskStepConfigMap（五步骨架：LockTask → idempotentCheck /
// CheckTask → UpdateTaskExecute → execute → finalizeFailure / UnlockTask）。
//
// max_execute_count=1<<30（rollbackRenewPassTaskMaxExecuteCount，R-MR-6 修订）：
//   - 与父 RenewPassTask "永不放弃" 的设计对齐；回滚也不能中途放弃，中途退出会让
//     pass.status 永远卡在 'renewing' / instance 永远反转不回 Paused；
//   - finalizeFailure 调 markRetryable（非终态）让 checkTasks bypass 重投；不做 "回滚的回滚"；
//   - 真的 execute_count >= 1<<30（理论永不出现）→ exceedMaxExecuteCount markFailed，
//     由 reconcile worker / 人工介入兜底。
type rollbackRenewPassTask struct {
	*taskruntime.BaseTask
	in             *taskcommon.RollbackRenewPassTaskPayload
	lastExecuteErr error
}

func newRollbackRenewPassTask() *rollbackRenewPassTask {
	task := &rollbackRenewPassTask{
		BaseTask: taskruntime.NewBaseTask(),
	}
	task.TaskLockSeconds = rollbackRenewPassTaskLockSeconds
	task.ExceedMaxExecuteCountFunc = task.exceedMaxExecuteCount
	return task
}

// PrepareRollbackRenewPassTask 由 processor.factory 注册到 pfMap
func PrepareRollbackRenewPassTask(_ pctx.Context, data []byte) (svcTask taskruntime.ServiceTask, in, out interface{}, err error) {
	svcTask = newRollbackRenewPassTask()
	in = new(taskcommon.RollbackRenewPassTaskPayload)
	err = parseMessageData(data, in)
	return
}

func (t *rollbackRenewPassTask) Init(in, _ interface{}) error {
	payload, ok := in.(*taskcommon.RollbackRenewPassTaskPayload)
	if !ok {
		return fmt.Errorf("unexpected rollback renew pass task payload: %T", in)
	}
	t.in = payload
	return nil
}

func (t *rollbackRenewPassTask) Name() string         { return taskcommon.TaskNameRollbackRenewPass }
func (t *rollbackRenewPassTask) FirstStepKey() string { return taskruntime.StepKeyLockTask }

func (t *rollbackRenewPassTask) StepConfigMap() map[string]*taskflow.StepConfig[pctx.Context] {
	stepMap := isolatePassTaskStepConfigMap(t.BaseTask, t.execute, t.onExecuteFailed, t.idempotentCheck)
	stepMap[stepKeyFinalizeFailure].StepFunc = t.finalizeFailure
	return stepMap
}

// execute 是回滚 task 的核心。7 步流程：
//
//	step 1: 等原 RenewInstance 子 task（OriginalParentTaskID 关联的）全部到达终态
//	step 2: 仅当 OriginalIsolatedTime != nil 时（isolated 续费分支）：
//	        为每个状态非 Paused / 非 Deleted/Failed 的 instance 派发 IsolateInstance 子 task
//	step 3: 等 step 2 派发的 IsolateInstance 子 task 全部到达终态
//	step 4: isolated 原态可靠取消长期 AI 权益
//	step 5: 调 pass DAO RollbackRenewal 一次性 CAS 回滚 pass 状态
//	step 6: best-effort 调 trade.CompleteFlow(flowID, "failed", reason) 触发 jifei 退款
//	step 7: markSuccess
func (t *rollbackRenewPassTask) execute(ctx pctx.Context) (string, error) {
	if t.in == nil || t.in.PassID == "" {
		return "", errors.New("execute: missing pass id")
	}
	if t.in.OriginalExpiredTime.IsZero() {
		return "", errors.New("execute: OriginalExpiredTime is zero (rollback baseline missing)")
	}
	if t.in.OriginalParentTaskID == "" {
		return "", errors.New("execute: OriginalParentTaskID is empty (cannot wait child tasks)")
	}

	logger := ctx.Logger().With(
		zap.String("pass_id", t.in.PassID),
		zap.String("user_id", t.in.UserID),
		zap.String("rollback_task_id", t.TaskId),
		zap.String("original_parent_task_id", t.in.OriginalParentTaskID),
		zap.Bool("had_isolated_origin", t.in.OriginalIsolatedTime != nil),
	)

	passDao := daoFactory.DefaultDaoFactory.PassDao(nil)
	taskDao := daoFactory.DefaultDaoFactory.TaskDao(nil)

	// 幂等：若 pass 已经回滚到原态（active 或 isolated），直接 markSuccess。
	passEntity, err := passDao.GetByPassID(t.in.PassID)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			destroyed, historyErr := rollbackPassAlreadyDestroyed(ctx, t.in.PassID)
			if historyErr != nil {
				return "", fmt.Errorf("get history pass: %w", historyErr)
			}
			if destroyed {
				logger.Info("pass already destroyed, rollback no longer required")
				notifyTradeFlowFailed(logger, t.in.TradeFlowID, t.in.FailureReason)
				return t.markSuccess(ctx)
			}
		}
		return "", fmt.Errorf("get pass: %w", err)
	}
	targetStatus := t.targetStatus()
	if passEntity.Status == targetStatus {
		logger.Info("pass already at rollback target status, short-circuit",
			zap.String("status", passEntity.Status),
		)
		if t.in.OriginalIsolatedTime != nil {
			if err := logicpass.CancelAiGatewayEntitlement(logger, passEntity.UserID); err != nil {
				return "", fmt.Errorf("repair isolated rollback entitlement: %w", err)
			}
		}
		// 仍 best-effort 调 trade callback（上一轮可能没成功）
		notifyTradeFlowFailed(logger, t.in.TradeFlowID, t.in.FailureReason)
		return t.markSuccess(ctx)
	}
	if passEntity.Status != modelpass.StatusRenewing {
		// pass 不在 renewing 也不在 target，状态被外部干预（不太可能，防御性返错）
		return "", fmt.Errorf("pass status unexpected: %s (expect renewing or %s)", passEntity.Status, targetStatus)
	}

	// step 1: 等原 RenewInstance 子 task 全部到达终态
	originalChildren, err := taskDao.ListByParentTaskID(t.in.OriginalParentTaskID)
	if err != nil {
		return "", fmt.Errorf("list original children: %w", err)
	}
	pendingOriginal := 0
	for _, ct := range originalChildren {
		if ct.TaskName != taskcommon.TaskNameRenewInstance {
			continue
		}
		if !taskmodel.TaskCompleted(ct.TaskState) {
			pendingOriginal++
		}
	}
	if pendingOriginal > 0 {
		logger.Info("waiting for original RenewInstance children terminal",
			zap.Int("pending_count", pendingOriginal),
		)
		return "", fmt.Errorf("waiting for %d original child task(s)", pendingOriginal)
	}

	// step 2 + 3: 仅 isolated 续费分支需要派 IsolateInstance 子 task 把 Running 改回 Paused。
	// active 续费分支跳过（实例本来就是 Running，子 task 没做实际状态变更，无副作用要回滚）。
	if t.in.OriginalIsolatedTime != nil {
		if stepCode, err := t.dispatchAndWaitIsolateChildren(ctx, logger); err != nil {
			return stepCode, err
		}
	} else {
		logger.Info("active renew rollback path: skip IsolateInstance dispatch")
	}

	// isolated 续费失败时，先撤销恢复阶段创建的长期权益，再把 pass 回滚为 isolated。
	// 取消失败时保持 renewing，等待任务重试，避免本地已隔离但网关仍可调用。
	if t.in.OriginalIsolatedTime != nil {
		userID := t.in.UserID
		if userID == "" {
			userID = passEntity.UserID
		}
		if err := logicpass.CancelAiGatewayEntitlement(logger, userID); err != nil {
			return "", fmt.Errorf("cancel ai-gateway entitlement during rollback: %w", err)
		}
	}

	// step 4: pass DAO RollbackRenewal 一次性 CAS。
	updated, err := passDao.RollbackRenewal(t.in.PassID, targetStatus, t.in.OriginalExpiredTime, t.in.OriginalIsolatedTime)
	if err != nil {
		return "", fmt.Errorf("RollbackRenewal: %w", err)
	}
	if !updated {
		// CAS 失败：可能并发已被推到 target，记 Warn 后兜底为成功
		// （与 renewPassTask.execute FinalizeRenewal CAS 失败同范式）。
		logger.Warn("RollbackRenewal affected 0 rows, treat as success (already terminal)")
	}
	logger.Info("rollback renewal applied",
		zap.String("target_status", targetStatus),
		zap.Time("rolled_back_to_expired_time", t.in.OriginalExpiredTime),
	)

	// step 6: best-effort 调 trade.CompleteFlow(failed) 触发 jifei 退款。
	notifyTradeFlowFailed(logger, t.in.TradeFlowID, t.in.FailureReason)

	// step 7: markSuccess
	return t.markSuccess(ctx)
}

// dispatchAndWaitIsolateChildren 是 step 2 + step 3 的实现：
//   - 反查本回滚 task 名下已派发的 IsolateInstance 子 task（child_registry 防重复派发）
//   - 列举 user 的所有 instance；对状态非 Paused / 非 Deleted/Failed 的派发 IsolateInstance
//   - 重新反查子 task，若有未到达终态的则 return err 让框架重试整轮
//
// 注意：本回滚 task 自己作为 IsolateInstance 子 task 的 parent_task_id；不复用
// OriginalParentTaskID（避免与原 RenewInstance 子 task 混淆 child_registry）。
func (t *rollbackRenewPassTask) dispatchAndWaitIsolateChildren(ctx pctx.Context, logger *zap.Logger) (string, error) {
	taskDao := daoFactory.DefaultDaoFactory.TaskDao(nil)
	instanceDao := daoFactory.DefaultDaoFactory.InstanceDao(nil)

	// 反查已派发的 IsolateInstance 子 task
	childTasks, err := taskDao.ListByParentTaskID(t.TaskId)
	if err != nil {
		return "", fmt.Errorf("list rollback children: %w", err)
	}
	// 反查已派发的 IsolateInstance 子 task。
	//
	// I-MR-1 修复（Bug A）：FAILED 终态的子 task 不计入 dispatched，
	// 让下面的 enqueue 阶段把它当成"未派发"重新派一个新子 task。
	// 与父 IsolatePass.execute 同范式自愈。
	dispatched := make(map[string]*taskmodel.Entity, len(childTasks))
	for _, ct := range childTasks {
		if ct.TaskName != taskcommon.TaskNameIsolateInstance {
			continue
		}
		if ct.TaskState == taskmodel.StateFailed {
			// 终态失败子 task：跳过登记，重派新子（I-MR-1 自愈）
			continue
		}
		var p taskcommon.IsolateInstanceTaskPayload
		if err := jsonUnmarshal(ct.TaskParams, &p); err != nil {
			logger.Warn("decode rollback child task payload failed, skip",
				zap.Error(err), zap.String("child_task_id", ct.TaskId))
			continue
		}
		if p.InstanceID != "" {
			dispatched[p.InstanceID] = ct
		}
	}

	// 列出 user 下所有非 Deleted/Failed 的 instance
	userID := t.in.UserID
	if userID == "" {
		// 兜底：从 pass 反查 user
		passEntity, err := daoFactory.DefaultDaoFactory.PassDao(nil).GetByPassID(t.in.PassID)
		if err != nil {
			return "", fmt.Errorf("get pass for userID fallback: %w", err)
		}
		userID = passEntity.UserID
	}
	instances, err := instanceDao.ListAllByUserIDForIsolate(userID)
	if err != nil {
		return "", fmt.Errorf("list user instances: %w", err)
	}

	// 对未派发过且状态非 Paused/Deleted/Failed 的 instance enqueue IsolateInstance 子 task
	for _, inst := range instances {
		if _, ok := dispatched[inst.InstanceId]; ok {
			continue
		}
		// instance 已经处于 Paused / 终态时跳过派发（无需回滚）
		if inst.Status == modelinstance.InstanceStatusPaused ||
			inst.Status == modelinstance.InstanceStatusDeleted ||
			inst.Status == modelinstance.InstanceStatusFailed {
			continue
		}
		if err := instanceasync.EnqueueIsolateInstanceTask(
			ctx,
			inst.InstanceId,
			t.in.PassID,
			userID,
			t.in.OperationID,
			t.TaskId, // 回滚 task 自己作为 parent
			rollbackIsolateInstanceExecuteInterval,
			rollbackIsolateInstanceMaxExecuteCount,
		); err != nil {
			return "", fmt.Errorf("enqueue rollback isolate instance task for %s: %w", inst.InstanceId, err)
		}
		logger.Info("dispatched rollback isolate instance child task",
			zap.String("instance_id", inst.InstanceId),
			zap.String("status_before", inst.Status),
		)
	}

	// 重新反查子 task，确认全部 SUCCESS（I-MR-1 修复：FAILED 不算"完成"）
	childTasks, err = taskDao.ListByParentTaskID(t.TaskId)
	if err != nil {
		return "", fmt.Errorf("re-list rollback children: %w", err)
	}
	pendingCount := 0
	failedCount := 0
	for _, ct := range childTasks {
		if ct.TaskName != taskcommon.TaskNameIsolateInstance {
			continue
		}
		switch ct.TaskState {
		case taskmodel.StateSuccess:
			// 真正完成
		case taskmodel.StateFailed:
			// 终态失败：dispatched map 已剔除，下一轮父 task execute 会重派新子
			failedCount++
		default:
			pendingCount++
		}
	}
	if pendingCount > 0 || failedCount > 0 {
		logger.Info("rollback IsolateInstance children not all SUCCESS, will retry parent",
			zap.Int("pending_count", pendingCount),
			zap.Int("failed_count", failedCount),
		)
		return "", fmt.Errorf("waiting for %d pending + %d failed-to-redispatch rollback child task(s)", pendingCount, failedCount)
	}
	return taskflow.StepCodeSuccess, nil
}

// targetStatus 根据 OriginalIsolatedTime 是否为 nil 决定回滚目标状态：
//   - nil  → active（active 续费回滚）
//   - 非 nil → isolated（isolated 续费回滚）
func (t *rollbackRenewPassTask) targetStatus() string {
	if t.in == nil || t.in.OriginalIsolatedTime == nil {
		return modelpass.StatusActive
	}
	return modelpass.StatusIsolated
}

// idempotentCheck 锁竞争场景：检查 pass 是否已 已回到 target；若是 → markSuccess。
func (t *rollbackRenewPassTask) idempotentCheck(ctx pctx.Context) (string, error) {
	if t.in == nil || t.in.PassID == "" {
		return "", errors.New("idempotent check: missing pass id")
	}
	passEntity, err := daoFactory.DefaultDaoFactory.PassDao(nil).GetByPassID(t.in.PassID)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			destroyed, historyErr := rollbackPassAlreadyDestroyed(ctx, t.in.PassID)
			if historyErr != nil {
				return "", fmt.Errorf("LockTask failed and history check unavailable: %w", historyErr)
			}
			if destroyed {
				ctx.Logger().Info("rollback idempotent check: pass already destroyed",
					zap.String("pass_id", t.in.PassID))
				notifyTradeFlowFailed(ctx.Logger(), t.in.TradeFlowID, t.in.FailureReason)
				return t.markSuccess(ctx)
			}
		}
		ctx.Logger().Warn("rollback idempotent check: query pass failed",
			zap.Error(err), zap.String("pass_id", t.in.PassID))
		return "", fmt.Errorf("LockTask failed and idempotent check unavailable: %w", err)
	}
	if passEntity.Status == t.targetStatus() {
		ctx.Logger().Info("rollback idempotent check: pass already at target status",
			zap.String("pass_id", t.in.PassID),
			zap.String("status", passEntity.Status))
		// pass 已经回到 target，但 trade_flow 可能仍是 in_progress，best-effort 再补一次
		notifyTradeFlowFailed(ctx.Logger(), t.in.TradeFlowID, t.in.FailureReason)
		return t.markSuccess(ctx)
	}
	return "", fmt.Errorf("LockTask failed, pass status=%s (not yet rolled back)", passEntity.Status)
}

func rollbackPassAlreadyDestroyed(ctx pctx.Context, passID string) (bool, error) {
	_, err := modelpass.NewHistoryDao().GetByPassID(ctx, passID)
	if err == nil {
		return true, nil
	}
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return false, nil
	}
	return false, err
}

func (t *rollbackRenewPassTask) onExecuteFailed(_ string, err error) {
	t.lastExecuteErr = err
	_ = daoFactory.DefaultDaoFactory.TaskDao(nil).UpdateByKeyColumn(map[string]interface{}{
		taskmodel.ColumnTaskMessage: taskmodel.TruncateMessage(err),
	}, t.TaskId)
}

// finalizeFailure R-MR-6 修订（2026-05-25 用户拍板）：回滚 task "永不放弃"。
//
// R-MR-5（旧）：5 次重试都失败 → markFailed。问题：
//   - 与父 task R-MR-6 "永不放弃" 设计不对齐；
//   - pending child / DB 抖动 / ai-gateway 短路 都被当成终态失败 → 提前卡住。
//
// R-MR-6（新）：finalizeFailure 总是调 markRetryable（非终态） → checkTasks bypass
// （ctl/pkg/bypass/check_tasks.go）1min 内扫到重投。不再区分 "暂态/终态"，也不做
// "回滚的回滚"。真的 max=1<<30 用尽（理论永不出现）才走 exceedMaxExecuteCount 兜底 markFailed。
func (t *rollbackRenewPassTask) finalizeFailure(ctx pctx.Context) (string, error) {
	err := t.lastExecuteErr
	if err == nil {
		err = errors.New("rollback renew pass task execute failed")
	}
	logger := ctx.Logger().With(
		zap.String("pass_id", t.in.PassID),
		zap.String("user_id", t.in.UserID),
		zap.String("rollback_task_id", t.TaskId),
		zap.Int("execute_count", t.TaskEntity.ExecuteCount),
	)
	logger.Warn("rollback renew pass transient failure, will be retried by checkTasks bypass",
		zap.Error(err),
	)
	return t.markRetryable(ctx, taskmodel.TruncateMessage(err))
}

// markRetryable 把 task_state 回写为 CREATED（非终态）+ 写入诊断 task_message。
//
// 与 completeTaskFailure 的区别（与 isolate_task / destroy_task / renew_task markRetryable 同范式）：
//   - completeTaskFailure：task_state=FAILED（终态）→ checkTasks bypass 不再扫 → 链路死亡
//   - markRetryable：task_state=CREATED（非终态）→ checkTasks bypass 1 分钟后扫到 →
//     把 task 重投回 MQ → 本 task 框架按 ExecuteInterval(30s) 重投，max_execute_count 兜底
func (t *rollbackRenewPassTask) markRetryable(ctx pctx.Context, message string) (string, error) {
	if err := daoFactory.DefaultDaoFactory.TaskDao(ctx).UpdateByKeyColumn(map[string]interface{}{
		taskmodel.ColumnTaskState:   taskmodel.StateCreated,
		taskmodel.ColumnTaskMessage: message,
	}, t.TaskId); err != nil {
		return "", fmt.Errorf("update rollback renew pass task retryable state: %w", err)
	}
	t.TaskEntity.TaskState = taskmodel.StateCreated
	t.TaskEntity.TaskMessage = message
	return taskflow.StepCodeSuccess, nil
}

func (t *rollbackRenewPassTask) exceedMaxExecuteCount(ctx pctx.Context) (string, error) {
	ctx.Logger().Error("rollback renew pass task exceeded max execute count (should never happen, manual intervention required)",
		zap.String("pass_id", t.in.PassID),
	)
	return t.failTask(ctx, "ExecuteCount greater than or equal to MaxExecuteCount")
}

func (t *rollbackRenewPassTask) failTask(ctx pctx.Context, message string) (string, error) {
	if _, err := t.completeTaskFailure(ctx, message); err != nil {
		return "", err
	}
	return "", errors.New(message)
}

func (t *rollbackRenewPassTask) markSuccess(ctx pctx.Context) (string, error) {
	if err := daoFactory.DefaultDaoFactory.TaskDao(ctx).UpdateByKeyColumn(map[string]interface{}{
		taskmodel.ColumnTaskState:   taskmodel.StateSuccess,
		taskmodel.ColumnTaskMessage: "",
	}, t.TaskId); err != nil {
		return "", fmt.Errorf("update rollback renew pass task success state: %w", err)
	}
	t.TaskEntity.TaskState = taskmodel.StateSuccess
	t.TaskEntity.TaskMessage = ""
	return taskflow.StepCodeSuccess, nil
}

func (t *rollbackRenewPassTask) completeTaskFailure(ctx pctx.Context, message string) (string, error) {
	if err := daoFactory.DefaultDaoFactory.TaskDao(ctx).UpdateByKeyColumn(map[string]interface{}{
		taskmodel.ColumnTaskState:       taskmodel.StateFailed,
		taskmodel.ColumnTaskMessage:     message,
		taskmodel.ColumnLastExecuteTime: time.Now().UTC(),
	}, t.TaskId); err != nil {
		return "", fmt.Errorf("update rollback renew pass task failed state: %w", err)
	}
	t.TaskEntity.TaskState = taskmodel.StateFailed
	t.TaskEntity.TaskMessage = message
	return taskflow.StepCodeSuccess, nil
}

// 用 _ 占位 import 防止潜在未使用警告（context 在 dispatchAndWaitIsolateChildren 间接使用）。
var _ = context.Background
