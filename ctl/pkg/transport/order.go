package transport

// OrderStatusResponse 订单状态查询响应（v1.7.32 引入）。
//
// 用途：GET /v1/orders/{dealName}/status，前端轮询订单支付状态。
//
// 设计稿：.tmp/ctl-order-status-query-design.md §3.3 + §5.6 + Q-OS-1/2/3/8 拍板。
//
// 字段语义：
//   - DealName：jifei 子订单号
//   - OrderType：'create' / 'renew'，前端按需展示新购 / 续费标签（B5 不变量）
//   - Status：统一 5 态 'pending' / 'paid' / 'success' / 'cancelled' / 'failed'（B8 不变量）
//   - Source：'local' / 'jifei' — 数据来源；local 表示 jifei 不可达降级（B7 不变量）
//   - LocalStatus：trade_order.status 原值（运维 / 排障可见，前端可忽略）
//   - BigOrderID：jifei 大订单号（运维 / 客服排障可见）
//   - UpstreamErr：jifei 不可达时的 error 描述（前端展示 + ELK 排障，B7 fallback signal）
//
// 透传策略：ctl logic 拿到 trade.QueryOrderStatus 结果后**直接透传**到本 DTO，
// 不做二次状态映射 — trade 内部已完成所有状态机封装。
type OrderStatusResponse struct {
	DealName    string `json:"deal_name"`
	OrderType   string `json:"order_type"`
	LocalStatus string `json:"local_status,omitempty"`
	Status      string `json:"status"`
	Source      string `json:"source"`
	BigOrderID  string `json:"big_order_id,omitempty"`
	UpstreamErr string `json:"upstream_err,omitempty"`
}
