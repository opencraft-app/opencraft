package internalapi

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"

	"git.woa.com/wisp/mono/trade/internal/logic/orderstatus"
)

// queryOrderStatusRequest 是 POST /internal/trade/orders/:dealName/query-status 的入参 body。
//
// 设计稿：.tmp/ctl-order-status-query-design.md §5.4。
//
// 字段语义：
//   - ExternalUserID：调用方（ctl）从 X-User-Id 透传过来的 lightclaw user_id，必填。
//     trade service.QueryStatus 内 B4 越权校验使用：trade_order.external_user_id == 此值。
//   - SkipJifei：可选；true 时退化为本地状态查询（运维 / 测试场景），不调 jifei.getDealsByKeyIndex。
type queryOrderStatusRequest struct {
	ExternalUserID string `json:"external_user_id"`
	SkipJifei      bool   `json:"skip_jifei,omitempty"`
}

// queryOrderStatusHandler 处理 ctl→trade 订单状态反查接口（v1.7.32 引入）。
//
// 行为：
//   - 鉴权：复用 group 级 Bearer token middleware（与询价 / 下单 / pay-url 同源）
//   - 入参：path param dealName + body { external_user_id, skip_jifei }
//   - 调用 orderstatus.Service.QueryStatus 完成"trade_order 反查 + B4 越权校验 +
//     B1 本地终态短路 + jifei.getDealsByKeyIndex 反查 + B2 同步"全流程
//   - 响应：直接 JSON 化 *QueryStatusResult（与 ctl adapter 协议一致透传）
//
// 错误分类（classifyOrderStatusError）：
//   - ErrInvalidInput → 400 InvalidRequest
//   - ErrOrderNotFound / ErrPermissionDenied → 404 OrderNotFound（B4 不暴露存在性）
//   - 其他基础设施错（OrderStore SQL 失败等） → 500 InternalError
//
// 注意：B7 jifei 不可达降级**不**返 error，service 层已封装为 200 + Source="local" + UpstreamErr。
func queryOrderStatusHandler(svc *orderstatus.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		dealName := c.Param("dealName")

		var body queryOrderStatusRequest
		if err := c.ShouldBindJSON(&body); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{
				"code":    "InvalidRequest",
				"message": "invalid JSON body: " + err.Error(),
			})
			return
		}

		result, err := svc.QueryStatus(c.Request.Context(), orderstatus.QueryStatusInput{
			DealName:       dealName,
			ExternalUserID: body.ExternalUserID,
			SkipJifei:      body.SkipJifei,
		})
		if err != nil {
			code, status := classifyOrderStatusError(err)
			c.JSON(status, gin.H{
				"code":    code,
				"message": err.Error(),
			})
			return
		}

		c.JSON(http.StatusOK, result)
	}
}

// classifyOrderStatusError 把 orderstatus service 的哨兵错误映射到 HTTP 业务码 + status code。
//
// 映射表（与设计稿 §6 错误码表对齐）：
//   - ErrInvalidInput → (400, "InvalidRequest")
//   - ErrOrderNotFound / ErrPermissionDenied → (404, "OrderNotFound")
//     【B4 关键】越权统一映射成 404 而不是 403，避免暴露 dealName 是否存在
//   - 其他（基础设施错 / SQL 失败等） → (500, "InternalError")
func classifyOrderStatusError(err error) (string, int) {
	switch {
	case errors.Is(err, orderstatus.ErrInvalidInput):
		return "InvalidRequest", http.StatusBadRequest
	case errors.Is(err, orderstatus.ErrOrderNotFound),
		errors.Is(err, orderstatus.ErrPermissionDenied):
		return "OrderNotFound", http.StatusNotFound
	default:
		return "InternalError", http.StatusInternalServerError
	}
}
