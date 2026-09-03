// 同 SP 变配父 task ModifyPass。需求：TAPD 1010132091137784162 §6 执行顺序 / §8 幂等与失败恢复
//
// 入口 logic.AcceptPassModify 已 CAS active → modifying 并写入 modify_flow_id /
// modify_target_bundle_id，本父 task 负责把权益真正升上去：
//
//  1. 派发并等待每台实例的 ModifyInstance 子 task（零实例是正常场景，直接跳过）
//  2. 全部实例到位后切 VelaGW 订阅到目标 Plan
//  3. 同一 CTL 事务提交 pass.bundle_id + AgentQuota，并清空中间字段回 active
//  4. 反向 callback trade 推进 trade_flow 与 trade_order；失败时父 task 保持可重试
//
// 步骤 2 必须在步骤 1 之后：先切权益会出现"套餐已是巡游但底层还是 2C4G"的窗口，
// 用户按新档位用资源却拿不到新机器。
//
// 失败策略是「前滚收敛」（§8.3）：系统盘扩容不可逆，缩不回去，所以任何失败都保持
// modifying 继续重试，已升配的实例不降回启航规格，也不自动触发退款。父 task
// max=1<<30「永不放弃」正是为此——中途放弃只会留下没有自动出路的半升配状态。
package pass

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	adapterfactory "ctl/pkg/adapter/factory"
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
)

const (
	// 单轮 execute 要枚举实例、反查子 task、可能多次 enqueue，30min 锁与 renew 父 task 同档。
	modifyPassTaskLockSeconds = 1800

	// 子 task 重试窗口 60s × 60 = 1h；父 task 的窗口必须严格覆盖子 task 的。
	modifyInstanceTaskExecuteInterval = int64(60)
	modifyInstanceTaskMaxExecuteCount = 60
)

type modifyPassTask struct {
	*taskruntime.BaseTask
	in             *taskcommon.ModifyPassTaskPayload
	lastExecuteErr error
	completeFlow   func(context.Context, int64, string, string) error
}

func newModifyPassTask() *modifyPassTask {
	task := &modifyPassTask{
		BaseTask: taskruntime.NewBaseTask(),
	}
	task.TaskLockSeconds = modifyPassTaskLockSeconds
	task.ExceedMaxExecuteCountFunc = task.exceedMaxExecuteCount
	return task
}

// PrepareModifyPassTask 由 processor.factory 注册到 pfMap
func PrepareModifyPassTask(_ pctx.Context, data []byte) (svcTask taskruntime.ServiceTask, in, out interface{}, err error) {
	svcTask = newModifyPassTask()
	in = new(taskcommon.ModifyPassTaskPayload)
	err = parseMessageData(data, in)
	return
}

func (t *modifyPassTask) Init(in, _ interface{}) error {
	payload, ok := in.(*taskcommon.ModifyPassTaskPayload)
	if !ok {
		return fmt.Errorf("unexpected modify pass task payload: %T", in)
	}
	t.in = payload
	return nil
}

func (t *modifyPassTask) Name() string         { return taskcommon.TaskNameModifyPass }
func (t *modifyPassTask) FirstStepKey() string { return taskruntime.StepKeyLockTask }

func (t *modifyPassTask) StepConfigMap() map[string]*taskflow.StepConfig[pctx.Context] {
	stepMap := isolatePassTaskStepConfigMap(t.BaseTask, t.execute, t.onExecuteFailed, t.idempotentCheck)
	stepMap[stepKeyFinalizeFailure].StepFunc = t.finalizeFailure
	return stepMap
}

func (t *modifyPassTask) execute(ctx pctx.Context) (string, error) {
	if t.in == nil || t.in.PassID == "" {
		return "", errors.New("execute: missing pass id")
	}
	if t.in.TargetBundleID == "" {
		return "", errors.New("execute: missing target bundle id")
	}

	logger := ctx.Logger().With(
		zap.String("pass_id", t.in.PassID),
		zap.String("user_id", t.in.UserID),
		zap.String("parent_task_id", t.TaskId),
		zap.Int64("trade_flow_id", t.in.TradeFlowID),
		zap.String("target_bundle_id", t.in.TargetBundleID),
	)
	if done, err := t.hasFinalizedReceipt(); err != nil {
		return "", err
	} else if done {
		if err := t.notifyModifyFlowCompleted(logger); err != nil {
			return "", err
		}
		return t.markSuccess(ctx)
	}

	passDao := daoFactory.DefaultDaoFactory.PassDao(nil)
	passEntity, err := passDao.GetByPassID(t.in.PassID)
	if err != nil {
		return "", fmt.Errorf("get pass: %w", err)
	}

	// 已收尾：上一轮 execute 完成了权益提交，本次只需补 callback 并 markSuccess。
	if passEntity.Status == modelpass.StatusActive && passEntity.BundleID == t.in.TargetBundleID {
		logger.Info("pass already upgraded, short-circuit parent task")
		if err := t.notifyModifyFlowCompleted(logger); err != nil {
			return "", err
		}
		return t.markSuccess(ctx)
	}
	if passEntity.Status != modelpass.StatusModifying {
		return "", fmt.Errorf("pass status unexpected: %s (expect modifying)", passEntity.Status)
	}
	if passEntity.ModifyFlowID != t.in.TradeFlowID {
		// 另一笔 flow 占着 pass。入口的 CAS 保证同时只有一笔，走到这里说明本 task
		// 是过期投递，直接终态成功让位，不去抢别人的状态机。
		logger.Warn("pass is held by another modify flow, abandoning this parent task",
			zap.Int64("in_flight_flow_id", passEntity.ModifyFlowID))
		return t.markSuccess(ctx)
	}

	userID := t.in.UserID
	if userID == "" {
		userID = passEntity.UserID
	}

	targetBundle, err := logicpass.ResolveModifyTargetSpec(t.in.TargetBundleID)
	if err != nil {
		return "", err
	}

	// === 步骤 1：全部实例升到目标规格 ===
	if err := t.advanceInstances(ctx, logger, userID, targetBundle.InstanceSpecID); err != nil {
		return "", err
	}

	// === 步骤 2：切 VelaGW 订阅到目标 Plan ===
	//
	// 相同的唯一 SubscriptionName 配不同 PlanID 就是替换语义，用户直接拿到目标套餐的
	// 完整额度（巡游 200 / 巡游 AI 10000）。源套餐周期内已用积分不做差值扣减，
	// 独立赠送的 free-credit:* 也不受影响。
	if !t.in.SubscriptionDone {
		if targetBundle.Credit > 0 {
			idempotencyKey := t.subscriptionIdempotencyKey()
			if _, err := logicpass.EnsureAiGatewayEntitlement(
				logger,
				userID,
				targetBundle.AiGatewayPlanID,
				idempotencyKey,
			); err != nil {
				return "", fmt.Errorf("switch gateway subscription to target plan: %w", err)
			}
			logger.Info("gateway subscription switched to target plan",
				zap.String("plan_id", targetBundle.AiGatewayPlanID),
				zap.Int64("credit", targetBundle.Credit),
			)
		}
		t.in.SubscriptionDone = true
		// 先落盘再继续：VelaGW 成功但 DB 提交失败时，重投必须跳过订阅调用直接重试提交。
		if err := instanceasync.UpdateModifyPassPayload(ctx, t.TaskId, t.in); err != nil {
			return "", fmt.Errorf("persist subscription progress: %w", err)
		}
	}

	// === 步骤 3：事务内提交 Bundle + AgentQuota，并回到 active ===
	finalized, err := passDao.FinalizeModify(
		t.in.PassID,
		t.in.TradeFlowID,
		t.in.TargetBundleID,
		userID,
		targetBundle.AgentQuota,
		t.TaskId,
	)
	if err != nil {
		return "", fmt.Errorf("FinalizeModify: %w", err)
	}
	if !finalized {
		// A missed CAS may also mean a different operation owns the Pass. Only
		// a receipt from the committing transaction proves this task completed.
		if done, err := t.hasFinalizedReceipt(); err != nil {
			return "", err
		} else if !done {
			return "", errors.New("FinalizeModify affected 0 rows without a finalized receipt")
		}
	}
	logger.Info("modify pass parent task completed",
		zap.String("bundle_id", t.in.TargetBundleID),
		zap.Int64("agent_quota", targetBundle.AgentQuota),
	)

	// === 步骤 4：推进 trade_flow ===
	if err := t.notifyModifyFlowCompleted(logger); err != nil {
		return "", err
	}
	return t.markSuccess(ctx)
}

// advanceInstances 派发缺失的子 task 并等待全部终态。
//
// 零实例直接返回 nil：用户买了套餐还没开机是正常场景，只升套餐级权益。
// 任一子 task 终态 FAILED 时不返哨兵错——变配没有回滚链路，失败只能前滚，
// 所以这里返普通错让父 task 继续重试；子 task 自己也会被 checkTasks 重投。
func (t *modifyPassTask) advanceInstances(ctx pctx.Context, logger *zap.Logger, userID, targetSpecID string) error {
	instances, err := daoFactory.DefaultDaoFactory.InstanceDao(nil).ListAllByUserIDForIsolate(userID)
	if err != nil {
		return fmt.Errorf("list user instances: %w", err)
	}
	if len(instances) == 0 {
		logger.Info("pass has no live instance, skipping instance upgrade step")
		return nil
	}

	targetPoolID, targetSKUID, err := instanceasync.ResolveModifyTargetPool(ctx, targetSpecID)
	if err != nil {
		return fmt.Errorf("resolve target pool for spec %q: %w", targetSpecID, err)
	}

	childTasks, err := daoFactory.DefaultDaoFactory.TaskDao(nil).ListByParentTaskID(t.TaskId)
	if err != nil {
		return fmt.Errorf("list child tasks: %w", err)
	}
	dispatched := latestModifyChildPerInstance(childTasks, logger)

	for _, inst := range instances {
		if inst == nil {
			continue
		}
		if ct, ok := dispatched[inst.InstanceId]; ok {
			// 已派发过且仍是终态失败：重派一个新子 task。新 task ID 意味着新的
			// sandbox 幂等键，sandbox 会基于当前实例状态重新派生剩余步骤。
			if ct.TaskState != taskmodel.StateFailed {
				continue
			}
			logger.Warn("previous modify child task failed terminally, dispatching a fresh one",
				zap.String("instance_id", inst.InstanceId),
				zap.String("failed_child_task_id", ct.TaskId),
				zap.String("failed_message", ct.TaskMessage),
			)
		}
		if inst.Status == modelinstance.InstanceStatusDeleted || inst.Status == modelinstance.InstanceStatusFailed {
			continue
		}
		if err := instanceasync.EnqueueModifyInstanceTask(
			ctx,
			taskcommon.ModifyInstanceTaskPayload{
				InstanceID:   inst.InstanceId,
				PassID:       t.in.PassID,
				UserID:       userID,
				SandboxID:    inst.SandboxId,
				TargetSKUID:  targetSKUID,
				TargetPoolID: targetPoolID,
			},
			t.TaskId,
			modifyInstanceTaskExecuteInterval,
			modifyInstanceTaskMaxExecuteCount,
		); err != nil {
			return fmt.Errorf("enqueue modify instance task for %s: %w", inst.InstanceId, err)
		}
		logger.Info("dispatched modify instance child task",
			zap.String("instance_id", inst.InstanceId),
			zap.String("target_pool_id", targetPoolID),
			zap.String("target_sku_id", targetSKUID),
		)
	}

	childTasks, err = daoFactory.DefaultDaoFactory.TaskDao(nil).ListByParentTaskID(t.TaskId)
	if err != nil {
		return fmt.Errorf("re-list child tasks: %w", err)
	}
	// 判定只看每个实例最新的那次派发。重派会给同一实例留下已失败的历史子 task，
	// 把它们也算进 failed 会让父 task 永远卡在这里——pass 停在 modifying、
	// trade_flow 永不收尾，用户付了钱却停在未收敛状态。
	dispatched = latestModifyChildPerInstance(childTasks, logger)
	pending, failed := assessModifyChildren(instances, dispatched)
	if len(failed) > 0 {
		// 不切权益：部分实例还停在启航规格时把套餐升上去，用户会按巡游档位
		// 使用一台 2C4G 的机器。下一轮 execute 会重派这些实例的子 task。
		return fmt.Errorf("modify child task(s) failed %v, holding entitlement commit", failed)
	}
	if pending > 0 {
		logger.Info("modify child tasks pending, will retry parent",
			zap.Int("pending_count", pending),
			zap.Int("total_children", len(childTasks)),
		)
		return fmt.Errorf("waiting for %d modify child task(s)", pending)
	}
	return nil
}

// assessModifyChildren 判定"实例们是否已全部升到目标规格"。
//
// 这是变配链路上唯一决定"能不能切权益"的判断，所以它必须是**保守**的：只有每个
// 在世实例都有一份终态成功的最新子 task 才返回 0 pending / 0 failed。返回非零的
// 任何一种都会让父 task 停在步骤 1，不去动 Bundle / AgentQuota / Plan。
//
// 已 Deleted / Failed 的实例不参与判定：它们不会再被升配，等它们会让 pass 永久
// 卡在 modifying。
func assessModifyChildren(
	instances []*modelinstance.Entity,
	dispatched map[string]*taskmodel.Entity,
) (pending int, failed []string) {
	failed = make([]string, 0)
	for _, inst := range instances {
		if inst == nil || inst.Status == modelinstance.InstanceStatusDeleted ||
			inst.Status == modelinstance.InstanceStatusFailed {
			continue
		}
		ct, ok := dispatched[inst.InstanceId]
		switch {
		case !ok:
			// 本轮没派发成功或 payload 解不出来，下一轮 execute 会补。
			pending++
		case ct.TaskState == taskmodel.StateFailed:
			failed = append(failed, ct.TaskId)
		case !taskmodel.TaskCompleted(ct.TaskState):
			pending++
		}
	}
	return pending, failed
}

// latestModifyChildPerInstance 把子 task 列表折叠成"每个实例最近一次派发"。
//
// 失败重派会给同一个实例留下多份子 task，所以按自增主键取最新的那份；
// ListByParentTaskID 按 task_id 排序，而 task_id 不是单调序列，不能用来判新旧。
func latestModifyChildPerInstance(childTasks []*taskmodel.Entity, logger *zap.Logger) map[string]*taskmodel.Entity {
	latest := make(map[string]*taskmodel.Entity, len(childTasks))
	for _, ct := range childTasks {
		if ct == nil || ct.TaskName != taskcommon.TaskNameModifyInstance {
			continue
		}
		var p taskcommon.ModifyInstanceTaskPayload
		if err := jsonUnmarshal(ct.TaskParams, &p); err != nil {
			logger.Warn("decode modify child task payload failed, skip",
				zap.Error(err), zap.String("child_task_id", ct.TaskId))
			continue
		}
		if p.InstanceID == "" {
			continue
		}
		if prev, ok := latest[p.InstanceID]; ok && taskEntityID(prev) >= taskEntityID(ct) {
			continue
		}
		latest[p.InstanceID] = ct
	}
	return latest
}

func taskEntityID(ct *taskmodel.Entity) int64 {
	if ct == nil || ct.Id == nil {
		return 0
	}
	return *ct.Id
}

// subscriptionIdempotencyKey 用 modify:{dealName}（§7.2 指定）。
// dealName 缺失时（dev/test 直连）退回 flow id，仍然保证同一笔变配只切一次订阅。
func (t *modifyPassTask) subscriptionIdempotencyKey() string {
	if t.in.DealName != "" {
		return "modify:" + t.in.DealName
	}
	return fmt.Sprintf("modify:flow-%d", t.in.TradeFlowID)
}

// notifyModifyFlowCompleted 推进 trade_flow 与 trade_order 到最终状态。
// flowID == 0 时跳过（dev/test 直连）。失败必须返回给父 task，使已经完成 Pass
// 收敛的 task 保持可重试；否则 callback-before-order-insert 会永久留下 pending 订单。
func (t *modifyPassTask) notifyModifyFlowCompleted(logger *zap.Logger) error {
	if t.in == nil || t.in.TradeFlowID == 0 {
		return nil
	}
	callCtx, cancel := context.WithTimeout(context.Background(), tradeCompleteFlowCallTimeout)
	defer cancel()

	completeFlow := t.completeFlow
	if completeFlow == nil {
		completeFlow = adapterfactory.DefaultAdapterFactory.TradeAdapter().CompleteFlow
	}
	if err := completeFlow(callCtx, t.in.TradeFlowID, "completed", ""); err != nil {
		logger.Warn("trade CompleteFlow callback failed; parent task will retry",
			zap.Int64("trade_flow_id", t.in.TradeFlowID),
			zap.Error(err),
		)
		return fmt.Errorf("complete trade modify flow %d: %w", t.in.TradeFlowID, err)
	}
	logger.Info("trade CompleteFlow callback succeeded",
		zap.Int64("trade_flow_id", t.in.TradeFlowID))
	return nil
}

// idempotentCheck 锁竞争场景：pass 已升到目标套餐则直接收口。
func (t *modifyPassTask) idempotentCheck(ctx pctx.Context) (string, error) {
	if t.in == nil || t.in.PassID == "" {
		return "", errors.New("idempotent check: missing pass id")
	}
	if done, err := t.hasFinalizedReceipt(); err != nil {
		return "", err
	} else if done {
		if err := t.notifyModifyFlowCompleted(ctx.Logger()); err != nil {
			return "", err
		}
		return t.markSuccess(ctx)
	}
	passEntity, err := daoFactory.DefaultDaoFactory.PassDao(nil).GetByPassID(t.in.PassID)
	if err != nil {
		ctx.Logger().Warn("modify pass idempotent check: query pass failed",
			zap.Error(err), zap.String("pass_id", t.in.PassID))
		return "", fmt.Errorf("LockTask failed and idempotent check unavailable: %w", err)
	}
	if passEntity.Status == modelpass.StatusActive && passEntity.BundleID == t.in.TargetBundleID {
		ctx.Logger().Info("modify idempotent check: pass already upgraded",
			zap.String("pass_id", t.in.PassID))
		if err := t.notifyModifyFlowCompleted(ctx.Logger()); err != nil {
			return "", err
		}
		return t.markSuccess(ctx)
	}
	return "", fmt.Errorf("LockTask failed, pass status=%s bundle=%s (not yet upgraded)",
		passEntity.Status, passEntity.BundleID)
}

// Always read durable task_params: an MQ delivery may carry a pre-finalization
// payload, even when the same task committed entitlements on an earlier run.
func (t *modifyPassTask) hasFinalizedReceipt() (bool, error) {
	var task taskmodel.Entity
	if err := taskmodel.NewDao().SelectByKeyColumn(t.TaskId, &task); err != nil {
		return false, fmt.Errorf("read finalized modify receipt: %w", err)
	}
	var receipt taskcommon.ModifyPassTaskPayload
	if err := json.Unmarshal([]byte(task.TaskParams), &receipt); err != nil {
		return false, fmt.Errorf("decode finalized modify receipt: %w", err)
	}
	if task.TaskName != taskcommon.TaskNameModifyPass || task.UserID != receipt.UserID ||
		receipt.PassID != t.in.PassID || receipt.UserID != t.in.UserID ||
		receipt.TradeFlowID != t.in.TradeFlowID || receipt.DealName != t.in.DealName ||
		receipt.SourceBundleID != t.in.SourceBundleID || receipt.TargetBundleID != t.in.TargetBundleID {
		return false, errors.New("finalized modify receipt identity mismatch")
	}
	return receipt.EntitlementsFinalized, nil
}

func (t *modifyPassTask) onExecuteFailed(_ string, err error) {
	t.lastExecuteErr = err
	_ = daoFactory.DefaultDaoFactory.TaskDao(nil).UpdateByKeyColumn(map[string]interface{}{
		taskmodel.ColumnTaskMessage: taskmodel.TruncateMessage(err),
	}, t.TaskId)
}

// finalizeFailure 一律走 markRetryable：变配没有回滚链路，也不该自动退款。
// 卡在 modifying 的时长和最近错误通过 pass.status + task_message 可查，由告警和人工介入兜底。
func (t *modifyPassTask) finalizeFailure(ctx pctx.Context) (string, error) {
	err := t.lastExecuteErr
	if err == nil {
		err = errors.New("modify pass task execute failed")
	}
	ctx.Logger().Warn("modify pass transient failure, will be retried by checkTasks bypass",
		zap.Error(err),
		zap.String("pass_id", t.in.PassID),
		zap.Int64("trade_flow_id", t.in.TradeFlowID),
		zap.Int("execute_count", t.TaskEntity.ExecuteCount),
	)
	return t.markRetryable(ctx, taskmodel.TruncateMessage(err))
}

func (t *modifyPassTask) markRetryable(ctx pctx.Context, message string) (string, error) {
	if err := daoFactory.DefaultDaoFactory.TaskDao(ctx).UpdateByKeyColumn(map[string]interface{}{
		taskmodel.ColumnTaskState:   taskmodel.StateCreated,
		taskmodel.ColumnTaskMessage: message,
	}, t.TaskId); err != nil {
		return "", fmt.Errorf("update modify pass task retryable state: %w", err)
	}
	t.TaskEntity.TaskState = taskmodel.StateCreated
	t.TaskEntity.TaskMessage = message
	return taskflow.StepCodeSuccess, nil
}

// exceedMaxExecuteCount 理论不会到达（max=1<<30）。真到了也只标失败留档，
// 不去动 pass 状态：没有回滚路径，机器可能已经是目标规格，回滚只会让账更不平。
func (t *modifyPassTask) exceedMaxExecuteCount(ctx pctx.Context) (string, error) {
	ctx.Logger().Error("modify pass task exceeded max execute count, manual intervention required",
		zap.String("pass_id", t.in.PassID),
		zap.Int64("trade_flow_id", t.in.TradeFlowID),
	)
	return t.completeModifyFailure(ctx, "ExecuteCount greater than or equal to MaxExecuteCount")
}

func (t *modifyPassTask) markSuccess(ctx pctx.Context) (string, error) {
	if err := daoFactory.DefaultDaoFactory.TaskDao(ctx).UpdateByKeyColumn(map[string]interface{}{
		taskmodel.ColumnTaskState:   taskmodel.StateSuccess,
		taskmodel.ColumnTaskMessage: "",
	}, t.TaskId); err != nil {
		return "", fmt.Errorf("update modify pass task success state: %w", err)
	}
	t.TaskEntity.TaskState = taskmodel.StateSuccess
	t.TaskEntity.TaskMessage = ""
	return taskflow.StepCodeSuccess, nil
}

func (t *modifyPassTask) completeModifyFailure(ctx pctx.Context, message string) (string, error) {
	if err := daoFactory.DefaultDaoFactory.TaskDao(ctx).UpdateByKeyColumn(map[string]interface{}{
		taskmodel.ColumnTaskState:   taskmodel.StateFailed,
		taskmodel.ColumnTaskMessage: message,
	}, t.TaskId); err != nil {
		return "", fmt.Errorf("update modify pass task failed state: %w", err)
	}
	t.TaskEntity.TaskState = taskmodel.StateFailed
	t.TaskEntity.TaskMessage = message
	return taskflow.StepCodeSuccess, nil
}
