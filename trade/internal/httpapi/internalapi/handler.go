// Package internalapi 实现 trade 服务对内（ctl 等其他后端服务）暴露的 HTTP RPC handlers。
//
// 设计稿对齐（trade-purchase-flow-design.md §3.3 / §4.2.1 / §4.2.2 / §3.6）：
//
//   - POST /internal/trade/inquiry/batch         批量询价（ctl/pass CreatePass 询价分支用）
//   - POST /internal/trade/orders                下单（ctl/pass CreatePass 下单分支用）
//   - POST /internal/trade/orders/:dealName/pay-url  生成支付 url（ctl/pass CreatePass 拉支付页用）
//
// 鉴权（§3.6 + 设计稿 §4.2.1）：
//   - HTTP header `Authorization: Bearer <InternalServiceToken>` 校验
//   - InternalServiceToken 与 ctl ↔ ai-gateway / shadow 现有内部服务间 token 共享同一密钥源
//
// 错误响应：
//   - 4xx（业务错）→ JSON {code, message}
//   - 5xx（基础设施错 / 未捕获 panic）→ gin Recovery 兜底 + JSON {code, message}
//
// 不在本包：
//   - jifei 回调 endpoint（POST /trade/jifei/callback）— 那是 jifei → trade 路径，鉴权 / 协议
//     完全不同，归 internal/httpapi/jifei 包处理
package internalapi

import (
	"errors"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"git.woa.com/wisp/mono/trade/internal/logic/inquiry"
	"git.woa.com/wisp/mono/trade/internal/logic/placeorder"
)

// Deps 是内部 RPC handler 的依赖注入。
type Deps struct {
	// InternalServiceToken 与 ctl ↔ ai-gateway / shadow 共用的内部服务间互信 token。
	InternalServiceToken string

	// Inquiry 提供询价业务能力。
	Inquiry *inquiry.Service

	// PlaceOrder 提供下单 / pay-url 业务能力。
	PlaceOrder *placeorder.Service
}

// Install 把内部 RPC handler 挂载到 gin router 的 /internal/trade 子路径下。
//
// nil deps（Inquiry / PlaceOrder）视为编程错（启动期暴露），与 NewRouter 一致行为。
func Install(router *gin.Engine, deps Deps) {
	if deps.Inquiry == nil {
		panic("internalapi.Install: Inquiry service is required")
	}
	if deps.PlaceOrder == nil {
		panic("internalapi.Install: PlaceOrder service is required")
	}

	group := router.Group("/internal/trade")
	group.Use(authMiddleware(deps.InternalServiceToken))

	group.POST("/inquiry/batch", inquiryBatchHandler(deps.Inquiry))
	group.POST("/orders", placeOrderHandler(deps.PlaceOrder))
	group.POST("/orders/:dealName/pay-url", payURLHandler(deps.PlaceOrder))
}

// authMiddleware 校验 Authorization Bearer token；token 与 ctl ↔ shadow ↔ ai-gateway 共用。
//
// 空 InternalServiceToken（配置缺失）→ 直接 5xx 拒绝，避免"配置漏注 token == 任何人都能调"的灾难。
func authMiddleware(expectedToken string) gin.HandlerFunc {
	return func(c *gin.Context) {
		if expectedToken == "" {
			c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{
				"code":    "InternalServiceTokenNotConfigured",
				"message": "trade internal RPC requires LIGHTCLAW_INTERNAL_SERVICE_TOKEN",
			})
			return
		}
		auth := c.GetHeader("Authorization")
		const prefix = "Bearer "
		if !strings.HasPrefix(auth, prefix) || strings.TrimSpace(auth[len(prefix):]) != expectedToken {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{
				"code":    "Unauthorized",
				"message": "invalid or missing Authorization Bearer token",
			})
			return
		}
		c.Next()
	}
}

// ============================================================================
// inquiry/batch
// ============================================================================

// inquiryBatchRequest 是 POST /internal/trade/inquiry/batch 入参。
//
// 字段命名遵循 Lightclaw 业务层 camelCase 风格（与 ctl ↔ trade 内部约定一致，详见设计稿
// §3.3 trade 内部询价接口草案）。
//
// Uin / AppID 字段策略（迭代 8B-1 起）：
//   - 当 trade 启动期注入了 ShadowClient（cfg.ShadowInternalBaseURL 非空），调用方可只传
//     ExternalUserID，trade 内部反查 shadow 自动回填 (Uin, AppID)
//   - 调用方仍可显式传 Uin / AppID（强同步语义，绕过 shadow 反查）
//   - ShadowClient 未注入时（8A 行为）：Uin 必填，否则 400
type inquiryBatchRequest struct {
	ExternalUserID string   `json:"externalUserId"`
	Uin            string   `json:"uin"`
	AppID          string   `json:"appId"`
	BundleIDs      []string `json:"bundleIds"`
	Period         int      `json:"period"`     // 时长数值（与 inquiry.QuoteRequest.TimeSpan 等价）
	TimeUnit       string   `json:"timeUnit"`   // "m"/"y"
	GoodsNum       int      `json:"goodsNum"`   // 本期固定 1（Q41）
	PayMode        int      `json:"payMode"`    // 0/1/2
	RegionID       int      `json:"regionId"`
}

// inquiryBatchResponse 是 POST /internal/trade/inquiry/batch 出参。
type inquiryBatchResponse struct {
	Prices []*inquiry.QuoteResult `json:"prices"`
}

// inquiryBatchHandler 处理批量询价。
//
// 实现策略：
//   - 入参 BundleIDs 长度 N → 内部串行 N 次 Quote 调用（jifei 询价 SDK 已支持单次 ResInfo[]
//     批量但本期 inquiry.Service 接口先按 1 调用 1 bundle 落地，未来如需要批次合并可扩展
//     Service 接口）
//   - 任一 bundle 询价失败 → 整批失败（与 jifei adapter InquiryBatch 设计一致）
func inquiryBatchHandler(svc *inquiry.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req inquiryBatchRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{
				"code":    "InvalidRequest",
				"message": "decode JSON: " + err.Error(),
			})
			return
		}
		if len(req.BundleIDs) == 0 {
			c.JSON(http.StatusBadRequest, gin.H{
				"code":    "InvalidRequest",
				"message": "bundleIds is required",
			})
			return
		}

		results := make([]*inquiry.QuoteResult, 0, len(req.BundleIDs))
		for _, bid := range req.BundleIDs {
			r, err := svc.Quote(c.Request.Context(), inquiry.QuoteRequest{
				ExternalUserID: req.ExternalUserID,
				Uin:            req.Uin,
				AppID:          req.AppID,
				BundleID:       bid,
				TimeSpan:       req.Period,
				TimeUnit:       req.TimeUnit,
				GoodsNum:       req.GoodsNum,
				PayMode:        req.PayMode,
				RegionID:       req.RegionID,
			})
			if err != nil {
				code, status := classifyInquiryError(err)
				c.JSON(status, gin.H{
					"code":     code,
					"message":  err.Error(),
					"bundleId": bid,
				})
				return
			}
			results = append(results, r)
		}
		c.JSON(http.StatusOK, inquiryBatchResponse{Prices: results})
	}
}

// classifyInquiryError 把 inquiry 业务错误映射为 (errorCode, httpStatus)。
func classifyInquiryError(err error) (string, int) {
	switch {
	case errors.Is(err, inquiry.ErrInvalidInput):
		return "InvalidRequest", http.StatusBadRequest
	case errors.Is(err, inquiry.ErrBundleNotFound):
		return "BundleNotFound", http.StatusNotFound
	case errors.Is(err, inquiry.ErrBundleOffline):
		return "BundleOffline", http.StatusConflict
	case errors.Is(err, inquiry.ErrBindingNotFound):
		// 8B-1：externalUserId 在 shadow 没有绑定记录（用户未实名 / 未绑云账号）
		return "BindingNotFound", http.StatusUnprocessableEntity
	default:
		return "UpstreamError", http.StatusBadGateway
	}
}

// ============================================================================
// place order
// ============================================================================

// placeOrderRequest 是 POST /internal/trade/orders 入参（与设计稿 §4.2.1 对齐）。
//
// 设计稿原文："入参只带 externalUserId（不带 uin/appId），trade 内部换 uin/app_id 后调 jifei"。
// 迭代 8B-1 起：
//   - trade 启动期已注入 ShadowClient → 调用方可只传 ExternalUserID，trade 自动反查 (Uin,
//     AppID)；这是设计稿期望的最终形态
//   - 调用方仍可显式传 Uin / AppID（覆盖反查）
//   - ShadowClient 未注入时（8A 行为）：Uin 必填，否则 400
type placeOrderRequest struct {
	ExternalUserID string `json:"externalUserId"`
	Uin            string `json:"uin"`
	AppID          string `json:"appId"`
	BundleID       string `json:"bundleId"`
	Period         int    `json:"period"`
	TimeUnit       string `json:"timeUnit"`
	GoodsNum       int    `json:"goodsNum"`
	PayMode        int    `json:"payMode"`
	RegionID       int    `json:"regionId"`
}

// placeOrderResponse 是 POST /internal/trade/orders 出参。
//
// 设计稿 §4.2.1 出参 schema：
//
//	{
//	  "dealName":   "20260506xxxxxxxxx",
//	  "payUrl":     "https://buy.cloud.tencent.com/...",
//	  "expireAt":   "2026-05-06T18:30:00Z"
//	}
//
// 本期 PlaceOrder 不调"生成支付 url" SDK，PayURL/ExpireAt 留空；ctl 在拿到 dealName 后
// 单独调 POST /internal/trade/orders/{dealName}/pay-url 拉取（设计稿 §4.2.2）。
type placeOrderResponse struct {
	DealName   string `json:"dealName"`
	BigOrderID string `json:"bigOrderId"`
	PayURL     string `json:"payUrl,omitempty"`
	ExpireAt   string `json:"expireAt,omitempty"`
}

func placeOrderHandler(svc *placeorder.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req placeOrderRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{
				"code":    "InvalidRequest",
				"message": "decode JSON: " + err.Error(),
			})
			return
		}
		res, err := svc.PlaceOrder(c.Request.Context(), placeorder.PlaceOrderRequest{
			ExternalUserID: req.ExternalUserID,
			Uin:            req.Uin,
			AppID:          req.AppID,
			BundleID:       req.BundleID,
			Period:         req.Period,
			TimeUnit:       req.TimeUnit,
			GoodsNum:       req.GoodsNum,
			PayMode:        req.PayMode,
			RegionID:       req.RegionID,
		})
		if err != nil {
			code, status := classifyPlaceOrderError(err)
			c.JSON(status, gin.H{
				"code":    code,
				"message": err.Error(),
			})
			return
		}
		c.JSON(http.StatusOK, placeOrderResponse{
			DealName:   res.DealName,
			BigOrderID: res.BigOrderID,
			PayURL:     res.PayURL,
			ExpireAt:   res.ExpireAt,
		})
	}
}

// classifyPlaceOrderError 把 placeorder 业务错误映射为 (errorCode, httpStatus)。
func classifyPlaceOrderError(err error) (string, int) {
	switch {
	case errors.Is(err, placeorder.ErrInvalidInput):
		return "InvalidRequest", http.StatusBadRequest
	case errors.Is(err, placeorder.ErrBundleNotFound):
		return "BundleNotFound", http.StatusNotFound
	case errors.Is(err, placeorder.ErrBundleOffline):
		return "BundleOffline", http.StatusConflict
	case errors.Is(err, placeorder.ErrDealNameDuplicate):
		return "DealNameConflict", http.StatusConflict
	case errors.Is(err, placeorder.ErrJifeiResponseInvalid):
		return "UpstreamInvalidResponse", http.StatusBadGateway
	case errors.Is(err, placeorder.ErrBindingNotFound):
		// 8B-1：externalUserId 在 shadow 没有绑定记录（用户未实名 / 未绑云账号）
		return "BindingNotFound", http.StatusUnprocessableEntity
	default:
		return "UpstreamError", http.StatusBadGateway
	}
}

// ============================================================================
// pay url
// ============================================================================

// payURLResponse 与设计稿 §4.2.2 出参对齐。
type payURLResponse struct {
	PayURL   string `json:"payUrl"`
	ExpireAt string `json:"expireAt,omitempty"`
}

func payURLHandler(svc *placeorder.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		dealName := c.Param("dealName")
		url, err := svc.GeneratePayURL(c.Request.Context(), dealName)
		if err != nil {
			code, status := classifyPayURLError(err)
			c.JSON(status, gin.H{
				"code":    code,
				"message": err.Error(),
			})
			return
		}
		c.JSON(http.StatusOK, payURLResponse{PayURL: url})
	}
}

func classifyPayURLError(err error) (string, int) {
	switch {
	case errors.Is(err, placeorder.ErrInvalidInput):
		return "InvalidRequest", http.StatusBadRequest
	case errors.Is(err, placeorder.ErrPayURLUnavailable):
		// 暂无缓存的支付 url（jifei 生成 url SDK 接入前的临时返回码）
		return "PayURLNotAvailable", http.StatusServiceUnavailable
	default:
		// trade_order not found / 其他基础设施错
		return "UpstreamError", http.StatusBadGateway
	}
}
