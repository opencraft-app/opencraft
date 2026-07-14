// Package pass 实现 pass 相关的后台 task worker。
//
// 销毁父 task DestroyPass 派发 DestroyInstanceWithSnapshot 子 task 后立即收尾：
//
//	5a CancelSubscription / 5b MoveToHistory / 5c CompleteFlow（Q6 步骤级幂等）
//
// 设计稿：.tmp/trade-pass-destroy-design.md §4.5.2 / §4.5.3 / §4.6 / §4.7 / §11-A Q1 / Q3 / Q5 / Q6 / Q21 / Q24
//
// 当前实现：父 task 列实例 + 派子 task + 立即从用户侧解除实例关联，再执行 5a/5b/5c 收尾。
package pass

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	adapterfactory "ctl/pkg/adapter/factory"
	pctx "ctl/pkg/context"
	instanceasync "ctl/pkg/instance"
	"ctl/pkg/logic/gatewayroute"
	"ctl/pkg/metric"
	daoFactory "ctl/pkg/model/factory"
	modelinstance "ctl/pkg/model/instance"
	modelpass "ctl/pkg/model/pass"
	taskmodel "ctl/pkg/model/task"
	"ctl/pkg/resource"
	"ctl/pkg/taskflow"
	"ctl/pkg/taskruntime"
	taskcommon "ctl/pkg/taskruntime/common"

	"go.uber.org/zap"
)

// === 销毁父 task 实现常量（与 IsolatePass 父 task 对偶）===
const (
	destroyPassTaskLockSeconds = 1800 // 30 分钟（单轮枚举可能跨多 instance + cbs 调用 + DB 反查）

	// DestroyInstanceWithSnapshot 子 task 重试节奏：60s × 60 = 1h（与 IsolateInstance 同范式）
	destroyInstanceForPassTaskExecuteInterval = int64(60)
	destroyInstanceForPassTaskMaxExecuteCount = 60

	// 收尾步骤外部调用超时
	cancelSubscriptionCallTimeout   = 5 * time.Second         // 5a：与 ai-gateway internal API 一致
	tradeCompleteFlowDestroyTimeout = 1500 * time.Millisecond // 5c：与 isolate 父 task 同 1.5s
)

type destroyPassTask struct {
	*taskruntime.BaseTask
	in             *taskcommon.DestroyPassTaskPayload
	lastExecuteErr error
}

func newDestroyPassTask() *destroyPassTask {
	task := &destroyPassTask{
		BaseTask: taskruntime.NewBaseTask(),
	}
	task.TaskLockSeconds = destroyPassTaskLockSeconds
	task.ExceedMaxExecuteCountFunc = task.exceedMaxExecuteCount
	return task
}

// PrepareDestroyPassTask 由 processor.factory 注册到 pfMap
func PrepareDestroyPassTask(_ pctx.Context, data []byte) (svcTask taskruntime.ServiceTask, in, out interface{}, err error) {
	svcTask = newDestroyPassTask()
	in = new(taskcommon.DestroyPassTaskPayload)
	err = parseMessageData(data, in)
	return
}

func (t *destroyPassTask) Init(in, _ interface{}) error {
	payload, ok := in.(*taskcommon.DestroyPassTaskPayload)
	if !ok {
		return fmt.Errorf("unexpected destroy pass task payload: %T", in)
	}
	t.in = payload
	return nil
}

func (t *destroyPassTask) Name() string         { return taskcommon.TaskNameDestroyPass }
func (t *destroyPassTask) FirstStepKey() string { return taskruntime.StepKeyLockTask }

func (t *destroyPassTask) StepConfigMap() map[string]*taskflow.StepConfig[pctx.Context] {
	stepMap := isolatePassTaskStepConfigMap(t.BaseTask, t.execute, t.onExecuteFailed, t.idempotentCheck)
	stepMap[stepKeyFinalizeFailure].StepFunc = t.finalizeFailure
	return stepMap
}

// execute 是销毁父 task 的核心（子 task 派发 + 5a/5b/5c 步骤级幂等收尾）
//
// 流程：
//  1. 校验 t.in.PassID 非空
//  2. 反查 pass：terminating → 进入子 task 派发 / 收尾；不存在 → 走 PassDeleted=true 的 5c 重投路径
//  3. 派发 instance 异步销毁子 task，并立即从用户侧解除待销毁实例关联
//  4. 阶段 5（步骤级幂等）：
//     - 5a：!SubscriptionDone → ai-gateway.CancelSubscription（best-effort，Q3 拍板）→ 持久化进度位
//     - 5b：!PassDeleted → dao.MoveToHistory（删 pass + 写 history_pass，单事务）→ 持久化
//     - 5c：!FlowCompleted && TradeFlowID > 0 → trade.CompleteFlow（best-effort）→ 持久化
//  5. markSuccess
//
// Q6 重投幂等：SubscriptionDone=true 跳 5a；PassDeleted=true 跳 5b；FlowCompleted=true 跳 5c。
// 关键场景：5b 成功 5c 失败重投 — execute 入口 GetByPassID 报 not found；PassDeleted=true 时直接进 5c。
func (t *destroyPassTask) execute(ctx pctx.Context) (string, error) {
	if t.in == nil || t.in.PassID == "" {
		return "", errors.New("execute: missing pass id")
	}

	logger := ctx.Logger().With(
		zap.String("pass_id", t.in.PassID),
		zap.String("user_id", t.in.UserID),
		zap.Int64("trade_flow_id", t.in.TradeFlowID),
		zap.String("destroy_reason", t.in.DestroyReason),
		zap.String("region", t.in.Region),
		zap.String("parent_task_id", t.TaskId),
		zap.Bool("subscription_done", t.in.SubscriptionDone),
		zap.Bool("pass_deleted", t.in.PassDeleted),
		zap.Bool("flow_completed", t.in.FlowCompleted),
	)

	passDao := daoFactory.DefaultDaoFactory.PassDao(nil)
	passEntity, err := passDao.GetByPassID(t.in.PassID)
	if err != nil {
		// pass 已不在表 — 关键 Q6 场景：5b 已成功 + 5c 失败的重投
		if t.in.PassDeleted {
			logger.Info("destroy pass: pass already migrated to history, proceeding to 5c finalize")
			return t.finalizePostPassDeleted(ctx, logger)
		}
		// pass 不在表但 PassDeleted=false：异常状态（pass 被外部清理或 D-2.3 之前的脏数据）
		logger.Warn("destroy pass: pass not found and PassDeleted=false, defensive markSuccess",
			zap.Error(err))
		return t.markSuccess(ctx)
	}

	if passEntity.Status != modelpass.StatusTerminating {
		logger.Warn("destroy pass: pass status unexpected, treat as terminal and markSuccess",
			zap.String("status", passEntity.Status))
		return t.markSuccess(ctx)
	}

	// === 阶段 1+2+3+4：子 task 派发 + 立即解除实例用户关联 ===
	if !(t.in.SubscriptionDone && t.in.PassDeleted && t.in.FlowCompleted) {
		if err := t.dispatchChildTasksAndDetachInstances(ctx, logger, passEntity); err != nil {
			return "", err
		}
	}

	// === 阶段 5：步骤级幂等收尾（D-7 落地，Q6 重投幂等）===

	// 5a：ai-gateway.CancelSubscription（best-effort，Q3 拍板不阻塞）
	if !t.in.SubscriptionDone {
		t.cancelAiGatewaySubscription(ctx, logger, passEntity.UserID)
		t.in.SubscriptionDone = true
		if err := t.persistProgress(ctx); err != nil {
			return "", fmt.Errorf("persist progress after 5a: %w", err)
		}
	}

	// 5b：dao.MoveToHistory（删 pass 行 + 写 history_pass，单事务）
	if !t.in.PassDeleted {
		if err := t.movePassToHistory(ctx, logger); err != nil {
			return "", fmt.Errorf("5b MoveToHistory: %w", err)
		}
		t.in.PassDeleted = true
		if err := t.persistProgress(ctx); err != nil {
			return "", fmt.Errorf("persist progress after 5b: %w", err)
		}
	}

	// 5c：trade.CompleteFlow（best-effort）
	return t.finalizePostPassDeleted(ctx, logger)
}

// finalizePostPassDeleted 5c 入口（pass 已迁移到 history，进入 trade callback + markSuccess）
func (t *destroyPassTask) finalizePostPassDeleted(ctx pctx.Context, logger *zap.Logger) (string, error) {
	if !t.in.FlowCompleted {
		t.notifyTradeFlowCompleted(ctx, logger)
		t.in.FlowCompleted = true
		if err := t.persistProgress(ctx); err != nil {
			// 持久化 5c 进度位失败也要 markSuccess（trade callback best-effort 已执行；
			// 重投仅引入一次幂等的多余 callback）
			logger.Warn("destroy pass: persist FlowCompleted failed, still markSuccess",
				zap.Error(err))
		}
	}
	logger.Info("destroy pass parent task finalized successfully")
	return t.markSuccess(ctx)
}

// dispatchChildTasksAndDetachInstances 阶段 1~4：列实例 / 反查 child_registry / 派子 task / 解除用户关联。
//
// 父 task 不再等待子 task 终态。子 task 通过 task runtime 的 checkTasks bypass 独立重试；
// 父 task 只保证每个当前归属用户的非终态 instance 至少已有一个非 failed 子 task，然后立即把
// instance 从用户侧软删/脱钩，让 pass 销毁、配额删除和订阅取消不被快照/CVM 删除耗时阻塞。
func (t *destroyPassTask) dispatchChildTasksAndDetachInstances(ctx pctx.Context, logger *zap.Logger, passEntity *modelpass.Entity) error {
	instanceDao := daoFactory.DefaultDaoFactory.InstanceDao(nil)
	userID := t.in.UserID
	if userID == "" {
		userID = passEntity.UserID
	}
	instances, err := instanceDao.ListAllByUserIDForIsolate(userID)
	if err != nil {
		return fmt.Errorf("list user instances: %w", err)
	}

	childTasks, err := daoFactory.DefaultDaoFactory.TaskDao(nil).ListByParentTaskID(t.TaskId)
	if err != nil {
		return fmt.Errorf("list child tasks: %w", err)
	}

	dispatched := make(map[string]*taskmodel.Entity, len(childTasks))
	for _, ct := range childTasks {
		if ct.TaskName != taskcommon.TaskNameDestroyInstanceWithSnapshot {
			continue
		}
		var p taskcommon.DestroyInstanceForPassTaskPayload
		if err := jsonUnmarshal(ct.TaskParams, &p); err != nil {
			logger.Warn("decode child task payload failed, skip",
				zap.Error(err), zap.String("child_task_id", ct.TaskId))
			continue
		}
		if p.InstanceID == "" {
			continue
		}
		// Q16 ✅ 拍板（重派语义）：failed 子 task 不算"已派发"
		if ct.TaskState == taskmodel.StateFailed {
			logger.Info("destroy pass: child task failed, will redispatch",
				zap.String("instance_id", p.InstanceID),
				zap.String("failed_child_task_id", ct.TaskId))
			continue
		}
		dispatched[p.InstanceID] = ct
	}

	toDetach := make([]*modelinstance.Entity, 0, len(instances))
	for _, inst := range instances {
		if inst.Status == modelinstance.InstanceStatusDeleted ||
			inst.Status == modelinstance.InstanceStatusFailed {
			continue
		}
		if _, ok := dispatched[inst.InstanceId]; !ok {
			childPayload := taskcommon.DestroyInstanceForPassTaskPayload{
				InstanceID:  inst.InstanceId,
				PassID:      t.in.PassID,
				UserID:      userID,
				OperationID: t.in.OperationID,
				SandboxID:   inst.SandboxId,
				Region:      t.in.Region,
				UIN:         passEntity.Uin,
				AppID:       passEntity.AppID,
				TradeFlowID: t.in.TradeFlowID,
			}
			if err := instanceasync.EnqueueDestroyInstanceForPassTask(
				ctx,
				childPayload,
				t.TaskId,
				destroyInstanceForPassTaskExecuteInterval,
				destroyInstanceForPassTaskMaxExecuteCount,
			); err != nil {
				return fmt.Errorf("enqueue destroy instance for pass task for %s: %w", inst.InstanceId, err)
			}
			logger.Info("destroy pass: dispatched destroy instance child task",
				zap.String("instance_id", inst.InstanceId))
		}
		toDetach = append(toDetach, inst)
	}

	if err := detachInstancesForPassDestroy(userID, toDetach); err != nil {
		return fmt.Errorf("detach instances for pass destroy: %w", err)
	}
	logger.Info("destroy pass: child tasks dispatched and instances detached from user",
		zap.Int("instance_count", len(toDetach)))
	return nil
}

func detachInstancesForPassDestroy(userID string, instances []*modelinstance.Entity) error {
	if userID == "" || len(instances) == 0 {
		return nil
	}
	ids := make([]int64, 0, len(instances))
	for _, inst := range instances {
		if inst != nil && inst.Id > 0 {
			ids = append(ids, inst.Id)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	now := time.Now().UTC()
	result := resource.GormDB.Table(modelinstance.TableName).
		Where(fmt.Sprintf("%s = ? AND %s IN ?", modelinstance.ColumnUserID, modelinstance.ColumnID), userID, ids).
		Updates(map[string]interface{}{
			modelinstance.ColumnUserID:    "",
			modelinstance.ColumnStatus:    modelinstance.InstanceStatusDeleted,
			modelinstance.ColumnDeletedAt: now,
			modelinstance.ColumnUpdatedAt: now,
		})
	if result.Error != nil {
		return result.Error
	}
	return nil
}

// === D-7 收尾步骤实现（5a / 5b / 5c）===

// cancelAiGatewaySubscription 5a：调 ai-gateway.CancelSubscription（best-effort，Q3 拍板不阻塞）
//
// 设计稿 §11-A Q3 拍板（方案 A）：CancelSubscription 维持 best-effort，不阻塞销毁主流程。
// 兜底依赖 ai-gateway Scheduler 按 period_end 自动过期 + 用户下次 Subscribe() 强制 CancelByUserID 覆盖。
func (t *destroyPassTask) cancelAiGatewaySubscription(_ pctx.Context, logger *zap.Logger, userIDFromEntity string) {
	userID := t.in.UserID
	if userID == "" {
		userID = userIDFromEntity
	}
	if userID == "" {
		logger.Warn("destroy pass 5a: userID empty, skip CancelSubscription")
		metric.DestroyFinalizeStepTotal.WithLabelValues("5a_cancel_subscription", "skipped").Inc()
		return
	}
	callCtx, cancel := context.WithTimeout(context.Background(), cancelSubscriptionCallTimeout)
	defer cancel()
	cancelSource := "llmgateway"
	if gateway, ok, err := gatewayroute.Get(userID); err != nil {
		logger.Warn("destroy pass 5a: get recorded subscription gateway failed, fallback to probe",
			zap.String("user_id", userID),
			zap.Error(err))
	} else if ok {
		switch gateway {
		case gatewayroute.GatewayAIGateway:
			cancelSource = "ai-gateway"
		case gatewayroute.GatewayLLMGateway:
			cancelSource = "llmgateway"
		default:
			logger.Warn("destroy pass 5a: unknown recorded subscription gateway, fallback to probe",
				zap.String("user_id", userID),
				zap.String("gateway", gateway))
		}
	} else if legacyAdapter := adapterfactory.DefaultAdapterFactory.AiGatewayAdapter(); legacyAdapter != nil {
		legacySub, legacyErr := legacyAdapter.GetActiveSubscription(callCtx, userID)
		if legacyErr == nil && legacySub != nil {
			cancelSource = "ai-gateway"
			gatewayroute.RecordBestEffort(logger, userID, gatewayroute.GatewayAIGateway, legacySub.ID, legacySub.PlanID, gatewayroute.SourceDetectActiveSubscription)
		} else if legacyErr != nil && !isLegacyGatewayDisabled(legacyErr) {
			logger.Warn("destroy pass 5a: get ai-gateway active subscription failed, try llmgateway cancel",
				zap.String("user_id", userID),
				zap.Error(legacyErr))
		}
	}

	var err error
	if cancelSource == "ai-gateway" {
		err = adapterfactory.DefaultAdapterFactory.AiGatewayAdapter().CancelSubscription(callCtx, userID)
	} else {
		err = adapterfactory.DefaultAdapterFactory.LLMGatewayAdapter().CancelSubscription(callCtx, userID)
	}
	if err != nil {
		// best-effort：失败仅记 Warn，不阻塞后续 5b/5c
		logger.Warn("destroy pass 5a: gateway CancelSubscription failed (best-effort, parent task still proceeds)",
			zap.String("user_id", userID),
			zap.String("gateway", cancelSource),
			zap.Error(err))
		metric.DestroyFinalizeStepTotal.WithLabelValues("5a_cancel_subscription", "failed").Inc()
		return
	}
	logger.Info("destroy pass 5a: gateway CancelSubscription succeeded",
		zap.String("user_id", userID),
		zap.String("gateway", cancelSource))
	metric.DestroyFinalizeStepTotal.WithLabelValues("5a_cancel_subscription", "success").Inc()
}

func isLegacyGatewayDisabled(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return strings.Contains(msg, "ai-gateway base_url not configured") ||
		strings.Contains(msg, "ai-gateway internal_service_token not configured")
}

// movePassToHistory 5b：dao.MoveToHistory（删 pass 行 + 写 history_pass，单事务）
//
// 设计稿 §4.6 步骤 5b + §11-A Q6 拍板（步骤级幂等加固）：
//   - 入参 deletedTime = time.Now().UTC()（销毁完成时刻）
//   - destroyReason 镜像 jifei `para.source` 透传值（Q24 ✅ 拍板）
//   - alreadyMigrated=true 也算成功（重投幂等保护）
//   - ErrPassNotFound 才返错（pass + history_pass 双表都缺；连续多次说明 trade_flow ↔ ctl 严重背离，需人工）
func (t *destroyPassTask) movePassToHistory(ctx pctx.Context, logger *zap.Logger) error {
	deletedTime := time.Now().UTC()
	alreadyMigrated, err := daoFactory.DefaultDaoFactory.PassDao(nil).MoveToHistory(
		ctx,
		t.in.PassID,
		deletedTime,
		t.in.DestroyReason,
	)
	if err != nil {
		metric.DestroyFinalizeStepTotal.WithLabelValues("5b_move_to_history", "failed").Inc()
		return err
	}
	logger.Info("destroy pass 5b: pass migrated to history_pass",
		zap.Bool("already_migrated", alreadyMigrated),
		zap.Time("deleted_time", deletedTime))
	metric.DestroyFinalizeStepTotal.WithLabelValues("5b_move_to_history", "success").Inc()
	return nil
}

// notifyTradeFlowCompleted 5c：best-effort 调 trade `/internal/trade/flows/{flow_id}/complete`
//
// 设计稿：trade-pass-destroy-design.md §4.6 步骤 5c（与 isolate 父 task notifyTradeFlowCompleted 同范式）。
// TradeFlowID == 0 时直接跳过（dev/test 兼容）。
func (t *destroyPassTask) notifyTradeFlowCompleted(_ pctx.Context, logger *zap.Logger) {
	if t.in == nil || t.in.TradeFlowID == 0 {
		metric.DestroyFinalizeStepTotal.WithLabelValues("5c_complete_flow", "skipped").Inc()
		return
	}
	flowID := t.in.TradeFlowID

	callCtx, cancel := context.WithTimeout(context.Background(), tradeCompleteFlowDestroyTimeout)
	defer cancel()

	tradeAdapter := adapterfactory.DefaultAdapterFactory.TradeAdapter()
	if err := tradeAdapter.CompleteFlow(callCtx, flowID, "completed", ""); err != nil {
		logger.Warn("destroy pass 5c: trade CompleteFlow callback failed (best-effort, parent task still proceeds)",
			zap.Int64("trade_flow_id", flowID),
			zap.Error(err))
		metric.DestroyFinalizeStepTotal.WithLabelValues("5c_complete_flow", "failed").Inc()
		return
	}
	logger.Info("destroy pass 5c: trade CompleteFlow callback succeeded",
		zap.Int64("trade_flow_id", flowID))
	metric.DestroyFinalizeStepTotal.WithLabelValues("5c_complete_flow", "success").Inc()
}

// persistProgress 把 t.in（含已更新的 SubscriptionDone / PassDeleted / FlowCompleted）持久化到 task.task_params。
//
// 关键：每次重投开始时框架会从 task.task_params 重新 unmarshal payload，这里持久化后下次重投自动可见。
// 不更新 last_execute_time / execute_count（框架已在每轮 update_task_execute 步骤自维护）。
func (t *destroyPassTask) persistProgress(_ pctx.Context) error {
	body, err := json.Marshal(t.in)
	if err != nil {
		return fmt.Errorf("marshal payload: %w", err)
	}
	if err := daoFactory.DefaultDaoFactory.TaskDao(nil).UpdateByKeyColumn(map[string]interface{}{
		taskmodel.ColumnTaskParams: string(body),
	}, t.TaskId); err != nil {
		return fmt.Errorf("update task params: %w", err)
	}
	return nil
}

// idempotentCheck 锁竞争场景：检查 pass 是否已不在 terminating（pass 行已被 5b 删除 →
// markSuccess；status 仍 terminating → 等下一轮 lock 重试）。
//
// 关键场景（Q6）：5b 已成功 + 5c 失败的重投。锁竞争路径下若 PassDeleted=true，应继续到 finalizePostPassDeleted。
func (t *destroyPassTask) idempotentCheck(ctx pctx.Context) (string, error) {
	if t.in == nil || t.in.PassID == "" {
		return "", errors.New("idempotent check: missing pass id")
	}
	passEntity, err := daoFactory.DefaultDaoFactory.PassDao(nil).GetByPassID(t.in.PassID)
	if err != nil {
		// pass 已迁移到 history，但锁拿不到（其它 worker 正在处理） — 走完成路径
		if t.in.PassDeleted {
			return t.finalizePostPassDeleted(ctx, ctx.Logger())
		}
		ctx.Logger().Info("destroy pass idempotent check: pass not found, assume already migrated to history",
			zap.Error(err), zap.String("pass_id", t.in.PassID))
		return t.markSuccess(ctx)
	}
	if passEntity.Status != modelpass.StatusTerminating {
		ctx.Logger().Warn("destroy pass idempotent check: status unexpected, markSuccess defensive",
			zap.String("status", passEntity.Status))
		return t.markSuccess(ctx)
	}
	return "", fmt.Errorf("LockTask failed, pass still in terminating; retry next round")
}

func (t *destroyPassTask) onExecuteFailed(_ string, err error) {
	t.lastExecuteErr = err
	_ = daoFactory.DefaultDaoFactory.TaskDao(nil).UpdateByKeyColumn(map[string]interface{}{
		taskmodel.ColumnTaskMessage: taskmodel.TruncateMessage(err),
	}, t.TaskId)
}

// finalizeFailure 设计契约（Q35=a 修订版 / 设计稿 §4.6 / Bug 1 修复）：
//
// 历史 Bug：原实现一次 execute 失败就调 completeTaskFailure 标 FAILED 终态，
// 与 max_execute_count=1<<30 "永不放弃" 的设计契约严重背离。一旦 task 标 FAILED，
// checkTasks bypass 不再扫（只扫 UnCompletedTaskStates={CREATED,RUNNING}），
// 整条销毁链路从此卡死，trade_flow 永远停在 in_progress。
//
// 当前实现：仅记录错误信息到 task_message，把 task_state 回写为 CREATED（非终态），
// 让 checkTasks bypass 1 分钟内扫到并按 ExecuteInterval 重投。真正终态失败由
// exceedMaxExecuteCount 入口（execute_count >= max_execute_count，即 1<<30 次）触发。
//
// 这样：
//   - 瞬时基础设施错（DB 表暂缺、网络抖动、下游 5xx）→ 自动重试 → 最终成功 / 走 max
//   - 真正永久失败（max 跑完 ≈ 1B 次）→ exceedMaxExecuteCount → completeTaskFailure 终态
func (t *destroyPassTask) finalizeFailure(ctx pctx.Context) (string, error) {
	err := t.lastExecuteErr
	if err == nil {
		err = errors.New("destroy pass task execute failed")
	}
	ctx.Logger().Warn("destroy pass task execute failed, will be retried by checkTasks bypass",
		zap.Error(err),
		zap.String("pass_id", t.in.PassID),
		zap.Int("execute_count", t.TaskEntity.ExecuteCount),
		zap.Int("max_execute_count", t.TaskEntity.MaxExecuteCount))
	return t.markRetryable(ctx, taskmodel.TruncateMessage(err))
}

// markRetryable 把 task_state 回写为 CREATED（非终态）+ 写入诊断 task_message。
//
// 与 completeTaskFailure 的区别：
//   - completeTaskFailure：task_state=FAILED（终态）→ checkTasks bypass 不再扫 → 链路死亡
//   - markRetryable：task_state=CREATED（非终态）→ checkTasks bypass 1 分钟后扫到 →
//     把 task 重投回 MQ → 父 task 框架按 ExecuteInterval(30s) 重投，max_execute_count 兜底
//
// 注意：不更新 last_execute_time（框架的 UpdateTaskExecute 步骤已自维护）；
// return StepCodeSuccess 让框架继续走 UnlockTask 释放分布式锁，下一轮重投能再次 LockTask 成功。
func (t *destroyPassTask) markRetryable(ctx pctx.Context, message string) (string, error) {
	if err := daoFactory.DefaultDaoFactory.TaskDao(ctx).UpdateByKeyColumn(map[string]interface{}{
		taskmodel.ColumnTaskState:   taskmodel.StateCreated,
		taskmodel.ColumnTaskMessage: message,
	}, t.TaskId); err != nil {
		return "", fmt.Errorf("update destroy pass task retryable state: %w", err)
	}
	t.TaskEntity.TaskState = taskmodel.StateCreated
	t.TaskEntity.TaskMessage = message
	return taskflow.StepCodeSuccess, nil
}

func (t *destroyPassTask) exceedMaxExecuteCount(ctx pctx.Context) (string, error) {
	ctx.Logger().Error("destroy pass task exceeded max execute count (should never happen)",
		zap.String("pass_id", t.in.PassID))
	return t.failTask(ctx, "ExecuteCount greater than or equal to MaxExecuteCount")
}

func (t *destroyPassTask) failTask(ctx pctx.Context, message string) (string, error) {
	if _, err := t.completeTaskFailure(ctx, message); err != nil {
		return "", err
	}
	return "", errors.New(message)
}

func (t *destroyPassTask) markSuccess(ctx pctx.Context) (string, error) {
	if err := daoFactory.DefaultDaoFactory.TaskDao(ctx).UpdateByKeyColumn(map[string]interface{}{
		taskmodel.ColumnTaskState:   taskmodel.StateSuccess,
		taskmodel.ColumnTaskMessage: "",
	}, t.TaskId); err != nil {
		return "", fmt.Errorf("update destroy pass task success state: %w", err)
	}
	t.TaskEntity.TaskState = taskmodel.StateSuccess
	t.TaskEntity.TaskMessage = ""
	metric.DestroyPassTotal.WithLabelValues(destroyEntryLabel(t.in), "success").Inc()
	return taskflow.StepCodeSuccess, nil
}

func (t *destroyPassTask) completeTaskFailure(ctx pctx.Context, message string) (string, error) {
	if err := daoFactory.DefaultDaoFactory.TaskDao(ctx).UpdateByKeyColumn(map[string]interface{}{
		taskmodel.ColumnTaskState:       taskmodel.StateFailed,
		taskmodel.ColumnTaskMessage:     message,
		taskmodel.ColumnLastExecuteTime: time.Now().UTC(),
	}, t.TaskId); err != nil {
		return "", fmt.Errorf("update destroy pass task failed state: %w", err)
	}
	t.TaskEntity.TaskState = taskmodel.StateFailed
	t.TaskEntity.TaskMessage = message
	metric.DestroyPassTotal.WithLabelValues(destroyEntryLabel(t.in), "failed").Inc()
	return taskflow.StepCodeSuccess, nil
}

// destroyEntryLabel 根据 payload 的 DestroyReason 推断销毁入口（设计稿 §1.1 / §11-A Q24 联动）：
//
//   - DestroyReason == ""：入口 A（用户主动销毁，未经 jifei 二次回标的兜底场景）
//   - DestroyReason == "biz" / "qn" / "other"：入口 B（jifei 计费侧 destroyResource 回调透传 source）
//
// 注：入口 A 也可能在 jifei 回调到达后写非空 DestroyReason（链路完整闭环），此时 metric 维度归 B。
// 这是合理的：metric 维度的 entry 含义是"销毁主链最终触达 jifei 的来源"，而非"用户态触发入口"。
func destroyEntryLabel(payload *taskcommon.DestroyPassTaskPayload) string {
	if payload == nil || payload.DestroyReason == "" {
		return "user_active"
	}
	return "jifei_callback"
}
