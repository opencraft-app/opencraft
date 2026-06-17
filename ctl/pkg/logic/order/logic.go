// Package order 提供订单维度的业务能力（v1.7.32 引入）。
//
// 当前承载：
//   - GET /v1/orders/{dealName}/status 订单状态反查（设计稿 .tmp/ctl-order-status-query-design.md）
//
// 设计原则（设计稿 §0.2 + §5.5）：
//   - **ctl 不感知 trade_order 内部状态机** — 全部封装在 trade 内部
//   - logic 层是**纯透传**：调 trade.QueryOrderStatus 一次拿统一 5 态，
//     直接装配到 transport.OrderStatusResponse
//   - B4 越权校验由 trade service 做（trade_order.external_user_id 比对）；
//     不匹配返 ORDER_NOT_FOUND 不暴露存在性
package order

import (
	"context"
	"errors"
	"strings"
	"time"

	adapterfactory "ctl/pkg/adapter/factory"
	"ctl/pkg/adapter/trade"
	"ctl/pkg/errcode"
	"ctl/pkg/transport"
)

// queryOrderStatusTimeout trade 调用超时（与其它内部 RPC 一致 5s SLA）。
const queryOrderStatusTimeout = 5 * time.Second

// Logic 订单业务能力对外接口。
type Logic interface {
	// GetOrderStatus 按订单号查询支付状态（v1.7.32）。
	//
	// 设计稿：.tmp/ctl-order-status-query-design.md §5.5。
	//
	// 流程（**纯透传**）：
	//   1) 校验入参（userID / dealName 必填）
	//   2) 调 trade.QueryOrderStatus 一次拿统一 5 态
	//   3) 把 trade.OrderStatusResult 装配到 transport.OrderStatusResponse
	//
	// 错误分类：
	//   - 入参缺失 → ErrInvalidParam
	//   - trade 4xx (400 InvalidRequest / 404 OrderNotFound) → 透传相应 errcode
	//   - trade 5xx → 包成 ErrUpstreamUnavailable（前端告知"上游服务异常"）
	GetOrderStatus(userID, dealName string) (*transport.OrderStatusResponse, error)
}

type logic struct{}

// NewLogic 构造 Logic 实现。
func NewLogic() Logic {
	return &logic{}
}

// GetOrderStatus 详见 Logic.GetOrderStatus 注释。
func (l *logic) GetOrderStatus(userID, dealName string) (*transport.OrderStatusResponse, error) {
	userID = strings.TrimSpace(userID)
	dealName = strings.TrimSpace(dealName)
	if userID == "" || dealName == "" {
		return nil, errcode.ErrInvalidParam
	}

	ctx, cancel := context.WithTimeout(context.Background(), queryOrderStatusTimeout)
	defer cancel()

	res, err := adapterfactory.DefaultAdapterFactory.TradeAdapter().
		QueryOrderStatus(ctx, dealName, userID)
	if err != nil {
		return nil, mapTradeError(err)
	}

	// trade 已完成 B1/B4/B7 全流程，ctl 直接透传字段（不做二次状态映射）。
	return &transport.OrderStatusResponse{
		DealName:    res.DealName,
		OrderType:   res.OrderType,
		LocalStatus: res.LocalStatus,
		Status:      res.Status,
		Source:      res.Source,
		BigOrderID:  res.BigOrderID,
		UpstreamErr: res.UpstreamErr,
	}, nil
}

// mapTradeError 把 trade adapter 返回的 *trade.Error 映射为 ctl 业务错误码。
//
// 映射表（与 trade C4 handler classifyOrderStatusError 对齐 — .tmp 设计稿 §6）：
//   - 400 InvalidRequest → ErrInvalidParam（HTTP 400）
//   - 404 OrderNotFound  → ErrOrderNotFound（HTTP 404，B4 不暴露存在性）
//   - 5xx                → 包成内部错（不直接透传 5xx 文本）
//   - 其它非 *Error      → raw err 原样返（HTTP 500）
func mapTradeError(err error) error {
	var tErr *trade.Error
	if !errors.As(err, &tErr) {
		// 非 trade adapter 的 *Error（如网络层失败 / 入参校验失败）— 透传 raw error
		return err
	}
	switch {
	case tErr.Status == 400:
		return errcode.Wrap(errcode.ErrInvalidParam, "%s", tErr.Message)
	case tErr.Status == 404:
		return errcode.Wrap(errcode.ErrOrderNotFound, "%s", tErr.Message)
	case tErr.Status >= 500:
		// 不直接透传 5xx 给前端（避免泄露内部细节）
		return errcode.Wrap(errcode.ErrInternalServer, "trade upstream error: %s", tErr.Code)
	}
	return err
}
