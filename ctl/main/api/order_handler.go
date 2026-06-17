package main

import (
	"net/http"
	"strings"

	"ctl/pkg/errcode"
	orderlogic "ctl/pkg/logic/order"
)

// orderHandler 订单维度 handler（v1.7.32 引入）。
//
// 当前承载：
//   - GET /v1/orders/{dealName}/status 订单状态反查（设计稿 .tmp/ctl-order-status-query-design.md）
type orderHandler struct {
	logic orderlogic.Logic
}

// handleUserOrders 用户订单顶层路由分发器。
//
// 当前仅承载 /v1/orders/{dealName}/status 一条接口（Q-OS-7 拍板：本期不支持批量）。
//
// 路由解析与 handleUserPassesByID 对偶（设计稿 §4 矩阵 #19/#20 + Q-OS-1/Q-OS-6 拍板）：
//   - subPath 段数 == 2 且第 2 段 == "status" → handleUserOrderStatus(parts[0])
//   - 其他子路径 → 404
func (h *orderHandler) handleUserOrders(w http.ResponseWriter, r *http.Request) {
	subPath := strings.Trim(strings.TrimPrefix(r.URL.Path, "/v1/orders"), "/")
	if subPath == "" {
		// 裸 /v1/orders 当前未注册，404
		writeHTTPError(w, r, errcode.ErrNotFound)
		return
	}
	parts := strings.Split(subPath, "/")
	// 2 段路径：{dealName}/status
	if len(parts) == 2 && parts[1] == "status" {
		h.handleUserOrderStatus(w, r, parts[0])
		return
	}
	writeHTTPError(w, r, errcode.ErrNotFound)
}

// handleUserOrderStatus GET /v1/orders/{dealName}/status — 用户订单状态反查（v1.7.32）。
//
// 设计稿：.tmp/ctl-order-status-query-design.md §5.5 + Q-OS-1/Q-OS-3/Q-OS-8 拍板。
//
// 鉴权：X-User-Id（与其他 /v1 路由一致）。
//
// 请求：path param dealName。
//
// 响应（HTTP 200）：transport.OrderStatusResponse 5 态统一枚举 + 数据来源标识。
//
// 错误：
//   - 401 UNAUTHORIZED：缺 X-User-Id
//   - 405 METHOD_NOT_ALLOWED：非 GET
//   - 400 INVALID_PARAMETER：dealName 路径参数为空
//   - 404 ORDER_NOT_FOUND：订单不存在 / 越权（B4 不暴露存在性）
//   - 500 INTERNAL_SERVER_ERROR：trade 服务异常
//
// **注意 B7 降级**：trade 在 jifei 不可达时仍返 200 + Source="local" + UpstreamErr 非空，
// ctl 直接透传给前端，前端可按需展示"状态可能不准"提示。
func (h *orderHandler) handleUserOrderStatus(w http.ResponseWriter, r *http.Request, dealName string) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeHTTPError(w, r, errcode.ErrMethodNotAllowed)
		return
	}
	ctx, ok := newRequestContext(r)
	if !ok {
		writeHTTPError(w, r, errcode.ErrUnauthorized)
		return
	}
	if dealName == "" {
		writeHTTPError(w, r, errcode.Wrap(errcode.ErrInvalidParam, "deal_name is required"))
		return
	}

	resp, err := h.logic.GetOrderStatus(ctx.GetUserID(), dealName)
	if err != nil {
		writeHTTPError(w, r, err)
		return
	}
	writeSuccess(w, r, http.StatusOK, resp)
}
