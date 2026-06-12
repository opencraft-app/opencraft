// Package orderstatus 实现 trade 服务对外暴露的"订单状态反查"业务能力（v1.7.32 引入）。
//
// 设计稿对齐：.tmp/ctl-order-status-query-design.md §1 不变量 B1~B7 + §5.2。
//
// 服务定位：
//   - 上层入口：POST /internal/trade/orders/:dealName/query-status（C4 切片 handler）
//   - 唯一对外接口（B1 终态短路 / 越权校验 / jifei 反查 / DB 同步全部封装在 trade 内部）
//   - ctl 仅做透传，不感知 trade_order 内部状态机
//
// 核心流程（QueryStatus）：
//
//  1. 反查本地 trade_order（OrderStore.GetOrderByDealName）
//  2. B4 越权校验（trade_order.external_user_id == 入参 ExternalUserID）
//  3. B1 本地终态短路（IsOrderTerminalStatus）→ 直接返本地状态，**不调 jifei**
//  4. SkipJifei=true 时退化为本地状态（B7 降级 / 性能 / 测试用）
//  5. 中态 → 调 jifei.GetDealsByKeyIndex 反查
//  6. B7 jifei 不可达降级：返本地状态 + Source="local" + UpstreamErr
//  7. 状态映射 + B2 / B3 同步：
//     - canceled / overdue / delete → MarkOrderCancelled 推进本地终态
//     - finished → 不更新本地（callback 链路兜底）
//     - 中态（init/paying/processing/delivered）→ 不更新本地
package orderstatus

import (
	"context"
	"errors"
	"fmt"
	"log"

	"git.woa.com/wisp/mono/trade/internal/jifeiclient"
	"git.woa.com/wisp/mono/trade/internal/store"
)

// 哨兵错误（handler 层映射成 HTTP 业务码）。
//
// ErrInvalidInput 入参校验失败（DealName / ExternalUserID 为空等）→ HTTP 400 INVALID_INPUT。
// ErrOrderNotFound trade_order 不存在 → HTTP 404 ORDER_NOT_FOUND。
// ErrPermissionDenied 越权（B4 不变量）→ handler 映射为 HTTP 404 ORDER_NOT_FOUND（不暴露存在性）。
var (
	ErrInvalidInput     = errors.New("orderstatus: invalid input")
	ErrOrderNotFound    = errors.New("orderstatus: trade_order not found")
	ErrPermissionDenied = errors.New("orderstatus: permission denied")
)

// 统一对外状态枚举（设计稿 §3.3 / B8 不变量）。
//
// ctl handler 直接透传给前端，不做二次映射。前端按 5 态展示订单生命周期。
const (
	// StatusPending 待支付 / 支付中（中态）。
	StatusPending = "pending"
	// StatusPaid 已支付待发货（中态）。
	StatusPaid = "paid"
	// StatusSuccess 成功完成（pass 已发货，终态）。
	StatusSuccess = "success"
	// StatusCancelled 已取消（含 jifei overdue / delete，终态）。
	StatusCancelled = "cancelled"
	// StatusFailed 失败（终态，本期由 trade_order.payment_failed/provision_failed 终态触发；jifei 协议未直接落）。
	StatusFailed = "failed"
)

// Source 字段枚举（区分数据来源，便于排障 + B7 降级感知）。
const (
	// SourceLocal 来源：trade 本地 trade_order 状态。
	//   - B1 本地终态短路返回时
	//   - B7 jifei 不可达降级时
	//   - SkipJifei=true 时
	SourceLocal = "local"
	// SourceJifei 来源：jifei.getDealsByKeyIndex 实时反查。
	SourceJifei = "jifei"
)

// QueryStatusInput 是 QueryStatus 的入参。
type QueryStatusInput struct {
	// DealName 订单号（jifei 子订单号），必填。
	DealName string
	// ExternalUserID 当前请求用户的 lightclaw user_id，必填，用于 B4 越权校验。
	ExternalUserID string
	// SkipJifei 是否跳过 jifei 反查（运维 / 测试用，默认 false）。
	// 设为 true 时直接返本地状态，等价于 B1 短路语义但应用于中态订单。
	SkipJifei bool
}

// QueryStatusResult 是 QueryStatus 的出参。
//
// handler 层 / ctl adapter 直接透传给前端，无二次状态映射。
type QueryStatusResult struct {
	DealName    string `json:"deal_name"`
	OrderType   string `json:"order_type"`             // 'create' / 'renew'
	LocalStatus string `json:"local_status"`           // trade_order.status 原值（运维 / 排障可见）
	Status      string `json:"status"`                 // 统一 5 态：pending / paid / success / cancelled / failed
	Source      string `json:"source"`                 // SourceLocal / SourceJifei
	BigOrderID  string `json:"big_order_id,omitempty"`
	UpstreamErr string `json:"upstream_err,omitempty"` // jifei 不可达时携带（B7 降级）
}

// Deps 是 Service 的依赖注入集合。
type Deps struct {
	OrderStore  store.OrderStore
	OrderWriter store.OrderWriter
	JifeiClient jifeiclient.Client
}

// Service 实现"订单状态反查"业务能力。
type Service struct {
	deps Deps
}

// New 构造 Service；依赖 nil 时 panic（启动期暴露编程错，符合 trade 仓既有范式）。
func New(deps Deps) *Service {
	if deps.OrderStore == nil {
		panic("orderstatus.New: OrderStore is required")
	}
	if deps.OrderWriter == nil {
		panic("orderstatus.New: OrderWriter is required")
	}
	if deps.JifeiClient == nil {
		panic("orderstatus.New: JifeiClient is required")
	}
	return &Service{deps: deps}
}

// QueryStatus 实现订单状态反查主流程（设计稿 §1 不变量 B1~B7 全程）。
//
// 错误分类：
//   - 入参校验失败 → ErrInvalidInput（handler 400）
//   - trade_order 不存在 → ErrOrderNotFound（handler 404）
//   - 越权（external_user_id 不匹配）→ ErrPermissionDenied（handler 404 不暴露存在性）
//   - 其他基础设施错（OrderStore / OrderWriter SQL 失败）→ raw error wrap（handler 500）
//
// **B7 jifei 不可达降级**：jifei.GetDealsByKeyIndex 返错时**不返 error**，而是
// 返 (Result{Source: "local", UpstreamErr: "..."}, nil)，让 handler 直接透传 200，
// 不阻断前端轮询。
func (s *Service) QueryStatus(ctx context.Context, in QueryStatusInput) (*QueryStatusResult, error) {
	// 入参校验
	if in.DealName == "" {
		return nil, fmt.Errorf("%w: deal_name is required", ErrInvalidInput)
	}
	if in.ExternalUserID == "" {
		return nil, fmt.Errorf("%w: external_user_id is required", ErrInvalidInput)
	}

	// 1) 反查本地 trade_order
	order, err := s.deps.OrderStore.GetOrderByDealName(ctx, in.DealName)
	if err != nil {
		if errors.Is(err, store.ErrTradeOrderNotFound) {
			return nil, fmt.Errorf("%w: dealName=%s", ErrOrderNotFound, in.DealName)
		}
		return nil, fmt.Errorf("orderstatus: get trade_order dealName=%s: %w", in.DealName, err)
	}

	// 2) B4 越权校验：external_user_id 必须匹配
	if order.ExternalUserID != in.ExternalUserID {
		// 不暴露存在性 — 返 PermissionDenied，handler 映射成 404 ORDER_NOT_FOUND
		return nil, fmt.Errorf("%w: dealName=%s requested by %q owned by %q",
			ErrPermissionDenied, in.DealName, in.ExternalUserID, order.ExternalUserID)
	}

	out := &QueryStatusResult{
		DealName:    order.DealName,
		OrderType:   order.OrderType,
		LocalStatus: order.Status,
		BigOrderID:  order.BigOrderID,
	}

	// 3) B1 本地终态短路：直接返本地状态，绝不调 jifei
	if store.IsOrderTerminalStatus(order.Status) {
		out.Status = mapLocalStatus(order.Status)
		out.Source = SourceLocal
		return out, nil
	}

	// 4) SkipJifei 退化为本地状态（运维 / 测试 / 性能场景）
	if in.SkipJifei {
		out.Status = mapLocalStatus(order.Status)
		out.Source = SourceLocal
		return out, nil
	}

	// 5) 中态 → 调 jifei.GetDealsByKeyIndex 反查
	resp, err := s.deps.JifeiClient.GetDealsByKeyIndex(ctx, &jifeiclient.GetDealsByKeyIndexRequest{
		Cond: jifeiclient.GetDealsByKeyIndexCond{DealName: in.DealName},
	})
	if err != nil {
		// 6) B7 jifei 不可达降级：不返 error，返本地状态 + UpstreamErr
		log.Printf("[orderstatus] jifei GetDealsByKeyIndex failed, fallback to local: dealName=%s err=%v", in.DealName, err)
		out.Status = mapLocalStatus(order.Status)
		out.Source = SourceLocal
		out.UpstreamErr = err.Error()
		return out, nil
	}

	// jifei 返 totalNum=0 / deals 空：订单在 jifei 侧不存在（极端场景）— 按 cancelled 处理
	// （与 overdue / delete 同一类终态，B2 触发本地同步）
	if resp == nil || resp.TotalNum == 0 || len(resp.Deals) == 0 {
		log.Printf("[orderstatus] jifei returned no deals, treat as cancelled: dealName=%s", in.DealName)
		s.bestEffortMarkCancelled(ctx, in.DealName)
		out.Status = StatusCancelled
		out.Source = SourceJifei
		return out, nil
	}

	// 7) 状态映射 + B2 / B3 同步
	jifeiStatus := int(resp.Deals[0].Status)
	out.Source = SourceJifei
	out.Status = mapJifeiStatus(jifeiStatus)

	switch jifeiStatus {
	case jifeiclient.JifeiDealStatusCanceled,
		jifeiclient.JifeiDealStatusOverdue,
		jifeiclient.JifeiDealStatusDelete:
		// B2 不变量：取消 / 超时 / 删除 → 单向同步 trade_order 到 cancelled
		s.bestEffortMarkCancelled(ctx, in.DealName)
	case jifeiclient.JifeiDealStatusFinished:
		// B3 不变量：finished 不更新本地，由 jifei → createResource 回调链路兜底
	default:
		// 中态（init/paying/processing/delivered/未知）→ 不更新本地
	}

	return out, nil
}

// bestEffortMarkCancelled 以"尽力而为"语义调用 OrderWriter.MarkOrderCancelled。
//
// 失败仅记日志，不影响响应：下次轮询会重试（MarkOrderCancelled 本身已幂等）。
func (s *Service) bestEffortMarkCancelled(ctx context.Context, dealName string) {
	if err := s.deps.OrderWriter.MarkOrderCancelled(ctx, dealName); err != nil {
		log.Printf("[orderstatus] mark order cancelled failed (best-effort, will retry on next poll): dealName=%s err=%v", dealName, err)
	}
}

// mapLocalStatus 把 trade_order.status 映射到统一 5 态（B8 不变量）。
//
// 映射表（设计稿 §3.3）：
//   - created / pending_pay → pending
//   - paid_pending_provision → paid
//   - provisioned → success
//   - cancelled → cancelled
//   - payment_failed / provision_failed → failed
//   - 其他 → pending（向前兼容兜底）
func mapLocalStatus(s string) string {
	switch s {
	case store.OrderStatusCreated, store.OrderStatusPendingPay:
		return StatusPending
	case store.OrderStatusPaidPendingProvision:
		return StatusPaid
	case store.OrderStatusProvisioned:
		return StatusSuccess
	case store.OrderStatusCancelled:
		return StatusCancelled
	case store.OrderStatusPaymentFailed, store.OrderStatusProvisionFailed:
		return StatusFailed
	}
	return StatusPending
}

// mapJifeiStatus 把 jifei deal status 映射到统一 5 态（B8 不变量）。
//
// 映射表（设计稿 §3.3）：
//   - init / paying → pending
//   - processing / delivered → paid
//   - finished → success
//   - canceled / overdue / delete → cancelled（Q-OS-2 拍板：overdue/delete 归 cancelled）
//   - 其他（如 status=7 jifei 内部未公开中间态）→ pending（向前兼容兜底）
func mapJifeiStatus(s int) string {
	switch s {
	case jifeiclient.JifeiDealStatusInit, jifeiclient.JifeiDealStatusPaying:
		return StatusPending
	case jifeiclient.JifeiDealStatusProcessing, jifeiclient.JifeiDealStatusDelivered:
		return StatusPaid
	case jifeiclient.JifeiDealStatusFinished:
		return StatusSuccess
	case jifeiclient.JifeiDealStatusCanceled,
		jifeiclient.JifeiDealStatusOverdue,
		jifeiclient.JifeiDealStatusDelete:
		return StatusCancelled
	}
	return StatusPending
}
