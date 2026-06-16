// Package pass 实现 pass 相关的后台 task worker。
//
// 父 task IsolatePass 派发并等待若干个 IsolateInstance 子 task 终态后推进 pass.status
// 从 isolating → isolated。设计稿：.tmp/trade-pass-isolate-design.md §10 Q22-I-E / Q35。
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

// === trade-pass-isolate 父 task 实现（设计稿 §10 Q22-I-E / Q35）===
//
// 行为契约：
//   - 拿到 pass.status==isolating 后被派发（IsolatePass logic 入口已 CAS active→isolating）
//   - 每轮 execute：
//     1. 列出 user 下所有非 Deleted/Failed 的 instance
//     2. 通过反查 task.parent_task_id == 当前父 taskID 的 task 集合作为 child_registry，
//     对未派发过的 instance enqueue IsolateInstance 子 task（防重派发）
//     3. 检查所有子 task 是否都已到 SUCCESS/FAILED 终态：
//   - 否：返错让 task 框架按 ExecuteInterval 重试
//   - 是：CAS pass.status isolating → isolated，markSuccess
//   - markSuccess 前 best-effort 反向调 trade `/internal/trade/flows/{flow_id}/complete`
//     通知 trade 侧推进 trade_flow 终态（端到端闭环 2026-05-15）；失败仅记日志，
//     不阻塞 markSuccess（trade 侧另有 reconcile worker 兜底）
//   - max_execute_count = INT64_MAX（Q35=a 兜底，永不"放弃"，由 reconcile worker 收拾僵尸）
//   - lock 时长延长到 30min：单轮枚举可能跨多个 instance + DB 反查 + 多次 enqueue
const (
	isolatePassTaskLockSeconds = 1800 // 30 分钟
	// IsolatePass 父 task 的子 task 重试节奏：60s/次 × 60 次 = 1h（Q22-I-D）
	isolateInstanceTaskExecuteInterval = int64(60)
	isolateInstanceTaskMaxExecuteCount = 60
	// 父 task 自身 ExecuteInterval：30s 已足够（同 instance 默认）
	// MaxExecuteCount：使用接近 int 上限的兜底值（Q35=a 修订版）
	// MySQL int(11) 范围 ≈ 2.1B，子 task 1h 终态 → 父 task 实际重试次数也只在十几次量级
	isolatePassTaskMaxExecuteCount = 1 << 30 // ~1B 次，配合 30s interval = 兜底等价于"不放弃"

	// trade callback 调用上限：1.5s 与 §6 设计稿 CTLCallTimeout 对齐
	tradeCompleteFlowCallTimeout = 1500 * time.Millisecond
)

type isolatePassTask struct {
	*taskruntime.BaseTask
	in             *taskcommon.IsolatePassTaskPayload
	lastExecuteErr error
}

func newIsolatePassTask() *isolatePassTask {
	task := &isolatePassTask{
		BaseTask: taskruntime.NewBaseTask(),
	}
	task.TaskLockSeconds = isolatePassTaskLockSeconds
	task.ExceedMaxExecuteCountFunc = task.exceedMaxExecuteCount
	return task
}

// PrepareIsolatePassTask 由 processor.factory 注册到 pfMap
func PrepareIsolatePassTask(_ pctx.Context, data []byte) (svcTask taskruntime.ServiceTask, in, out interface{}, err error) {
	svcTask = newIsolatePassTask()
	in = new(taskcommon.IsolatePassTaskPayload)
	err = parseMessageData(data, in)
	return
}

func (t *isolatePassTask) Init(in, _ interface{}) error {
	payload, ok := in.(*taskcommon.IsolatePassTaskPayload)
	if !ok {
		return fmt.Errorf("unexpected isolate pass task payload: %T", in)
	}
	t.in = payload
	return nil
}

func (t *isolatePassTask) Name() string         { return taskcommon.TaskNameIsolatePass }
func (t *isolatePassTask) FirstStepKey() string { return taskruntime.StepKeyLockTask }

func (t *isolatePassTask) StepConfigMap() map[string]*taskflow.StepConfig[pctx.Context] {
	stepMap := isolatePassTaskStepConfigMap(t.BaseTask, t.execute, t.onExecuteFailed, t.idempotentCheck)
	stepMap[stepKeyFinalizeFailure].StepFunc = t.finalizeFailure
	return stepMap
}

const stepKeyIdempotentCheck = "IdempotentCheck"
const stepKeyFinalizeFailure = "FinalizeFailure"

// isolatePassTaskStepConfigMap 复用与 instance worker 相同的五步骨架
func isolatePassTaskStepConfigMap(base *taskruntime.BaseTask, execute taskflow.StepFunc[pctx.Context], onFailed taskflow.StepFailedFunc, idempotentCheck taskflow.StepFunc[pctx.Context]) map[string]*taskflow.StepConfig[pctx.Context] {
	return map[string]*taskflow.StepConfig[pctx.Context]{
		taskruntime.StepKeyLockTask: {
			RetryCnt:   5,
			RetryDelay: 3 * time.Second,
			StepFunc:   base.LockTask,
			RouteMap: map[string]string{
				taskflow.StepCodeSuccess: taskruntime.StepKeyCheckTask,
				taskflow.StepCodeFailure: stepKeyIdempotentCheck,
			},
		},
		stepKeyIdempotentCheck: {
			StepFunc: idempotentCheck,
			RouteMap: map[string]string{
				taskflow.StepCodeSuccess: "",
				taskflow.StepCodeFailure: "",
			},
		},
		taskruntime.StepKeyCheckTask: {
			StepFunc: base.CheckTask,
			RouteMap: map[string]string{
				taskflow.StepCodeSuccess: taskruntime.StepKeyUpdateTaskExecute,
				taskflow.StepCodeFailure: taskruntime.StepKeyUnlockTask,
			},
		},
		taskruntime.StepKeyUpdateTaskExecute: {
			StepFunc: base.UpdateTaskExecute,
			RouteMap: map[string]string{
				taskflow.StepCodeSuccess: "Execute",
				taskflow.StepCodeFailure: taskruntime.StepKeyUnlockTask,
			},
		},
		"Execute": {
			StepFunc:       execute,
			StepFailedFunc: onFailed,
			RouteMap: map[string]string{
				taskflow.StepCodeSuccess: taskruntime.StepKeyUnlockTask,
				taskflow.StepCodeFailure: stepKeyFinalizeFailure,
			},
		},
		stepKeyFinalizeFailure: {
			RouteMap: map[string]string{
				taskflow.StepCodeSuccess: taskruntime.StepKeyUnlockTask,
				taskflow.StepCodeFailure: taskruntime.StepKeyUnlockTask,
			},
		},
		taskruntime.StepKeyUnlockTask: {
			StepFunc: base.UnlockTask,
			RouteMap: map[string]string{
				taskflow.StepCodeSuccess: "",
				taskflow.StepCodeFailure: "",
			},
		},
	}
}

// execute 是父 task 的核心：派发 + 等待 + 推进
func (t *isolatePassTask) execute(ctx pctx.Context) (string, error) {
	if t.in == nil || t.in.PassID == "" {
		return "", errors.New("execute: missing pass id")
	}

	logger := ctx.Logger().With(
		zap.String("pass_id", t.in.PassID),
		zap.String("user_id", t.in.UserID),
		zap.String("parent_task_id", t.TaskId),
	)

	passDao := daoFactory.DefaultDaoFactory.PassDao(nil)
	passEntity, err := passDao.GetByPassID(t.in.PassID)
	if err != nil {
		return "", fmt.Errorf("get pass: %w", err)
	}

	// 已经到达终态：上一次 execute 已 CAS isolating → isolated，本次只需 markSuccess
	if passEntity.Status == modelpass.StatusIsolated {
		logger.Info("pass already isolated, short-circuit parent task")
		// pass 终态但 trade callback 上一轮可能没成功，best-effort 再补一次
		t.notifyTradeFlowCompleted(ctx, logger)
		return t.markSuccess(ctx)
	}
	if passEntity.Status != modelpass.StatusIsolating {
		// 状态被外部干预（不太可能，但防御性返错）
		return "", fmt.Errorf("pass status unexpected: %s (expect isolating)", passEntity.Status)
	}

	// 1. 列出该 user 下所有非 Deleted/Failed 的 instance
	instanceDao := daoFactory.DefaultDaoFactory.InstanceDao(nil)
	userID := t.in.UserID
	if userID == "" {
		// 兜底：从 pass 反查 user
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

	// 解析子 task payload，提取 instance_id 集合。
	//
	// I-MR-1 修复（Bug A）：FAILED 终态的子 task 不计入 dispatched，
	// 让 step 3 把它当成"未派发"重新派一个新子 task。这样运维只需重启 sandbox
	// 等下游恢复，无需手动 reset 子 task 状态。配合子 task markRetryable + max=60，
	// 整条隔离链路具备从短暂故障自愈的能力。
	dispatched := make(map[string]*taskmodel.Entity, len(childTasks))
	for _, ct := range childTasks {
		if ct.TaskName != taskcommon.TaskNameIsolateInstance {
			continue
		}
		if ct.TaskState == taskmodel.StateFailed {
			// 终态失败子 task：跳过登记，让 step 3 重派新子覆盖（I-MR-1 自愈）
			continue
		}
		var p taskcommon.IsolateInstanceTaskPayload
		if err := jsonUnmarshal(ct.TaskParams, &p); err != nil {
			logger.Warn("decode child task payload failed, skip",
				zap.Error(err), zap.String("child_task_id", ct.TaskId))
			continue
		}
		if p.InstanceID != "" {
			dispatched[p.InstanceID] = ct
		}
	}

	// 3. 对未派发过的 instance enqueue IsolateInstance 子 task
	for _, inst := range instances {
		if _, ok := dispatched[inst.InstanceId]; ok {
			continue
		}
		// instance 处于 Paused/Deleted/Failed 终态时跳过派发
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
			t.TaskId,
			isolateInstanceTaskExecuteInterval,
			isolateInstanceTaskMaxExecuteCount,
		); err != nil {
			// 派发失败让父 task 重试整轮（下一次 execute 会基于 child_registry 跳过已派发的）
			return "", fmt.Errorf("enqueue isolate instance task for %s: %w", inst.InstanceId, err)
		}
		logger.Info("dispatched isolate instance child task", zap.String("instance_id", inst.InstanceId))
	}

	// 4. 检查所有子 task 是否都终态 SUCCESS
	//
	// I-MR-1 修复（Bug A）：原实现用 TaskCompleted（SUCCESS or FAILED 都算"完成"）
	// 导致子 FAILED 时父也声明 SUCCESS，pass=isolated 但 instance 仍 Running 的虚假隔离。
	// 修订：只有 SUCCESS 才算"实际完成"；FAILED 被当成 pending 让父 task 继续重投，
	// 下一轮 dispatch 阶段会因 dispatched map 不再包含该 instance 而重新 enqueue 新子 task。
	// 重新 ListByParentTaskID 拿最新视图（包含本轮 enqueue 的）
	childTasks, err = daoFactory.DefaultDaoFactory.TaskDao(nil).ListByParentTaskID(t.TaskId)
	if err != nil {
		return "", fmt.Errorf("re-list child tasks: %w", err)
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
			// 终态失败：在下一轮 execute 重新派子 task（dispatched map 已剔除）
			failedCount++
		default:
			// CREATED / RUNNING：仍在跑
			pendingCount++
		}
	}
	if pendingCount > 0 || failedCount > 0 {
		// 还有子 task 在跑或有 FAILED 待重派，让框架按 30s ExecuteInterval 重试
		logger.Info("child tasks not all SUCCESS, will retry parent",
			zap.Int("pending_count", pendingCount),
			zap.Int("failed_count", failedCount),
			zap.Int("total_children", len(childTasks)),
		)
		return "", fmt.Errorf("waiting for %d pending + %d failed-to-redispatch child task(s)", pendingCount, failedCount)
	}

	// 5. 全部子 task 终态 → CAS isolating → isolated
	//
	// 设计稿：trade-pass-isolate-design.md §11-Q22 钦点 — 父 task 终态须同时写
	// status='isolated' + isolated_time=NOW()（不再视 isolated_time 为"预留字段"）。
	//
	// v1.7.30 BUG-35 退费分支扩展：
	//   - NewDeadline == nil  → 生命周期隔离场景；走 MarkIsolated 同事务写 status + isolated_time
	//   - NewDeadline != nil  → 退费隔离场景；走 MarkIsolatedWithExpiredTime 同事务原子写
	//                            status='isolated' + expired_time = *NewDeadline + isolated_time = NOW()
	//                          （避免拆成多次 UPDATE 让 expired_time / isolated_time 在 isolating 中间态被
	//                           jifei / reconcile worker 看到不一致；退费本质上仍是隔离操作，
	//                           isolated_time 与生命周期分支同口径写"隔离完成时刻"）
	isolatedAt := time.Now().UTC()
	var (
		updated bool
		casErr  error
	)
	if t.in.NewDeadline != nil {
		updated, casErr = passDao.MarkIsolatedWithExpiredTime(t.in.PassID, *t.in.NewDeadline, isolatedAt)
		if casErr != nil {
			return "", fmt.Errorf("CAS pass isolated with expired_time (refund branch, deal_name=%s): %w", t.in.DealName, casErr)
		}
		if !updated {
			// CAS 失败：可能并发被其他流程改了状态；与生命周期分支同型兜底
			logger.Warn("MarkIsolatedWithExpiredTime affected 0 rows, treat as success (already terminal)",
				zap.Time("new_deadline", *t.in.NewDeadline),
				zap.Time("isolated_time", isolatedAt),
				zap.String("deal_name", t.in.DealName),
			)
		} else {
			logger.Info("isolate pass refund branch: status=isolated + expired_time + isolated_time updated atomically",
				zap.Time("new_deadline", *t.in.NewDeadline),
				zap.Time("isolated_time", isolatedAt),
				zap.String("deal_name", t.in.DealName),
			)
		}
	} else {
		updated, casErr = passDao.MarkIsolated(t.in.PassID, isolatedAt)
		if casErr != nil {
			return "", fmt.Errorf("CAS pass isolated: %w", casErr)
		}
		if !updated {
			// CAS 失败：可能并发被其他流程改了状态（极罕见）；记录后兜底为成功
			// 因为我们刚 GetByPassID 拿到 isolating，期间被改往 isolated 也 OK
			logger.Warn("MarkIsolated affected 0 rows, treat as success (already terminal)",
				zap.Time("isolated_time", isolatedAt),
			)
		} else {
			logger.Info("isolate pass lifecycle branch: status=isolated + isolated_time updated atomically",
				zap.Time("isolated_time", isolatedAt),
			)
		}
	}

	// R-MR-4 退费分支接 ai-gateway 对齐（2026-05-24 用户拍板）：退费分支下
	// pass.expired_time 刚被 MarkIsolatedWithExpiredTime 覆写为 jifei newDeadline（可能
	// 比原值早），必须强制同步镜像到 ai-gateway subscription.period_end，保证两侧天级一致。
	//
	// 设计原则：pass.expired_time 是 ctl 真源，任何变动（续费向后 / 退费向前）都要
	// ai-gateway 跟车；ai-gateway ExtendSubscription 已在 2026-05-24 的 commit
	// 里从 only-forward CAS 升级为 "等值幂等 + 不等强制覆盖" 对齐语义，能安全表达
	// 退费向前缩短。生命周期隔离分支（NewDeadline == nil）不动 ai-gateway：pass.expired_time
	// 本身也不变，ai-gateway 保持原值与 ctl 自然一致。
	//
	// 失败语义（与隔离父 task 永不放弃对偶）：调用失败（非 ErrAiGatewayPlanNotFound
	// / 非 ErrAiGatewayRouteNotFound）返 err 让父 task 重试 30s × INT64_MAX。路由 404
	// 则在调试期不阻断主链（记 Warn），避免 ai-gateway 镜像迟后于 R-MR-4 时完全阻住隔离
	// 完成。UserID 为空（老 payload 兑现场景）跳过并 Warn。
	if t.in.NewDeadline != nil {
		switch {
		case t.in.UserID == "":
			logger.Warn("isolate pass refund branch: user_id empty in payload, skip ai-gateway align",
				zap.String("pass_id", t.in.PassID),
				zap.String("deal_name", t.in.DealName))
		default:
			if err := logicpass.AlignAiGatewaySubscriptionPeriodEnd(
				logger, t.in.UserID, t.in.PassID, *t.in.NewDeadline,
			); err != nil {
				return "", fmt.Errorf("align ai-gateway period_end (refund branch, deal_name=%s): %w",
					t.in.DealName, err)
			}
		}
	}

	logger.Info("isolate pass parent task completed")

	// best-effort 反向调 trade callback 推进 trade_flow 终态（端到端闭环 §10 Q22-I-E）
	t.notifyTradeFlowCompleted(ctx, logger)
	return t.markSuccess(ctx)
}

// notifyTradeFlowCompleted best-effort 调 trade /internal/trade/flows/{flow_id}/complete
//
// 设计稿：trade-pass-isolate-design.md §10 Q22-I-E（端到端闭环 2026-05-15 / Q1 拍板）
//
// 行为：
//   - TradeFlowID == 0 时直接跳过（dev/test 兼容 + 老 task payload 没有 FlowID 的兼容路径）
//   - 调 1.5s 超时（与 §6 CTLCallTimeout 对齐）；2xx → 记 Info；非 2xx / 网络错 → 记 Warn 不阻塞
//   - trade 侧另有 reconcile worker 周期性扫描 stuck trade_flow 兜底，本调用不传输关键状态
func (t *isolatePassTask) notifyTradeFlowCompleted(_ pctx.Context, logger *zap.Logger) {
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

// idempotentCheck 锁竞争场景：检查 pass 是否已 isolated；若是 → markSuccess
func (t *isolatePassTask) idempotentCheck(ctx pctx.Context) (string, error) {
	if t.in == nil || t.in.PassID == "" {
		return "", errors.New("idempotent check: missing pass id")
	}
	passEntity, err := daoFactory.DefaultDaoFactory.PassDao(nil).GetByPassID(t.in.PassID)
	if err != nil {
		ctx.Logger().Warn("isolate pass idempotent check: query pass failed",
			zap.Error(err), zap.String("pass_id", t.in.PassID))
		return "", fmt.Errorf("LockTask failed and idempotent check unavailable: %w", err)
	}
	if passEntity.Status == modelpass.StatusIsolated {
		ctx.Logger().Info("idempotent check: pass already isolated", zap.String("pass_id", t.in.PassID))
		// pass 已经 isolated，但 trade 侧 trade_flow 可能还停在 in_progress
		// （前一轮 markSuccess 后 callback 失败了），这里再补一次 best-effort
		t.notifyTradeFlowCompleted(ctx, ctx.Logger())
		return t.markSuccess(ctx)
	}
	return "", fmt.Errorf("LockTask failed, pass status=%s (not yet isolated)", passEntity.Status)
}

func (t *isolatePassTask) onExecuteFailed(_ string, err error) {
	t.lastExecuteErr = err
	_ = daoFactory.DefaultDaoFactory.TaskDao(nil).UpdateByKeyColumn(map[string]interface{}{
		taskmodel.ColumnTaskMessage: taskmodel.TruncateMessage(err),
	}, t.TaskId)
}

// finalizeFailure：父 task 永不"放弃"（max_execute_count 极大），但若意外触发就只记录失败，
// 不做 isolating → active 回滚（设计稿 Q35=a 不支持回滚）。reconcile worker 会负责清理。
// finalizeFailure 设计契约（Q35=a 修订版 / 设计稿 §10 / Bug 1 修复）：
//
// 历史 Bug：原实现一次 execute 失败就调 completeTaskFailure 标 FAILED 终态，
// 与 max_execute_count=1<<30 "永不放弃" 的设计契约严重背离。一旦 task 标 FAILED，
// checkTasks bypass 不再扫（只扫 UnCompletedTaskStates={CREATED,RUNNING}），
// 整条隔离链路从此卡死，trade_flow 永远停在 in_progress。
//
// 当前实现：仅记录错误信息到 task_message，把 task_state 回写为 CREATED（非终态），
// 让 checkTasks bypass 1 分钟内扫到并按 ExecuteInterval 重投。真正终态失败由
// exceedMaxExecuteCount 入口（execute_count >= max_execute_count，即 1<<30 次）触发。
func (t *isolatePassTask) finalizeFailure(ctx pctx.Context) (string, error) {
	err := t.lastExecuteErr
	if err == nil {
		err = errors.New("isolate pass task execute failed")
	}
	ctx.Logger().Warn("isolate pass task execute failed, will be retried by checkTasks bypass",
		zap.Error(err),
		zap.String("pass_id", t.in.PassID),
		zap.Int("execute_count", t.TaskEntity.ExecuteCount),
		zap.Int("max_execute_count", t.TaskEntity.MaxExecuteCount),
	)
	return t.markRetryable(ctx, taskmodel.TruncateMessage(err))
}

// markRetryable 把 task_state 回写为 CREATED（非终态）+ 写入诊断 task_message。
//
// 与 completeTaskFailure 的区别：
//   - completeTaskFailure：task_state=FAILED（终态）→ checkTasks bypass 不再扫 → 链路死亡
//   - markRetryable：task_state=CREATED（非终态）→ checkTasks bypass 1 分钟后扫到 →
//     把 task 重投回 MQ → 父 task 框架按 ExecuteInterval(30s) 重投，max_execute_count 兜底
func (t *isolatePassTask) markRetryable(ctx pctx.Context, message string) (string, error) {
	if err := daoFactory.DefaultDaoFactory.TaskDao(ctx).UpdateByKeyColumn(map[string]interface{}{
		taskmodel.ColumnTaskState:   taskmodel.StateCreated,
		taskmodel.ColumnTaskMessage: message,
	}, t.TaskId); err != nil {
		return "", fmt.Errorf("update isolate pass task retryable state: %w", err)
	}
	t.TaskEntity.TaskState = taskmodel.StateCreated
	t.TaskEntity.TaskMessage = message
	return taskflow.StepCodeSuccess, nil
}

func (t *isolatePassTask) exceedMaxExecuteCount(ctx pctx.Context) (string, error) {
	ctx.Logger().Error("isolate pass task exceeded max execute count (should never happen)",
		zap.String("pass_id", t.in.PassID),
	)
	return t.failTask(ctx, "ExecuteCount greater than or equal to MaxExecuteCount")
}

func (t *isolatePassTask) failTask(ctx pctx.Context, message string) (string, error) {
	if _, err := t.completeTaskFailure(ctx, message); err != nil {
		return "", err
	}
	return "", errors.New(message)
}

func (t *isolatePassTask) markSuccess(ctx pctx.Context) (string, error) {
	if err := daoFactory.DefaultDaoFactory.TaskDao(ctx).UpdateByKeyColumn(map[string]interface{}{
		taskmodel.ColumnTaskState:   taskmodel.StateSuccess,
		taskmodel.ColumnTaskMessage: "",
	}, t.TaskId); err != nil {
		return "", fmt.Errorf("update isolate pass task success state: %w", err)
	}
	t.TaskEntity.TaskState = taskmodel.StateSuccess
	t.TaskEntity.TaskMessage = ""
	return taskflow.StepCodeSuccess, nil
}

func (t *isolatePassTask) completeTaskFailure(ctx pctx.Context, message string) (string, error) {
	if err := daoFactory.DefaultDaoFactory.TaskDao(ctx).UpdateByKeyColumn(map[string]interface{}{
		taskmodel.ColumnTaskState:       taskmodel.StateFailed,
		taskmodel.ColumnTaskMessage:     message,
		taskmodel.ColumnLastExecuteTime: time.Now().UTC(),
	}, t.TaskId); err != nil {
		return "", fmt.Errorf("update isolate pass task failed state: %w", err)
	}
	t.TaskEntity.TaskState = taskmodel.StateFailed
	t.TaskEntity.TaskMessage = message
	return taskflow.StepCodeSuccess, nil
}
