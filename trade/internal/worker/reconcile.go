// Package worker 收纳 trade 服务的后台 worker（迭代 7 起）。
//
// 当前唯一 worker：trade_flow reconcile（设计稿 §6.4 / Q61 兜底分支）。
//
// 设计稿对齐（trade-purchase-flow-design.md / trade-pass-isolate-design.md）：
//   - Q61 抢占式幂等：trade_flow.status 三态（in_progress / completed / failed）
//   - 边缘场景：trade pod 在主链路执行中途 SIGKILL → 留下 in_progress 孤儿记录
//   - 兜底机制：每 5 min 扫描 created_time < NOW()-30min 的 in_progress 记录，
//     反查 ctl 是否已实际生成 / 隔离 pass，决定升级 completed 还是 failed
//
// Sub-5（isolate 链路扩展，trade-pass-isolate-design.md §11 Q11 修订版）：
//   - createResource 链路兜底：保留原行为（exists=true→completed / false→failed）
//   - isolateResource 链路兜底：仅在 ctl 反查 pass.status==isolated 时升级 completed；
//     其他态（含 isolating/active/not_found/error）保持 in_progress + 日志告警，
//     绝不升级 failed —— 与 §11 Q11 修订版"父 task unbounded 重投至 all-success，
//     永远 result=completed"严格对齐。
//
// R-C-6（renew 链路扩展，trade-pass-renew-design.md §3.4 / §12 Q13=a）：
//   - renewResource 链路兜底：**完全 trade-side passive**
//   - **不反查 ctl**（不需要 ProbeRenew 接口）+ **永不主动 markFailed**：
//     避免 trade=failed 但 ctl=active 的资金/状态不一致风险
//   - 仅按 age 分级日志告警：
//     a) age < 12 月 → 普通滞留日志（与 isolate 同语义）
//     b) age ≥ 12 月 → ALERT 级日志（计费协议明确 12 月止步，需人工介入）
//   - **不构造退款响应体**：续费已支付，不存在退款语义
//
// D-9（destroy 链路扩展，trade-pass-destroy-design.md §3.4 / §6.4）：
//   - destroyResource 链路兜底：与 isolateResource 同范式，**永远向 completed 收敛**
//     （配合 ctl DestroyPass 父 task 的 "永不放弃 + checkTasks bypass 重投" 设计）
//   - ProbeDestroy=true（ctl pass 已迁 history_pass）→ MarkCompletedByID 升级 completed
//   - ProbeDestroy=false（pass 还在 live 表非 history） / err → 保持 in_progress 等下轮
//   - 永不主动 markFailed（与 isolate 同语义：destroy 链路无"永久失败"语义）
//   - 现网 prober=nil 时走专属"destroy orphan still pending"日志，**不再被 default 分支的
//     unknown flow_type 噪声日志淹没** —— 即便没注入真实 prober，destroy 链路也能被 SRE
//     在日志里精准 grep 出来。
//
// 本期范围（迭代 7 + Sub-5）：
//   - ✅ 扫描骨架：周期触发、批量分页、context cancel 优雅停机
//   - ✅ 反查注入：ResourceProber interface（生产路径默认 nil → 仅日志告警，
//     不自动升级；迭代 8 ctl 暴露反查接口后注入真实 prober 自动升级）
//   - ✅ Sub-5 双链路兜底：按 Flow.FlowType 路由到 ProbeResource / ProbeIsolate
//   - ❌ 不引入指标库（保留 log 输出供运维排障，避免提前依赖 metrics 栈）
//
// 安全约束（Q56 / Q61 / Sub-5 §11 Q11）：
//   - 仅 status='in_progress' 的记录才会被升级；reconcile 与赢家路径
//     共用 markStatus / markStatusByID 的 WHERE status='in_progress' 守卫，互不破坏
//   - 反查失败（prober 返错）→ 跳过本条，下一轮再试，绝不在不确定状态下乱改
//   - createResource 输家路径仍然走 in_progress → ReturnCodeFlowInProgress（让 jifei 重试），
//     reconcile 升级是异步副线，不影响在途 jifei 重试节奏
//   - isolate 链路 reconcile 不升级 failed（设计上没有"永久失败"语义，只有"待 ctl 收尾"）
package worker

import (
	"context"
	"errors"
	"log"
	"time"

	"git.woa.com/wisp/mono/trade/internal/store"
)

// DefaultInterval 是 reconcile 周期的默认值（5 min）。
//
// 选 5 min 的原因：
//   - 太频繁（如 1 min）会持续扫库给 trade DB 增压，孤儿记录场景本身罕见
//   - 太稀疏（如 1 hour）则用户感知补偿过慢
//   - 5 min ≈ jifei 重试间隔的中位数，与上游节奏对齐
const DefaultInterval = 5 * time.Minute

// DefaultStaleThreshold 是判定"僵尸 in_progress"的最小存活时长（30 min）。
//
// 选 30 min 的原因：
//   - createResource handler timeout = 4s（Q59）；正常情况下记录最多 ~5s 内收尾
//   - isolateResource handler timeout = 4s + ctl callback 异步收尾（最坏数分钟级）；
//     30 min 仍足够覆盖 ctl 父子任务正常派发节奏
//   - 给"trade pod 漂移 / k8s rolling 重启 / DB 抖动后人工恢复"留足缓冲
//   - 设计稿 §6.4 拍板值
const DefaultStaleThreshold = 30 * time.Minute

// DefaultBatchLimit 是每轮扫描的最大记录数。
//
// 防止积压时一次扫几万条压垮 trade DB，超出本批的下轮再扫。
const DefaultBatchLimit = 100

// RenewStaleAlertThreshold 是 renew_resource 链路 in_progress 记录"超长滞留"的告警阈值。
//
// 取值 12 个月（按 30 天/月近似）的依据（设计稿 trade-pass-renew-design.md §3.4 / §12 Q13=a）：
//   - 计费续费协议（PDF §1.4）明确"超过 12 个月不再重试，需要业务侧主动回调"
//   - 与 isolate 链路（无最大次数 / 永久重投）显著不同，renew 协议有"12 个月止步"硬阈值
//   - 一旦 trade_flow 滞留超过 12 个月，意味着计费侧已彻底放弃重试 → trade 必须告警
//
// 行为约束（Q13=a 严格）：
//   - 仅 **日志告警**（"ALERT"/"renew_resource_alert" 关键字便于运维监控筛选）
//   - **不主动 markFailed** — 避免 trade=failed 而 ctl=active 的状态不一致
//   - **不构造退款响应体** — 续费已支付，不存在退款语义（与 createResource 反向）
//   - 由人工介入排查（ctl 是否真的卡住 / 是否需要手工补尾）
const RenewStaleAlertThreshold = 365 * 24 * time.Hour

// ModifyStaleAlertThreshold 是 modify_resource 链路 in_progress 记录的告警阈值。
//
// 取 6 小时：变配的正常收敛时长由腾讯云侧"停机 → 改规格 → 扩盘 → 开机"决定，
// 单台十几分钟，多实例串行也在小时级以内。滞留超过这个量级说明 CTL 变配父 task
// 卡住了（实例状态异常、目标 pool 无容量等），需要人看。
//
// 不用 renew 那个 12 个月阈值：那是计费续费协议的重投窗口，与"我们这边多久算卡住"
// 无关。变配的重投由 CTL 父 task 自己负责，trade 这边的阈值只服务于告警。
//
// 行为约束与 renew 分支一致：仅告警，不 markFailed，不构造退款响应体。
const ModifyStaleAlertThreshold = 6 * time.Hour

// ResourceProber 抽象"反查 ctl 中 pass 实际状态"的能力。
//
// 本期（迭代 7）注入 nil 即可 — worker 退化为"仅扫描 + 告警"模式，
// 等待运维介入或迭代 8 注入真实 prober。
//
// 迭代 8 计划（生产注入）：
//   - ctl 新增 GET /internal/ctl/passes/by-deal/{dealName} 反查接口（createResource 兜底）
//   - ctl 新增 GET /internal/ctl/passes/{passID}/isolated（isolate 兜底，按 resourceID 反查）
//   - trade ctlclient 加对应方法 + main.go 注入实现 ResourceProber 的 adapter
type ResourceProber interface {
	// ProbeResource 反查 dealName 对应的 pass 是否已发货（createResource 链路兜底）。
	//
	// 返回：
	//   - exists=true → ctl 已生成 pass（升级 completed 安全）
	//   - exists=false → ctl 没生成 pass（升级 failed → 退款响应安全）
	//   - err != nil → 反查失败（基础设施错或限流），跳过本条等下轮
	ProbeResource(ctx context.Context, dealName string) (exists bool, err error)

	// ProbeIsolate 反查 resourceID（=pass_id）对应的 pass 是否已进入 isolated 终态
	// （Sub-5 isolate 链路兜底）。
	//
	// 返回：
	//   - isolated=true → ctl 中 pass.status=isolated（升级 completed 安全）
	//   - isolated=false → ctl 中 pass 还在 isolating / active / 其他非终态
	//     （**不升级 failed**，仅日志告警，等下轮或人工介入）
	//   - err != nil → 反查失败，跳过本条等下轮
	//
	// 设计稿：trade-pass-isolate-design.md §11 Q11 修订版
	ProbeIsolate(ctx context.Context, resourceID string) (isolated bool, err error)

	// ProbeDestroy 反查 resourceID（=pass_id）对应的 pass 是否已被销毁
	// （D-9 destroy 链路兜底，trade-pass-destroy-design.md §6.4）。
	//
	// "已销毁"的判定标准（ctl 侧）：
	//   - pass 已从 live `pass` 表移除并迁入 `history_pass` 表
	//   - 等价于 ctl DestroyPass 父 task 收尾步 5b MoveToHistory 已成功
	//
	// 返回：
	//   - destroyed=true → ctl 已收尾（升级 completed 安全）
	//   - destroyed=false → ctl 还在 terminating / 其他非终态
	//     （**不升级 failed**，仅日志告警，等下轮或人工介入；与 isolate Q11 同语义：
	//     destroy 链路无"永久失败"，最终向 completed 收敛）
	//   - err != nil → 反查失败，跳过本条等下轮
	ProbeDestroy(ctx context.Context, resourceID string) (destroyed bool, err error)
}

// Config 配置 reconcile worker 行为；未指定字段走 Default* 常量。
type Config struct {
	// Interval 扫描周期；<= 0 走 DefaultInterval
	Interval time.Duration

	// StaleThreshold 多久未收尾视为僵尸；<= 0 走 DefaultStaleThreshold
	StaleThreshold time.Duration

	// BatchLimit 每轮扫描记录数上限；<= 0 走 DefaultBatchLimit
	BatchLimit int

	// Now 注入时钟函数便于单元测试；nil 走 time.Now
	Now func() time.Time

	// Prober 反查 ctl 是否已发货 / 已隔离；nil 表示本期保守模式（仅日志告警，不升级状态）
	Prober ResourceProber

	// Logger 注入日志（依赖反转便于测试）；nil 走 log.Default()
	Logger *log.Logger
}

// Worker 是 trade_flow reconcile 后台 worker。
//
// 生命周期：
//   - New() 构造（不启动）
//   - Run(ctx) 阻塞运行直到 ctx 被 cancel
//   - 通常由 main.go go w.Run(ctx) 起一个 goroutine，应用 SIGTERM 时取消 ctx
type Worker struct {
	store          store.FlowStore
	cfg            Config
	interval       time.Duration
	staleThreshold time.Duration
	batchLimit     int
	now            func() time.Time
	logger         *log.Logger
}

// New 构造 Worker。store 必填；cfg 全部可选。
func New(s store.FlowStore, cfg Config) *Worker {
	w := &Worker{store: s, cfg: cfg}
	if cfg.Interval > 0 {
		w.interval = cfg.Interval
	} else {
		w.interval = DefaultInterval
	}
	if cfg.StaleThreshold > 0 {
		w.staleThreshold = cfg.StaleThreshold
	} else {
		w.staleThreshold = DefaultStaleThreshold
	}
	if cfg.BatchLimit > 0 {
		w.batchLimit = cfg.BatchLimit
	} else {
		w.batchLimit = DefaultBatchLimit
	}
	if cfg.Now != nil {
		w.now = cfg.Now
	} else {
		w.now = time.Now
	}
	if cfg.Logger != nil {
		w.logger = cfg.Logger
	} else {
		w.logger = log.Default()
	}
	return w
}

// Run 阻塞运行 reconcile 循环；ctx cancel 后立即退出。
//
// 启动时立即跑一次（避免进程刚起来时存量孤儿记录等 5min 才被发现），
// 然后按 interval 周期触发。
func (w *Worker) Run(ctx context.Context) {
	if w == nil || w.store == nil {
		// 防御：构造期就该 panic 但兜底兼容（main.go 误传 nil 不至于崩主进程）
		return
	}
	w.logger.Printf("trade_flow reconcile worker starting: interval=%v stale_threshold=%v batch=%d prober_present=%v",
		w.interval, w.staleThreshold, w.batchLimit, w.cfg.Prober != nil)

	// 立即跑一次
	w.runOnce(ctx)

	t := time.NewTicker(w.interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			w.logger.Printf("trade_flow reconcile worker stopping: %v", ctx.Err())
			return
		case <-t.C:
			w.runOnce(ctx)
		}
	}
}

// runOnce 执行一轮扫描；导出（小写）便于单元测试驱动。
//
// 错误策略：
//   - List 失败 → 记日志返回（下轮再试）
//   - 单条 reconcile 失败 → 记日志继续下一条（不让单条错卡死整轮）
func (w *Worker) runOnce(ctx context.Context) {
	cutoff := w.now().Add(-w.staleThreshold)
	flows, err := w.store.ListInProgressBefore(ctx, cutoff, w.batchLimit)
	if err != nil {
		w.logger.Printf("trade_flow reconcile: list orphans failed cutoff=%v err=%v", cutoff, err)
		return
	}
	if len(flows) == 0 {
		return
	}
	w.logger.Printf("trade_flow reconcile: found %d orphan in_progress flows older than %v", len(flows), cutoff)

	for _, f := range flows {
		if ctx.Err() != nil {
			return
		}
		w.reconcileOne(ctx, f)
	}
}

// reconcileOne 处理单条孤儿记录，按 FlowType 路由到 createResource / isolateResource / renewResource 兜底。
//
// 公共行为：
//   - Prober == nil（本期默认）：仅日志告警，不改状态 — 等迭代 8 / 人工介入
//   - 反查 err → 跳过本条，下轮再试（仅 createResource / isolateResource 路径）
//   - renewResource 路径**不依赖 prober**（Q13=a trade-side passive）
//
// FlowType 分支：
//
//	(1) createResource 链路（reconcileCreateResource）：
//	    - exists=true → MarkCompleted（响应体 nil；输家路径下次会返 ReturnCodeFlowReplayCorrupted）
//	    - exists=false → MarkFailed（响应体 nil；输家走 corrupted 让 jifei 重试退款）
//
//	(2) isolateResource 链路（reconcileIsolateResource，§11 Q11 修订版）：
//	    - isolated=true → MarkCompletedByID（按 PK；与 ctl callback 共用守卫）
//	    - isolated=false → 仅日志告警，**不升级 failed**（isolate 链路无"永久失败"语义；
//	      对应 jifei 父 task unbounded 重投至 all-success → 永远 result=completed）
//
//	(3) renewResource 链路（reconcileRenewResource，§3.4 / §12 Q13=a）：
//	    - 不反查 ctl（trade-side passive；避免 trade=failed/pass=active 不一致）
//	    - age < 12 月 → 普通"still pending"日志
//	    - age ≥ 12 月 → ALERT 级日志（计费协议明确 12 月止步重试，需人工介入）
//	    - 永不调 mark*（与 isolate 路径同语义但更被动）
//
// 严格 Q56：reconcile 不主动构造退款响应体，避免越权决策（"判定为永久失败"
// 这件事属于 createResource 主链路 / 中转服务策略层，reconcile 只是收尸）。
// renew 链路特殊：续费已支付，根本没有退款语义。
func (w *Worker) reconcileOne(ctx context.Context, f *store.Flow) {
	if f == nil {
		return
	}

	// renew 链路独立分支：trade-side passive，不依赖 prober，
	// prober 是否配置都正常做 age 分级日志（Q13=a）。
	// 必须放在 prober==nil 早返之前，否则 renew 12 月告警会被静默吞掉。
	if f.FlowType == store.FlowTypeRenewResource {
		w.reconcileRenewResource(ctx, f)
		return
	}

	// 变配链路同样是 trade-side passive（TAPD 1010132091137784162 §7.1）：
	// 用户已支付差价，且变配没有回滚链路——系统盘扩完不能缩回去。trade 这边
	// 主动 markFailed 只会造出"trade=failed 但机器已经是巡游规格"的不一致账。
	// CTL 变配父 task 永不放弃（max=1<<30），终态时回调
	// POST /internal/trade/flows/{id}/complete 把 trade_flow 推到 completed；
	// 本分支只负责按 age 分级告警，把卡住的单暴露给人。
	if f.FlowType == store.FlowTypeModifyResource {
		w.reconcileModifyResource(f)
		return
	}

	if w.cfg.Prober == nil {
		// 保守模式（仅 createResource / isolateResource 路径生效）：
		// 仅日志，不动状态。日志中暴露 ID + flow_type 方便 SRE 反查。
		w.logger.Printf("trade_flow reconcile: orphan id=%d flow_type=%s deal_name=%q resource_id=%s app_id=%s created_time=%v age=%v — prober not configured, manual intervention required",
			f.ID, f.FlowType, f.DealName, derefResourceID(f.ResourceID), f.AppID, f.CreatedTime, w.now().Sub(f.CreatedTime))
		return
	}

	switch f.FlowType {
	case store.FlowTypeCreateResource:
		w.reconcileCreateResource(ctx, f)
	case store.FlowTypeIsolateResource:
		w.reconcileIsolateResource(ctx, f)
	case store.FlowTypeDestroyResource:
		w.reconcileDestroyResource(ctx, f)
	default:
		// 未知 flow_type：可能是新链路上线了但 worker 还没跟进。
		// 保守起见仅日志告警，不动状态。
		w.logger.Printf("trade_flow reconcile: orphan id=%d unknown flow_type=%q deal_name=%q resource_id=%s — skip (manual intervention required)",
			f.ID, f.FlowType, f.DealName, derefResourceID(f.ResourceID))
	}
}

// reconcileCreateResource 处理 createResource 链路的孤儿记录（与迭代 7 原行为一致）。
func (w *Worker) reconcileCreateResource(ctx context.Context, f *store.Flow) {
	exists, err := w.cfg.Prober.ProbeResource(ctx, f.DealName)
	if err != nil {
		w.logger.Printf("trade_flow reconcile: probe failed id=%d deal_name=%s err=%v — skip this round",
			f.ID, f.DealName, err)
		return
	}

	if exists {
		if err := w.store.MarkCompleted(ctx, f.DealName, f.FlowType, f.AppID, nil); err != nil {
			w.logger.Printf("trade_flow reconcile: MarkCompleted failed id=%d deal_name=%s err=%v",
				f.ID, f.DealName, err)
			return
		}
		w.logger.Printf("trade_flow reconcile: orphan promoted to completed id=%d deal_name=%s app_id=%s",
			f.ID, f.DealName, f.AppID)
		return
	}

	if err := w.store.MarkFailed(ctx, f.DealName, f.FlowType, f.AppID, nil); err != nil {
		w.logger.Printf("trade_flow reconcile: MarkFailed failed id=%d deal_name=%s err=%v",
			f.ID, f.DealName, err)
		return
	}
	w.logger.Printf("trade_flow reconcile: orphan promoted to failed id=%d deal_name=%s app_id=%s",
		f.ID, f.DealName, f.AppID)
}

// reconcileIsolateResource 处理 isolateResource 链路的孤儿记录（Sub-5 §11 Q11 修订版）。
//
// 关键约束：
//   - DB schema 保证 isolate 链路 resource_id NOT NULL（INSERT 由 TryAcquireSlotForIsolate 写入）；
//     此处仍做 nil 守卫（防御 schema 变更或脏数据），nil 时仅日志不动作
//   - 仅 isolated=true 时升级 completed；其他态保持 in_progress 让下轮再试
//     （与 jifei 父 task unbounded 重投语义对齐：isolate 链路永远向 completed 收敛）
//   - MarkCompletedByID 用 trade_flow.id PK 定位，与 ctl callback / 赢家路径共用
//     status='in_progress' 守卫，互不破坏
func (w *Worker) reconcileIsolateResource(ctx context.Context, f *store.Flow) {
	if f.ResourceID == nil || *f.ResourceID == "" {
		// 防御：isolate 链路 INSERT 时 resource_id 必非空。出现空值意味着数据异常。
		w.logger.Printf("trade_flow reconcile: isolate orphan id=%d has nil/empty resource_id — skip (data corruption?)",
			f.ID)
		return
	}
	resourceID := *f.ResourceID

	isolated, err := w.cfg.Prober.ProbeIsolate(ctx, resourceID)
	if err != nil {
		w.logger.Printf("trade_flow reconcile: probe isolate failed id=%d resource_id=%s err=%v — skip this round",
			f.ID, resourceID, err)
		return
	}

	if isolated {
		// ctl 已收尾到 isolated 终态 → 升级 completed
		if err := w.store.MarkCompletedByID(ctx, f.ID, nil); err != nil {
			w.logger.Printf("trade_flow reconcile: MarkCompletedByID failed id=%d resource_id=%s err=%v",
				f.ID, resourceID, err)
			return
		}
		w.logger.Printf("trade_flow reconcile: isolate orphan promoted to completed id=%d resource_id=%s app_id=%s",
			f.ID, resourceID, f.AppID)
		return
	}

	// isolated=false：ctl 还在 isolating / active / 其他非终态。
	// 严格按 §11 Q11 修订版：不升级 failed，保持 in_progress 让下轮再试。
	w.logger.Printf("trade_flow reconcile: isolate orphan still pending id=%d resource_id=%s app_id=%s age=%v — keep in_progress (Q11 unbounded retry semantics)",
		f.ID, resourceID, f.AppID, w.now().Sub(f.CreatedTime))
}

// reconcileDestroyResource 处理 destroyResource 链路的孤儿记录（D-9，与 isolate Q11 同范式）。
//
// 关键约束（与 isolate 链路对偶）：
//   - DB schema 保证 destroy 链路 resource_id NOT NULL（INSERT 由 TryAcquireSlotForIsolate 写入
//     pass_id，destroyresource handler 复用 isolate 的 store 范式）；nil 时仅日志不动作
//   - destroyed=true（pass 已迁 history_pass）→ MarkCompletedByID 升级 completed
//   - destroyed=false → 保持 in_progress 等下轮（不升级 failed，destroy 链路无"永久失败"）
//   - 与 ctl DestroyPass 父 task 配合：
//   - 父 task max_execute_count = 1<<30（永不放弃）
//   - checkTasks bypass 每分钟重投未终态 task
//   - trade reconcile worker 每 5 min 反查升级
//     三层兜底确保 destroy 链路最终收敛 → trade_flow=completed + ctl history_pass 写入
//
// prober == nil 现网保守模式（main.go 当前未注入 prober）：
//   - 走本函数仍然只打日志（与 isolate prober==nil 路径同行为，但 reconcileOne 已经在
//     prober==nil 时走通用日志早返；此处不会被命中），
//   - 真正的 prober==nil 保守日志由 reconcileOne 上游处理，本函数仅在 prober != nil 时被调。
func (w *Worker) reconcileDestroyResource(ctx context.Context, f *store.Flow) {
	if f.ResourceID == nil || *f.ResourceID == "" {
		// 防御：destroy 链路 INSERT 时 resource_id 必非空（与 isolate 链路同 schema）。
		// 出现空值意味着数据异常 / schema 漂移。
		w.logger.Printf("trade_flow reconcile: destroy orphan id=%d has nil/empty resource_id — skip (data corruption?)",
			f.ID)
		return
	}
	resourceID := *f.ResourceID

	destroyed, err := w.cfg.Prober.ProbeDestroy(ctx, resourceID)
	if err != nil {
		w.logger.Printf("trade_flow reconcile: probe destroy failed id=%d resource_id=%s err=%v — skip this round",
			f.ID, resourceID, err)
		return
	}

	if destroyed {
		// ctl 已收尾到 history_pass 终态 → 升级 completed
		if err := w.store.MarkCompletedByID(ctx, f.ID, nil); err != nil {
			w.logger.Printf("trade_flow reconcile: MarkCompletedByID failed id=%d resource_id=%s err=%v",
				f.ID, resourceID, err)
			return
		}
		w.logger.Printf("trade_flow reconcile: destroy orphan promoted to completed id=%d resource_id=%s app_id=%s",
			f.ID, resourceID, f.AppID)
		return
	}

	// destroyed=false：ctl 还在 terminating / deleting / 其他非终态。
	// 与 isolate Q11 同语义：不升级 failed，保持 in_progress 让下轮再试。
	w.logger.Printf("trade_flow reconcile: destroy orphan still pending id=%d resource_id=%s app_id=%s age=%v — keep in_progress (D-9 unbounded retry semantics)",
		f.ID, resourceID, f.AppID, w.now().Sub(f.CreatedTime))
}

// reconcileRenewResource 处理 renewResource 链路的孤儿记录（设计稿 §3.4 / §12 Q13=a）。
//
// 关键约束（与 createResource / isolateResource 对偶分析）：
//   - 计费续费协议（PDF §1.4）明确"超过 12 个月不再重试，需要业务侧主动回调"
//     → 与 isolate 协议"无最大次数永久重投"显著不同，renew 协议有 12 月止步硬阈值
//   - **trade 不主动反查 ctl + 不主动 markFailed**：避免 trade=failed 但 ctl=active
//     的资金/状态不一致风险（用户已支付续费款，pass 实际可能已经续期成功）
//   - **trade 不构造退款响应体**：续费场景已支付，不存在退款语义
//   - 处理动作仅为 **日志告警分级**：
//     a) age < 12 月：普通"still pending"日志（与 isolate 同语义）
//     b) age ≥ 12 月：升级到 ALERT 级别日志（"renew_resource_alert" 关键字便于运维监控筛选）
//   - 永远保持 in_progress；由人工介入排查 ctl 是否卡住 / 手工补尾
//
// 防御：
//   - DB schema 保证 renew 链路 resource_id NOT NULL（R-A INSERT 由 TryAcquireSlot 写入 pass_id）；
//     此处仍做 nil 守卫（与 isolate 同范式），nil 时仅日志不动作
func (w *Worker) reconcileRenewResource(_ context.Context, f *store.Flow) {
	if f.ResourceID == nil || *f.ResourceID == "" {
		// 防御：renew 链路 INSERT 时 resource_id 必非空（R-A migration 0003）。
		// 出现空值意味着数据异常 / schema 漂移。
		w.logger.Printf("trade_flow reconcile: renew orphan id=%d has nil/empty resource_id — skip (data corruption?)",
			f.ID)
		return
	}
	resourceID := *f.ResourceID
	age := w.now().Sub(f.CreatedTime)

	if age >= RenewStaleAlertThreshold {
		// 12 月止步硬阈值越界：升级 ALERT 级日志
		// "renew_resource_alert" 关键字 + age 字段便于运维 grep / 监控筛选
		w.logger.Printf("trade_flow reconcile: ALERT renew_resource_alert orphan id=%d resource_id=%s app_id=%s deal_name=%s age=%v threshold=%v — calc-renewal billing has stopped retry, manual intervention required (Q13 trade does NOT auto markFailed)",
			f.ID, resourceID, f.AppID, f.DealName, age, RenewStaleAlertThreshold)
		return
	}

	// age < 12 月：普通滞留日志（与 isolate Q11 修订版同语义；保持 in_progress 让下轮再观察）
	w.logger.Printf("trade_flow reconcile: renew orphan still pending id=%d resource_id=%s app_id=%s deal_name=%s age=%v — keep in_progress (Q13 trade-side passive)",
		f.ID, resourceID, f.AppID, f.DealName, age)
}

// reconcileModifyResource 处理 modify_resource 链路的孤儿记录（TAPD 1010132091137784162 §7.1）。
//
// 与 renew 分支同范式（trade-side passive，只告警不改状态），阈值不同：
// 变配的收敛时长由"停机 → 改规格 → 扩盘 → 开机"决定，腾讯云侧单台十几分钟，
// 多实例串行也就是小时级。滞留超过 ModifyStaleAlertThreshold 说明 CTL 父 task
// 卡住了，需要人看，而不是继续等一个自然不会到来的回调。
func (w *Worker) reconcileModifyResource(f *store.Flow) {
	resourceID := derefResourceID(f.ResourceID)
	age := w.now().Sub(f.CreatedTime)

	if age >= ModifyStaleAlertThreshold {
		w.logger.Printf("trade_flow reconcile: ALERT modify_resource_alert orphan id=%d resource_id=%s app_id=%s deal_name=%s age=%v threshold=%v — ctl modify parent task appears stuck, manual intervention required (trade does NOT auto markFailed: no rollback path for disk resize)",
			f.ID, resourceID, f.AppID, f.DealName, age, ModifyStaleAlertThreshold)
		return
	}

	w.logger.Printf("trade_flow reconcile: modify orphan still pending id=%d resource_id=%s app_id=%s deal_name=%s age=%v — keep in_progress (trade-side passive)",
		f.ID, resourceID, f.AppID, f.DealName, age)
}

// derefResourceID 是 reconcileOne 日志格式化用的辅助：nil → "<nil>"。
func derefResourceID(p *string) string {
	if p == nil {
		return "<nil>"
	}
	return *p
}

// errCtxDone 是导出便于测试时识别"运行被 ctx 中断"的哨兵；当前未对外使用。
var _ = errors.New
