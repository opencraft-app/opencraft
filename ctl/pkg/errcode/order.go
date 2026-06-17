package errcode

// ErrOrderNotFound trade_order 不存在或越权（B4 不暴露存在性策略）。
//
// 设计稿：.tmp/ctl-order-status-query-design.md §1 不变量 B4 + §6 错误码表。
//
// 触发场景：
//   - 前端用 dealName 查询订单状态，但 trade_order 表没有该记录
//   - 前端用 dealName 查询订单状态，但该订单 owner 不是当前用户（B4 越权）
//
// 上述两种场景统一返 404 ORDER_NOT_FOUND，不区分（避免暴露 dealName 是否存在）。
var ErrOrderNotFound = Register(New("ORDER_NOT_FOUND", 404, "order not found"))
