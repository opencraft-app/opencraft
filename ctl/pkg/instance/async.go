package instance

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	paigateway "ctl/pkg/adapter/aigateway"
	pllmgateway "ctl/pkg/adapter/llmgateway"
	psandbox "ctl/pkg/adapter/sandbox"
	"ctl/pkg/config"
	pctx "ctl/pkg/context"
	"ctl/pkg/errcode"
	instancebirth "ctl/pkg/instancebirth"
	entitlementmigration "ctl/pkg/logic/entitlementmigration"
	"ctl/pkg/logic/gatewayroute"
	"ctl/pkg/metric"
	modelfactory "ctl/pkg/model/factory"
	modelinstance "ctl/pkg/model/instance"
	"ctl/pkg/model/operationhistory"
	modelsnapshot "ctl/pkg/model/snapshot"
	taskmodel "ctl/pkg/model/task"
	"ctl/pkg/mq"
	mqfactory "ctl/pkg/mq/factory"
	"ctl/pkg/resource"
	"ctl/pkg/taskruntime/common"
	"ctl/pkg/tracing"

	"go.uber.org/zap"
	"gorm.io/gorm"
)

const (
	defaultTaskExecuteIntervalSeconds = 30
	defaultTaskMaxExecuteCount        = 20
)

const (
	TaskNameCreateInstance            = common.TaskNameCreateInstance
	TaskNameDestroyInstance           = common.TaskNameDestroyInstance
	TaskNameBuildInstanceBirthProfile = common.TaskNameBuildInstanceBirthProfile
)

type CreateInstanceTaskPayload = common.CreateInstanceTaskPayload
type DestroyInstanceTaskPayload = common.DestroyInstanceTaskPayload
type BuildInstanceBirthProfileTaskPayload = common.BuildInstanceBirthProfileTaskPayload

type noopProducer struct{}

func (noopProducer) Send(_ *mq.Message) error { return nil }

func defaultProducer() mq.Producer {
	if resource.RedisMQClient == nil {
		return noopProducer{}
	}
	return mqfactory.DefaultMQFactory.Producer(pctx.NewContext(nil))
}

func truncateTaskMessage(err error) string {
	return taskmodel.TruncateMessage(err)
}

func ExecuteCreateInstanceTask(ctx pctx.Context, payload *CreateInstanceTaskPayload) error {
	return NewLogic().(*logic).RunCreateInstanceTask(ctx, payload)
}

func ExecuteDestroyInstanceTask(ctx pctx.Context, payload *DestroyInstanceTaskPayload) error {
	return NewLogic().(*logic).RunDestroyInstanceTask(ctx, payload)
}

func FinalizeCreateInstanceTaskFailure(ctx pctx.Context, payload *CreateInstanceTaskPayload, taskErr error) {
	NewLogic().(*logic).FinalizeCreateInstanceTaskFailure(ctx, payload, taskErr)
}

func FinalizeDestroyInstanceTaskFailure(ctx pctx.Context, payload *DestroyInstanceTaskPayload, taskErr error) {
	NewLogic().(*logic).FinalizeDestroyInstanceTaskFailure(ctx, payload, taskErr)
}

// === trade-pass-isolate 子 task 公开入口（设计稿 §10 Q22-I-D / Q26-D 修订版）===

// IsolateInstanceTaskPayload 是子 task IsolateInstance 的 payload 类型别名
type IsolateInstanceTaskPayload = common.IsolateInstanceTaskPayload

// ExecuteIsolateInstanceTask 由 worker 层 isolate_task.go 反向调用
func ExecuteIsolateInstanceTask(ctx pctx.Context, payload *IsolateInstanceTaskPayload) error {
	return NewLogic().(*logic).RunIsolateInstanceTask(ctx, payload)
}

// FinalizeIsolateInstanceTaskFailure 子 task 重试耗尽 / 显式失败时的兜底回调
//
// 行为：仅记录失败 message + 关联 operation_id 为 ERROR；不做 instance 状态回滚
//   - 子 task execute 是 "Running → Paused" 的直接迁移，失败时 instance 仍是 Running，
//     不存在中间态需要回滚（与 Pausing 设计有别）
//   - 父 task IsolatePass 看到该子 task FAILED 仍会推进 pass.status 到 isolated（最终一致性）
func FinalizeIsolateInstanceTaskFailure(ctx pctx.Context, payload *IsolateInstanceTaskPayload, taskErr error) {
	NewLogic().(*logic).FinalizeIsolateInstanceTaskFailure(ctx, payload, taskErr)
}

// === trade-pass-renew 子 task 公开入口（设计稿 §3.4 / §5 / R-D-4）===

// ExecuteRenewInstanceTask 由 worker 层 renew_task.go 反向调用（与 ExecuteIsolateInstanceTask 对偶）
func ExecuteRenewInstanceTask(ctx pctx.Context, payload *RenewInstanceTaskPayload) error {
	return NewLogic().(*logic).RunRenewInstanceTask(ctx, payload)
}

// FinalizeRenewInstanceTaskFailure 子 task 重试耗尽 / 显式失败时的兜底回调
//
// 行为（与 IsolateInstance 对偶反向）：仅记录失败 message + 关联 operation_id 为 ERROR；
// 不做 instance 状态回滚（execute 走 Paused → Running 直接迁移，失败时 instance 仍是 Paused）。
// 父 task RenewPass 看到该子 task FAILED 仍会推进 pass.status 到 active（与 isolate 同 "最终一致性"）。
func FinalizeRenewInstanceTaskFailure(ctx pctx.Context, payload *RenewInstanceTaskPayload, taskErr error) {
	NewLogic().(*logic).FinalizeRenewInstanceTaskFailure(ctx, payload, taskErr)
}

// EnqueueIsolateInstanceTask 由父 task IsolatePass 调用，派发一个子 task
//
// 入参 executeInterval / maxExecuteCount 由 caller 显式控制（IsolateInstance 子 task 默认 60s × 60 = 1h）。
// parentTaskID 必传，用于父 task 反查 child_registry。
//
// userID 必传：用于注入 ctx → enqueueTaskWithSchedule 把 task entity.UserID 持久化到 tasks 表；
// task 框架后续 reload 子 task 时通过 GenerateMessageDataByTaskEntity 把 entity.UserID 写入
// msg.Account.UserID，再由 processor.newContext 反向恢复到执行 ctx，instanceDao 才不会报
// `context user is required`（BUG-30 修订）。
func EnqueueIsolateInstanceTask(ctx pctx.Context, instanceID, passID, userID, operationID, parentTaskID string, executeInterval int64, maxExecuteCount int) error {
	if instanceID == "" {
		return errors.New("instanceID is required")
	}
	if parentTaskID == "" {
		return errors.New("parentTaskID is required")
	}
	if userID == "" {
		return errors.New("userID is required")
	}
	if executeInterval <= 0 {
		executeInterval = defaultTaskExecuteIntervalSeconds
	}
	if maxExecuteCount <= 0 {
		maxExecuteCount = defaultTaskMaxExecuteCount
	}
	payload := &IsolateInstanceTaskPayload{
		InstanceID:  instanceID,
		PassID:      passID,
		OperationID: operationID,
	}
	// BUG-30 修订：把 userID 注入 ctx，让 enqueueTaskWithSchedule 写 task entity.UserID 不为空。
	if ctx == nil {
		ctx = pctx.NewContext(nil)
	}
	ctx = ctx.WithUserID(userID)
	_, err := NewLogic().(*logic).enqueueTaskWithSchedule(
		ctx,
		common.TaskNameIsolateInstance,
		payload,
		parentTaskID,
		executeInterval,
		maxExecuteCount,
	)
	return err
}

// EnqueueIsolatePassTask 由 logic/pass.IsolatePass 调用，派发父 task
//
// 入参：
//   - passID / userID / operationID：父 task 业务标识
//   - tradeFlowID：trade 侧 trade_flow.id PK（端到端闭环 2026-05-15）；
//     父 task 终态时 best-effort 反向调 trade callback；0 值表示无 trade callback 链路（dev/test）
//   - newDeadline：jifei 退费场景下的"新到期时间"（v1.7.30 BUG-35）；
//     非 nil 时父 task 终态在同一事务里 CAS isolating→isolated + 写 pass.expired_time = *newDeadline；
//     nil 时父 task 终态仅 CAS isolating→isolated（生命周期隔离场景，**不动** pass.expired_time）。
//   - dealName：jifei 退费场景下的子订单号（v1.7.30 BUG-35）；仅日志透传，不参与状态机。
//   - executeInterval / maxExecuteCount：默认 30s × 极大值（Q35=a 修订版兜底，"永不放弃"）
func EnqueueIsolatePassTask(ctx pctx.Context, passID, userID, operationID string, tradeFlowID int64, newDeadline *time.Time, dealName string, executeInterval int64, maxExecuteCount int) (taskID string, err error) {
	if passID == "" {
		return "", errors.New("passID is required")
	}
	if userID == "" {
		return "", errors.New("userID is required")
	}
	if executeInterval <= 0 {
		executeInterval = defaultTaskExecuteIntervalSeconds
	}
	if maxExecuteCount <= 0 {
		maxExecuteCount = defaultTaskMaxExecuteCount
	}
	payload := &common.IsolatePassTaskPayload{
		PassID:      passID,
		UserID:      userID,
		OperationID: operationID,
		TradeFlowID: tradeFlowID,
		NewDeadline: newDeadline,
		DealName:    dealName,
	}
	// BUG-30 修订：把 userID 注入 ctx，让 enqueueTaskWithSchedule 写 task entity.UserID 不为空，
	// 子 task 派发链路（父 task execute → EnqueueIsolateInstanceTask）依赖此 ctx user 透传。
	if ctx == nil {
		ctx = pctx.NewContext(nil)
	}
	ctx = ctx.WithUserID(userID)
	return NewLogic().(*logic).enqueueTaskWithSchedule(
		ctx,
		common.TaskNameIsolatePass,
		payload,
		"",
		executeInterval,
		maxExecuteCount,
	)
}

// === trade-pass-renew 父子 task 公开入口（设计稿 §3.4 / §5 / R-D-2）===

// RenewPassTaskPayload / RenewInstanceTaskPayload 是父子 task payload 的类型别名
type RenewPassTaskPayload = common.RenewPassTaskPayload
type RenewInstanceTaskPayload = common.RenewInstanceTaskPayload

// EnqueueRenewPassTask 由 logic/pass.RenewPass 异步分支（pass.status='isolated' 路径）调用，派发父 task
//
// 入参（与 EnqueueIsolatePassTask 对偶 + 续费独有 timeSpan/timeUnit + R-MR-5 回滚基线字段）：
//   - passID / userID / operationID：父 task 业务标识
//   - tradeFlowID：trade 侧 trade_flow.id PK（与 isolate 同语义）
//   - timeSpan / timeUnit：续费时长（父 task 收尾计算 new_expired_time 的依据；
//     基线 = pass.expired_time，v1.7.20 B15 修订）
//   - originalExpiredTime / originalIsolatedTime：R-MR-5 续费失败回滚基线（2026-05-24 用户拍板）
//     · originalExpiredTime：续费前的 pass.expired_time（active / isolated 续费均为 entity.ExpiredTime）
//     · originalIsolatedTime：续费前的 pass.isolated_time（active 分支传 nil；isolated 分支传 entity.IsolatedTime
//     的副本指针）；决定回滚目标状态：nil → active；非 nil → isolated
//   - executeInterval / maxExecuteCount：默认 30s × 5 次（R-MR-5：父 task 失败有限重试 +
//     失败后派发 RollbackRenewPassTask 回滚副作用）
func EnqueueRenewPassTask(ctx pctx.Context, passID, userID, operationID string, tradeFlowID int64, timeSpan int, timeUnit string, originalExpiredTime time.Time, originalIsolatedTime *time.Time, executeInterval int64, maxExecuteCount int) (taskID string, err error) {
	if passID == "" {
		return "", errors.New("passID is required")
	}
	if userID == "" {
		return "", errors.New("userID is required")
	}
	if timeSpan <= 0 {
		return "", fmt.Errorf("timeSpan must be > 0, got %d", timeSpan)
	}
	if timeUnit == "" {
		return "", errors.New("timeUnit is required")
	}
	if originalExpiredTime.IsZero() {
		// R-MR-5：回滚基线必须传入；零值会让回滚 task 把 pass.expired_time 写成 1970 年。
		return "", errors.New("originalExpiredTime is required (R-MR-5 rollback baseline)")
	}
	if executeInterval <= 0 {
		executeInterval = defaultTaskExecuteIntervalSeconds
	}
	if maxExecuteCount <= 0 {
		maxExecuteCount = defaultTaskMaxExecuteCount
	}
	payload := &common.RenewPassTaskPayload{
		PassID:               passID,
		UserID:               userID,
		OperationID:          operationID,
		TimeSpan:             timeSpan,
		TimeUnit:             timeUnit,
		TradeFlowID:          tradeFlowID,
		OriginalExpiredTime:  originalExpiredTime,
		OriginalIsolatedTime: originalIsolatedTime,
	}
	// BUG-30 修订：与 EnqueueIsolatePassTask 同范式，注入 ctx user 让 task entity.UserID 不为空。
	if ctx == nil {
		ctx = pctx.NewContext(nil)
	}
	ctx = ctx.WithUserID(userID)
	return NewLogic().(*logic).enqueueTaskWithSchedule(
		ctx,
		common.TaskNameRenewPass,
		payload,
		"",
		executeInterval,
		maxExecuteCount,
	)
}

// === R-MR-5 续费失败回滚 task 入队接口（2026-05-24 用户拍板）===

// RollbackRenewPassTaskPayload 是回滚 task payload 的类型别名
type RollbackRenewPassTaskPayload = common.RollbackRenewPassTaskPayload

// EnqueueRollbackRenewPassTask 由 renewPassTask.finalizeFailure 在 max_execute_count
// 用尽（=5）时调用，派发回滚父 task。
//
// 入参（payload 字段透传 + execute schedule 参数）：
//   - passID / userID / operationID：业务标识（继承自原 RenewPass payload）
//   - tradeFlowID：透传到回滚 task；> 0 时回滚收尾步骤 6 调 trade.CompleteFlow(failed)
//   - originalExpiredTime / originalIsolatedTime：续费前基线，决定 RollbackRenewal 写回的目标值
//   - failureReason：原父 task 最后一次 execute 错误（写入 trade.CompleteFlow message 字段）
//   - originalParentTaskID：原 RenewPass 父 task 的 task_id（回滚 task 步骤 1 等子 task 终态时反查用）
//   - executeInterval / maxExecuteCount：默认 30s × 5 次（与父 task 同节奏；失败即终态由人工介入）
func EnqueueRollbackRenewPassTask(ctx pctx.Context, passID, userID, operationID string, tradeFlowID int64, originalExpiredTime time.Time, originalIsolatedTime *time.Time, failureReason, originalParentTaskID string, executeInterval int64, maxExecuteCount int) (taskID string, err error) {
	if passID == "" {
		return "", errors.New("passID is required")
	}
	if userID == "" {
		return "", errors.New("userID is required")
	}
	if originalExpiredTime.IsZero() {
		return "", errors.New("originalExpiredTime is required (R-MR-5 rollback baseline)")
	}
	if originalParentTaskID == "" {
		return "", errors.New("originalParentTaskID is required (used to wait child tasks)")
	}
	if executeInterval <= 0 {
		executeInterval = defaultTaskExecuteIntervalSeconds
	}
	if maxExecuteCount <= 0 {
		maxExecuteCount = defaultTaskMaxExecuteCount
	}
	payload := &common.RollbackRenewPassTaskPayload{
		PassID:               passID,
		UserID:               userID,
		OperationID:          operationID,
		TradeFlowID:          tradeFlowID,
		OriginalExpiredTime:  originalExpiredTime,
		OriginalIsolatedTime: originalIsolatedTime,
		FailureReason:        failureReason,
		OriginalParentTaskID: originalParentTaskID,
	}
	if ctx == nil {
		ctx = pctx.NewContext(nil)
	}
	ctx = ctx.WithUserID(userID)
	return NewLogic().(*logic).enqueueTaskWithSchedule(
		ctx,
		common.TaskNameRollbackRenewPass,
		payload,
		"",
		executeInterval,
		maxExecuteCount,
	)
}

// EnqueueRenewInstanceTask 由父 task RenewPassTask 调用，派发一个续费子 task
//
// 入参（与 EnqueueIsolateInstanceTask 对偶）：
//   - instanceID / passID / userID / operationID：业务标识；userID 必传，用于 ctx 注入 →
//     task entity.UserID 持久化（BUG-30 修订），子 task reload 时才能恢复 ctx user，
//     instanceDao.GetByInstanceID 才不会报 `context user is required`。
//   - parentTaskID 必传，用于父 task 反查 child_registry
//   - executeInterval / maxExecuteCount：默认 60s × 60 = 1h 重试窗口（与 IsolateInstance 子 task 对偶）
func EnqueueRenewInstanceTask(ctx pctx.Context, instanceID, passID, userID, operationID, parentTaskID string, executeInterval int64, maxExecuteCount int) error {
	return EnqueueRenewInstanceTaskWithTarget(ctx, instanceID, passID, userID, operationID, parentTaskID, "", executeInterval, maxExecuteCount)
}

// EnqueueRenewInstanceTaskWithTarget adds an optional forward-only gateway
// migration to the ordinary resume task. targetGateway must be empty or
// llm_gateway.
func EnqueueRenewInstanceTaskWithTarget(ctx pctx.Context, instanceID, passID, userID, operationID, parentTaskID, targetGateway string, executeInterval int64, maxExecuteCount int) error {
	if instanceID == "" {
		return errors.New("instanceID is required")
	}
	if parentTaskID == "" {
		return errors.New("parentTaskID is required")
	}
	if userID == "" {
		return errors.New("userID is required")
	}
	if executeInterval <= 0 {
		executeInterval = defaultTaskExecuteIntervalSeconds
	}
	if maxExecuteCount <= 0 {
		maxExecuteCount = defaultTaskMaxExecuteCount
	}
	payload := &common.RenewInstanceTaskPayload{
		InstanceID:    instanceID,
		PassID:        passID,
		OperationID:   operationID,
		TargetGateway: strings.TrimSpace(targetGateway),
	}
	// BUG-30 修订：注入 ctx user，让 enqueueTaskWithSchedule 写 task entity.UserID 不为空。
	if ctx == nil {
		ctx = pctx.NewContext(nil)
	}
	ctx = ctx.WithUserID(userID)
	_, err := NewLogic().(*logic).enqueueTaskWithSchedule(
		ctx,
		common.TaskNameRenewInstance,
		payload,
		parentTaskID,
		executeInterval,
		maxExecuteCount,
	)
	return err
}

// === trade-pass-destroy 父子 task 公开入口（设计稿 §3.5 / §4.5.2 / §4.5.3 / §4.6 / §4.7）===

// DestroyPassTaskPayload / DestroyInstanceForPassTaskPayload 是父子 task payload 的类型别名。
//
// 命名说明（Q5 ✅ 拍板）：销毁子 task payload 用 `DestroyInstanceForPassTaskPayload`（设计稿 §4.8 正式命名）
// 与已存在的 `DestroyInstanceTaskPayload`（老的纯 instance 销毁链路）区分；TaskName 命名为
// `TaskNameDestroyInstanceWithSnapshot` 体现"含快照"语义（详见 taskruntime/common/instance_task.go）。
type DestroyPassTaskPayload = common.DestroyPassTaskPayload
type DestroyInstanceForPassTaskPayload = common.DestroyInstanceForPassTaskPayload

// EnqueueDestroyPassTask 由 logic/pass.DestroyPass 调用，派发销毁父 task
//
// 入参（与 EnqueueIsolatePassTask 对偶 + 销毁独有 destroyReason / region）：
//   - passID / userID / operationID：父 task 业务标识
//   - tradeFlowID：trade 侧 trade_flow.id PK（与 isolate 同语义；> 0 时父 task 收尾步 5c 反向 callback）
//   - destroyReason：jifei `para.source` 透传值（biz/qn/other/空串；Q24 ✅ 拍板），
//     父 task 收尾步 5b 调 dao.MoveToHistory(passID, deletedTime, destroyReason)
//   - region：ctl 进程配置 config.ServerConf.MiscConfig.Region（Q21 ✅ 拍板），父 task 派子 task
//     时透传到 DestroyInstanceForPassTaskPayload，子 task 入 snapshot 表时作为 snapshot.region 列值
//   - executeInterval / maxExecuteCount：默认 30s × 极大值（与 isolate / renew 父 task 同 "永不放弃"）
func EnqueueDestroyPassTask(ctx pctx.Context, passID, userID, operationID string, tradeFlowID int64, destroyReason, region string, executeInterval int64, maxExecuteCount int) (taskID string, err error) {
	if passID == "" {
		return "", errors.New("passID is required")
	}
	if executeInterval <= 0 {
		executeInterval = defaultTaskExecuteIntervalSeconds
	}
	if maxExecuteCount <= 0 {
		maxExecuteCount = defaultTaskMaxExecuteCount
	}
	payload := &common.DestroyPassTaskPayload{
		PassID:        passID,
		UserID:        userID,
		OperationID:   operationID,
		TradeFlowID:   tradeFlowID,
		DestroyReason: destroyReason,
		Region:        region,
		// 三个进度位 SubscriptionDone / PassDeleted / FlowCompleted 默认 false，由父 task
		// 各收尾子步骤成功后通过 UpdatePayload 持久化（D-7 切片落实现）。
	}
	return NewLogic().(*logic).enqueueTaskWithSchedule(
		ctx,
		common.TaskNameDestroyPass,
		payload,
		"",
		executeInterval,
		maxExecuteCount,
	)
}

// EnqueueDestroyInstanceForPassTask 由父 task DestroyPassTask 调用，派发一个销毁子 task
//
// 入参（与 EnqueueIsolateInstanceTask 对偶 + 销毁独有快照 + 销毁事件 ID）：
//   - payload：DestroyInstanceForPassTaskPayload — 由父 task 在 enqueue 时填齐字段
//     （InstanceID / PassID / UserID / SandboxID / Region / UIN / AppID / TradeFlowID 等；
//     SnapshotID / SnapshotsDone 默认 zero，由子 task execute 阶段写回）
//   - parentTaskID：父 task 的 task_id，用于父 task 反查 child_registry 防重派发
//   - executeInterval / maxExecuteCount：默认 60s × 60 = 1h 重试窗口（与 IsolateInstance 子 task 对偶）
//
// payload.UserID 必传：用于注入 ctx → enqueueTaskWithSchedule 把 task entity.UserID 持久化到 tasks 表；
// task 框架后续 reload 子 task 时通过 GenerateMessageDataByTaskEntity 把 entity.UserID 写入
// msg.Account.UserID，再由 processor.newContext 反向恢复到执行 ctx，instanceDao.GetByInstanceID
// 才不会报 `context user is required`（BUG-30 修订在销毁子 task 链路的延伸 — sandbox-bj-7
// 联调 2026-05-25 实测：原实现漏注入 ctx user，导致 DestroyInstanceWithSnapshot 子 task
// reload 时 ctx user 为空 → 父 task 一直等不到子 task 终态、销毁链路卡死）。
func EnqueueDestroyInstanceForPassTask(ctx pctx.Context, payload common.DestroyInstanceForPassTaskPayload, parentTaskID string, executeInterval int64, maxExecuteCount int) error {
	if payload.InstanceID == "" {
		return errors.New("payload.InstanceID is required")
	}
	if payload.UserID == "" {
		return errors.New("payload.UserID is required")
	}
	if parentTaskID == "" {
		return errors.New("parentTaskID is required")
	}
	if executeInterval <= 0 {
		executeInterval = defaultTaskExecuteIntervalSeconds
	}
	if maxExecuteCount <= 0 {
		maxExecuteCount = defaultTaskMaxExecuteCount
	}
	// BUG-30 销毁链路延伸：把 payload.UserID 注入 ctx，让 enqueueTaskWithSchedule 写
	// task entity.UserID 不为空，子 task reload 后才能恢复 ctx user，
	// 否则 instanceDao.GetByInstanceID 报 `context user is required`，
	// 父 task DestroyPass 一直等不到子 task 终态。
	if ctx == nil {
		ctx = pctx.NewContext(nil)
	}
	ctx = ctx.WithUserID(payload.UserID)
	_, err := NewLogic().(*logic).enqueueTaskWithSchedule(
		ctx,
		common.TaskNameDestroyInstanceWithSnapshot,
		&payload,
		parentTaskID,
		executeInterval,
		maxExecuteCount,
	)
	return err
}

// UpdateDestroyInstanceForPassPayload 子 task DestroyInstanceWithSnapshot 阶段 1+2 持久化进度位用：
//
//   - 阶段 1 sandbox.CreateSnapshot 成功后：把返回的 snapshotID 写回 payload.SnapshotID
//   - 阶段 2 sandbox.GetSnapshotStatus 返 ready / 无系统盘场景：写 SnapshotsDone=true
//
// 实现：MarshalJSON payload → UPDATE task.task_params WHERE task_id=?
// 不持任何子 task 内部状态（每次重投都从 DB 读最新 task_params 后再 unmarshal）。
func UpdateDestroyInstanceForPassPayload(ctx pctx.Context, taskID string, payload *common.DestroyInstanceForPassTaskPayload) error {
	return NewLogic().(*logic).updateTaskPayload(ctx, taskID, payload)
}

// ExecuteDestroyInstanceForPassTask 由 worker 层 destroy_for_pass_task.go 反向调用执行 4 阶段流程
func ExecuteDestroyInstanceForPassTask(ctx pctx.Context, taskID string, payload *DestroyInstanceForPassTaskPayload) error {
	return NewLogic().(*logic).RunDestroyInstanceForPassTask(ctx, taskID, payload)
}

// FinalizeDestroyInstanceForPassTaskFailure 子 task 失败兜底
func FinalizeDestroyInstanceForPassTaskFailure(ctx pctx.Context, payload *DestroyInstanceForPassTaskPayload, taskErr error) {
	NewLogic().(*logic).FinalizeDestroyInstanceForPassTaskFailure(ctx, payload, taskErr)
}

func CompleteAsyncOperation(ctx pctx.Context, operationID string, err error) {
	NewLogic().(*logic).completeOperation(ctx, operationID, err)
}

func IsPendingSandboxID(sandboxID string) bool {
	return strings.HasPrefix(sandboxID, "pending-")
}

func isPendingSandboxID(sandboxID string) bool {
	return IsPendingSandboxID(sandboxID)
}

func (l *logic) enqueueTask(ctx pctx.Context, taskName string, payload interface{}, parentTaskID string) (taskID string, err error) {
	ctx, span := tracing.StartTrace(ctx, "Instance.EnqueueTask")
	defer func() { span.EndWithError(err) }()

	if l.taskDao == nil {
		return "", errors.New("task dao is nil")
	}
	if l.producer == nil {
		return "", errors.New("mq producer is nil")
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return "", fmt.Errorf("marshal task payload: %w", err)
	}

	taskID = l.generateTaskID()
	taskEntity := &taskmodel.Entity{
		TaskId:          taskID,
		ParentTaskId:    parentTaskID,
		TaskName:        taskName,
		TaskParams:      string(body),
		TaskState:       taskmodel.StateCreated,
		TaskMessage:     "",
		TraceId:         ctx.GetRequestId(),
		ExecuteInterval: defaultTaskExecuteIntervalSeconds,
		ExecuteCount:    0,
		MaxExecuteCount: defaultTaskMaxExecuteCount,
		LastExecuteTime: time.Unix(0, 0),
	}
	taskEntity.UserID = ctx.GetUserID()

	if err := l.taskDao.Insert(taskEntity); err != nil {
		return "", fmt.Errorf("insert task: %w", err)
	}

	messageData, err := common.GenerateMessageData(ctx, taskName, taskID, payload)
	if err != nil {
		_ = l.taskDao.UpdateByKeyColumn(map[string]interface{}{
			taskmodel.ColumnTaskState:   taskmodel.StateFailed,
			taskmodel.ColumnTaskMessage: err.Error(),
		}, taskID)
		return taskID, fmt.Errorf("generate task message: %w", err)
	}
	if err := l.producer.Send(&mq.Message{Data: messageData}); err != nil {
		// MQ 发送失败时直接将 task 置为 FAILED，避免 bypass 再次补偿这条未真正入队的任务。
		_ = l.taskDao.UpdateByKeyColumn(map[string]interface{}{
			taskmodel.ColumnTaskState:   taskmodel.StateFailed,
			taskmodel.ColumnTaskMessage: err.Error(),
		}, taskID)
		return taskID, fmt.Errorf("send task message: %w", err)
	}

	return taskID, nil
}

// enqueueTaskWithSchedule 是 enqueueTask 的扩展：允许 caller 显式指定 ExecuteInterval / MaxExecuteCount
//
// 用于 trade-pass-isolate 父子 task：
//   - 父 task IsolatePass：interval=30s, max=极大（"永不放弃"兜底）
//   - 子 task IsolateInstance：interval=60s, max=60（1h 重试窗口）
//
// 与 enqueueTask 共享其余 schema（task_id 自生成 / state=CREATED / params=json marshal / MQ.Send）
func (l *logic) enqueueTaskWithSchedule(ctx pctx.Context, taskName string, payload interface{}, parentTaskID string, executeInterval int64, maxExecuteCount int) (taskID string, err error) {
	ctx, span := tracing.StartTrace(ctx, "Instance.EnqueueTaskWithSchedule")
	defer func() { span.EndWithError(err) }()

	if l.taskDao == nil {
		return "", errors.New("task dao is nil")
	}
	if l.producer == nil {
		return "", errors.New("mq producer is nil")
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return "", fmt.Errorf("marshal task payload: %w", err)
	}

	taskID = l.generateTaskID()
	taskEntity := &taskmodel.Entity{
		TaskId:          taskID,
		ParentTaskId:    parentTaskID,
		TaskName:        taskName,
		TaskParams:      string(body),
		TaskState:       taskmodel.StateCreated,
		TaskMessage:     "",
		TraceId:         ctx.GetRequestId(),
		ExecuteInterval: executeInterval,
		ExecuteCount:    0,
		MaxExecuteCount: maxExecuteCount,
		LastExecuteTime: time.Unix(0, 0),
	}
	taskEntity.UserID = ctx.GetUserID()

	if err := l.taskDao.Insert(taskEntity); err != nil {
		return "", fmt.Errorf("insert task: %w", err)
	}

	messageData, err := common.GenerateMessageData(ctx, taskName, taskID, payload)
	if err != nil {
		_ = l.taskDao.UpdateByKeyColumn(map[string]interface{}{
			taskmodel.ColumnTaskState:   taskmodel.StateFailed,
			taskmodel.ColumnTaskMessage: err.Error(),
		}, taskID)
		return taskID, fmt.Errorf("generate task message: %w", err)
	}
	if err := l.producer.Send(&mq.Message{Data: messageData}); err != nil {
		_ = l.taskDao.UpdateByKeyColumn(map[string]interface{}{
			taskmodel.ColumnTaskState:   taskmodel.StateFailed,
			taskmodel.ColumnTaskMessage: err.Error(),
		}, taskID)
		return taskID, fmt.Errorf("send task message: %w", err)
	}
	return taskID, nil
}

func (l *logic) markOperationRunning(ctx pctx.Context, operationID string) {
	if operationID == "" || l.operationHistoryDao == nil {
		return
	}
	if err := l.operationHistoryDao.UpdateStatus(ctx, operationID, operationhistory.StatusRunning, ""); err != nil {
		l.logger.Warn("update operation running failed",
			zap.Error(err),
			zap.String("operation_id", operationID),
		)
	}
}

func (l *logic) enqueueCreateInstanceTask(ctx pctx.Context, entity *modelinstance.Entity, instanceSpecID string, timeout int32, soulTemplateID string, operationID string) error {
	taskID, err := l.enqueueTask(ctx, TaskNameCreateInstance, &CreateInstanceTaskPayload{
		InstanceID:     entity.InstanceId,
		InstanceSpecID: instanceSpecID,
		Timeout:        timeout,
		SoulTemplateID: soulTemplateID,
		OperationID:    operationID,
	}, operationID)
	if err != nil || !l.executeTasksInline {
		return err
	}
	return l.runCreateTaskInline(ctx, taskID, &CreateInstanceTaskPayload{
		InstanceID:     entity.InstanceId,
		InstanceSpecID: instanceSpecID,
		Timeout:        timeout,
		SoulTemplateID: soulTemplateID,
		OperationID:    operationID,
	})
}

func (l *logic) enqueueDestroyInstanceTask(ctx pctx.Context, entity *modelinstance.Entity, releaseQuota bool, operationID string) error {
	taskID, err := l.enqueueTask(ctx, TaskNameDestroyInstance, &DestroyInstanceTaskPayload{
		InstanceID:   entity.InstanceId,
		ReleaseQuota: releaseQuota,
		OperationID:  operationID,
	}, operationID)
	if err != nil || !l.executeTasksInline {
		return err
	}
	return l.runDestroyTaskInline(ctx, taskID, &DestroyInstanceTaskPayload{
		InstanceID:   entity.InstanceId,
		ReleaseQuota: releaseQuota,
		OperationID:  operationID,
	})
}

func (l *logic) enqueueBirthProfileTask(ctx pctx.Context, instanceID, parentTaskID string) error {
	payload := &BuildInstanceBirthProfileTaskPayload{InstanceID: instanceID}
	taskID, err := l.enqueueCompensableTask(ctx, TaskNameBuildInstanceBirthProfile, payload, parentTaskID)
	if err != nil {
		return err
	}
	if !l.executeTasksInline {
		return nil
	}
	return l.runBuildBirthProfileTaskInline(ctx, taskID, payload)
}

func (l *logic) enqueueCompensableTask(ctx pctx.Context, taskName string, payload interface{}, parentTaskID string) (taskID string, err error) {
	ctx, span := tracing.StartTrace(ctx, "Instance.EnqueueCompensableTask")
	defer func() { span.EndWithError(err) }()

	if l.taskDao == nil {
		return "", errors.New("task dao is nil")
	}
	if l.producer == nil {
		return "", errors.New("mq producer is nil")
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return "", fmt.Errorf("marshal task payload: %w", err)
	}

	taskID = l.generateTaskID()
	taskEntity := &taskmodel.Entity{
		TaskId:          taskID,
		ParentTaskId:    parentTaskID,
		TaskName:        taskName,
		TaskParams:      string(body),
		TaskState:       taskmodel.StateCreated,
		TaskMessage:     "",
		TraceId:         ctx.GetRequestId(),
		ExecuteInterval: defaultTaskExecuteIntervalSeconds,
		ExecuteCount:    0,
		MaxExecuteCount: defaultTaskMaxExecuteCount,
		LastExecuteTime: time.Unix(0, 0),
	}
	taskEntity.UserID = ctx.GetUserID()

	if err := l.taskDao.Insert(taskEntity); err != nil {
		return "", fmt.Errorf("insert task: %w", err)
	}

	messageData, err := common.GenerateMessageData(ctx, taskName, taskID, payload)
	if err != nil {
		_ = l.taskDao.UpdateByKeyColumn(map[string]interface{}{
			taskmodel.ColumnTaskState:   taskmodel.StateFailed,
			taskmodel.ColumnTaskMessage: err.Error(),
		}, taskID)
		return taskID, fmt.Errorf("generate task message: %w", err)
	}
	if err := l.producer.Send(&mq.Message{Data: messageData}); err != nil {
		_ = l.taskDao.UpdateByKeyColumn(map[string]interface{}{
			taskmodel.ColumnTaskMessage: truncateTaskMessage(err),
		}, taskID)
		l.logger.Warn("send compensable task message failed, leave task in CREATED for bypass retry",
			zap.Error(err),
			zap.String("task_id", taskID),
			zap.String("task_name", taskName),
		)
	}
	return taskID, nil
}

func (l *logic) RunCreateInstanceTask(ctx pctx.Context, payload *CreateInstanceTaskPayload) error {
	if payload == nil || strings.TrimSpace(payload.InstanceID) == "" {
		return errcode.ErrInstanceInvalidParam
	}
	l.markOperationRunning(ctx, payload.OperationID)

	entity, err := l.instanceDao.GetByInstanceID(ctx, payload.InstanceID)
	if err != nil {
		return err
	}
	if entity.Status == modelinstance.InstanceStatusRunning && !isPendingSandboxID(entity.SandboxId) {
		return nil
	}
	if entity.Status != modelinstance.InstanceStatusCreating {
		return errcode.ErrInstanceStatusInvalid
	}

	candidates, err := l.resolveCreateCandidatePools(ctx, payload.InstanceSpecID)
	if err != nil {
		return err
	}
	selection := l.selectCreateCandidatePools(ctx, candidates)
	l.logger.Info("selected sandbox candidate pools for create",
		zap.String("instance_id", entity.InstanceId),
		zap.String("instance_spec_id", payload.InstanceSpecID),
		zap.Strings("candidate_pools", selection.Pools),
		zap.Int("attempt_limit", selection.AttemptLimit),
		zap.Bool("used_pressure_snapshot", selection.UsedSnapshot),
		zap.Time("snapshot_refreshed_at", selection.SnapshotRefreshedAt),
	)

	sandboxResp, err := l.createSandboxWithFallback(ctx, entity.InstanceId, payload.InstanceSpecID, selection, payload.Timeout)
	if err != nil {
		return err
	}
	l.logger.Info("sandbox create returned",
		zap.String("instance_id", entity.InstanceId),
		zap.String("sandbox_id", sandboxResp.SandboxID),
		zap.String("template_id", sandboxResp.TemplateID),
		zap.String("pod_name", currentPodNameForDebug()),
	)

	if err := l.persistCreatedSandboxID(ctx, entity, sandboxResp.SandboxID); err != nil {
		_ = l.cleanupCreatedSandbox(ctx, entity.InstanceId, sandboxResp.SandboxID, "persist sandbox id failed")
		return err
	}

	if l.aiGatewayProvisioningEnabled() {
		if err := l.provisionAiGatewayOnCreate(ctx, entity, sandboxResp.SandboxID); err != nil {
			_ = l.cleanupCreatedSandbox(ctx, entity.InstanceId, sandboxResp.SandboxID, "ai-gateway onboarding failed")
			return errcode.Wrap(errcode.ErrInstanceCreationFailed, "provision ai-gateway on create for sandbox %s: %v", sandboxResp.SandboxID, err)
		}
	}

	if strings.TrimSpace(payload.SoulTemplateID) != "" {
		l.logger.Warn("skip soul template apply during create",
			zap.String("instance_id", entity.InstanceId),
			zap.String("sandbox_id", sandboxResp.SandboxID),
			zap.String("soul_template_id", payload.SoulTemplateID),
		)
	}

	if err := l.instanceDao.UpdateWithStatusPrecondition(ctx, entity.Id, []string{modelinstance.InstanceStatusCreating}, map[string]interface{}{
		modelinstance.ColumnStatus: modelinstance.InstanceStatusRunning,
	}); err != nil {
		_ = l.cleanupCreatedSandbox(ctx, entity.InstanceId, sandboxResp.SandboxID, "persist sandbox info failed")
		return errcode.Wrap(errcode.ErrInstanceCreationFailed, "persist sandbox status for sandbox %s: %v", sandboxResp.SandboxID, err)
	}
	metric.RecordInstanceCreate("success", sandboxResp.TemplateID, payload.InstanceSpecID, time.Since(entity.CreatedAt).Seconds())
	l.recordCreateSuccessEvent(ctx, entity.InstanceId)
	if err := l.enqueueBirthProfileTask(ctx, entity.InstanceId, payload.OperationID); err != nil {
		l.logger.Warn("enqueue birth profile task failed",
			zap.Error(err),
			zap.String("instance_id", entity.InstanceId),
		)
	}

	return nil
}

func (l *logic) selectCreateCandidatePools(ctx pctx.Context, candidates []string) orderedCandidatePools {
	conf := currentInstanceAPIConfig()
	now := time.Now().UTC()
	selection := orderCandidatePoolsForCreate(conf, now, candidates, nil)
	if l == nil || l.churnGuard == nil || l.churnGuard.snapshots == nil {
		return selection
	}
	snapshot, err := l.churnGuard.snapshots.Load(ctx)
	if err != nil {
		l.logger.Warn("load pool pressure snapshot for create ordering failed", zap.Error(err))
		return selection
	}
	return orderCandidatePoolsForCreate(conf, now, candidates, snapshot)
}

func (l *logic) cleanupCreatedSandbox(ctx pctx.Context, instanceID, sandboxID, reason string) error {
	if err := l.sandboxAdapter.DeleteSandbox(ctx, sandboxID); err != nil && !isSandboxNotFound(err) {
		l.logger.Error("cleanup sandbox after create task failure failed",
			zap.Error(err),
			zap.String("instance_id", instanceID),
			zap.String("sandbox_id", sandboxID),
			zap.String("reason", reason),
		)
		return err
	}
	return nil
}

func (l *logic) FinalizeCreateInstanceTaskFailure(ctx pctx.Context, payload *CreateInstanceTaskPayload, taskErr error) {
	if payload == nil {
		return
	}
	entity, err := l.instanceDao.GetByInstanceID(ctx, payload.InstanceID)
	if err == nil && entity.Status == modelinstance.InstanceStatusCreating {
		metric.RecordInstanceCreate("fail", "unknown", payload.InstanceSpecID, time.Since(entity.CreatedAt).Seconds())
		if updateErr := l.instanceDao.UpdateStatus(ctx, entity.Id, modelinstance.InstanceStatusFailed); updateErr != nil {
			l.logger.Warn("update create task instance failed state failed",
				zap.Error(updateErr),
				zap.String("instance_id", payload.InstanceID),
			)
		}
	}
	l.rollbackQuota(ctx)
	l.completeOperation(ctx, payload.OperationID, taskErr)
}

func (l *logic) RunDestroyInstanceTask(ctx pctx.Context, payload *DestroyInstanceTaskPayload) error {
	if payload == nil || strings.TrimSpace(payload.InstanceID) == "" {
		return errcode.ErrInstanceInvalidParam
	}
	l.markOperationRunning(ctx, payload.OperationID)

	entity, err := l.instanceDao.GetByInstanceID(ctx, payload.InstanceID)
	if err != nil {
		if errors.Is(err, errcode.ErrInstanceNotFound) {
			return nil
		}
		return err
	}
	if entity.Status == modelinstance.InstanceStatusDeleted {
		return nil
	}
	if entity.Status != modelinstance.InstanceStatusDeleting {
		return errcode.ErrInstanceStatusInvalid
	}

	if strings.TrimSpace(entity.AiGatewayKeyID) != "" {
		if err := l.revokeAiGatewayApiKey(ctx, entity.AiGatewayKeyID); err != nil && !isAiGatewayKeyNotFound(err) {
			return fmt.Errorf("revoke ai-gateway api key: %w", err)
		}
	}

	if entity.SandboxId != "" && !isPendingSandboxID(entity.SandboxId) {
		err = l.sandboxAdapter.DeleteSandbox(ctx, entity.SandboxId)
		if err != nil && !isSandboxNotFound(err) {
			return err
		}
	}

	return l.finalizeInstanceDeletion(ctx, entity, payload.ReleaseQuota)
}

func (l *logic) FinalizeDestroyInstanceTaskFailure(ctx pctx.Context, payload *DestroyInstanceTaskPayload, taskErr error) {
	if payload == nil {
		return
	}
	l.completeOperation(ctx, payload.OperationID, taskErr)
}

// === trade-pass-isolate 子 task 业务实现（设计稿 §10 Q22-I-D）===

// RunIsolateInstanceTask 子 task IsolateInstance 的 execute 入口
//
// 流程：
//  1. 反查 instance；NotFound / 已 Paused / 已 Deleted/Failed → 直接成功（幂等）
//  2. 校验 sandbox_id；空 / pending → 跳过 sandbox 调用，仅 CAS 状态
//  3. 调 sandbox.PauseSandbox：
//     - sandbox not_found        → 视为成功，继续 CAS（与 RenewInstance / DestroyInstance 容错对偶；
//     I-MR-1 修复：sandbox 已不存在意味着 "instance 已无可暂停目标"，业务目标天然达成，
//     不能让 sandbox 偶发缺失阻塞父 IsolatePass 收尾）
//     - sandbox already-paused   → 视为成功，继续 CAS
//     - 其它错误                 → 冒泡，触发父 task 重试
//  4. CAS Running/Resuming → Paused（同时接管用户恢复流程的中间态）
func (l *logic) RunIsolateInstanceTask(ctx pctx.Context, payload *common.IsolateInstanceTaskPayload) error {
	if payload == nil || strings.TrimSpace(payload.InstanceID) == "" {
		return errcode.ErrInstanceInvalidParam
	}
	logger := l.logger.With(
		zap.String("instance_id", payload.InstanceID),
		zap.String("pass_id", payload.PassID),
	)

	entity, err := l.instanceDao.GetByInstanceID(ctx, payload.InstanceID)
	if err != nil {
		if errors.Is(err, errcode.ErrInstanceNotFound) {
			logger.Info("isolate task: instance not found, treat as success")
			return nil
		}
		return err
	}
	switch entity.Status {
	case modelinstance.InstanceStatusPaused:
		logger.Info("isolate task: instance already paused, short-circuit")
		return nil
	case modelinstance.InstanceStatusDeleted, modelinstance.InstanceStatusFailed:
		logger.Info("isolate task: instance in terminal state, no-op",
			zap.String("status", entity.Status),
		)
		return nil
	case modelinstance.InstanceStatusRunning, modelinstance.InstanceStatusResuming:
		// 正常路径
	default:
		// Creating / Deleting 等中间态：让框架按 60s interval 重试，等其先到 Running/终态
		return fmt.Errorf("instance status=%s not eligible for isolate yet", entity.Status)
	}

	if entity.SandboxId != "" && !isPendingSandboxID(entity.SandboxId) {
		if err := l.sandboxAdapter.PauseSandbox(ctx, entity.SandboxId); err != nil {
			switch {
			case isSandboxNotFound(err):
				// I-MR-1 修复：sandbox 已不存在（被人工或异常流程删除）→ instance 已无可暂停的 sandbox。
				// 业务上 IsolateInstance 子 task 的语义是"让 instance 回到 Paused 终态"，
				// 与 RenewInstance / DestroyInstance 的 sandbox 容错保持一致：
				// 视为幂等成功，继续走 CAS Running→Paused，不阻塞隔离父 task 收尾。
				logger.Warn("isolate task: sandbox not found, treating as success and continuing CAS",
					zap.String("sandbox_id", entity.SandboxId),
					zap.Error(err),
				)
			case isExpectedSandboxConflict(err, expectedPauseConflictMessages):
				logger.Warn("isolate task: sandbox already paused, treating as success",
					zap.String("sandbox_id", entity.SandboxId),
					zap.Error(err),
				)
			default:
				return fmt.Errorf("pause sandbox: %w", err)
			}
		}
	} else {
		logger.Warn("isolate task: instance has no usable sandbox, skip pause call",
			zap.String("sandbox_id", entity.SandboxId),
		)
	}

	if err := l.instanceDao.TransitionStatus(
		ctx,
		entity.Id,
		[]string{modelinstance.InstanceStatusRunning, modelinstance.InstanceStatusResuming},
		modelinstance.InstanceStatusPaused,
	); err != nil {
		// CAS 失败常见于并发被 PauseInstance 改了状态：再次 GetByInstanceID 兜底
		current, getErr := l.instanceDao.GetByInstanceID(ctx, entity.InstanceId)
		if getErr == nil && current.Status == modelinstance.InstanceStatusPaused {
			logger.Info("isolate task: state already paused after CAS reject, success")
			return nil
		}
		return fmt.Errorf("persist paused state: %w", err)
	}
	logger.Info("isolate task: instance paused successfully")
	return nil
}

// FinalizeIsolateInstanceTaskFailure 子 task IsolateInstance 失败兜底
//
// 不做 instance 状态回滚（execute 走的是 Running → Paused 直接迁移），仅记录 operation 失败
func (l *logic) FinalizeIsolateInstanceTaskFailure(ctx pctx.Context, payload *common.IsolateInstanceTaskPayload, taskErr error) {
	if payload == nil {
		return
	}
	l.completeOperation(ctx, payload.OperationID, taskErr)
	l.logger.Warn("isolate instance task finalize failure",
		zap.Error(taskErr),
		zap.String("instance_id", payload.InstanceID),
		zap.String("pass_id", payload.PassID),
	)
}

// === trade-pass-renew 子 task 业务实现（设计稿 §3.4 / §5 / R-D-4）===
//
// RunRenewInstanceTask 子 task RenewInstance 的 execute 入口（与 RunIsolateInstanceTask 对偶反向）
//
// 流程：
//  1. 反查 instance；NotFound / 已 Running / 已 Deleted/Failed → 直接成功（幂等）
//  2. 校验 sandbox_id；空 / pending → 跳过 sandbox 调用，仅 CAS 状态
//  3. 调 sandbox.ResumeSandbox；遇 already-running 视为成功
//  4. CAS Paused → Running（与 ResumeInstance 同语义）
//
// ⚠️ R-F 阻塞：sandbox.ResumeSandbox handler 当前是 noop（不调 cp.StartInstance / 不调 CVM SDK），
// 等 R-F 落地后续费链路才真闭环；本期单测用 mock adapter 验证调用路径即可。
func (l *logic) RunRenewInstanceTask(ctx pctx.Context, payload *common.RenewInstanceTaskPayload) error {
	if payload == nil || strings.TrimSpace(payload.InstanceID) == "" {
		return errcode.ErrInstanceInvalidParam
	}
	logger := l.logger.With(
		zap.String("instance_id", payload.InstanceID),
		zap.String("pass_id", payload.PassID),
	)

	entity, err := l.instanceDao.GetByInstanceID(ctx, payload.InstanceID)
	if err != nil {
		if errors.Is(err, errcode.ErrInstanceNotFound) {
			logger.Info("renew task: instance not found, treat as success")
			return nil
		}
		return err
	}
	migrateGateway := strings.TrimSpace(payload.TargetGateway)
	switch entity.Status {
	case modelinstance.InstanceStatusRunning:
		if migrateGateway == "" {
			logger.Info("renew task: instance already running, short-circuit")
			return nil
		}
	case modelinstance.InstanceStatusDeleted, modelinstance.InstanceStatusFailed:
		logger.Info("renew task: instance in terminal state, no-op",
			zap.String("status", entity.Status),
		)
		return nil
	case modelinstance.InstanceStatusPaused:
		// 正常路径
	default:
		// Creating / Deleting 等中间态：让框架按 60s interval 重试，等其先到 Running/Paused/终态
		return fmt.Errorf("instance status=%s not eligible for renew yet", entity.Status)
	}

	wasPaused := entity.Status == modelinstance.InstanceStatusPaused
	if wasPaused && entity.SandboxId != "" && !isPendingSandboxID(entity.SandboxId) {
		// ResumeSandbox 默认请求体（不带 timeout 覆盖；timeout 维持 sandbox 服务侧默认值）
		// 与 ResumeInstance 主路径一致，但本子 task 是系统侧自动续费，不强制重置 timeout
		if _, err := l.sandboxAdapter.ResumeSandbox(ctx, entity.SandboxId, &psandbox.ResumeSandboxRequest{}); err != nil {
			switch {
			case isSandboxNotFound(err):
				// sandbox 已不存在（被人工或异常流程删除）→ instance 已无可恢复的 sandbox。
				// 业务上 RenewInstance 子 task 的语义是"让 instance 回到 Running 终态"，
				// 与 IsolateInstance / DestroyInstance 的 DeleteSandbox 容错保持一致：
				// 视为幂等成功，继续走 CAS Paused→Running，不阻塞续费父 task 收尾。
				logger.Warn("renew task: sandbox not found, treating as success and continuing CAS",
					zap.String("sandbox_id", entity.SandboxId),
					zap.Error(err),
				)
			case isExpectedSandboxConflict(err, expectedResumeConflictMessages):
				logger.Warn("renew task: sandbox already running, treating as success",
					zap.String("sandbox_id", entity.SandboxId),
					zap.Error(err),
				)
			default:
				return fmt.Errorf("resume sandbox: %w", err)
			}
		}
	} else if wasPaused {
		logger.Warn("renew task: instance has no usable sandbox, skip resume call",
			zap.String("sandbox_id", entity.SandboxId),
		)
	}

	if wasPaused {
		if err := l.instanceDao.TransitionStatus(
			ctx,
			entity.Id,
			[]string{modelinstance.InstanceStatusPaused},
			modelinstance.InstanceStatusRunning,
		); err != nil {
			// CAS 失败常见于并发被 ResumeInstance 改了状态：再次 GetByInstanceID 兜底
			current, getErr := l.instanceDao.GetByInstanceID(ctx, entity.InstanceId)
			if getErr == nil && current.Status == modelinstance.InstanceStatusRunning {
				logger.Info("renew task: state already running after CAS reject, continue")
				entity = current
			} else {
				return fmt.Errorf("persist running state: %w", err)
			}
		} else {
			logger.Info("renew task: instance resumed successfully")
			entity.Status = modelinstance.InstanceStatusRunning
		}
	}

	if migrateGateway != "" {
		if migrateGateway != gatewayroute.GatewayLLMGateway {
			return fmt.Errorf("unsupported renewal migration target gateway %q", migrateGateway)
		}
		if err := l.applyRenewalGatewayMigration(ctx, entity, gatewayBackendLLMGateway); err != nil {
			return fmt.Errorf("apply renewal gateway migration: %w", err)
		}
	}
	return nil
}

func (l *logic) applyRenewalGatewayMigration(ctx pctx.Context, entity *modelinstance.Entity, backend gatewayBackend) error {
	if entity == nil {
		return fmt.Errorf("instance is nil")
	}
	if strings.TrimSpace(entity.SandboxId) == "" || isPendingSandboxID(entity.SandboxId) {
		return fmt.Errorf("instance has no usable sandbox")
	}
	userID := strings.TrimSpace(ctx.GetUserID())
	if userID == "" {
		userID = strings.TrimSpace(entity.UserId)
	}
	apiKeyResp, err := l.createAiGatewayApiKey(ctx, backend, userID, entity.InstanceId)
	if err != nil {
		return err
	}
	gwConf, err := l.gatewayRuntimeConfig(backend)
	if err != nil {
		_ = l.revokeGatewayAPIKey(ctx, backend, apiKeyResp.KeyID)
		return err
	}
	if err := l.configureGatewayRuntimeAndRestart(ctx, entity.SandboxId, apiKeyResp.APIKey, gwConf); err != nil {
		_ = l.revokeGatewayAPIKey(ctx, backend, apiKeyResp.KeyID)
		return err
	}
	if err := l.persistAiGatewayKeyIDWithStatuses(ctx, entity, apiKeyResp.KeyID, []string{modelinstance.InstanceStatusRunning}); err != nil {
		_ = l.revokeGatewayAPIKey(ctx, backend, apiKeyResp.KeyID)
		return fmt.Errorf("persist migrated gateway key id: %w", err)
	}
	return nil
}

func (l *logic) revokeGatewayAPIKey(ctx pctx.Context, backend gatewayBackend, keyID string) error {
	if strings.TrimSpace(keyID) == "" {
		return nil
	}
	if backend == gatewayBackendLLMGateway {
		if l.llmGatewayAdapter == nil {
			return fmt.Errorf("llmGatewayAdapter not configured")
		}
		return l.llmGatewayAdapter.RevokeApiKey(ctx, keyID)
	}
	if l.aiGatewayAdapter == nil {
		return fmt.Errorf("aiGatewayAdapter not configured")
	}
	return l.aiGatewayAdapter.RevokeApiKey(ctx, keyID)
}

// FinalizeRenewInstanceTaskFailure 子 task RenewInstance 失败兜底
//
// 不做 instance 状态回滚（execute 走的是 Paused → Running 直接迁移），仅记录 operation 失败
func (l *logic) FinalizeRenewInstanceTaskFailure(ctx pctx.Context, payload *common.RenewInstanceTaskPayload, taskErr error) {
	if payload == nil {
		return
	}
	l.completeOperation(ctx, payload.OperationID, taskErr)
	l.logger.Warn("renew instance task finalize failure",
		zap.Error(taskErr),
		zap.String("instance_id", payload.InstanceID),
		zap.String("pass_id", payload.PassID),
	)
}

// === trade-pass-destroy 子 task 业务实现（设计稿 §4.7 4 阶段流程 / §11-A Q4-a / Q5 / Q9 / Q10 / Q21 / Q25）===

// snapshotPollWaitErr 是子 task 阶段 1+2 中"sandbox 已接受快照创建但尚未 ready"的标准错误。
//
// 与子 task worker 层 finalizeFailure 配合：execute 返回任何非 nil error 都会被 stepMap 路由到
// finalizeFailure；后者默认走 markRetryable（task_state=Created）让 checkTasks bypass 60s 后重投，
// max_execute_count(60) 兜底；只有 ErrSnapshotPermanentFailed 哨兵和 max_execute_count 耗尽才进真终态
// Failed → 父 task 重派新子 task。
var snapshotPollWaitErr = errors.New("waiting for snapshot ready")

// ErrSnapshotPermanentFailed 是 fail-fast 哨兵：子 task 命中后跳过 60 次重试 1h 重试窗口，直接终态
// Failed，让父 task 立刻重派新子 task。命中场景：
//   - cbs 后端报 snapshot StateError（不可逆终态，重试无意义）
//   - payload 关键字段缺失（PassID / TradeFlowID 等参数性致命错，重试无法自愈）
//
// worker 层 finalizeFailure 通过 errors.Is 命中后调 failTask 走 completeTaskFailure。
var ErrSnapshotPermanentFailed = errors.New("snapshot permanent failed")

// RunDestroyInstanceForPassTask 子 task DestroyInstanceWithSnapshot 的 execute 入口
//
// 4 阶段流程（设计稿 §4.7）：
//  1. 阶段 1（payload.SnapshotID==""）：调 sandbox.CreateSnapshot 触发系统盘快照创建
//     - 收到 snapshotID → 写回 payload + UpdatePayload → return snapshotPollWaitErr 让框架重投
//     - sandbox 端返 ErrInstanceNoSystemDisk（Q10/Q25）→ 标记 SnapshotID="<no-disk>" + SnapshotsDone=true
//     直接进入阶段 3+4（snapshot 表也不入）
//  2. 阶段 2（SnapshotsDone==false）：调 sandbox.GetSnapshotStatus 轮询：
//     - "ready"       → 入 ctl snapshot 表（Q9-fix：(flow_id, instance_id) 唯一键防重投冲突）→
//     SnapshotsDone=true + UpdatePayload，进入阶段 3
//     - "in_progress" → return snapshotPollWaitErr 重投
//     - "failed"      → 子 task 终态失败（return 业务错；finalizeFailure 不回滚 instance.status）
//  3. 阶段 3：调 sandbox.DeleteSandbox（与老 DestroyInstance 同接口）销毁 cvm
//  4. 阶段 4：CAS instance.status (Running/Paused/Deleting) → Deleted
//
// 重投幂等：
//   - SnapshotID != "" → 跳过阶段 1
//   - SnapshotsDone == true → 跳过阶段 1+2，直接进 3+4
//   - 父 task 已提前将 instance 从用户侧软删/脱钩时，子 task 继续使用 payload.SandboxID/UserID
//     完成快照和 sandbox 删除，snapshot 表保留原用户关联用于恢复
//
// 入参 taskID 用于 UpdatePayload 持久化进度位（写回 task.task_params 列）。
func (l *logic) RunDestroyInstanceForPassTask(ctx pctx.Context, taskID string, payload *common.DestroyInstanceForPassTaskPayload) error {
	if payload == nil || strings.TrimSpace(payload.InstanceID) == "" {
		// 参数性致命错：payload 缺失 / InstanceID 为空 — 重试无法自愈，fail-fast 让父 task 重派。
		return fmt.Errorf("%w: %v", ErrSnapshotPermanentFailed, errcode.ErrInstanceInvalidParam)
	}
	if payload.PassID == "" {
		return fmt.Errorf("%w: payload.PassID is required", ErrSnapshotPermanentFailed)
	}
	if payload.TradeFlowID <= 0 {
		// trade_flow_id 是 snapshot 表 (flow_id, instance_id) UNIQUE 键左半，必须 > 0；
		// 0 值通常是父 task payload 没透传 — fail-fast 让父 task 重派（防止 snapshot 表脏数据 + 60min 重试空转）。
		return fmt.Errorf("%w: payload.TradeFlowID must be > 0, got %d", ErrSnapshotPermanentFailed, payload.TradeFlowID)
	}

	logger := l.logger.With(
		zap.String("instance_id", payload.InstanceID),
		zap.String("pass_id", payload.PassID),
		zap.Int64("trade_flow_id", payload.TradeFlowID),
		zap.String("task_id", taskID),
	)

	entity, err := getInstanceForPassDestroy(ctx, l.instanceDao, payload.InstanceID)
	if err != nil {
		if errors.Is(err, errcode.ErrInstanceNotFound) {
			if payload.SandboxID != "" && !isPendingSandboxID(payload.SandboxID) {
				logger.Warn("destroy task: instance row not found, continue with payload sandbox id",
					zap.String("sandbox_id", payload.SandboxID))
			} else {
				logger.Info("destroy task: instance not found and no usable payload sandbox, treat as already destroyed")
				return nil
			}
		} else {
			return fmt.Errorf("get instance: %w", err)
		}
	}
	sandboxID := strings.TrimSpace(payload.SandboxID)
	if sandboxID == "" && entity != nil {
		sandboxID = entity.SandboxId
	}
	if entity != nil && entity.Status == modelinstance.InstanceStatusFailed &&
		(sandboxID == "" || isPendingSandboxID(sandboxID)) {
		// Failed 是终态且无可用 sandbox；记录 warn 后视为成功（不强行删 cvm，避免无限重试）
		logger.Warn("destroy task: instance in Failed terminal state without usable sandbox, treat as success",
			zap.String("status", entity.Status))
		return nil
	}
	if sandboxID == "" || isPendingSandboxID(sandboxID) {
		if entity != nil && entity.Status == modelinstance.InstanceStatusDeleted && payload.SnapshotsDone {
			logger.Info("destroy task: detached instance has no usable sandbox and snapshots are done, success")
			return nil
		}
	}

	// === 阶段 1：发起快照创建 ===
	if payload.SnapshotID == "" {
		if sandboxID == "" || isPendingSandboxID(sandboxID) {
			// instance 没有可用 sandbox → 跳过快照（无系统盘语义同等价处理）
			logger.Warn("destroy task: instance has no usable sandbox, skip snapshot phase",
				zap.String("sandbox_id", sandboxID))
			payload.SnapshotID = "<no-sandbox>"
			payload.SnapshotsDone = true
			if updErr := l.updateTaskPayload(ctx, taskID, payload); updErr != nil {
				return fmt.Errorf("update task payload after no-sandbox skip: %w", updErr)
			}
		} else {
			// 调 sandbox.CreateSnapshot
			retentionSec := int64(snapshotRetentionSeconds())
			req := &psandbox.CreateSnapshotRequest{
				InstanceID:       payload.InstanceID,
				PassID:           payload.PassID,
				UserID:           payload.UserID,
				Region:           payload.Region,
				RetentionSeconds: retentionSec,
			}
			resp, sErr := l.sandboxAdapter.CreateSnapshot(ctx, sandboxID, req)
			if sErr != nil {
				if isInstanceNoSystemDiskError(sErr) {
					// Q10/Q25 联动：无系统盘 → 跳过快照阶段，直接进入阶段 3+4
					logger.Info("destroy task: sandbox returned INSTANCE_NO_SYSTEM_DISK, skip snapshot phases",
						zap.Error(sErr))
					payload.SnapshotID = "<no-disk>"
					payload.SnapshotsDone = true
					if updErr := l.updateTaskPayload(ctx, taskID, payload); updErr != nil {
						return fmt.Errorf("update task payload after no-disk skip: %w", updErr)
					}
				} else {
					// 其它错（包括 sandbox 5xx / 网络）：让框架重投
					return fmt.Errorf("sandbox.CreateSnapshot: %w", sErr)
				}
			} else {
				if resp == nil || resp.SnapshotID == "" {
					return errors.New("sandbox.CreateSnapshot: empty snapshotID")
				}
				payload.SnapshotID = resp.SnapshotID
				if updErr := l.updateTaskPayload(ctx, taskID, payload); updErr != nil {
					return fmt.Errorf("update task payload after CreateSnapshot: %w", updErr)
				}
				logger.Info("destroy task: snapshot creation initiated",
					zap.String("snapshot_id", resp.SnapshotID),
					zap.Int64("retention_seconds", retentionSec))
				// 阶段 1 完成 — 让框架按 60s ExecuteInterval 重投，下一轮进入阶段 2
				return snapshotPollWaitErr
			}
		}
	}

	// === 阶段 2：轮询快照状态 + 入 snapshot 表 ===
	if !payload.SnapshotsDone {
		// payload.SnapshotID != "<no-disk>" / "<no-sandbox>" 时才真调 sandbox 轮询
		if !isSnapshotSentinel(payload.SnapshotID) && sandboxID != "" && !isPendingSandboxID(sandboxID) {
			statusResp, sErr := l.sandboxAdapter.GetSnapshotStatus(ctx, sandboxID, payload.SnapshotID)
			if sErr != nil {
				return fmt.Errorf("sandbox.GetSnapshotStatus: %w", sErr)
			}
			if statusResp == nil {
				return errors.New("sandbox.GetSnapshotStatus: nil response")
			}
			switch statusResp.Status {
			case modelsnapshot.StateError:
				// 快照失败 — cbs 后端不可逆终态，重试无意义；fail-fast 让父 task 立刻重派新子 task
				// （结合 sandbox 端 cbs.ClientToken 幂等，新子 task 阶段 1 触发的 CreateSnapshot 会拿到全新 SnapshotId）。
				return fmt.Errorf("%w: snapshot failed: %s", ErrSnapshotPermanentFailed, statusResp.Reason)
			case modelsnapshot.StateInProgress:
				// 仍在创建中，让框架按 60s 重投
				logger.Info("destroy task: snapshot still in progress, will retry",
					zap.String("snapshot_id", payload.SnapshotID))
				return snapshotPollWaitErr
			case modelsnapshot.StateNormal:
				// ready — 入 snapshot 表
			default:
				return fmt.Errorf("sandbox.GetSnapshotStatus unexpected status: %q (reason=%s)",
					statusResp.Status, statusResp.Reason)
			}

			// 入表（Q9-fix：(flow_id, instance_id) 唯一键防重投冲突）
			snapshotDao := modelsnapshot.NewDao()
			existing, getErr := snapshotDao.GetByFlowAndInstance(ctx, payload.TradeFlowID, payload.InstanceID)
			if getErr == nil && existing != nil {
				// 重投场景：本子 task 上一轮已入表，跳过
				logger.Info("destroy task: snapshot already persisted (idempotent re-entry), skip insert",
					zap.String("snapshot_id", payload.SnapshotID))
			} else {
				retention := time.Duration(snapshotRetentionSeconds()) * time.Second
				snapshotEntity := &modelsnapshot.Entity{
					SnapshotID:    payload.SnapshotID,
					FlowID:        payload.TradeFlowID,
					PassID:        payload.PassID,
					InstanceID:    payload.InstanceID,
					UserID:        payload.UserID,
					Uin:           payload.UIN,
					AppID:         payload.AppID,
					Region:        payload.Region,
					SnapshotState: modelsnapshot.StateNormal,
					ExpireTime:    time.Now().UTC().Add(retention),
				}
				if insErr := snapshotDao.Create(ctx, snapshotEntity); insErr != nil {
					return fmt.Errorf("snapshot.Create: %w", insErr)
				}
				logger.Info("destroy task: snapshot persisted in ctl snapshot table",
					zap.String("snapshot_id", payload.SnapshotID),
					zap.Time("expire_time", snapshotEntity.ExpireTime))
			}
		}
		payload.SnapshotsDone = true
		if updErr := l.updateTaskPayload(ctx, taskID, payload); updErr != nil {
			return fmt.Errorf("update task payload after snapshot ready: %w", updErr)
		}
	}

	// === 阶段 3：删除 sandbox（与老 DestroyInstance 同接口）===
	if sandboxID != "" && !isPendingSandboxID(sandboxID) {
		if err := l.sandboxAdapter.DeleteSandbox(ctx, sandboxID); err != nil && !isSandboxNotFound(err) {
			return fmt.Errorf("sandbox.DeleteSandbox: %w", err)
		}
		logger.Info("destroy task: sandbox deleted",
			zap.String("sandbox_id", sandboxID))
	} else {
		logger.Warn("destroy task: instance has no usable sandbox, skip DeleteSandbox call",
			zap.String("sandbox_id", sandboxID))
	}

	// === 阶段 4：CAS instance.status → Deleted + 软删 instance 行 ===
	//
	// 设计稿 §4.7 步骤 4 落地（trade-pass-destroy 销毁链路）：
	//   - status CAS：from-states 包含 Running/Paused/Deleting/Creating（trade-pass 销毁链路不前置改 Deleting，
	//     instance 进入子 task 时可能仍是任意活跃态，全部接住）
	//   - 软删 instance 行（GORM `Delete(&Entity{})` 写 `deleted_at`），与老 DestroyInstance 链路保持一致：
	//     软删后 GORM 默认查询过滤 deleted_at IS NULL，列表/详情查询自动屏蔽该 instance。
	//
	// 配额释放：本阶段绝不能调普通实例销毁的 finalizeInstanceDeletion/releaseQuota。
	// pass 销毁父 task 已经前置删除旧 pass 配额；更晚执行到这里时，同一用户也可能已经购买新 pass。
	// 子 task 若再 +1 恢复配额，会污染新 pass 的 user_resource_quota。这里仅负责实例状态/软删和 sandbox 清理。
	if entity == nil {
		logger.Info("destroy task: instance row absent, sandbox cleanup finished")
		return nil
	}
	if entity.Status == modelinstance.InstanceStatusDeleted || entity.DeletedAt.Valid || entity.UserId == "" {
		logger.Info("destroy task: instance already detached from user, sandbox cleanup finished",
			zap.String("status", entity.Status),
			zap.Bool("deleted_at_valid", entity.DeletedAt.Valid))
		return nil
	}
	if err := l.instanceDao.TransitionStatus(
		ctx,
		entity.Id,
		[]string{
			modelinstance.InstanceStatusRunning,
			modelinstance.InstanceStatusPaused,
			modelinstance.InstanceStatusDeleting,
			modelinstance.InstanceStatusCreating,
		},
		modelinstance.InstanceStatusDeleted,
	); err != nil {
		// CAS 失败常见于并发被 PauseInstance / DeleteInstance 改了状态：再次反查兜底
		current, getErr := l.instanceDao.GetByInstanceID(ctx, entity.InstanceId)
		if getErr == nil && current.Status == modelinstance.InstanceStatusDeleted {
			// 已被并发改成 Deleted：仍需保证软删落地（CAS 路径绕过本函数 DeleteByID，
			// 兜底补一刀，幂等）
			if delErr := l.instanceDao.DeleteByID(ctx, entity.Id); delErr != nil &&
				!errors.Is(delErr, errcode.ErrInstanceNotFound) {
				return fmt.Errorf("soft-delete instance after concurrent CAS reject: %w", delErr)
			}
			logger.Info("destroy task: instance already deleted after CAS reject, success")
			return nil
		}
		return fmt.Errorf("persist deleted state: %w", err)
	}

	// 软删 instance 行（GORM 自动写 deleted_at；重投场景行已软删时 RowsAffected=0 → ErrInstanceNotFound，幂等接住）
	if err := l.instanceDao.DeleteByID(ctx, entity.Id); err != nil {
		if errors.Is(err, errcode.ErrInstanceNotFound) {
			logger.Info("destroy task: instance row already soft-deleted (idempotent), success")
			return nil
		}
		return fmt.Errorf("soft-delete instance row: %w", err)
	}
	logger.Info("destroy task: instance deleted successfully")
	return nil
}

func getInstanceForPassDestroy(ctx pctx.Context, instanceDao modelinstance.Dao, instanceID string) (*modelinstance.Entity, error) {
	if strings.TrimSpace(instanceID) == "" {
		return nil, errcode.ErrInstanceInvalidParam
	}
	if resource.GormDB != nil {
		var entity modelinstance.Entity
		if err := resource.GormDB.Unscoped().
			Where(fmt.Sprintf("%s = ?", modelinstance.ColumnInstanceID), instanceID).
			First(&entity).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return nil, errcode.ErrInstanceNotFound
			}
			return nil, err
		}
		return &entity, nil
	}
	return instanceDao.GetByInstanceID(ctx, instanceID)
}

// FinalizeDestroyInstanceForPassTaskFailure 子 task DestroyInstanceWithSnapshot 失败兜底
//
// 不做 instance 状态回滚（execute 是单向迁移）；仅记录 operation 失败 + 留 instance 当前状态。
// 父 task DestroyPass 看到该子 task FAILED 仍会推进收尾步（本期最终一致性策略，与 isolate 对偶）。
func (l *logic) FinalizeDestroyInstanceForPassTaskFailure(ctx pctx.Context, payload *common.DestroyInstanceForPassTaskPayload, taskErr error) {
	if payload == nil {
		return
	}
	l.completeOperation(ctx, payload.OperationID, taskErr)
	l.logger.Warn("destroy instance for pass task finalize failure",
		zap.Error(taskErr),
		zap.String("instance_id", payload.InstanceID),
		zap.String("pass_id", payload.PassID),
	)
}

// updateTaskPayload 子 task 阶段 1+2 持久化进度位 — 把 payload marshal 后 UPDATE task.task_params 列。
//
// 关键：每次重投开始时框架会从 task.task_params 重新 unmarshal payload，所以这里持久化后下次重投自动可见。
// 不更新 last_execute_time / execute_count（框架已在每轮 update_task_execute 步骤自维护）。
func (l *logic) updateTaskPayload(ctx pctx.Context, taskID string, payload interface{}) error {
	if taskID == "" {
		return errors.New("updateTaskPayload: taskID empty")
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal payload: %w", err)
	}
	if err := l.taskDao.UpdateByKeyColumn(map[string]interface{}{
		taskmodel.ColumnTaskParams: string(body),
	}, taskID); err != nil {
		return fmt.Errorf("update task params: %w", err)
	}
	return nil
}

// snapshotRetentionSeconds 返回 snapshot 表 expire_time 字段的"现在 + retention"窗口秒数。
//
// Q7 ✅ 拍板（2026-05-17，方案 B）：snapshot 有效期写到 ctl 配置文件，**默认 3 个月**。
// 配置项：config.ServerConf.MiscConfig.SnapshotRetentionSeconds（int），<=0 时回退到默认 90 天。
//
// sandbox.CreateSnapshot 的 RetentionSeconds 入参也复用此函数（同一窗口透传给 cbs Deadline）。
func snapshotRetentionSeconds() int64 {
	const defaultDays = 90 // 3 个月（Q7 默认值）
	if config.ServerConf != nil {
		if v := config.ServerConf.MiscConfig.SnapshotRetentionSeconds; v > 0 {
			return int64(v)
		}
	}
	return int64(defaultDays) * 24 * 3600
}

// isSnapshotSentinel 判断 SnapshotID 是否是 ctl 子 task 内部哨兵值（"<no-disk>" / "<no-sandbox>"）：
// 这些值表明跳过了 sandbox.CreateSnapshot，因此阶段 2 也不应调 sandbox.GetSnapshotStatus。
func isSnapshotSentinel(snapshotID string) bool {
	switch snapshotID {
	case "<no-disk>", "<no-sandbox>":
		return true
	}
	return false
}

// isInstanceNoSystemDiskError 判断 sandbox.CreateSnapshot 的错误是否是 INSTANCE_NO_SYSTEM_DISK 业务码（HTTP 422）。
//
// Q10/Q25 联动：sandbox handler 在 inst.CloudID==空 / cbs DescribeDisks 反查不到系统盘时返
// 422 + code=INSTANCE_NO_SYSTEM_DISK；ctl 子 task 据此跳过快照阶段直接销毁。
func isInstanceNoSystemDiskError(err error) bool {
	if err == nil {
		return false
	}
	// sandbox adapter 把响应 envelope 错误码透传到 errcode；ctl 这边按字符串匹配（避免循环引入 sandbox 错误类型）。
	return strings.Contains(err.Error(), "INSTANCE_NO_SYSTEM_DISK")
}

func (l *logic) runCreateTaskInline(ctx pctx.Context, taskID string, payload *CreateInstanceTaskPayload) (err error) {
	ctx, span := tracing.StartTrace(ctx, "Instance.RunCreateTaskInline")
	defer func() { span.EndWithError(err) }()

	if err := l.taskDao.UpdateByKeyColumn(map[string]interface{}{
		taskmodel.ColumnExecuteCount:    1,
		taskmodel.ColumnLastExecuteTime: time.Now().UTC(),
		taskmodel.ColumnTaskState:       taskmodel.StateRunning,
	}, taskID); err != nil {
		return err
	}
	if err := l.RunCreateInstanceTask(ctx, payload); err != nil {
		_ = l.taskDao.UpdateByKeyColumn(map[string]interface{}{
			taskmodel.ColumnTaskState:   taskmodel.StateFailed,
			taskmodel.ColumnTaskMessage: truncateTaskMessage(err),
		}, taskID)
		l.FinalizeCreateInstanceTaskFailure(ctx, payload, err)
		return err
	}
	if err := l.taskDao.UpdateByKeyColumn(map[string]interface{}{
		taskmodel.ColumnTaskState:   taskmodel.StateSuccess,
		taskmodel.ColumnTaskMessage: "",
	}, taskID); err != nil {
		return err
	}
	l.completeOperation(ctx, payload.OperationID, nil)
	return nil
}

func (l *logic) runDestroyTaskInline(ctx pctx.Context, taskID string, payload *DestroyInstanceTaskPayload) error {
	if err := l.taskDao.UpdateByKeyColumn(map[string]interface{}{
		taskmodel.ColumnExecuteCount:    1,
		taskmodel.ColumnLastExecuteTime: time.Now().UTC(),
		taskmodel.ColumnTaskState:       taskmodel.StateRunning,
	}, taskID); err != nil {
		return err
	}
	if err := l.RunDestroyInstanceTask(ctx, payload); err != nil {
		if errors.Is(err, errcode.ErrSandboxServiceError) {
			if entity, getErr := l.instanceDao.GetByInstanceID(ctx, payload.InstanceID); getErr == nil && entity.Status == modelinstance.InstanceStatusDeleting {
				_ = l.instanceDao.UpdateStatus(ctx, entity.Id, modelinstance.InstanceStatusFailed)
			}
		}
		_ = l.taskDao.UpdateByKeyColumn(map[string]interface{}{
			taskmodel.ColumnTaskState:   taskmodel.StateFailed,
			taskmodel.ColumnTaskMessage: truncateTaskMessage(err),
		}, taskID)
		l.FinalizeDestroyInstanceTaskFailure(ctx, payload, err)
		return err
	}
	if err := l.taskDao.UpdateByKeyColumn(map[string]interface{}{
		taskmodel.ColumnTaskState:   taskmodel.StateSuccess,
		taskmodel.ColumnTaskMessage: "",
	}, taskID); err != nil {
		return err
	}
	l.completeOperation(ctx, payload.OperationID, nil)
	return nil
}

func (l *logic) runBuildBirthProfileTaskInline(ctx pctx.Context, taskID string, payload *BuildInstanceBirthProfileTaskPayload) error {
	if err := l.taskDao.UpdateByKeyColumn(map[string]interface{}{
		taskmodel.ColumnExecuteCount:    1,
		taskmodel.ColumnLastExecuteTime: time.Now().UTC(),
		taskmodel.ColumnTaskState:       taskmodel.StateRunning,
	}, taskID); err != nil {
		return err
	}

	svc := instancebirth.NewService(
		modelfactory.DefaultDaoFactory.InstanceDao(ctx),
		modelfactory.DefaultDaoFactory.InstanceBirthProfileDao(ctx),
	)
	if err := svc.RebuildForInstance(ctx, payload.InstanceID); err != nil {
		_ = l.taskDao.UpdateByKeyColumn(map[string]interface{}{
			taskmodel.ColumnTaskState:   taskmodel.StateFailed,
			taskmodel.ColumnTaskMessage: truncateTaskMessage(err),
		}, taskID)
		return err
	}

	return l.taskDao.UpdateByKeyColumn(map[string]interface{}{
		taskmodel.ColumnTaskState:   taskmodel.StateSuccess,
		taskmodel.ColumnTaskMessage: "",
	}, taskID)
}

func (l *logic) persistCreatedSandboxID(ctx pctx.Context, entity *modelinstance.Entity, sandboxID string) error {
	previousSandboxID := ""
	instanceID := ""
	instanceDBID := int64(0)
	if entity != nil {
		previousSandboxID = entity.SandboxId
		instanceID = entity.InstanceId
		instanceDBID = entity.Id
	}
	if err := l.instanceDao.UpdateWithStatusPrecondition(ctx, entity.Id, []string{modelinstance.InstanceStatusCreating}, map[string]interface{}{
		modelinstance.ColumnSandboxID: sandboxID,
	}); err != nil {
		fields := []zap.Field{
			zap.String("instance_id", instanceID),
			zap.Int64("instance_db_id", instanceDBID),
			zap.String("previous_sandbox_id", previousSandboxID),
			zap.String("attempt_sandbox_id", sandboxID),
			zap.String("pod_name", currentPodNameForDebug()),
			zap.Error(err),
		}
		if latest, latestErr := l.instanceDao.GetByID(ctx, entity.Id); latestErr == nil && latest != nil {
			fields = append(fields,
				zap.String("current_sandbox_id", latest.SandboxId),
				zap.String("current_status", latest.Status),
				zap.Time("current_updated_at", latest.UpdatedAt),
			)
		}
		l.logger.Warn("sandbox assignment persist failed", fields...)
		if isDuplicateKeyError(err) {
			return errcode.Wrap(errcode.ErrInstanceCreationFailed, "duplicate sandbox id: %s", sandboxID)
		}
		return errcode.Wrap(errcode.ErrInstanceCreationFailed, "persist sandbox id %s: %v", sandboxID, err)
	}
	entity.SandboxId = sandboxID
	l.logger.Info("sandbox assignment persisted",
		zap.String("instance_id", instanceID),
		zap.Int64("instance_db_id", instanceDBID),
		zap.String("previous_sandbox_id", previousSandboxID),
		zap.String("current_sandbox_id", sandboxID),
		zap.String("pod_name", currentPodNameForDebug()),
	)
	return nil
}

func (l *logic) persistAiGatewayKeyID(ctx pctx.Context, entity *modelinstance.Entity, keyID string) error {
	return l.persistAiGatewayKeyIDWithStatuses(ctx, entity, keyID, []string{modelinstance.InstanceStatusCreating})
}

func (l *logic) persistAiGatewayKeyIDWithStatuses(ctx pctx.Context, entity *modelinstance.Entity, keyID string, statuses []string) error {
	keyID = strings.TrimSpace(keyID)
	if keyID == "" {
		return fmt.Errorf("ai-gateway key_id is empty")
	}
	if err := l.instanceDao.UpdateWithStatusPrecondition(ctx, entity.Id, statuses, map[string]interface{}{
		modelinstance.ColumnAiGatewayKeyID: keyID,
	}); err != nil {
		return fmt.Errorf("persist ai-gateway key id: %w", err)
	}
	entity.AiGatewayKeyID = keyID
	return nil
}

func generateGatewayAuthToken() (string, error) {
	buf := make([]byte, 24)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("generate gateway auth token: %w", err)
	}
	return hex.EncodeToString(buf), nil
}

func (l *logic) persistGatewayAuthToken(ctx pctx.Context, entity *modelinstance.Entity, token string) error {
	return l.persistGatewayAuthTokenWithStatuses(ctx, entity, token, []string{modelinstance.InstanceStatusCreating})
}

func (l *logic) persistGatewayAuthTokenWithStatuses(ctx pctx.Context, entity *modelinstance.Entity, token string, statuses []string) error {
	token = strings.TrimSpace(token)
	if token == "" {
		return fmt.Errorf("gateway auth token is empty")
	}
	if err := l.instanceDao.UpdateWithStatusPrecondition(ctx, entity.Id, statuses, map[string]interface{}{
		modelinstance.ColumnGatewayAuthToken: token,
	}); err != nil {
		return fmt.Errorf("persist gateway auth token: %w", err)
	}
	entity.GatewayAuthToken = token
	return nil
}

type gatewayBackend string

const (
	gatewayBackendAiGateway  gatewayBackend = "ai-gateway"
	gatewayBackendLLMGateway gatewayBackend = "llmgateway"
)

type gatewayAPIKey struct {
	APIKey    string
	KeyID     string
	KeyPrefix string
}

type gatewayRuntimeConfig struct {
	DefaultBaseURL       string
	DefaultModelID       string
	DefaultCompatibility string
}

func (l *logic) resolveProvisionGateway(ctx pctx.Context, userID, instanceID string) gatewayBackend {
	if gateway, ok, err := gatewayroute.Get(userID); err != nil {
		l.logger.Warn("resolve instance gateway backend: get recorded subscription gateway failed, fallback to probe",
			zap.String("instance_id", instanceID),
			zap.String("user_id", userID),
			zap.Error(err))
	} else if ok {
		switch gateway {
		case gatewayroute.GatewayAIGateway:
			return gatewayBackendAiGateway
		case gatewayroute.GatewayLLMGateway:
			if config.LLMGatewayEnabled() {
				return gatewayBackendLLMGateway
			}
			l.logger.Warn("resolve instance gateway backend: llmgateway route disabled by explicit configuration gate, use ai-gateway",
				zap.String("instance_id", instanceID),
				zap.String("user_id", userID))
			return gatewayBackendAiGateway
		default:
			l.logger.Warn("resolve instance gateway backend: unknown recorded subscription gateway, fallback to probe",
				zap.String("instance_id", instanceID),
				zap.String("user_id", userID),
				zap.String("gateway", gateway))
		}
	}

	if l.aiGatewayAdapter != nil {
		sub, err := l.aiGatewayAdapter.GetActiveSubscription(ctx, userID)
		if err == nil && sub != nil {
			gatewayroute.RecordBestEffort(l.logger, userID, gatewayroute.GatewayAIGateway, sub.ID, sub.PlanID, gatewayroute.SourceDetectActiveSubscription)
			l.logger.Info("resolved instance gateway backend from ai-gateway active subscription",
				zap.String("instance_id", instanceID),
				zap.String("user_id", userID))
			return gatewayBackendAiGateway
		}
		if err != nil && !isLegacyGatewayDisabled(err) {
			l.logger.Warn("resolve instance gateway backend: get ai-gateway active subscription failed, use llmgateway",
				zap.String("instance_id", instanceID),
				zap.String("user_id", userID),
				zap.Error(err))
		}
	}
	if gatewayroute.NewAllocationGateway(userID) != gatewayroute.GatewayLLMGateway {
		return gatewayBackendAiGateway
	}
	if l.llmGatewayAdapter != nil {
		sub, err := l.llmGatewayAdapter.GetActiveSubscription(ctx, userID)
		if err == nil && sub != nil {
			gatewayroute.RecordBestEffort(l.logger, userID, gatewayroute.GatewayLLMGateway, sub.ID, sub.PlanID, gatewayroute.SourceDetectActiveSubscription)
		} else if err != nil {
			l.logger.Warn("resolve instance gateway backend: get llmgateway active subscription failed, use llmgateway",
				zap.String("instance_id", instanceID),
				zap.String("user_id", userID),
				zap.Error(err))
		}
	}
	return gatewayBackendLLMGateway
}

func (l *logic) gatewayRuntimeConfig(backend gatewayBackend) (*gatewayRuntimeConfig, error) {
	if config.ServerConf == nil || config.ServerConf.AdapterConfig == nil {
		return nil, fmt.Errorf("adapter config not configured")
	}
	if backend == gatewayBackendAiGateway {
		conf := config.ServerConf.AdapterConfig.AiGateway
		if conf == nil {
			return nil, fmt.Errorf("ai-gateway config not configured")
		}
		return &gatewayRuntimeConfig{
			DefaultBaseURL:       conf.DefaultBaseURL,
			DefaultModelID:       conf.DefaultModelID,
			DefaultCompatibility: conf.DefaultCompatibility,
		}, nil
	}
	conf := config.ServerConf.AdapterConfig.LLMGateway
	if conf == nil {
		return nil, fmt.Errorf("llmgateway config not configured")
	}
	return &gatewayRuntimeConfig{
		DefaultBaseURL:       conf.DefaultBaseURL,
		DefaultModelID:       conf.DefaultModelID,
		DefaultCompatibility: conf.DefaultCompatibility,
	}, nil
}

// createAiGatewayApiKey 在用户与权益准备完成后调用选定网关创建 API Key。
// 所有实例侧签发入口必须经过这里，避免产生可鉴权但没有可用额度的密钥。
func (l *logic) createAiGatewayApiKey(ctx pctx.Context, backend gatewayBackend, userID, instanceID string) (*gatewayAPIKey, error) {
	if err := l.ensureAiGatewayUser(ctx, backend, userID, "", instanceID); err != nil {
		return nil, err
	}
	if backend == gatewayBackendLLMGateway {
		if err := l.ensureLegacyPassEntitlement(ctx, userID); err != nil {
			return nil, fmt.Errorf("ensure llmgateway pass entitlement: %w", err)
		}
	}
	l.logger.Info("gateway create-api-key started",
		zap.String("instance_id", instanceID),
		zap.String("user_id", userID),
		zap.String("gateway", string(backend)),
	)
	var (
		keyID     string
		apiKey    string
		keyPrefix string
		err       error
	)
	if backend == gatewayBackendAiGateway {
		if l.aiGatewayAdapter == nil {
			return nil, fmt.Errorf("aiGatewayAdapter not configured")
		}
		var resp *paigateway.CreateApiKeyResponse
		resp, err = l.aiGatewayAdapter.CreateApiKey(ctx, userID, "default")
		if resp != nil {
			keyID = resp.KeyID
			apiKey = resp.APIKey
			keyPrefix = resp.KeyPrefix
		}
	} else {
		if l.llmGatewayAdapter == nil {
			return nil, fmt.Errorf("llmGatewayAdapter not configured")
		}
		var resp *pllmgateway.CreateApiKeyResponse
		resp, err = l.llmGatewayAdapter.CreateApiKey(ctx, userID, "default")
		if resp != nil {
			keyID = resp.KeyID
			apiKey = resp.APIKey
			keyPrefix = resp.KeyPrefix
		}
	}
	if err != nil {
		l.logger.Warn("gateway create-api-key failed",
			zap.String("instance_id", instanceID),
			zap.String("user_id", userID),
			zap.String("gateway", string(backend)),
			zap.Error(err),
		)
		return nil, fmt.Errorf("%s create-api-key: %w", backend, err)
	}
	if strings.TrimSpace(keyID) == "" {
		return nil, fmt.Errorf("%s create-api-key: missing key_id", backend)
	}
	if strings.TrimSpace(apiKey) == "" {
		return nil, fmt.Errorf("%s create-api-key: missing api_key", backend)
	}
	l.logger.Info("gateway create-api-key succeeded",
		zap.String("instance_id", instanceID),
		zap.String("user_id", userID),
		zap.String("gateway", string(backend)),
		zap.String("key_id", keyID),
	)
	return &gatewayAPIKey{KeyID: keyID, APIKey: apiKey, KeyPrefix: keyPrefix}, nil
}

func (l *logic) revokeAiGatewayApiKey(ctx pctx.Context, keyID string) error {
	if strings.TrimSpace(keyID) == "" {
		return nil
	}
	if l.aiGatewayAdapter != nil {
		err := l.aiGatewayAdapter.RevokeApiKey(ctx, keyID)
		if err == nil {
			return nil
		}
		if !isLegacyGatewayDisabled(err) && !isAiGatewayKeyNotFound(err) {
			l.logger.Warn("revoke ai-gateway api key failed, try llmgateway",
				zap.String("key_id", keyID),
				zap.Error(err))
		}
	}
	if l.llmGatewayAdapter == nil {
		return fmt.Errorf("llmGatewayAdapter not configured")
	}
	return l.llmGatewayAdapter.RevokeApiKey(ctx, keyID)
}

func isDuplicateKeyError(err error) bool {
	if err == nil {
		return false
	}
	return strings.Contains(err.Error(), "Duplicate entry") || strings.Contains(err.Error(), "1062")
}

func isAiGatewayKeyNotFound(err error) bool {
	if err == nil {
		return false
	}
	return strings.Contains(err.Error(), "status 404")
}

func isLegacyGatewayDisabled(err error) bool {
	return errors.Is(err, paigateway.ErrAiGatewayNotConfigured)
}

func currentPodNameForDebug() string {
	if name := os.Getenv("POD_NAME"); name != "" {
		return name
	}
	if name, err := os.Hostname(); err == nil && name != "" {
		return name
	}
	return "unknown"
}

func (l *logic) aiGatewayProvisioningEnabled() bool {
	conf := config.ServerConf.AdapterConfig
	if conf == nil {
		return false
	}
	return (conf.AiGateway != nil && strings.TrimSpace(conf.AiGateway.BaseURL) != "") ||
		(conf.LLMGateway != nil && strings.TrimSpace(conf.LLMGateway.BaseURL) != "")
}

func (l *logic) ensureAiGatewayUser(ctx pctx.Context, backend gatewayBackend, userID, nickname, instanceID string) error {
	l.logger.Info("gateway ensure-user started",
		zap.String("instance_id", instanceID),
		zap.String("user_id", userID),
		zap.String("gateway", string(backend)),
	)
	result := ""
	var err error
	if backend == gatewayBackendAiGateway {
		if l.aiGatewayAdapter == nil {
			return fmt.Errorf("aiGatewayAdapter not configured")
		}
		var resp *paigateway.EnsureUserResponse
		resp, err = l.aiGatewayAdapter.EnsureUser(ctx, userID, nickname)
		if resp != nil {
			result = resp.Result
		}
	} else {
		if l.llmGatewayAdapter == nil {
			return fmt.Errorf("llmGatewayAdapter not configured")
		}
		var resp *pllmgateway.EnsureUserResponse
		resp, err = l.llmGatewayAdapter.EnsureUser(ctx, userID, nickname)
		if resp != nil {
			result = resp.Result
		}
	}
	if err != nil {
		l.logger.Warn("gateway ensure-user failed",
			zap.String("instance_id", instanceID),
			zap.String("user_id", userID),
			zap.String("gateway", string(backend)),
			zap.Error(err),
		)
		return fmt.Errorf("%s ensure-user: %w", backend, err)
	}
	l.logger.Info("gateway ensure-user succeeded",
		zap.String("instance_id", instanceID),
		zap.String("user_id", userID),
		zap.String("gateway", string(backend)),
		zap.String("result", strings.TrimSpace(result)),
	)
	return nil
}

func (l *logic) provisionAiGatewayOnCreate(ctx pctx.Context, entity *modelinstance.Entity, sandboxID string) error {
	backend := l.resolveProvisionGateway(ctx, ctx.GetUserID(), entity.InstanceId)
	apiKeyResp, err := l.createAiGatewayApiKey(ctx, backend, ctx.GetUserID(), entity.InstanceId)
	if err != nil {
		return err
	}
	gatewayAuthToken, err := generateGatewayAuthToken()
	if err != nil {
		_ = l.revokeAiGatewayApiKey(ctx, apiKeyResp.KeyID)
		return err
	}

	revokeIfNeeded := func(stageErr error) error {
		revokeErr := l.revokeAiGatewayApiKey(ctx, apiKeyResp.KeyID)
		if revokeErr != nil {
			return fmt.Errorf("%w; revoke key %s: %v", stageErr, apiKeyResp.KeyID, revokeErr)
		}
		return stageErr
	}

	gwConf, err := l.gatewayRuntimeConfig(backend)
	if err != nil {
		return revokeIfNeeded(err)
	}
	if err := l.configureOnboard(ctx, sandboxID, apiKeyResp.APIKey, gatewayAuthToken, gwConf); err != nil {
		return revokeIfNeeded(fmt.Errorf("configure onboard: %w", err))
	}

	if err := l.persistAiGatewayKeyID(ctx, entity, apiKeyResp.KeyID); err != nil {
		l.logCreateOnboardPersistenceFailure(ctx, "persist_ai_gateway_key_id", entity, sandboxID, apiKeyResp.KeyID, err)
		return revokeIfNeeded(fmt.Errorf("persist ai-gateway key id: %w", err))
	}
	if err := l.persistGatewayAuthToken(ctx, entity, gatewayAuthToken); err != nil {
		l.logCreateOnboardPersistenceFailure(ctx, "persist_gateway_auth_token", entity, sandboxID, apiKeyResp.KeyID, err)
		return revokeIfNeeded(fmt.Errorf("persist gateway auth token: %w", err))
	}

	return nil
}

func (l *logic) ensureLegacyPassEntitlement(ctx pctx.Context, userID string) error {
	if l.legacyPassEntitlementEnsurer != nil {
		return l.legacyPassEntitlementEnsurer(ctx, userID, time.Now().UTC())
	}
	_, err := entitlementmigration.EnsureLegacyPassEntitlement(ctx, userID, time.Now().UTC())
	return err
}

const hermesRuntimeUser = "agentuser"
const hermesDefaultProviderName = "custom"

// configureOnboard 通过 envd process 在沙箱中完成 Hermes 的默认模型初始化。
//
// 当前路径遵循 Hermes 镜像演进语义：
// 1. 镜像内置 acli 时优先使用 acli
// 2. 老镜像没有 acli 时，由 root 动态安装/更新 harness CLI 到 /usr/local/bin/harness
// 3. 再由 agentuser 执行模型配置命令
//
// 历史上这里走的是 `openclaw onboard` + gateway config patch；那套逻辑已保留在
// legacy helper 中，仅作回滚/排障参考，不再作为 Hermes create-time 初始化路径。
func (l *logic) configureOnboard(ctx pctx.Context, sandboxID string, apiKey string, gatewayAuthToken string, gwConf *gatewayRuntimeConfig) error {
	if strings.TrimSpace(apiKey) == "" {
		return fmt.Errorf("api_key is empty")
	}
	if strings.TrimSpace(gatewayAuthToken) == "" {
		return fmt.Errorf("gateway auth token is empty")
	}
	if gwConf == nil {
		return fmt.Errorf("gateway runtime config is nil")
	}

	baseURL := gwConf.DefaultBaseURL      // 技术债：后续从 provisionResp 读取
	modelID := gwConf.DefaultModelID      // 技术债：后续从 provisionResp 读取
	compat := gwConf.DefaultCompatibility // 技术债：后续从 provisionResp 读取

	if baseURL == "" || modelID == "" {
		return fmt.Errorf("default_base_url or default_model_id not configured")
	}

	// Keep the provider identity stable with the legacy harness setup. The
	// environment config decides the endpoint/model; provider naming is not a
	// separate deploy-time default.
	providerID := hermesDefaultProviderName
	l.logHermesModelSetInput(sandboxID, providerID, modelID, baseURL, compat, apiKey)

	installResult, err := l.execSandboxProcessCommand(ctx, sandboxID, "hermes_ensure_model_cli", &psandbox.ProcessStartRequest{
		Cmd:  "/bin/bash",
		Args: []string{"-l", "-c", renderHermesEnsureModelCLICommand()},
	}, 60)
	l.logHermesCommandResult("hermes_ensure_model_cli", sandboxID, installResult, err)
	if err != nil {
		return fmt.Errorf("exec ensure hermes model cli command: %w", err)
	}
	if !sandboxCommandSucceeded(installResult) {
		return fmt.Errorf("ensure hermes model cli command failed: %s", sandboxCommandFailureDetail(installResult))
	}

	modelSetCommand := shellUserCommand(hermesRuntimeUser, renderHermesModelSetCommand(
		modelID,
		providerID,
		baseURL,
		apiKey,
		compat,
	))
	modelSetResult, err := l.execSandboxProcessCommand(ctx, sandboxID, "hermes_model_set", &psandbox.ProcessStartRequest{
		Cmd:  "/bin/bash",
		Args: []string{"-l", "-c", modelSetCommand},
		Env:  shellUserEnv(hermesRuntimeUser),
	}, 60)
	l.logHermesCommandResult("hermes_model_set", sandboxID, modelSetResult, err)
	if err != nil {
		return fmt.Errorf("exec hermes model set command: %w", err)
	}
	if !sandboxCommandSucceeded(modelSetResult) {
		return fmt.Errorf("hermes model set command failed: %s", sandboxCommandFailureDetail(modelSetResult))
	}

	l.logger.Info("hermes default model configured successfully",
		zap.String("sandbox_id", sandboxID),
		zap.String("provider_id", providerID),
		zap.String("model_id", modelID),
	)
	return nil
}

// configureGatewayRuntimeAndRestart applies a new platform provider/key and
// restarts the Agent gateway in the same sandbox process. It intentionally does
// not reset the whole backend configuration, preserving user-managed providers.
func (l *logic) configureGatewayRuntimeAndRestart(ctx pctx.Context, sandboxID string, apiKey string, gwConf *gatewayRuntimeConfig) error {
	if strings.TrimSpace(apiKey) == "" {
		return fmt.Errorf("api_key is empty")
	}
	if gwConf == nil || strings.TrimSpace(gwConf.DefaultBaseURL) == "" || strings.TrimSpace(gwConf.DefaultModelID) == "" {
		return fmt.Errorf("default_base_url or default_model_id not configured")
	}
	installResult, err := l.execSandboxProcessCommand(ctx, sandboxID, "hermes_ensure_model_cli", &psandbox.ProcessStartRequest{
		Cmd:  "/bin/bash",
		Args: []string{"-l", "-c", renderHermesEnsureModelCLICommand()},
	}, 60)
	if err != nil {
		return fmt.Errorf("exec ensure hermes model cli command: %w", err)
	}
	if !sandboxCommandSucceeded(installResult) {
		return fmt.Errorf("ensure hermes model cli command failed: %s", sandboxCommandFailureDetail(installResult))
	}

	command := shellUserCommand(hermesRuntimeUser, renderHermesModelSetAndRestartCommand(
		gwConf.DefaultModelID,
		hermesDefaultProviderName,
		gwConf.DefaultBaseURL,
		apiKey,
		gwConf.DefaultCompatibility,
	))
	result, err := l.execSandboxProcessCommand(ctx, sandboxID, "hermes_model_set_and_restart", &psandbox.ProcessStartRequest{
		Cmd:  "/bin/bash",
		Args: []string{"-l", "-c", command},
		Env:  shellUserEnv(hermesRuntimeUser),
	}, 120)
	if err != nil {
		return fmt.Errorf("exec hermes model set and restart command: %w", err)
	}
	if !sandboxCommandSucceeded(result) {
		return fmt.Errorf("hermes model set and restart command failed: %s", sandboxCommandFailureDetail(result))
	}
	return nil
}

func renderHermesEnsureModelCLICommand() string {
	return strings.Join([]string{
		`if command -v acli >/dev/null 2>&1; then`,
		`  exit 0`,
		`fi`,
		`sudo curl -fsSL -z /usr/local/bin/harness -o /tmp/harness "https://agentone-1388575217.cos.ap-guangzhou.myqcloud.com/harness-linux-amd64"`,
		`if [ -s /tmp/harness ]; then`,
		`  sudo mv /tmp/harness /usr/local/bin/harness`,
		`  sudo chmod +x /usr/local/bin/harness`,
		`else`,
		`  rm -f /tmp/harness`,
		`fi`,
		`command -v harness >/dev/null 2>&1`,
	}, "\n")
}

func (l *logic) logHermesCommandResult(commandKind string, sandboxID string, result *psandbox.ExecCommandResult, err error) {
	if l.logger == nil {
		return
	}
	fields := []zap.Field{
		zap.String("sandbox_id", sandboxID),
		zap.String("command_kind", commandKind),
	}
	if result != nil {
		fields = append(fields,
			zap.String("status", strings.TrimSpace(result.Status)),
			zap.Int64("exit_code", result.ExitCode),
			zap.String("invocation_id", strings.TrimSpace(result.InvocationID)),
			zap.String("command_id", strings.TrimSpace(result.CommandID)),
			zap.String("stdout_tail", truncateForLog(result.Stdout, 256)),
			zap.String("stderr_tail", truncateForLog(result.Stderr, 256)),
			zap.String("error_info", strings.TrimSpace(result.ErrorInfo)),
		)
	}
	if err != nil {
		l.logger.Warn("hermes command finished with error", append(fields, zap.Error(err))...)
		return
	}
	l.logger.Info("hermes command finished", fields...)
}

func (l *logic) logHermesModelSetInput(sandboxID, providerID, modelID, baseURL, compat, apiKey string) {
	if l.logger == nil {
		return
	}
	l.logger.Info("hermes model set input",
		zap.String("sandbox_id", sandboxID),
		zap.String("provider_id", providerID),
		zap.String("model_id", modelID),
		zap.String("base_url", baseURL),
		zap.String("compatibility", compat),
		zap.String("api_mode", mapHermesAPIMode(compat)),
		zap.Bool("api_key_present", strings.TrimSpace(apiKey) != ""),
		zap.Int("api_key_length", len(strings.TrimSpace(apiKey))),
	)
}

func (l *logic) logCreateOnboardPersistenceFailure(ctx pctx.Context, stage string, entity *modelinstance.Entity, sandboxID, keyID string, err error) {
	if l.logger == nil || entity == nil {
		return
	}
	fields := []zap.Field{
		zap.String("stage", stage),
		zap.String("instance_id", entity.InstanceId),
		zap.Int64("instance_db_id", entity.Id),
		zap.String("sandbox_id", sandboxID),
		zap.String("new_key_id", keyID),
		zap.String("expected_status", modelinstance.InstanceStatusCreating),
		zap.String("entity_status_in_memory", entity.Status),
		zap.Error(err),
	}
	if latest, latestErr := l.instanceDao.GetByID(ctx, entity.Id); latestErr != nil {
		fields = append(fields, zap.Error(latestErr))
		l.logger.Warn("create-time onboarding persistence failed and current instance reload failed", fields...)
		return
	} else if latest != nil {
		fields = append(fields,
			zap.String("current_status", latest.Status),
			zap.String("current_sandbox_id", latest.SandboxId),
			zap.String("current_ai_gateway_key_id", latest.AiGatewayKeyID),
			zap.String("current_gateway_auth_token_prefix", truncateForLog(latest.GatewayAuthToken, 8)),
			zap.Time("current_updated_at", latest.UpdatedAt),
		)
	}
	l.logger.Warn("create-time onboarding persistence failed", fields...)
}

func truncateForLog(value string, max int) string {
	value = strings.TrimSpace(value)
	if max <= 0 || len(value) <= max {
		return value
	}
	return value[len(value)-max:]
}

func renderHermesModelSetCommand(modelID, providerName, baseURL, apiKey, compat string) string {
	return renderHermesModelCommand(modelID, providerName, baseURL, apiKey, compat, false)
}

func renderHermesModelSetAndRestartCommand(modelID, providerName, baseURL, apiKey, compat string) string {
	return renderHermesModelCommand(modelID, providerName, baseURL, apiKey, compat, true)
}

func renderHermesModelCommand(modelID, providerName, baseURL, apiKey, compat string, restart bool) string {
	modelName := hermesModelName(modelID)
	acliParts := []string{
		fmt.Sprintf(`--name %s`, shellQuoteArg(providerName)),
	}
	harnessParts := []string{
		fmt.Sprintf(`--model %s`, shellQuoteArg(modelID)),
		fmt.Sprintf(`--name %s`, shellQuoteArg(providerName)),
	}
	if strings.TrimSpace(baseURL) != "" {
		acliParts = append(acliParts, fmt.Sprintf(`--base-url %s`, shellQuoteArg(baseURL)))
		harnessParts = append(harnessParts, fmt.Sprintf(`--base-url %s`, shellQuoteArg(baseURL)))
	}
	if strings.TrimSpace(apiKey) != "" {
		harnessParts = append(harnessParts, fmt.Sprintf(`--api-key %s`, shellQuoteArg(apiKey)))
	}
	if api := mapHermesProviderAPI(compat); strings.TrimSpace(api) != "" {
		acliParts = append(acliParts, fmt.Sprintf(`--api %s`, shellQuoteArg(api)))
	}
	if strings.TrimSpace(apiKey) != "" {
		acliParts = append(acliParts, `--api-key "$ACLI_SECRET_API_KEY"`)
	}
	if strings.TrimSpace(modelID) != "" {
		acliParts = append(acliParts, fmt.Sprintf(`--model-id %s`, shellQuoteArg(modelID)))
	}
	if strings.TrimSpace(modelName) != "" {
		acliParts = append(acliParts, fmt.Sprintf(`--model-name %s`, shellQuoteArg(modelName)))
	}
	if harnessAPIMode := mapHermesAPIMode(compat); strings.TrimSpace(harnessAPIMode) != "" {
		harnessParts = append(harnessParts, fmt.Sprintf(`--api-mode %s`, shellQuoteArg(harnessAPIMode)))
	}
	acliArgs := strings.Join(acliParts, " ")
	harnessArgs := strings.Join(harnessParts, " ")
	secretExport := `ACLI_SECRET_API_KEY=` + shellQuoteArg(apiKey)
	lines := []string{
		`set -euo pipefail`,
		`if command -v acli >/dev/null 2>&1; then`,
		`  ` + secretExport,
		fmt.Sprintf(`  save_output="$(acli provider save %s)"`, acliArgs),
		`  printf '%s\n' "$save_output"`,
		`  switch_model="$(printf '%s\n' "$save_output" | python3 -c 'import json,re,sys`,
		`raw=sys.stdin.read()`,
		`match=re.search(r"\{.*\}", raw, re.S)`,
		`if not match:`,
		`    raise SystemExit("provider save did not return JSON")`,
		`payload=json.loads(match.group(0))`,
		`data=payload.get("data", payload) if isinstance(payload, dict) else {}`,
		`def pick(*keys):`,
		`    for key in keys:`,
		`        value=data.get(key) if isinstance(data, dict) else None`,
		`        if isinstance(value, str) and value.strip():`,
		`            return value.strip()`,
		`    return ""`,
		`model=pick("model", "model_name", "modelName", "default_model", "defaultModel")`,
		`provider=pick("provider", "provider_name", "providerName", "name")`,
		`if "/" in model:`,
		`    print(model)`,
		`elif provider and model:`,
		`    print(provider + "/" + model)`,
		`else:`,
		`    raise SystemExit("provider save output missing switch model")`,
		`')"`,
		`  acli model switch --model "$switch_model"`,
	}
	lines = append(lines,
		`elif command -v harness >/dev/null 2>&1; then`,
		fmt.Sprintf(`  harness model set %s`, harnessArgs),
		`else`,
		`  echo "neither acli nor harness found" >&2`,
		`  exit 127`,
		`fi`,
	)
	if restart {
		lines = append(lines,
			`if command -v acli >/dev/null 2>&1; then`,
			`  acli gateway restart`,
			`else`,
			`  harness gateway restart`,
			`fi`,
		)
	}
	return strings.Join(lines, "\n")
}

func hermesModelName(modelID string) string {
	modelID = strings.TrimSpace(modelID)
	if modelID == "" {
		return ""
	}
	if idx := strings.LastIndex(modelID, "/"); idx >= 0 && idx+1 < len(modelID) {
		return modelID[idx+1:]
	}
	return modelID
}

func mapHermesProviderAPI(compat string) string {
	switch strings.TrimSpace(strings.ToLower(compat)) {
	case "", "openai", "openai-completions", "openai-compatible", "chat_completions", "chat-completions":
		return "chat_completions"
	case "anthropic", "anthropic-messages":
		return "anthropic_messages"
	default:
		return compat
	}
}

func mapHermesAPIMode(compat string) string {
	switch strings.TrimSpace(strings.ToLower(compat)) {
	case "", "openai", "openai-completions":
		return "openai-completions"
	case "anthropic", "anthropic-messages":
		return "anthropic-messages"
	default:
		return compat
	}
}

func (l *logic) applySoulTemplateOnCreate(ctx pctx.Context, sandboxID, templateID string) error {
	content, err := loadSoulTemplateContent(templateID)
	if err != nil {
		return err
	}
	if strings.TrimSpace(content) == "" {
		return nil
	}

	result, err := l.execSandboxProcessCommand(ctx, sandboxID, "openclaw_write_soul", &psandbox.ProcessStartRequest{
		Cmd:  "/bin/bash",
		Args: []string{"-l", "-c", openclawRuntimeUserCommand(renderSandboxSoulWriteCommand(content))},
	}, 60)
	if err != nil {
		return fmt.Errorf("exec soul write command: %w", err)
	}
	if !sandboxCommandSucceeded(result) {
		return fmt.Errorf("soul write command failed: %s", sandboxCommandFailureDetail(result))
	}

	l.logger.Info("openclaw soul configured successfully",
		zap.String("sandbox_id", sandboxID),
		zap.String("soul_template_id", templateID),
	)
	return nil
}

func shellSingleQuote(value string) string {
	return strings.ReplaceAll(value, `'`, `'\''`)
}
