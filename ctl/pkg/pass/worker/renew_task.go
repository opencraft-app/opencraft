// 设计稿：.tmp/trade-pass-renew-design.md §3.4 / §5 / §12 Q2=a / R-D-3
//
// 父 task RenewPassTask 派发并等待若干个 RenewInstanceTask 子 task 终态后推进 pass.status
// 从 renewing → active，同时一次性写入 expired_time（基线 = expired_time，v1.7.20 B15
// 修订；原设计稿 §12 Q2=a 写 isolated_time 已废弃 — 续费业务语义统一以原到期时间为基线，
// 与 jifei goodsDetail.curDeadline 协议层语义对齐）+ 清空 isolated_time。
package pass

import (
	"context"
	"errors"
	"fmt"
	"time"

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

// === trade-pass-renew 父 task 实现（设计稿 §3.4 / §5 / §12 Q2=a）===
//
// 行为契约（与 IsolatePassTask 对偶 + 续费独有终态收尾）：
//   - 拿到 pass.status==renewing 后被派发（logic.RenewPass 异步分支已 CAS isolated→renewing）
//   - 每轮 execute：
//     1. 列出 user 下所有非 Deleted/Failed 的 instance（复用 ListAllByUserIDForIsolate）
//     2. 通过反查 task.parent_task_id == 当前父 taskID 的 task 集合作为 child_registry，
//     对未派发过的 instance enqueue RenewInstance 子 task（防重派发）
//     3. 检查所有子 task 是否都已到 SUCCESS/FAILED 终态：
//   - 否：返错让 task 框架按 ExecuteInterval 重试
//   - 是：计算 newExpired = CalcExpiredTime(pass.expired_time, TimeSpan, TimeUnit)
//     （基线 = expired_time，v1.7.20 B15 修订；原设计稿 §12 Q2=a 已废弃）
//     然后 FinalizeRenewal CAS 一次性写 status='active' + expired_time + isolated_time=NULL
//     markSuccess
//   - markSuccess 前 best-effort 反向调 trade `/internal/trade/flows/{flow_id}/complete`
//     通知 trade 侧推进 trade_flow 终态（端到端闭环，与 isolate 同范式）；失败仅记日志
//   - max_execute_count = INT64_MAX（与 isolate 父 task 同 "永不放弃"）
//   - lock 时长延长到 30min：单轮枚举可能跨多个 instance + DB 反查 + 多次 enqueue
const (
	renewPassTaskLockSeconds = 1800 // 30 分钟
	// RenewPass 父 task 的子 task 重试节奏：60s/次 × 60 次 = 1h（与 IsolateInstance 子 task 对偶）
	renewInstanceTaskExecuteInterval = int64(60)
	renewInstanceTaskMaxExecuteCount = 60
	// 父 task 自身 ExecuteInterval：30s 已足够（同 instance 默认）
	// MaxExecuteCount（R-MR-6 修订，2026-05-25 用户拍板）：
	//   - 1<<30：与 isolate / destroy 父 task 同范式，"永不放弃"
	//   - 失败回滚仅在两种情况下触发（finalizeFailure 用哨兵 error 区分）：
	//     a) execute 检测到任意 RenewInstance 子 task 自身 max 用尽 markFailed
	//        → 返 errChildTaskTerminalFailed → finalizeFailure 派 RollbackRenewPass + markFailed
	//     b) 父 task 真的 execute_count >= 1<<30（理论永不出现）
	//        → exceedMaxExecuteCount 兜底派 RollbackRenewPass + markFailed
	//   - 其它任何 execute 错误（waiting child / DB 抖动 / ai-gateway 短路 / FinalizeRenewal CAS 等）
	//     一律视为暂态：finalizeFailure 调 markRetryable 把 task_state 回写为 CREATED（非终态），
	//     由 checkTasks bypass 1min 内扫到重投。
	//   - 详见 .tmp/trade-pass-renew-design.md §3.4 R-MR-6 修订。
	renewPassTaskMaxExecuteCount = 1 << 30

	// R-MR-6 回滚 task 的重试节奏：与父 task 对偶 "永不放弃"，由 reconcile worker / 人工介入兜底
	rollbackRenewPassTaskLockSeconds       = 1800
	rollbackRenewPassTaskExecuteInterval   = int64(30)
	rollbackRenewPassTaskMaxExecuteCount   = 1 << 30
	rollbackIsolateInstanceExecuteInterval = int64(60)
	rollbackIsolateInstanceMaxExecuteCount = 60
	tradeCompleteFlowRollbackCallTimeout   = 1500 * time.Millisecond
)

// errChildTaskTerminalFailed 是 RenewPass 父 task execute 检测到任意 RenewInstance 子 task
// 自身 max 用尽 markFailed 时返回的哨兵 error；finalizeFailure 用 errors.Is 判定后
// 派发 RollbackRenewPass。其它任何 execute error 都视为暂态，走 markRetryable 重投。
var errChildTaskTerminalFailed = errors.New("renew: child task terminal failed")

type renewPassTask struct {
	*taskruntime.BaseTask
	in             *taskcommon.RenewPassTaskPayload
	lastExecuteErr error
}

func newRenewPassTask() *renewPassTask {
	task := &renewPassTask{
		BaseTask: taskruntime.NewBaseTask(),
	}
	task.TaskLockSeconds = renewPassTaskLockSeconds
	task.ExceedMaxExecuteCountFunc = task.exceedMaxExecuteCount
	return task
}

// PrepareRenewPassTask 由 processor.factory 注册到 pfMap
func PrepareRenewPassTask(_ pctx.Context, data []byte) (svcTask taskruntime.ServiceTask, in, out interface{}, err error) {
	svcTask = newRenewPassTask()
	in = new(taskcommon.RenewPassTaskPayload)
	err = parseMessageData(data, in)
	return
}

func (t *renewPassTask) Init(in, _ interface{}) error {
	payload, ok := in.(*taskcommon.RenewPassTaskPayload)
	if !ok {
		return fmt.Errorf("unexpected renew pass task payload: %T", in)
	}
	t.in = payload
	return nil
}

func (t *renewPassTask) Name() string         { return taskcommon.TaskNameRenewPass }
func (t *renewPassTask) FirstStepKey() string { return taskruntime.StepKeyLockTask }

func (t *renewPassTask) StepConfigMap() map[string]*taskflow.StepConfig[pctx.Context] {
	// 复用 isolatePassTaskStepConfigMap 的五步骨架：LockTask → idempotentCheck / CheckTask
	// → UpdateTaskExecute → execute → finalizeFailure / UnlockTask
	stepMap := isolatePassTaskStepConfigMap(t.BaseTask, t.execute, t.onExecuteFailed, t.idempotentCheck)
	stepMap[stepKeyFinalizeFailure].StepFunc = t.finalizeFailure
	return stepMap
}

// execute 是父 task 的核心：派发 + 等待 + 终态收尾
func (t *renewPassTask) execute(ctx pctx.Context) (string, error) {
	if t.in == nil || t.in.PassID == "" {
		return "", errors.New("execute: missing pass id")
	}

	logger := ctx.Logger().With(
		zap.String("pass_id", t.in.PassID),
		zap.String("user_id", t.in.UserID),
		zap.String("parent_task_id", t.TaskId),
		zap.Int("time_span", t.in.TimeSpan),
		zap.String("time_unit", t.in.TimeUnit),
	)

	passDao := daoFactory.DefaultDaoFactory.PassDao(nil)
	passEntity, err := passDao.GetByPassID(t.in.PassID)
	if err != nil {
		return "", fmt.Errorf("get pass: %w", err)
	}

	// 已经到达终态：上一次 execute 已 FinalizeRenewal 推进 active，本次只需 markSuccess
	if passEntity.Status == modelpass.StatusActive {
		logger.Info("pass already active, short-circuit parent task")

		// === R-MR-5 ai-gateway short-circuit 修复（2026-05-24 用户拍板）===
		//
		// Bug 场景（用户报告 ai-gateway pipeline 报错）：
		//  1. 上一轮 execute：FinalizeRenewal 成功（pass→active）→ AlignAiGatewaySubscriptionPeriodEnd
		//     失败（ai-gateway 502/route 404 等）→ execute 返错让父 task 重投。
		//  2. 本轮 execute：进入 short-circuit 分支（status==active 已成立）→ 旧代码直接
		//     markSuccess 跳过 Align → ai-gateway PeriodEnd 永远停留在旧值 → scheduler 5min
		//     内标 expired → AI 服务断档。
		//
		// 修复：short-circuit 分支也调一次 Align。幂等性由 ai-gateway ExtendSubscription
		// 的 "等值即 no-op、不等强制覆盖" 语义保证（2026-05-24 升级）：
		//  - 如果上一轮 Align 实际成功了 → 本轮 ExtendSubscription 看到等值返 updated=false（no-op）；
		//  - 如果上一轮 Align 失败了    → 本轮强制覆盖到正确的 newExpired（即当前 pass.expired_time）。
		//
		// 失败处理：Align 仍失败 → return err 让父 task 继续重投到 max=5（与正常路径一致）；
		// 不进 markSuccess short-circuit，避免 short-circuit 把 ai-gateway 失败"吞掉"。
		if t.in.UserID != "" {
			if err := logicpass.AlignAiGatewaySubscriptionPeriodEnd(logger, t.in.UserID, t.in.PassID, passEntity.ExpiredTime); err != nil {
				return "", fmt.Errorf("short-circuit re-align ai-gateway subscription: %w", err)
			}
		}

		// pass 终态但 trade callback 上一轮可能没成功，best-effort 再补一次
		t.notifyTradeFlowCompleted(ctx, logger)
		return t.markSuccess(ctx)
	}
	if passEntity.Status != modelpass.StatusRenewing {
		// 状态被外部干预（不太可能，但防御性返错）
		return "", fmt.Errorf("pass status unexpected: %s (expect renewing)", passEntity.Status)
	}

	// 1. 列出该 user 下所有非 Deleted/Failed 的 instance
	instanceDao := daoFactory.DefaultDaoFactory.InstanceDao(nil)
	userID := t.in.UserID
	if userID == "" {
		userID = passEntity.UserID
	}
	instances, err := instanceDao.ListAllByUserIDForIsolate(userID)
	if err != nil {
		return "", fmt.Errorf("list user instances: %w", err)
	}

	// 2. 反查已派发的子 task（child_registry）
	childTasks, err := daoFactory.DefaultDaoFactory.TaskDao(nil).ListByParentTaskID(t.TaskId)
	if err != nil {
		return "", fmt.Errorf("list child tasks: %w", err)
	}

	// 解析子 task payload，提取 instance_id 集合
	dispatched := make(map[string]*taskmodel.Entity, len(childTasks))
	for _, ct := range childTasks {
		if ct.TaskName != taskcommon.TaskNameRenewInstance {
			continue
		}
		var p taskcommon.RenewInstanceTaskPayload
		if err := jsonUnmarshal(ct.TaskParams, &p); err != nil {
			logger.Warn("decode child task payload failed, skip",
				zap.Error(err), zap.String("child_task_id", ct.TaskId))
			continue
		}
		if p.InstanceID != "" {
			dispatched[p.InstanceID] = ct
		}
	}

	// 3. 对未派发过的 instance enqueue RenewInstance 子 task
	for _, inst := range instances {
		if _, ok := dispatched[inst.InstanceId]; ok {
			continue
		}
		// instance 处于 Running/Deleted/Failed 终态时跳过派发
		// 续费子 task 的目标是 Paused → Running（与 isolate 子 task 的 Running → Paused 对偶反向）
		if inst.Status == modelinstance.InstanceStatusRunning ||
			inst.Status == modelinstance.InstanceStatusDeleted ||
			inst.Status == modelinstance.InstanceStatusFailed {
			continue
		}
		if err := instanceasync.EnqueueRenewInstanceTask(
			ctx,
			inst.InstanceId,
			t.in.PassID,
			userID,
			t.in.OperationID,
			t.TaskId,
			renewInstanceTaskExecuteInterval,
			renewInstanceTaskMaxExecuteCount,
		); err != nil {
			// 派发失败让父 task 重试整轮（下一次 execute 会基于 child_registry 跳过已派发的）
			return "", fmt.Errorf("enqueue renew instance task for %s: %w", inst.InstanceId, err)
		}
		logger.Info("dispatched renew instance child task", zap.String("instance_id", inst.InstanceId))
	}

	// 4. 检查所有子 task 是否都终态
	childTasks, err = daoFactory.DefaultDaoFactory.TaskDao(nil).ListByParentTaskID(t.TaskId)
	if err != nil {
		return "", fmt.Errorf("re-list child tasks: %w", err)
	}
	pendingCount := 0
	failedChildIDs := make([]string, 0)
	for _, ct := range childTasks {
		if ct.TaskName != taskcommon.TaskNameRenewInstance {
			continue
		}
		if ct.TaskState == taskmodel.StateFailed {
			failedChildIDs = append(failedChildIDs, ct.TaskId)
			continue
		}
		if !taskmodel.TaskCompleted(ct.TaskState) {
			pendingCount++
		}
	}
	// R-MR-6：任一子 task 自身 max 用尽 markFailed → 终态失败 → 哨兵触发 rollback
	if len(failedChildIDs) > 0 {
		logger.Error("child renew instance task(s) terminal failed, will dispatch rollback",
			zap.Strings("failed_child_task_ids", failedChildIDs),
		)
		return "", fmt.Errorf("child renew instance task(s) failed %v: %w", failedChildIDs, errChildTaskTerminalFailed)
	}
	if pendingCount > 0 {
		// 还有子 task 在跑（暂态）：父 task 不带哨兵返错 → finalizeFailure 走 markRetryable
		// → checkTasks bypass 重投。框架的 ExecuteInterval(30s) 在父 task task_state 回 CREATED
		// 后由 bypass 扫到再重投。
		logger.Info("child tasks pending, will retry parent",
			zap.Int("pending_count", pendingCount),
			zap.Int("total_children", len(childTasks)),
		)
		return "", fmt.Errorf("waiting for %d child task(s)", pendingCount)
	}

	// 5. 全部子 task 终态 → 计算 newExpired + FinalizeRenewal CAS
	//
	// **续费基线修订（v1.7.20 B15，2026-05-20 用户拍板）**：
	// 基线 = passEntity.ExpiredTime（原到期时间），不是 IsolatedTime（隔离时刻）。
	//
	// 推翻历史设计稿 §12 Q2=a "基线=isolated_time" 的原因：
	//   - jifei 续费协议（PDF §4.3 goodsDetail.curDeadline）把 "原资源到期时间" 作为续费基线
	//     传给 jifei，jifei 据此计算询价与剩余时长 — 即 jifei 与 ctl 必须以 expired_time 为同一基线
	//     才能保证 ctl pass.expired_time 与 jifei 端订单时长完全一致（不会出现 ctl 给 1 个月
	//     而 jifei 计算的是从隔离时刻起 1 个月的漂移）。
	//   - "原到期时间" 是续费业务语义的真源（无论 pass active 还是 isolated 续费）；
	//     isolated_time 只是 "什么时候被隔离的" 审计时刻，不参与续费时长计算。
	//   - 两个 SoT（trade.curDeadline 用 expired_time / ctl finalize 用 isolated_time）会让
	//     R-MR-4 ai-gateway ExtendSubscription 的 newExpired 与 jifei 实际计费时长漂移。
	//
	// 防御：passEntity.ExpiredTime 在 active / isolated 续费场景下必非零（DB NOT NULL 约束）
	if passEntity.ExpiredTime.IsZero() {
		// 数据漂移：renewing 状态但 expired_time 为零值 — 防御性返错让 reconcile 兜底
		// （理论不会出现：DDL pass.expired_time NOT NULL，CAS 进 renewing 前必有值）
		return "", fmt.Errorf("pass expired_time is zero while status=renewing — data corruption?")
	}
	newExpired, err := logicpass.CalcExpiredTime(passEntity.ExpiredTime, t.in.TimeSpan, t.in.TimeUnit)
	if err != nil {
		return "", fmt.Errorf("calc new expired_time: %w", err)
	}

	updated, err := passDao.FinalizeRenewal(t.in.PassID, newExpired)
	if err != nil {
		return "", fmt.Errorf("FinalizeRenewal: %w", err)
	}
	if !updated {
		// CAS 失败：可能并发已被推到 active；记录后兜底为成功（与 isolate UpdateStatus 同范式）
		logger.Warn("FinalizeRenewal affected 0 rows, treat as success (already terminal)")
	}
	logger.Info("renew pass parent task completed",
		zap.Time("new_expired_time", newExpired),
		zap.Time("expired_time_baseline", passEntity.ExpiredTime), // v1.7.20 B15: 基线改用 expired_time
	)

	// R-MR-4 续费链路接 ai-gateway ExtendSubscription（强一致 + CAS 幂等）：
	// 把 newExpired 镜像到 ai-gateway，让 ai-gateway 端 PeriodEnd 与 ctl pass.expired_time 完全对齐。
	// 失败必须父 task fail 重试 — 否则 PeriodEnd 没推进 → ai-gateway scheduler 5min
	// 内会标 expired → AI 服务断档。详见 logicpass.AlignAiGatewaySubscriptionPeriodEnd doc。
	if t.in.UserID != "" {
		if err := logicpass.AlignAiGatewaySubscriptionPeriodEnd(logger, t.in.UserID, t.in.PassID, newExpired); err != nil {
			return "", fmt.Errorf("extend ai-gateway subscription: %w", err)
		}
	}

	// best-effort 反向调 trade callback 推进 trade_flow 终态
	t.notifyTradeFlowCompleted(ctx, logger)
	return t.markSuccess(ctx)
}

// extendAiGatewaySubscription R-MR-4 续费链路另一个调用点已迁移到 logic/pass
// 包内 AlignAiGatewaySubscriptionPeriodEnd helper，以便与同步 active 分支共享实现（续费同步分
// 支原本漏调 ai-gateway 是 bug，见 .tmp/trade-pass-renew-integration-runbook.md §2.5）。
//
// 本处保留空阐述作为变更错错反面设计重点，帮助后续阅读者快速定位本次抽取出去的公
// 用 helper。下一个跳过本 helper 独立重构切片可反向删除本注释。

// notifyTradeFlowCompleted best-effort 调 trade /internal/trade/flows/{flow_id}/complete
//
// 与 isolatePassTask.notifyTradeFlowCompleted 同范式：
//   - TradeFlowID == 0 时直接跳过（dev/test 兼容）
//   - 调 1.5s 超时（与 §6 CTLCallTimeout 对齐）；2xx → 记 Info；非 2xx / 网络错 → 记 Warn 不阻塞
//   - trade 侧另有 reconcile worker 周期性扫描 stuck trade_flow 兜底
func (t *renewPassTask) notifyTradeFlowCompleted(_ pctx.Context, logger *zap.Logger) {
	if t.in == nil || t.in.TradeFlowID == 0 {
		return
	}
	flowID := t.in.TradeFlowID

	callCtx, cancel := context.WithTimeout(context.Background(), tradeCompleteFlowCallTimeout)
	defer cancel()

	tradeAdapter := adapterfactory.DefaultAdapterFactory.TradeAdapter()
	if err := tradeAdapter.CompleteFlow(callCtx, flowID, "completed", ""); err != nil {
		logger.Warn("trade CompleteFlow callback failed (best-effort, parent task still proceeds)",
			zap.Int64("trade_flow_id", flowID),
			zap.Error(err),
		)
		return
	}
	logger.Info("trade CompleteFlow callback succeeded",
		zap.Int64("trade_flow_id", flowID),
	)
}

// notifyTradeFlowFailed R-MR-5 续费失败回滚收尾的 trade callback（2026-05-24 用户拍板）。
//
// 与 notifyTradeFlowCompleted 对偶反向：调用 trade.CompleteFlow(flowID, "failed", reason)
// 把 trade_flow.status 推进到 'failed'，让 jifei 计费查询 trade_flow 状态时自动触发退款。
//
// 共性：
//   - flowID == 0 时直接跳过（dev/test 兼容）
//   - 1.5s 超时（与 notifyTradeFlowCompleted 同步）
//   - best-effort：失败仅记 Warn 不阻塞回滚 task；trade reconcile worker 兜底
//
// 差异：
//   - result 字段传 "failed" → trade 端 R-MR-5 升级后会路由到 MarkFailedByID
//     （trade-side commit 6f821e20 已上线 sandbox-bj-7）
//   - reason 字段携带原 renewPassTask 最后一次 execute 错误（FailureReason），
//     落 trade_flow.response_body 便于 jifei / 排障侧定位失败原因
//
// 注意：本函数定义在 renewPassTask 上是为了与 notifyTradeFlowCompleted 共用 import / helper 风格；
// 实际调用方是 rollbackRenewPassTask（同 package 内可直接复用，方法接收器对外不可见无影响）。
func notifyTradeFlowFailed(logger *zap.Logger, flowID int64, reason string) {
	if flowID == 0 {
		return
	}
	callCtx, cancel := context.WithTimeout(context.Background(), tradeCompleteFlowRollbackCallTimeout)
	defer cancel()

	tradeAdapter := adapterfactory.DefaultAdapterFactory.TradeAdapter()
	if err := tradeAdapter.CompleteFlow(callCtx, flowID, "failed", reason); err != nil {
		logger.Warn("trade CompleteFlow(failed) callback failed (best-effort, rollback task still proceeds)",
			zap.Int64("trade_flow_id", flowID),
			zap.String("reason", reason),
			zap.Error(err),
		)
		return
	}
	logger.Info("trade CompleteFlow(failed) callback succeeded — jifei refund will be triggered",
		zap.Int64("trade_flow_id", flowID),
		zap.String("reason", reason),
	)
}

// idempotentCheck 锁竞争场景：检查 pass 是否已 active；若是 → markSuccess
func (t *renewPassTask) idempotentCheck(ctx pctx.Context) (string, error) {
	if t.in == nil || t.in.PassID == "" {
		return "", errors.New("idempotent check: missing pass id")
	}
	passEntity, err := daoFactory.DefaultDaoFactory.PassDao(nil).GetByPassID(t.in.PassID)
	if err != nil {
		ctx.Logger().Warn("renew pass idempotent check: query pass failed",
			zap.Error(err), zap.String("pass_id", t.in.PassID))
		return "", fmt.Errorf("LockTask failed and idempotent check unavailable: %w", err)
	}
	if passEntity.Status == modelpass.StatusActive {
		ctx.Logger().Info("idempotent check: pass already active (renewal completed)",
			zap.String("pass_id", t.in.PassID))
		// pass 已经 active，但 trade 侧 trade_flow 可能还停在 in_progress，best-effort 再补一次
		t.notifyTradeFlowCompleted(ctx, ctx.Logger())
		return t.markSuccess(ctx)
	}
	return "", fmt.Errorf("LockTask failed, pass status=%s (not yet active)", passEntity.Status)
}

func (t *renewPassTask) onExecuteFailed(_ string, err error) {
	t.lastExecuteErr = err
	_ = daoFactory.DefaultDaoFactory.TaskDao(nil).UpdateByKeyColumn(map[string]interface{}{
		taskmodel.ColumnTaskMessage: taskmodel.TruncateMessage(err),
	}, t.TaskId)
}

// finalizeFailure RenewPass 父 task R-MR-6 修订（2026-05-25 用户拍板）：
//
// R-MR-5（旧）：execute 失败 5 次后立即 markFailed + 派 rollback。问题：
//   - max=5 太短，连"等 RenewInstance 子 task 自身 60 次 1h 重试窗口"都等不到
//     → 父 task 先于子 task 失败 → 提前触发 rollback
//   - finalizeFailure 不区分 "暂态/终态" 错误，pending child / DB 抖动 / ai-gateway 短路
//     都被当成终态失败派 rollback → 噪声大、jifei 退款被错误触发
//
// R-MR-6（新）：父 task max=1<<30 "永不放弃"（与 isolate / destroy 父 task 同范式）。
// finalizeFailure 用哨兵 error 区分两类失败：
//
//  1. errors.Is(lastExecuteErr, errChildTaskTerminalFailed) → 终态失败：
//     execute 检测到任意 RenewInstance 子 task 自身 max 用尽 markFailed →
//     派 RollbackRenewPassTask + 父 task markFailed（保持原 R-MR-5 行为）。
//     这是回滚链路的唯一触发入口（execute 路径）。
//
//  2. 其它任何 error（waiting child / DB 抖动 / ai-gateway 短路 / FinalizeRenewal CAS / 网络抖动）
//     → 暂态：调 markRetryable 把 task_state 回写为 CREATED（非终态），
//     由 checkTasks bypass（ctl/pkg/bypass/check_tasks.go）1min 内扫到重投。
//     绝不派 rollback，绝不 markFailed。
//
// 兜底：父 task 真的 execute_count >= 1<<30（理论永不出现）→ exceedMaxExecuteCount
// 仍然派 rollback + failTask，避免 "父 task 永远卡住" 雪崩。
func (t *renewPassTask) finalizeFailure(ctx pctx.Context) (string, error) {
	err := t.lastExecuteErr
	if err == nil {
		err = errors.New("renew pass task execute failed")
	}
	logger := ctx.Logger().With(
		zap.String("pass_id", t.in.PassID),
		zap.String("user_id", t.in.UserID),
		zap.String("parent_task_id", t.TaskId),
		zap.Int("execute_count", t.TaskEntity.ExecuteCount),
	)

	// 暂态失败（绝大多数情况）：markRetryable + checkTasks bypass 重投，绝不派 rollback。
	if !errors.Is(err, errChildTaskTerminalFailed) {
		logger.Warn("renew pass transient failure, will be retried by checkTasks bypass",
			zap.Error(err),
		)
		return t.markRetryable(ctx, taskmodel.TruncateMessage(err))
	}

	// 终态失败（子 task 真终态 FAILED）：派 RollbackRenewPassTask + markFailed。
	logger.Error("renew pass terminal failure (child task FAILED), dispatching rollback (R-MR-6)",
		zap.Error(err),
	)
	return t.dispatchRollbackAndMarkFailed(ctx, logger, err)
}

// dispatchRollbackAndMarkFailed 派发 RollbackRenewPassTask 并 markFailed。
// 由 finalizeFailure（哨兵命中）和 exceedMaxExecuteCount（兜底）共用。
func (t *renewPassTask) dispatchRollbackAndMarkFailed(ctx pctx.Context, logger *zap.Logger, cause error) (string, error) {
	if t.in != nil && !t.in.OriginalExpiredTime.IsZero() {
		rollbackTaskID, enqErr := instanceasync.EnqueueRollbackRenewPassTask(
			ctx,
			t.in.PassID,
			t.in.UserID,
			t.in.OperationID,
			t.in.TradeFlowID,
			t.in.OriginalExpiredTime,
			t.in.OriginalIsolatedTime,
			taskmodel.TruncateMessage(cause),
			t.TaskId, // 原父 taskID 作为 OriginalParentTaskID 透传
			rollbackRenewPassTaskExecuteInterval,
			rollbackRenewPassTaskMaxExecuteCount,
		)
		if enqErr != nil {
			logger.Error("dispatch rollback renew pass task failed (reconcile worker fallback)",
				zap.Error(enqErr),
			)
		} else {
			logger.Info("rollback renew pass task dispatched",
				zap.String("rollback_task_id", rollbackTaskID),
			)
		}
	} else {
		// payload 缺基线（理论不会出现，EnqueueRenewPassTask 入口已校验非零）：
		// 跳过回滚 task 派发，仅 markFailed；reconcile worker 兜底人工介入。
		logger.Error("rollback baseline missing in payload, skip enqueueing rollback task",
			zap.Bool("payload_nil", t.in == nil),
		)
	}

	return t.completeTaskFailure(ctx, taskmodel.TruncateMessage(cause))
}

// markRetryable 把 task_state 回写为 CREATED（非终态）+ 写入诊断 task_message。
//
// 与 completeTaskFailure 的区别（与 isolate_task / destroy_task markRetryable 同范式）：
//   - completeTaskFailure：task_state=FAILED（终态）→ checkTasks bypass 不再扫 → 链路死亡
//   - markRetryable：task_state=CREATED（非终态）→ checkTasks bypass 1 分钟后扫到 →
//     把 task 重投回 MQ → 父 task 框架按 ExecuteInterval(30s) 重投，max_execute_count 兜底
func (t *renewPassTask) markRetryable(ctx pctx.Context, message string) (string, error) {
	if err := daoFactory.DefaultDaoFactory.TaskDao(ctx).UpdateByKeyColumn(map[string]interface{}{
		taskmodel.ColumnTaskState:   taskmodel.StateCreated,
		taskmodel.ColumnTaskMessage: message,
	}, t.TaskId); err != nil {
		return "", fmt.Errorf("update renew pass task retryable state: %w", err)
	}
	t.TaskEntity.TaskState = taskmodel.StateCreated
	t.TaskEntity.TaskMessage = message
	return taskflow.StepCodeSuccess, nil
}

// exceedMaxExecuteCount R-MR-6 兜底：父 task max=1<<30 真的用尽（理论永不出现）。
// 仍然派 RollbackRenewPassTask + markFailed，避免 "父 task 永远卡住" 雪崩。
func (t *renewPassTask) exceedMaxExecuteCount(ctx pctx.Context) (string, error) {
	logger := ctx.Logger().With(
		zap.String("pass_id", t.in.PassID),
		zap.String("user_id", t.in.UserID),
		zap.String("parent_task_id", t.TaskId),
	)
	logger.Error("renew pass task exceeded max execute count (should never happen, dispatching rollback as last resort)")
	cause := errors.New("ExecuteCount greater than or equal to MaxExecuteCount")
	return t.dispatchRollbackAndMarkFailed(ctx, logger, cause)
}

func (t *renewPassTask) failTask(ctx pctx.Context, message string) (string, error) {
	if _, err := t.completeTaskFailure(ctx, message); err != nil {
		return "", err
	}
	return "", errors.New(message)
}

func (t *renewPassTask) markSuccess(ctx pctx.Context) (string, error) {
	if err := daoFactory.DefaultDaoFactory.TaskDao(ctx).UpdateByKeyColumn(map[string]interface{}{
		taskmodel.ColumnTaskState:   taskmodel.StateSuccess,
		taskmodel.ColumnTaskMessage: "",
	}, t.TaskId); err != nil {
		return "", fmt.Errorf("update renew pass task success state: %w", err)
	}
	t.TaskEntity.TaskState = taskmodel.StateSuccess
	t.TaskEntity.TaskMessage = ""
	return taskflow.StepCodeSuccess, nil
}

func (t *renewPassTask) completeTaskFailure(ctx pctx.Context, message string) (string, error) {
	if err := daoFactory.DefaultDaoFactory.TaskDao(ctx).UpdateByKeyColumn(map[string]interface{}{
		taskmodel.ColumnTaskState:       taskmodel.StateFailed,
		taskmodel.ColumnTaskMessage:     message,
		taskmodel.ColumnLastExecuteTime: time.Now().UTC(),
	}, t.TaskId); err != nil {
		return "", fmt.Errorf("update renew pass task failed state: %w", err)
	}
	t.TaskEntity.TaskState = taskmodel.StateFailed
	t.TaskEntity.TaskMessage = message
	return taskflow.StepCodeSuccess, nil
}
