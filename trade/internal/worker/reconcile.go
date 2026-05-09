// Package worker 收纳 trade 服务的后台 worker（迭代 7 起）。
//
// 当前唯一 worker：trade_flow reconcile（设计稿 §6.4 / Q61 兜底分支）。
//
// 设计稿对齐（trade-purchase-flow-design.md）：
//   - Q61 抢占式幂等：trade_flow.status 三态（in_progress / completed / failed）
//   - 边缘场景：trade pod 在主链路执行中途 SIGKILL → 留下 in_progress 孤儿记录
//   - 兜底机制：每 5 min 扫描 created_time < NOW()-30min 的 in_progress 记录，
//     反查 ctl 是否已实际生成 pass，决定升级 completed 还是 failed
//
// 本期范围（迭代 7）：
//   - ✅ 扫描骨架：周期触发、批量分页、context cancel 优雅停机
//   - ✅ 反查注入：ResourceProber interface（生产路径默认 nil → 仅日志告警，
//     不自动升级；迭代 8 ctl 暴露 GetPassByDealName 后注入真实 prober 自动升级）
//   - ❌ 不引入指标库（保留 log 输出供运维排障，避免提前依赖 metrics 栈）
//
// 安全约束（Q56 / Q61）：
//   - 仅 status='in_progress' 的记录才会被升级；reconcile 与赢家路径
//     共用 markStatus 的 WHERE status='in_progress' 守卫，互不破坏
//   - 反查失败（prober 返错）→ 跳过本条，下一轮再试，绝不在不确定状态下乱改
//   - 输家路径仍然走 in_progress → ReturnCodeFlowInProgress（让 jifei 重试），
//     reconcile 升级是异步副线，不影响在途 jifei 重试节奏
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
//   - 给"trade pod 漂移 / k8s rolling 重启 / DB 抖动后人工恢复"留足缓冲
//   - 设计稿 §6.4 拍板值
const DefaultStaleThreshold = 30 * time.Minute

// DefaultBatchLimit 是每轮扫描的最大记录数。
//
// 防止积压时一次扫几万条压垮 trade DB，超出本批的下轮再扫。
const DefaultBatchLimit = 100

// ResourceProber 抽象"按 dealName 反查 ctl 是否已发货"。
//
// 本期（迭代 7）注入 nil 即可 — worker 退化为"仅扫描 + 告警"模式，
// 等待运维介入或迭代 8 注入真实 prober。
//
// 迭代 8 计划：
//   - ctl 新增 GET /internal/ctl/passes/by-deal/{dealName} 反查接口
//   - trade ctlclient 加 GetPassByDealName 方法
//   - 在 main.go 注入实现 ResourceProber 的 adapter
type ResourceProber interface {
	// ProbeResource 反查 dealName 对应的 pass 是否已发货。
	//
	// 返回：
	//   - exists=true → ctl 已生成 pass（升级 completed 安全）
	//   - exists=false → ctl 没生成 pass（升级 failed → 退款响应安全）
	//   - err != nil → 反查失败（基础设施错或限流），跳过本条等下轮
	ProbeResource(ctx context.Context, dealName string) (exists bool, err error)
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

	// Prober 反查 ctl 是否已发货；nil 表示本期保守模式（仅日志告警，不升级状态）
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

// reconcileOne 处理单条孤儿记录。
//
// 三种行为分支：
//  1. Prober == nil（本期默认）：仅日志告警，不改状态 — 等迭代 8 / 人工介入
//  2. Prober.ProbeResource → exists=true：MarkCompleted（响应体回填留 nil，
//     等下次 jifei 重试时输家路径返 ReturnCodeFlowReplayCorrupted；不写假响应体
//     的原因是 reconcile 不知道当时赢家本应返回什么字段，写假响应体反而破坏
//     Q58 不变量）。注：本期 ctl 还没暴露 prober，这条路径要等迭代 8 真正生效。
//  3. Prober.ProbeResource → exists=false：MarkFailed（同样 nil 响应体；
//     输家路径会走 corrupted 分支让 jifei 重试退款 — 这是设计上的兜底成本）
//
// 严格 Q56：reconcile 不主动构造退款响应体，避免越权决策（"判定为永久失败"
// 这件事属于 createResource 主链路 / 中转服务策略层，reconcile 只是收尸）。
func (w *Worker) reconcileOne(ctx context.Context, f *store.Flow) {
	if f == nil {
		return
	}
	if w.cfg.Prober == nil {
		// 保守模式：仅日志，不动状态
		w.logger.Printf("trade_flow reconcile: orphan deal_name=%s flow_type=%s app_id=%s created_time=%v age=%v — prober not configured, manual intervention required",
			f.DealName, f.FlowType, f.AppID, f.CreatedTime, w.now().Sub(f.CreatedTime))
		return
	}

	exists, err := w.cfg.Prober.ProbeResource(ctx, f.DealName)
	if err != nil {
		w.logger.Printf("trade_flow reconcile: probe failed deal_name=%s err=%v — skip this round",
			f.DealName, err)
		return
	}

	if exists {
		if err := w.store.MarkCompleted(ctx, f.DealName, f.FlowType, f.AppID, nil); err != nil {
			w.logger.Printf("trade_flow reconcile: MarkCompleted failed deal_name=%s err=%v", f.DealName, err)
			return
		}
		w.logger.Printf("trade_flow reconcile: orphan promoted to completed deal_name=%s app_id=%s",
			f.DealName, f.AppID)
		return
	}

	if err := w.store.MarkFailed(ctx, f.DealName, f.FlowType, f.AppID, nil); err != nil {
		w.logger.Printf("trade_flow reconcile: MarkFailed failed deal_name=%s err=%v", f.DealName, err)
		return
	}
	w.logger.Printf("trade_flow reconcile: orphan promoted to failed deal_name=%s app_id=%s",
		f.DealName, f.AppID)
}

// errCtxDone 是导出便于测试时识别"运行被 ctx 中断"的哨兵；当前未对外使用。
var _ = errors.New
