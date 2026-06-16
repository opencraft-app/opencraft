// Package metric 提供 trade-pass-destroy 销毁链路的 Prometheus 指标定义。
//
// 设计稿：.tmp/trade-pass-destroy-design.md §4.5.1 / §11-A Q23
//
// 指标命名规范（与现有 lightvela_* / openclaw_* 同前缀）：
//   - lightvela_destroy_pass_total      销毁链路终态计数（按入口 / 状态分类）
//   - lightvela_destroy_trade_call_failed_total   trade.DeleteResource 调用失败计数（D-2.3 入口 A 用）
//   - lightvela_destroy_finalize_step_total       父 task 收尾步 5a/5b/5c 完成 / 失败计数（D-7）
//   - lightvela_snapshot_cleanup_total            snapshot cron 单轮清理结果（D-8）
//
// 告警规则在 argocd/services/lightvela/alerts.yaml 配置（设计稿 Q23 拍板）。
package metric

import "github.com/prometheus/client_golang/prometheus"

var (
	// DestroyPassTotal 销毁链路终态计数
	//
	// labels:
	//   - entry：入口分类（"user_active"=入口 A 用户主动销毁 / "jifei_callback"=入口 B 计费侧销毁回调）
	//   - status：终态分类（"success"=父 task markSuccess / "failed"=父 task FAILED / "deleting_pending"=入口 A 卡在 deleting）
	DestroyPassTotal = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "lightvela_destroy_pass_total",
			Help: "Total destroy-pass terminal events by entry and status",
		},
		[]string{"entry", "status"},
	)

	// DestroyTradeCallFailedTotal trade.DeleteResource 调用失败计数（入口 A 兜底告警）
	//
	// 设计稿 §4.5.1 拍板：DeletePass logic CAS isolated→deleting 后调 trade.DeleteResource 失败时，
	// pass 留在 deleting 不回滚，依赖 reconcile worker / 监控告警人工处理。
	DestroyTradeCallFailedTotal = prometheus.NewCounter(
		prometheus.CounterOpts{
			Name: "lightvela_destroy_trade_call_failed_total",
			Help: "Total trade.DeleteResource call failures from ctl.DeletePass entry (entry A user-active)",
		},
	)

	// DestroyFinalizeStepTotal 父 task 收尾步 5a/5b/5c 完成 / 失败计数
	//
	// labels:
	//   - step：收尾子步（"5a_cancel_subscription" / "5b_move_to_history" / "5c_complete_flow"）
	//   - result：结果（"success" / "failed"；best-effort 步骤如 5a/5c 失败也算 success_with_warning）
	DestroyFinalizeStepTotal = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "lightvela_destroy_finalize_step_total",
			Help: "Total destroy-pass finalize step completions by step and result",
		},
		[]string{"step", "result"},
	)

	// SnapshotCleanupTotal snapshot cron 单轮清理结果计数
	//
	// labels:
	//   - result：单 row 清理结果（"cleaned"=成功删 ctl 表行 / "failed"=DeleteByID 报错 / "skipped"=row.Id nil 跳过）
	SnapshotCleanupTotal = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "lightvela_snapshot_cleanup_total",
			Help: "Total snapshot cleanup outcomes by result (Phase A: ctl table only)",
		},
		[]string{"result"},
	)
)
