package common

import "time"

type CreateInstanceTaskPayload struct {
	InstanceID     string `json:"instance_id"`
	Timeout        int32  `json:"timeout"`
	SoulTemplateID string `json:"soul_template_id,omitempty"`
	OperationID    string `json:"operation_id,omitempty"`
	// InstanceSpecID 实例规格 ID（设计稿 .tmp/bundle-instance-spec-design.md Q3=a）。
	//
	// 由 CreateInstance 入口处反查 active pass.bundle_id → bundle.instance_spec_id 得到，
	// 透传到 RunCreateInstanceTask 选 per-spec 候选池；空字符串表示兼容期 fallback
	// 到全局默认池（无 active pass / pass.bundle_id 为空 / bundle.instance_spec_id 为空）。
	//
	// sku_id 不再单独持久化在 payload 里（设计稿 §13.2 R1f 对偶项收敛 v1.7.32）：
	// RunCreateInstanceTask → createSandboxWithFallback 内部统一靠
	// `logic.skuIDForSpec(InstanceSpecID)` 解析（spec 命中显式 sku_id 用 spec 级值，
	// 否则 fallback 到全局 defaultSKUID）。这样保证 task_params 里看到的字段集合与真正
	// 进 sandbox 的 sku 一致，避免老 payload.SKUID 字段在多规格部署下误导排障。
	InstanceSpecID string `json:"instance_spec_id,omitempty"`
}

type DestroyInstanceTaskPayload struct {
	InstanceID   string `json:"instance_id"`
	ReleaseQuota bool   `json:"release_quota"`
	OperationID  string `json:"operation_id,omitempty"`
}

type BuildInstanceBirthProfileTaskPayload struct {
	InstanceID string `json:"instance_id"`
}

// === trade-pass-isolate 设计稿落地（pass / instance 隔离 task 链路）===
// 设计稿：.tmp/trade-pass-isolate-design.md §10 Q22-I-D / Q22-I-E

// IsolatePassTaskPayload 是父 task 的 payload
//   - 父 task 负责：
//     1. CAS 拿锁 pass.status active → isolating
//     2. 列出该 pass 下所有非终态的 instance
//     3. 为每个 instance 派发一个 IsolateInstanceTask 子 task（child_registry 防重复）
//     4. 等所有子 task finalize 完成后 CAS pass.status isolating → isolated
//     5. **best-effort 反向调 trade callback**（当 TradeFlowID > 0）告知 trade_flow 推进到 completed
//   - max_execute_count=INT64_MAX（Q35=a / Q27=b' 修订版）
type IsolatePassTaskPayload struct {
	PassID      string `json:"pass_id"`
	UserID      string `json:"user_id,omitempty"`
	OperationID string `json:"operation_id,omitempty"`

	// TradeFlowID 是 trade 侧 trade_flow.id PK（设计稿 §10 Q22-I-E 端到端闭环 2026-05-15）。
	//
	// 用途：父 task IsolatePass 完成所有子 task + CAS pass.status isolating → isolated 后，
	// 在 markSuccess 之前 best-effort 调 trade adapter `POST /internal/trade/flows/{flow_id}/complete`
	// callback 把 trade_flow.status 从 in_progress 推进到 completed。
	//
	// 0 值兼容：trade 旧版本未透传 / dev/test/curl 直接拉起的 task 等场景跳过 callback，
	// trade_flow 由 reconcile worker + jifei queryFlow 兑底推进（设计稿 §6.3 + 联调 SOP §4）。
	TradeFlowID int64 `json:"trade_flow_id,omitempty"`

	// NewDeadline 是 jifei 退费场景下的"新到期时间"（v1.7.30 BUG-35）。
	//
	// 三态语义（与 ctlclient.IsolatePassRequest.NewDeadline / transport.IsolatePassRequest.NewDeadline 镇位一致）：
	//   - nil           → 生命周期隔离；父 task 终态仅 CAS isolating→isolated，**不动** pass.expired_time。
	//   - 非 nil time.Time → 退费隔离；父 task 终态在同一事务里
	//                     CAS isolating→isolated + 写 pass.expired_time = *NewDeadline。
	//
	// 时区：UTC time.Time，trade 侧已从北京时间字面值解析为绝对时刻，父 task 拿到后无需再做时区转换。
	NewDeadline *time.Time `json:"new_deadline,omitempty"`

	// DealName 是 jifei 退费场景下的子订单号（v1.7.30 BUG-35）。
	//
	// trade 侧已存入 trade_flow.deal_name 列做审计；透传到 ctl 仅用作日志（不参与状态机）。
	// 空字符串 = 生命周期场景或老调用链路。
	DealName string `json:"deal_name,omitempty"`
}

// IsolateInstanceTaskPayload 是子 task 的 payload
//   - 子 task 负责：
//     1. CAS 拿 instance status → Pausing（Q22-I-D）
//     2. 调 sandbox.PauseSandbox 走关机语义（Q26-D 修订版 / Q29=E5 / Q32=b）
//     3. CAS Pausing → Paused（成功）或 Pausing → Running 回滚（finalizeFailure）
//   - interval=60s, max_execute_count=60 → 1h 重试窗口
//   - finalizeFailure 行为：CAS Pausing → Running，让 user 后续可以正常使用
type IsolateInstanceTaskPayload struct {
	InstanceID  string `json:"instance_id"`
	PassID      string `json:"pass_id"`
	OperationID string `json:"operation_id,omitempty"`
}

// === trade-pass-renew 设计稿落地（pass / instance 续费 task 链路）===
// 设计稿：.tmp/trade-pass-renew-design.md §3.4 / §5 / R-D-2

// RenewPassTaskPayload 是续费父 task 的 payload（与 IsolatePassTaskPayload 对偶）
//   - 父 task 负责（设计稿 §3.4 + §5）：
//     1. 等待入口处（logic.RenewPass 异步分支）已经 CAS isolated → renewing；本 task 入口 idempotent 校验
//     2. 列出该 pass 下所有 Paused / 非终态的 instance
//     3. 为每个 instance 派发一个 RenewInstanceTask 子 task（child_registry 防重复）
//     4. 等所有子 task finalize 后：
//   - 计算 newExpired = CalcExpiredTime(pass.expired_time, TimeSpan, TimeUnit)
//     （基线 = expired_time，v1.7.20 B15 修订；原设计稿 §12 Q2=a 已废弃）
//   - 一次性 UPDATE pass SET status='active', expired_time=new_expired, isolated_time=NULL
//     WHERE pass_id=? AND status='renewing'（CAS 兜底）
//     5. **best-effort 反向调 trade callback**（当 TradeFlowID > 0）告知 trade_flow 推进到 completed
//   - max_execute_count=INT64_MAX（Q11 修订版 / 与 isolate 对偶 "永不放弃"，由 reconcile worker 兜底）
//
// TimeSpan / TimeUnit 是 jifei 续费的时长维度（与 trade_order.period / time_unit 一致），
// 由 logic.RenewPass 入口直接透传到 payload；父 task 收尾时用它计算 new_expired_time。
// 设计稿铁律（v1.7.20 B15 修订）：基线 = pass.expired_time，不是 isolated_time / NOW()。
// 原设计稿 §12 Q2=a 写 isolated_time 已废弃 — 续费业务语义统一以原到期时间为基线，
// 与 jifei goodsDetail.curDeadline 协议层语义对齐。
type RenewPassTaskPayload struct {
	PassID      string `json:"pass_id"`
	UserID      string `json:"user_id,omitempty"`
	OperationID string `json:"operation_id,omitempty"`

	// TimeSpan / TimeUnit：续费时长（§3.4 + §12 Q19=b 联动放开 m/d/y 全链路）
	TimeSpan int    `json:"time_span"`
	TimeUnit string `json:"time_unit"` // "m" / "d" / "y"，bundlemodel.TimeUnit{Month,Day,Year}

	// TradeFlowID 是 trade 侧 trade_flow.id PK（与 IsolatePassTaskPayload.TradeFlowID 同语义）：
	// 父 task 终态时 best-effort 反向调 trade /internal/trade/flows/{flow_id}/complete callback。
	// 0 值兼容：dev/test/curl 直接拉起 task 时跳过 callback；trade 侧 reconcile worker 兜底。
	TradeFlowID int64 `json:"trade_flow_id,omitempty"`

	// === R-MR-5 续费失败回滚扩展（2026-05-24 用户拍板）===
	// 设计稿：.tmp/trade-pass-renew-design.md §3.4 失败回滚链路升级
	//
	// 续费父 task 失败时（renewPassTaskMaxExecuteCount=5 用尽），需要派发
	// RollbackRenewPassTask 把已生效的副作用（pass 状态/到期时间、ai-gateway PeriodEnd、
	// 已被子 task 改动 Paused→Running 的实例）回滚到续费前的基线状态。
	// 该回滚 task 的 payload 直接复用本结构体（透传），所以基线字段必须从入口 RenewPass
	// 一路带到父 task，再带到回滚 task。
	//
	// OriginalExpiredTime：续费前的 pass.expired_time（绝对值 UTC time.Time）
	//   - active 续费分支：= 入口 entity.ExpiredTime
	//   - isolated 续费分支：= 入口 entity.ExpiredTime（与 active 同；isolated 状态期间
	//     expired_time 不被改动，所以入口快照即原值）
	//   - 父 task 收尾失败 → 回滚 task 据此把 pass.expired_time 写回旧值 + 把 ai-gateway
	//     subscription.period_end Align 回旧值（强一致语义）
	OriginalExpiredTime time.Time `json:"original_expired_time,omitempty"`

	// OriginalIsolatedTime：续费前的 pass.isolated_time（决定回滚目标状态）
	//   - active 续费分支：nil（pass 原本不在 isolated 状态，isolated_time 列也是 NULL/零值；
	//     回滚目标状态 = active）
	//   - isolated 续费分支：非 nil（= 入口 entity.IsolatedTime；回滚目标状态 = isolated）
	//   - 二态语义关键区别：
	//     · nil → 回滚不需要重新 Isolate 实例（active 续费期间子 task 看到 Running 直接幂等
	//       跳过，没变更实例状态，所以无副作用要回滚）
	//     · 非 nil → 回滚必须为所有已被 RenewInstance 子 task 改 Paused→Running 的实例派
	//       发 IsolateInstance 子 task 把 Running→Paused 回去，再把 pass 状态 CAS 回 isolated
	OriginalIsolatedTime *time.Time `json:"original_isolated_time,omitempty"`
}

// === R-MR-5 续费失败回滚 task payload（2026-05-24 用户拍板）===
//
// RollbackRenewPassTaskPayload 是回滚 task 的 payload。
//
// 触发：renewPassTask.finalizeFailure（max_execute_count=5 用尽）。
//
// 行为契约（max_execute_count=5，与父 task 同节奏；失败即终态，不做"回滚的回滚"）：
//  1. 等原 RenewInstance 子 task 全部到达终态（防止与回滚同时操作同一 instance）
//  2. 仅当 OriginalIsolatedTime != nil 时：为每个状态非终态、非 Paused 的 instance
//     派发 IsolateInstance 子 task 把 Running→Paused
//  3. 等步骤 2 派发的 IsolateInstance 子 task 全部到达终态
//  4. Align ai-gateway subscription.period_end 回 OriginalExpiredTime（强一致；
//     由于 ai-gateway ExtendSubscription 已升级"等值即 no-op、不等强制覆盖"语义，
//     向前缩短同样安全）
//  5. 调 pass DAO RollbackRenewal 一次性 CAS：
//     · OriginalIsolatedTime == nil → renewing→active + expired_time=Original + isolated_time=NULL
//     · OriginalIsolatedTime != nil → renewing→isolated + expired_time=Original + isolated_time=Original
//  6. best-effort 调 trade.CompleteFlow(flowID, "failed", reason) 让 trade_flow.status
//     落 failed，触发 jifei 自动退款（trade 端 R-MR-5 已升级 result 分发）
//  7. markSuccess
//
// max_execute_count=5：与父 task 同节奏；回滚也需要"有限重试 + 失败即终态"避免雪崩
// （如果回滚也失败 5 次，pass 卡在 renewing 状态，由 reconcile worker 兜底人工介入）
type RollbackRenewPassTaskPayload struct {
	PassID      string `json:"pass_id"`
	UserID      string `json:"user_id,omitempty"`
	OperationID string `json:"operation_id,omitempty"`

	// TradeFlowID：透传自原 RenewPass payload，回滚收尾步骤 6 调
	// trade.CompleteFlow(flowID, "failed", reason) 触发 jifei 退款；0 → 跳过（dev/test）
	TradeFlowID int64 `json:"trade_flow_id,omitempty"`

	// OriginalExpiredTime / OriginalIsolatedTime：透传自原 RenewPassTaskPayload。
	// 回滚目标状态（active vs isolated）由 OriginalIsolatedTime 是否为 nil 决定。
	OriginalExpiredTime  time.Time  `json:"original_expired_time,omitempty"`
	OriginalIsolatedTime *time.Time `json:"original_isolated_time,omitempty"`

	// FailureReason：原 renewPassTask.finalizeFailure 透传过来的最后一次 execute 错误，
	// 写入 trade.CompleteFlow 的 message 字段帮助 jifei 侧 / 排障侧定位失败原因。
	FailureReason string `json:"failure_reason,omitempty"`

	// OriginalParentTaskID：原 renewPassTask 的 task_id，回滚 task 的步骤 1
	// 通过反查 task.parent_task_id == OriginalParentTaskID 列出所有原 RenewInstance
	// 子 task 等待终态。注意：本字段 ≠ 回滚 task 自身的 parent_task_id（回滚 task
	// 没有父 task，是顶层 task，由 finalizeFailure 直接 enqueue）。
	OriginalParentTaskID string `json:"original_parent_task_id,omitempty"`
}

// RenewInstanceTaskPayload 是续费子 task 的 payload（与 IsolateInstanceTaskPayload 对偶）
//   - 子 task 负责（设计稿 §3.4 + §5）：
//     1. 反查 instance；NotFound / 已 Running / 已 Deleted/Failed → 直接成功（幂等）
//     2. 校验 sandbox_id 非空 → 调 sandbox.ResumeSandbox（依赖 R-F 落地后才真开机）
//     3. CAS Paused → Running
//   - interval=60s, max_execute_count=60 → 1h 重试窗口（与 IsolateInstance 对偶）
//
// ⚠️ R-F 阻塞：sandbox.ResumeSandbox handler 当前是 noop（不调 cp.StartInstance / 不调 CVM SDK），
// 等 R-F 落地后续费链路才真闭环；本期单测用 mock adapter 验证调用路径即可。
type RenewInstanceTaskPayload struct {
	InstanceID  string `json:"instance_id"`
	PassID      string `json:"pass_id"`
	OperationID string `json:"operation_id,omitempty"`

	// TargetGateway is empty for an ordinary renewal. During a forward-only
	// gateway migration it is set to llm_gateway, which makes the child task
	// save the new provider/key and restart the Agent even when it was already
	// running.
	TargetGateway string `json:"target_gateway,omitempty"`
}

// === trade-pass-destroy 设计稿落地（pass 销毁父 task payload）===
// 设计稿：.tmp/trade-pass-destroy-design.md §4.3 / §4.6 / §11-A Q6 / Q24
//
// DestroyPassTaskPayload 是销毁父 task 的 payload（与 IsolatePassTaskPayload 对偶 + Q6 步骤级幂等扩展）：
type DestroyPassTaskPayload struct {
	PassID      string `json:"pass_id"`
	UserID      string `json:"user_id,omitempty"`
	OperationID string `json:"operation_id,omitempty"`

	// TradeFlowID = trade 侧 trade_flow.id PK（与 IsolatePassTaskPayload.TradeFlowID 同语义）。
	// > 0：父 task 收尾步 5c 调 trade.CompleteFlow(flowID, "completed", "")
	// 0：跳过 callback（dev/test 兼容；reconcile worker 兜底）
	TradeFlowID int64 `json:"trade_flow_id,omitempty"`

	// DestroyReason = jifei `para.source` 透传值（biz/qn/other/空串；Q24 ✅ 拍板）。
	// 父 task 收尾步 5b 调 dao.MoveToHistory(passID, deletedTime, DestroyReason)，
	// 写入 history_pass.destroy_reason 列。空串合法（用户控制台 DeletePass 入口未经 jifei
	// 二次回标的兜底场景）。
	DestroyReason string `json:"destroy_reason,omitempty"`

	// Region = ctl 进程配置 config.ServerConf.MiscConfig.Region（Q21 ✅ 拍板）：
	// 父 task 在 enqueue 时从 ctl 配置写入 payload，子 task 据此填 snapshot.region 列；
	// 本期单集群单 region 前提下 = 实例所在 region，与"反查 instance.region 列"等价。
	Region string `json:"region,omitempty"`

	// === Q6 步骤级幂等进度位（设计稿 §4.6 重投场景 5 类）===
	// 子步骤成功后 UpdatePayload 持久化，下一轮 execute 重入时据此跳过已完成步骤；
	// 关键解锁场景：5b（MoveToHistory）已成功后 pass 已不在表，5c（CompleteFlow）失败重投时
	// 必须跳过 5b，否则 MoveToHistory 命中 ErrPassNotFound 卡死。
	SubscriptionDone bool `json:"subscription_done,omitempty"`
	PassDeleted      bool `json:"pass_deleted,omitempty"`
	FlowCompleted    bool `json:"flow_completed,omitempty"`
}

// DestroyInstanceForPassTaskPayload 是销毁子 task 的 payload（D-6 切片完整字段集，设计稿 §4.8）。
//
// 命名说明（Q5 ✅ 拍板）：与已存在的 `DestroyInstanceTaskPayload`（line 11，老的纯 instance 销毁链路）
// 区分；本类型专属于 trade-pass-destroy 的"父 task DestroyPass → 子 task 销毁单实例 + 快照"
// 链路（含 cbs snapshot），TaskName 命名为 `TaskNameDestroyInstanceWithSnapshot` 体现"含快照"语义。
//
// 子 task 负责（设计稿 §4.7 4 阶段流程）：
//  1. 阶段 1（payload.SnapshotID==""）：调 sandbox.CreateSnapshot 触发系统盘快照创建 →
//     收到 snapshotID 后写回 payload.SnapshotID + UpdatePayload → 返 error 让框架重投
//  2. 阶段 2（payload.SnapshotsDone==false）：调 sandbox.GetSnapshotStatus 轮询：
//     - "ready"       → 入 ctl snapshot 表（Q9-fix：(flow_id, instance_id) 唯一键防重投冲突）
//     → SnapshotsDone=true + UpdatePayload，进入阶段 3
//     - "in_progress" → 返 error 重投
//     - "failed"      → 子 task 终态失败
//  3. 阶段 3：调 sandbox.DeleteSandbox（与老 DestroyInstance 同接口）销毁 cvm
//  4. 阶段 4：CAS instance.status (Running/Paused/Deleting) → Deleted
//
// 无系统盘场景（Q10/Q25 联动）：sandbox 端返 ErrInstanceNoSystemDisk → 子 task 跳过阶段 1+2
// 直接进入阶段 3+4（payload 写 SnapshotID="<no-disk>" + SnapshotsDone=true 标记跳过）。
//
// interval=60s, max_execute_count=60 → 1h 重试窗口（与 IsolateInstance / RenewInstance 同范式）。
type DestroyInstanceForPassTaskPayload struct {
	InstanceID  string `json:"instance_id"`
	PassID      string `json:"pass_id"`
	UserID      string `json:"user_id,omitempty"`
	OperationID string `json:"operation_id,omitempty"`

	// SandboxID 是 instance.sandbox_id 列值（销毁子 task 入口由父 task 透传）。
	// 用于调 sandbox.CreateSnapshot / GetSnapshotStatus / DeleteSandbox 三个端点。
	// 空值 / pending 前缀场景下子 task 跳过 sandbox 调用直接 CAS 终态（与 IsolateInstance 同范式）。
	SandboxID string `json:"sandbox_id,omitempty"`

	// Region = ctl 进程配置 config.ServerConf.MiscConfig.Region（Q21 ✅ 拍板）。
	// 由父 task 派子 task 时透传，子 task 入 ctl snapshot 表时作为 snapshot.region 列值。
	Region string `json:"region,omitempty"`

	// UIN / AppID 是销毁事件维度审计字段（snapshot 表镜像）。
	UIN   int64 `json:"uin,omitempty"`
	AppID int64 `json:"app_id,omitempty"`

	// TradeFlowID = trade_flow.id PK（Q9-fix ✅ 拍板：snapshot 表唯一键左半 (flow_id, instance_id)）。
	// 由父 task DestroyPassTaskPayload.TradeFlowID 透传到子 task。
	TradeFlowID int64 `json:"trade_flow_id,omitempty"`

	// SnapshotID 是阶段 1 sandbox.CreateSnapshot 返回的 cbs snapshot id；
	// 阶段 2 轮询用、阶段 2 入 snapshot 表用。
	// 子 task 重投幂等关键：!="" 时跳过阶段 1（不重复创建快照）。
	// 特殊值 "<no-disk>"：Q10/Q25 联动 — sandbox 端返 ErrInstanceNoSystemDisk 时设置，
	// 子 task 跳过阶段 1+2 直接进入阶段 3+4（snapshot 表也不入）。
	SnapshotID string `json:"snapshot_id,omitempty"`

	// SnapshotsDone 标记阶段 2 完成（包括 ready 入表 / 无系统盘跳过两种情况）。
	// 子 task 重投幂等关键：true 时跳过阶段 1+2 直接进入阶段 3+4。
	SnapshotsDone bool `json:"snapshots_done,omitempty"`
}

const (
	TaskNameCreateInstance            = "CreateInstance"
	TaskNameDestroyInstance           = "DestroyInstance"
	TaskNameBuildInstanceBirthProfile = "BuildInstanceBirthProfile"

	// trade-pass-isolate 父子 task（Q22-I-E）
	TaskNameIsolatePass     = "IsolatePass"
	TaskNameIsolateInstance = "IsolateInstance"

	// trade-pass-renew 父子 task（R-D / 设计稿 §5）
	TaskNameRenewPass     = "RenewPass"
	TaskNameRenewInstance = "RenewInstance"

	// R-MR-5 续费失败回滚父 task（2026-05-24 用户拍板，trade-pass-renew §3.4 失败回滚链路升级）
	//
	// 触发：renewPassTask.finalizeFailure 在 max_execute_count=5 用尽后派发；
	// 行为：等原子 task 终态 → IsolateInstance 回滚（仅 isolated 续费分支）→ Align ai-gateway
	//       回旧值 → RollbackRenewal CAS pass 状态 → CompleteFlow(failed) → 触发 jifei 退款。
	// max_execute_count=5（与父 task 同节奏；失败即终态由人工介入）。
	TaskNameRollbackRenewPass = "RollbackRenewPass"

	// trade-pass-destroy 父子 task（设计稿 §3.5 / §4.5.2 / §4.5.3 / §4.6 / §4.7）
	//
	// 父 task DestroyPass：
	//   - 入口 ctl.DestroyPass 已 CAS deleting∨isolated → terminating
	//   - 父 task 列举 pass 下所有 instance + 派 DestroyInstanceWithSnapshot 子 task
	//   - 子 task 全终态后收尾：5a CancelSubscription / 5b MoveToHistory / 5c CompleteFlow
	//   - 进度位 SubscriptionDone / PassDeleted / FlowCompleted 持久化在 payload 内（Q6 步骤级幂等）
	//   - max_execute_count=INT64_MAX（与 isolate / renew 父 task 同 "永不放弃"）
	TaskNameDestroyPass = "DestroyPass"

	// 子 task DestroyInstanceWithSnapshot（Q5 ✅ 拍板，2026-05-17）：
	//   - 命名与"含快照"语义对齐（区别于老的 TaskNameDestroyInstance — sandbox 主动删除，无需快照）
	//   - 4 阶段流程：CreateSnapshot → 轮询 → snapshot 表入表 → sandbox.DeleteSandbox + CAS Deleted
	//   - interval=60s × max=60 = 1h 重试窗口（与 IsolateInstance 同范式）
	TaskNameDestroyInstanceWithSnapshot = "DestroyInstanceWithSnapshot"
)
