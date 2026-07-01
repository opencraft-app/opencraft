// Package internalapi 实现 trade 服务对内（ctl 等其他后端服务）暴露的 HTTP RPC handlers。
//
// 设计稿对齐（trade-purchase-flow-design.md §3.3 / §4.2.1 / §4.2.2 / §3.6 +
// trade-pass-renew-design.md §4.3 / R-C-7 / R-D-7）：
//
//   - POST /internal/trade/inquiry/batch              批量询价（ctl/pass CreatePass 询价分支用）
//   - POST /internal/trade/inquiry/renew              续费询价（ctl/pass RenewPassPrice 用，R-C-4）
//   - POST /internal/trade/orders                     下单（ctl/pass CreatePass 下单分支用）
//   - POST /internal/trade/orders/place-and-pay       下单+支付一体化（迭代 8B-1.5 测试链路用）
//   - POST /internal/trade/orders/renew               续费下单（ctl/pass.RenewPassOrderUrl 用，R-C-7）
//   - POST /internal/trade/orders/renew/place-and-pay 续费下单+支付一体化（ctl/pass.RenewPassOrderAndPay 测试用，R-D-7）
//   - POST /internal/trade/orders/:dealName/pay-url   生成支付 url（ctl/pass CreatePass 拉支付页用）
//   - POST /internal/trade/orders/:dealName/query-status 订单状态反查（v1.7.32 引入，详见 .tmp/ctl-order-status-query-design.md）
//   - POST /internal/trade/flows/:flowID/complete     trade_flow.status 推进到 completed（Sub-4）
//   - POST /internal/trade/resources/:resourceID/delete  ctl→trade 销毁链路用户主动入口（D-2）
//   - POST /internal/trade/resources/:resourceID/refund  ctl→trade 退款链路用户主动入口（trade-pass-refund-design.md v0.5）
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
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"git.woa.com/wisp/mono/trade/internal/jifeiclient"
	"git.woa.com/wisp/mono/trade/internal/logic/inquiry"
	"git.woa.com/wisp/mono/trade/internal/logic/orderstatus"
	"git.woa.com/wisp/mono/trade/internal/logic/placeorder"
	"git.woa.com/wisp/mono/trade/internal/region"
	"git.woa.com/wisp/mono/trade/internal/store"
)

// Deps 是内部 RPC handler 的依赖注入。
type Deps struct {
	// InternalServiceToken 与 ctl ↔ ai-gateway / shadow 共用的内部服务间互信 token。
	InternalServiceToken string

	// Inquiry 提供询价业务能力。
	Inquiry *inquiry.Service

	// PlaceOrder 提供下单 / pay-url 业务能力。
	PlaceOrder *placeorder.Service

	// FlowStore 提供 trade_flow 写端能力（Sub-4 ctl→trade callback 用）。
	//
	// 设计稿：.tmp/trade-pass-isolate-design.md §11 Q6=a + Q22=B3 修订版 + Q11 修订版
	// 用途：ctl 父 task `[isolating]→[isolated]` CAS 成功后通过 POST /internal/trade/flows/{flow_id}/complete
	//       回写 trade_flow.status=completed；行级幂等 UPDATE WHERE status='in_progress'。
	//
	// 允许 nil（向后兼容仅承载 8A 内部 RPC 的旧调用方）；nil 时 callback 路由不挂载。
	FlowStore store.FlowStore

	// BundleStore 提供 trade_bundle_definition 反查能力（D-2 销毁链路用户主动入口用）。
	//
	// 设计稿：.tmp/trade-pass-destroy-design.md §3.5 + §11-A Q26 ✅
	// 用途：DeleteResource handler 收到 ctl 入参后，按 BundleID 反查 BundleDefinition.ProductCode
	//       拼装 jifei.ModifyResourceStatus 协议字段（productCode 不在协议层固化，运行时取值）。
	//
	// 允许 nil（向后兼容仅承载 8A / Sub-4 的旧调用方）；nil 时 DeleteResource 路由不挂载。
	BundleStore store.BundleDefinitionStore

	// JifeiClient 提供 trade → jifei CGW 出向能力（D-2 销毁链路用户主动入口用）。
	//
	// 设计稿：.tmp/trade-pass-destroy-design.md §3.5 + §3.6 + PDF §1.1 ModifyResourceStatus
	// 用途：DeleteResource handler 反查 BundleDefinition 后调
	//       jifeiClient.ModifyResourceStatus(operateName=PRE_DESTROY) 通知 jifei 启动销毁。
	//
	// 允许 nil（向后兼容仅承载 8A / Sub-4 的旧调用方）；nil 时 DeleteResource 路由不挂载。
	JifeiClient jifeiclient.Client

	// OrderStatus 提供订单状态反查能力（v1.7.32 引入）。
	//
	// 设计稿：.tmp/ctl-order-status-query-design.md §5.4 + §5.2
	// 用途：handleQueryOrderStatus 处理 POST /internal/trade/orders/:dealName/query-status，
	//       包装 trade_order 反查 + B4 越权校验 + B1 终态短路 + jifei.getDealsByKeyIndex 反查 + B2 同步。
	//
	// 允许 nil（向后兼容 8A / Sub-4 / D-2 的旧调用方）；nil 时 query-status 路由不挂载。
	OrderStatus *orderstatus.Service

	// SiteKind（v1.7.x 国际站接入 A6.1 新增）：trade 内部部署站点语义字面量。
	//
	// 设计稿：.tmp/trade-international-site-design.md v1.1 §3.1 A6
	// 取值："cn" / "intl"；空 / 非法值由 region.Resolve 兜底为 cn。
	// 用途：DeleteResource handler 装配期解析为 region 三元组，与出向 jifei.ModifyResourceStatus
	//       的 envelope.resInfo.regionId 同源同值（cn=1 / intl=9）。
	SiteKind string

	// RegionOverride（北京 2 预发布接入 2026-06-12 新增）：腾讯云 region 字面量 override。
	// 由 LIGHTVELA_TRADE_REGION env 注入；非空且命中 region.regionTable 时优先于 SiteKind 兜底。
	// DeleteResource handler 装配期一同透传给 region.Resolve。
	RegionOverride string

	// DianshiAdminStore 提供点石订单和活动参与记录的后台管理能力。
	//
	// 用途：GET/DELETE /internal/trade/dianshi/*，供 ctl admin 后台查询/删除点石下单记录，
	// 以便运营清理 participation 或订单后重试点石下单。允许 nil；nil 时不挂载路由。
	DianshiAdminStore store.DianshiAdminStore
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
	group.POST("/inquiry/renew", inquiryRenewHandler(deps.Inquiry))
	group.POST("/orders", placeOrderHandler(deps.PlaceOrder))
	group.POST("/orders/place-and-pay", placeOrderAndPayHandler(deps.PlaceOrder))
	group.POST("/orders/renew", placeRenewOrderHandler(deps.PlaceOrder))
	group.POST("/orders/renew/place-and-pay", placeRenewOrderAndPayHandler(deps.PlaceOrder))
	group.POST("/orders/:dealName/pay-url", payURLHandler(deps.PlaceOrder))

	// Sub-4 ctl→trade callback：trade_flow.status 推进到 completed。
	// FlowStore == nil 时不挂载（向后兼容；生产路径 main.go 必注入）。
	if deps.FlowStore != nil {
		group.POST("/flows/:flowID/complete", flowCompleteHandler(deps.FlowStore))
	}

	// D-2 ctl→trade 销毁链路用户主动入口（设计稿 §3.5 + §11-A Q2/Q20/Q26）：
	//   POST /internal/trade/resources/:resourceID/delete
	// BundleStore + JifeiClient 任一 nil 时不挂载（生产路径 main.go 必注入；
	// 旧测试 / 仅承载 jifei 回调的调用方留 nil 兼容）。
	if deps.BundleStore != nil && deps.JifeiClient != nil {
		// v1.7.x A6.1 + 2026-06-12 北京 2 预发布接入：region 三元组在装配期解析一次
		// （RegionOverride 非空时优先，SiteKind 空/非法 → cn 兜底），然后传入
		// deleteResourceHandler 闭包；运行期不再重复调 region.Resolve。
		lhRegion := region.Resolve(deps.SiteKind, deps.RegionOverride)
		group.POST("/resources/:resourceID/delete",
			deleteResourceHandler(deps.JifeiClient, deps.BundleStore, lhRegion))

		// ctl→trade 退款链路用户主动入口（设计稿 .tmp/trade-pass-refund-design.md v0.5）：
		//   POST /internal/trade/resources/:resourceID/refund
		// 与 delete 共享 BundleStore + JifeiClient + region 装配；同生同灭。
		// Q8b=b 拍板：无状态翻译层，不写 trade_flow，jifei OnlineRefund 同步翻译给 ctl。
		group.POST("/resources/:resourceID/refund",
			refundResourceHandler(deps.JifeiClient, deps.BundleStore, lhRegion))
	}

	// v1.7.32 ctl→trade 订单状态反查（设计稿 .tmp/ctl-order-status-query-design.md §5.4）：
	//   POST /internal/trade/orders/:dealName/query-status
	// OrderStatus == nil 时不挂载（生产路径 main.go 必注入；老测试留 nil 兼容）。
	if deps.OrderStatus != nil {
		group.POST("/orders/:dealName/query-status", queryOrderStatusHandler(deps.OrderStatus))
	}

	if deps.DianshiAdminStore != nil {
		group.GET("/dianshi/orders", listDianshiRecordsHandler(deps.DianshiAdminStore))
		group.DELETE("/dianshi/orders/:dealName", deleteDianshiOrderHandler(deps.DianshiAdminStore))
		group.DELETE("/dianshi/participations/:id", deleteDianshiParticipationHandler(deps.DianshiAdminStore))
	}
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
//   - 当 trade 启动期注入了 ShadowClient（cfg.AccountBindingInternalBaseURL 非空），调用方可只传
//     ExternalUserID，trade 内部反查 account binding 自动回填 (Uin, AppID)
//   - 调用方仍可显式传 Uin / AppID（强同步语义，绕过 account binding 反查）
//   - ShadowClient 未注入时（8A 行为）：Uin 必填，否则 400
type inquiryBatchRequest struct {
	ExternalUserID string   `json:"externalUserId"`
	Uin            string   `json:"uin"`
	AppID          string   `json:"appId"`
	BundleIDs      []string `json:"bundleIds"`
	Period         int      `json:"period"`   // 时长数值（与 inquiry.QuoteRequest.TimeSpan 等价）
	TimeUnit       string   `json:"timeUnit"` // "m"/"y"
	GoodsNum       int      `json:"goodsNum"` // 本期固定 1（Q41）
	PayMode        int      `json:"payMode"`  // 0/1/2
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
				// Q41 修订 2026-05-11：RegionID 不再透传，trade 内部固定 1（广州）
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
// inquiry/renew (v1.7.21 B16, 续费询价)
// ============================================================================

// inquiryRenewRequest 是 POST /internal/trade/inquiry/renew 入参。
//
// 与 inquiryBatchRequest 关键差异（trade-pass-renew §3.5 / §4.3 / R-C-4）：
//   - 单 bundle 询价（续费场景下用户当前只关心自己的 pass.bundle_id），无 BundleIDs 数组
//   - 新增 ResourceID（必填）：续费目标 pass_id
//   - 新增 CurDeadline（必填，PDF §4.3 jifei goodsDetail.curDeadline 协议字段）：原资源到期时间，
//     由 ctl 调用方从 pass.expired_time 拼字符串透传
//   - 复用 ExternalUserID / Uin / AppID / BundleID / Period / TimeUnit / GoodsNum / PayMode 8 字段
//
// shadow 反查策略与 inquiryBatchRequest 一致：调用方可仅传 ExternalUserID，trade 内部反查回填。
type inquiryRenewRequest struct {
	ExternalUserID string `json:"externalUserId"`
	Uin            string `json:"uin"`
	AppID          string `json:"appId"`
	BundleID       string `json:"bundleId"`
	ResourceID     string `json:"resourceId"`
	CurDeadline    string `json:"curDeadline"` // PDF §4.3 续费必填; 格式 "2006-01-02 15:04:05"
	Period         int    `json:"period"`
	TimeUnit       string `json:"timeUnit"`
	GoodsNum       int    `json:"goodsNum"`
	PayMode        int    `json:"payMode"`
}

// inquiryRenewResponse 是 POST /internal/trade/inquiry/renew 出参。
//
// 形态与 inquiryBatchResponse 完全一致（QuoteResult 同型，沿用同一份 schema）；续费询价单条
// 结果直接放入 prices 数组，前端按数组首元素取即可，与 inquiryBatch happy path 兼容。
type inquiryRenewResponse struct {
	Prices []*inquiry.QuoteResult `json:"prices"`
}

// inquiryRenewHandler 处理续费询价（R-C-4）。
//
// 复用 classifyInquiryError 与新购询价共享同一组 sentinel 错误（ErrInvalidInput /
// ErrBundleNotFound / ErrBundleOffline / ErrBindingNotFound）。
func inquiryRenewHandler(svc *inquiry.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req inquiryRenewRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{
				"code":    "InvalidRequest",
				"message": "decode JSON: " + err.Error(),
			})
			return
		}
		r, err := svc.QuoteRenew(c.Request.Context(), inquiry.QuoteRenewRequest{
			ExternalUserID: req.ExternalUserID,
			Uin:            req.Uin,
			AppID:          req.AppID,
			BundleID:       req.BundleID,
			ResourceID:     req.ResourceID,
			CurDeadline:    req.CurDeadline,
			TimeSpan:       req.Period,
			TimeUnit:       req.TimeUnit,
			GoodsNum:       req.GoodsNum,
			PayMode:        req.PayMode,
		})
		if err != nil {
			code, status := classifyInquiryError(err)
			c.JSON(status, gin.H{
				"code":     code,
				"message":  err.Error(),
				"bundleId": req.BundleID,
			})
			return
		}
		c.JSON(http.StatusOK, inquiryRenewResponse{Prices: []*inquiry.QuoteResult{r}})
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
	// 注：Q41 修订 2026-05-11 删除 RegionID 字段。trade 内部固定 1（广州），ctl / 前端不再透传。
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
			// Q41 修订：RegionID 不再透传，trade 内部固定 1（广州）
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
// place order and pay (8B-1.5)
// ============================================================================

// placeOrderAndPayHandler 处理 "下单 + 自动支付" 一体化端点（迭代 8B-1.5）。
//
// 与 placeOrderHandler 的差异：
//   - placeOrderHandler 调 placeorder.PlaceOrder：仅创建订单，落库 status='pending_pay'，
//     调用方再走 /orders/:dealName/pay-url 拉支付 URL 引导用户在浏览器付款。
//   - placeOrderAndPayHandler 调 placeorder.PlaceOrderAndPay：调 jifei 一体化接口
//     `qcloud.Deal.generateDealsAndPay`，**一次调用**完成"创建订单 + 同步支付 + 触发 createResource
//     发货回调"，跳过支付 URL；落库 status='paid_pending_provision'。
//
// 入参 / 出参 schema 与 placeOrderHandler 完全一致（均为 placeOrderRequest / placeOrderResponse），
// 调用方可平滑切换；唯一行为差异是 PayURL/ExpireAt 永远不会返回（一体化接口跳过支付 URL 概念）。
//
// 使用场景（业务侧）：
//   - **联调测试 / 自动化 e2e**：测试代金券充足的环境用本端点让 trade ↔ jifei ↔ ctl.createResource
//     端到端跑通，不需要真人浏览器付款
//   - **降配场景**：jifei 协议规范要求降配必须用本接口，不能拆分成下单+支付两步（详见
//     placeorder.Service.PlaceOrderAndPay 注释）
//
// 错误码与 placeOrderHandler 共用 classifyPlaceOrderError，避免业务错误分类发散。
func placeOrderAndPayHandler(svc *placeorder.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req placeOrderRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{
				"code":    "InvalidRequest",
				"message": "decode JSON: " + err.Error(),
			})
			return
		}
		res, err := svc.PlaceOrderAndPay(c.Request.Context(), placeorder.PlaceOrderRequest{
			ExternalUserID: req.ExternalUserID,
			Uin:            req.Uin,
			AppID:          req.AppID,
			BundleID:       req.BundleID,
			Period:         req.Period,
			TimeUnit:       req.TimeUnit,
			GoodsNum:       req.GoodsNum,
			PayMode:        req.PayMode,
			// Q41 修订：RegionID 不再透传，trade 内部固定 1（广州）
		})
		if err != nil {
			code, status := classifyPlaceOrderError(err)
			c.JSON(status, gin.H{
				"code":    code,
				"message": err.Error(),
			})
			return
		}
		// PayURL/ExpireAt 一体化接口下永远为空（不再走支付 URL 流程）
		c.JSON(http.StatusOK, placeOrderResponse{
			DealName:   res.DealName,
			BigOrderID: res.BigOrderID,
		})
	}
}

// ============================================================================
// place renew order (R-C-7)
// ============================================================================

// placeRenewOrderRequest 是 POST /internal/trade/orders/renew 入参（与 trade-pass-renew-design §4.3 对齐）。
//
// 与 placeOrderRequest 的关键差异：
//   - 新增 ResourceID（必填）：续费目标 pass_id
//   - 新增 CurDeadline（必填，v1.7.20 B15）：jifei goodsDetail.curDeadline 透传，PDF §4.3 续费独有必填字段。
//     真源 = ctl pass.expired_time，由 ctl 调用方按 "2006-01-02 15:04:05" 格式拼字符串透传 (前端不感知)
//   - 复用 ExternalUserID / Uin / AppID / BundleID / Period / TimeUnit / GoodsNum / PayMode 8 字段
//
// shadow 反查策略与 placeOrderRequest 一致：调用方可仅传 ExternalUserID，trade 内部反查回填。
type placeRenewOrderRequest struct {
	ExternalUserID string `json:"externalUserId"`
	Uin            string `json:"uin"`
	AppID          string `json:"appId"`
	BundleID       string `json:"bundleId"`
	ResourceID     string `json:"resourceId"`
	CurDeadline    string `json:"curDeadline"` // PDF §4.3 续费必填; 格式 "2006-01-02 15:04:05" (与 jifei 协议字符串形态一致)
	Period         int    `json:"period"`
	TimeUnit       string `json:"timeUnit"`
	GoodsNum       int    `json:"goodsNum"`
	PayMode        int    `json:"payMode"`
}

// placeRenewOrderHandler 处理续费下单端点（R-C-7）。
//
// 与 placeOrderHandler 的对偶关系：
//   - placeOrderHandler 调 placeorder.PlaceOrder：新购 generateDeals，trade_order.order_type='create'
//   - placeRenewOrderHandler 调 placeorder.PlaceRenewOrder：续费 generateDeals，
//     trade_order.order_type='renew'，trade_order.resource_id=req.ResourceID（INSERT 时直接写入）
//
// 出参 schema 与 placeOrderResponse 完全一致（dealName/bigOrderId）；调用方可平滑共用 DTO。
//
// 错误码复用 classifyPlaceOrderError（PlaceRenewOrder 与 PlaceOrder 共用同一组 sentinel 错误：
// ErrInvalidInput / ErrBundleNotFound / ErrBundleOffline / ErrDealNameDuplicate /
// ErrJifeiResponseInvalid / ErrBindingNotFound）。
func placeRenewOrderHandler(svc *placeorder.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req placeRenewOrderRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{
				"code":    "InvalidRequest",
				"message": "decode JSON: " + err.Error(),
			})
			return
		}
		res, err := svc.PlaceRenewOrder(c.Request.Context(), placeorder.PlaceRenewOrderRequest{
			ExternalUserID: req.ExternalUserID,
			Uin:            req.Uin,
			AppID:          req.AppID,
			BundleID:       req.BundleID,
			ResourceID:     req.ResourceID,
			CurDeadline:    req.CurDeadline,
			Period:         req.Period,
			TimeUnit:       req.TimeUnit,
			GoodsNum:       req.GoodsNum,
			PayMode:        req.PayMode,
		})
		if err != nil {
			code, status := classifyPlaceOrderError(err)
			c.JSON(status, gin.H{
				"code":    code,
				"message": err.Error(),
			})
			return
		}
		// 续费走两步流程，与 placeOrderHandler 一致：本端点只创建订单，PayURL/ExpireAt 留空，
		// 调用方再走 /orders/:dealName/pay-url 拉支付 URL。
		c.JSON(http.StatusOK, placeOrderResponse{
			DealName:   res.DealName,
			BigOrderID: res.BigOrderID,
			PayURL:     res.PayURL,
			ExpireAt:   res.ExpireAt,
		})
	}
}

// placeRenewOrderAndPayHandler 处理续费下单+支付一体化端点（R-D-7，测试链路用）。
//
// 与 placeRenewOrderHandler 的对偶关系（与 placeOrderAndPayHandler vs placeOrderHandler 同范式）：
//   - placeRenewOrderHandler        → svc.PlaceRenewOrder        → jifei generateDeals （续费两步式）
//   - placeRenewOrderAndPayHandler  → svc.PlaceRenewOrderAndPay  → jifei generateDealsAndPay
//     **一次调用** 完成"创建续费订单 + 同步支付 + 触发 checkRenew/renewResource 回调"，跳过支付 URL
//
// 入参 schema 与 placeRenewOrderHandler 完全一致（placeRenewOrderRequest，9 字段含 ResourceID 必填）；
// 出参与 placeOrderAndPayHandler 一致（dealName/bigOrderId；PayURL/ExpireAt 永远为空 — 一体化跳过支付 URL）。
//
// 错误码与 placeOrderHandler / placeRenewOrderHandler 共用 classifyPlaceOrderError，
// 续费一体化与单步续费共用同一组 sentinel 错误（PlaceRenewOrderAndPay 沿用 PlaceRenewOrder 的
// validatePlaceRenewOrderRequest 校验集）。
func placeRenewOrderAndPayHandler(svc *placeorder.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req placeRenewOrderRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{
				"code":    "InvalidRequest",
				"message": "decode JSON: " + err.Error(),
			})
			return
		}
		res, err := svc.PlaceRenewOrderAndPay(c.Request.Context(), placeorder.PlaceRenewOrderRequest{
			ExternalUserID: req.ExternalUserID,
			Uin:            req.Uin,
			AppID:          req.AppID,
			BundleID:       req.BundleID,
			ResourceID:     req.ResourceID,
			CurDeadline:    req.CurDeadline,
			Period:         req.Period,
			TimeUnit:       req.TimeUnit,
			GoodsNum:       req.GoodsNum,
			PayMode:        req.PayMode,
		})
		if err != nil {
			code, status := classifyPlaceOrderError(err)
			c.JSON(status, gin.H{
				"code":    code,
				"message": err.Error(),
			})
			return
		}
		// 一体化接口下永远不返 PayURL（与 placeOrderAndPayHandler 一致）
		c.JSON(http.StatusOK, placeOrderResponse{
			DealName:   res.DealName,
			BigOrderID: res.BigOrderID,
		})
	}
}

// ============================================================================
// pay url
// ============================================================================

// payURLResponse 与设计稿 §4.2.2 出参对齐；v1.7.30（2026-05-23）扩展 5 个字段，
// 透传给 ctl 后再透前端，便于前端用 Midas SDK 跳转 + 展示米大师订单号。
//
// 字段语义：
//   - PayURL：jifei 返回的 Midas 收银台 URL（前端跳转用）
//   - ExpireAt：保留位（jifei 当前未返过期时间，Lightclaw 不依赖）
//   - TokenID / OrderID / MidasAppID：jifei 协议外字段（PDF 未列、实测稳定返）；
//     **指针类型 + omitempty**：jifei 未返时 JSON 序列化为缺字段，前端兜底处理（D3）
//   - NeedCharge：1 = 需跳支付 / 0 = 已扣完无需支付
//   - Uin / AppID：来自 trade_order，用户腾讯云 uin / appId（**不是米大师商户 appid**）
type payURLResponse struct {
	PayURL     string  `json:"payUrl"`
	ExpireAt   string  `json:"expireAt,omitempty"`
	TokenID    *string `json:"tokenId,omitempty"`
	OrderID    *string `json:"orderId,omitempty"`
	MidasAppID *string `json:"midasAppId,omitempty"`
	NeedCharge int     `json:"needCharge"`
	Uin        string  `json:"uin,omitempty"`
	AppID      string  `json:"appId,omitempty"`
}

func payURLHandler(svc *placeorder.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		dealName := c.Param("dealName")

		// v1.7.31 接口拆分：解析可选 body（body 为空 / nil 时兼容现有行为）
		var opts *placeorder.GeneratePayURLOptions
		var body struct {
			Platform string `json:"platform"`
			WxOpenID string `json:"wx_open_id"`
			WxAppID  string `json:"wx_app_id"`
		}
		// 尝试解析 body；忽略 EOF / 空 body 错误（兼容无 body 调用）
		if err := c.ShouldBindJSON(&body); err == nil {
			if body.Platform != "" || body.WxOpenID != "" || body.WxAppID != "" {
				opts = &placeorder.GeneratePayURLOptions{
					Platform: body.Platform,
					WxOpenID: body.WxOpenID,
					WxAppID:  body.WxAppID,
				}
			}
		}

		detail, err := svc.GeneratePayURL(c.Request.Context(), dealName, opts)
		if err != nil {
			code, status := classifyPayURLError(err)
			c.JSON(status, gin.H{
				"code":    code,
				"message": err.Error(),
			})
			return
		}
		c.JSON(http.StatusOK, payURLResponse{
			PayURL:     detail.PayURL,
			TokenID:    detail.TokenID,
			OrderID:    detail.OrderID,
			MidasAppID: detail.MidasAppID,
			NeedCharge: detail.NeedCharge,
			Uin:        detail.Uin,
			AppID:      detail.AppID,
		})
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

// ============================================================================
// flow complete (Sub-4 ctl→trade callback)
// ============================================================================

// flowCompleteRequest 是 POST /internal/trade/flows/:flowID/complete 入参。
//
// 设计稿：.tmp/trade-pass-isolate-design.md §3.5 + §11 Q6=a + Q22=B3 修订版 + Q11 修订版
//   - R-MR-5 续费失败回滚扩展（2026-05-24 用户拍板，trade-pass-renew-design.md §3.4 失败语义升级）
//
// 字段：
//   - Result：取值 {"completed", "failed"}（缺省 / 空值视为 "completed" 兼容旧 ctl 调用方）。
//     R-MR-5 之前 ctl 父 task 永不放弃只会传 "completed"；R-MR-5 起 renewPassTask
//     max=5 失败后会派发 RollbackRenewPassTask，回滚收尾时本 callback 传 "failed"
//     触发 jifei 退款链路（trade_flow.status='failed' → 计费查询时 jifei 自动退款）。
//   - Message：可选排障 / 审计文本，落 trade_flow.response_body
type flowCompleteRequest struct {
	Result  string `json:"result"`
	Message string `json:"message,omitempty"`
}

// flowCompleteResponse 是该端点的统一出参（与设计稿 §3.5 表 `{ack: true}` 对齐）。
type flowCompleteResponse struct {
	Ack bool `json:"ack"`
}

// flowCompleteHandler 处理 ctl 父 task 完成后回写 trade_flow.status 的 callback。
//
// 行为：
//   - 鉴权：复用 group 级 Bearer token middleware（与询价 / 下单同源）
//   - 入参：path param flowID（= trade_flow.id PK；BIGINT），body 含 result/message
//   - 根据 req.Result 分发（R-MR-5 2026-05-24 升级）：
//     · "failed"            → MarkFailedByID（trade_flow.status=failed → 计费查询触发 jifei 退款）
//     · 缺省 / "completed" → MarkCompletedByID（向后兼容旧 ctl 调用方语义不变）
//     · 其它字面量 		 → 同 "completed"（不在白名单的字符串保守按 completed 走，避免误退款）
//   - 行级幂等：MarkCompletedByID/MarkFailedByID 内部 SQL `UPDATE ... WHERE id=? AND status='in_progress'` —
//     已被 reconcile worker / 重复 callback 推进过的行不会被覆盖（status 已是 completed/failed 时 RowsAffected=0，不返错）
//   - 出参：200 {ack: true}
//
// 错误响应：
//   - 400 InvalidRequest：flowID 非数字 / body decode 失败
//   - 502 UpstreamError：DB 写失败
func flowCompleteHandler(flowStore store.FlowStore) gin.HandlerFunc {
	return func(c *gin.Context) {
		flowIDStr := c.Param("flowID")
		flowID, err := strconv.ParseInt(flowIDStr, 10, 64)
		if err != nil || flowID <= 0 {
			c.JSON(http.StatusBadRequest, gin.H{
				"code":    "InvalidRequest",
				"message": "flowID must be positive integer: " + flowIDStr,
			})
			return
		}

		// body 允许为空（Result 可缺省）— 默认按 completed 处理。
		var req flowCompleteRequest
		if c.Request.ContentLength > 0 {
			if err := c.ShouldBindJSON(&req); err != nil {
				c.JSON(http.StatusBadRequest, gin.H{
					"code":    "InvalidRequest",
					"message": "decode JSON: " + err.Error(),
				})
				return
			}
		}

		// 序列化 body 落 trade_flow.response_body 便于排障（含 result + message）。
		respBody := buildResponseBody(&req)

		// R-MR-5 升级：根据 result 分发。仅当显式 "failed" 时走失败链路（→ jifei 退款）；
		// 其它情况（缺省 / "completed" / 未知字面量）保守按 completed 处理，避免误触发退款。
		if req.Result == "failed" {
			if err := flowStore.MarkFailedByID(c.Request.Context(), flowID, respBody); err != nil {
				c.JSON(http.StatusBadGateway, gin.H{
					"code":    "UpstreamError",
					"message": "mark trade_flow failed: " + err.Error(),
				})
				return
			}
		} else {
			if err := flowStore.MarkCompletedByID(c.Request.Context(), flowID, respBody); err != nil {
				c.JSON(http.StatusBadGateway, gin.H{
					"code":    "UpstreamError",
					"message": "mark trade_flow completed: " + err.Error(),
				})
				return
			}
		}

		c.JSON(http.StatusOK, flowCompleteResponse{Ack: true})
	}
}

// buildResponseBody 把 callback 入参序列化为 trade_flow.response_body 落库内容。
//
// 当前最简实现：直接 JSON-marshal flowCompleteRequest（result/message 两字段）；
// MarkCompletedByID 实现内部对 nil/空 byte slice 容忍。
func buildResponseBody(req *flowCompleteRequest) []byte {
	if req == nil {
		return nil
	}
	body, err := json.Marshal(req)
	if err != nil {
		return nil
	}
	return body
}

// ============================================================================
// delete resource (D-2 销毁链路用户主动入口)
// ============================================================================

// deleteResourceRequest 是 POST /internal/trade/resources/:resourceID/delete 入参。
//
// 设计稿对齐：.tmp/trade-pass-destroy-design.md §3.5 入口 A trade.DeleteResource +
// §11-A Q26 ✅（productCode 运行时反查 BundleDefinition）+ Q27 ✅（subProductCode 运行时反查
// BundleDefinition，与 ProductCode 同源）+ Q41 修订（trade 内部固定 region=1，ctl/前端不再透传 region）。
//
// 字段（与 placeOrder/inquiry 链路一致的 3 字段最小集）：
//   - UIN：pass.uin（必填，jifei.ModifyResourceStatus.uin）
//   - AppID：pass.app_id（int64，必填，jifei.ModifyResourceStatus.appId）
//   - BundleID：pass.bundle_id（必填，trade 内部反查 BundleDefinition.ProductCode + .SubProductCode）
//
// 注：
//   - Q27 修订（2026-05-17）：原本规划让 ctl 透传 SubProductCode，但 ctl bundle 表不持有
//     sub_product_code（Q25/Q33/Q37：归 trade 库 trade_bundle_definition，ctl 完全不感知）。
//     与 ProductCode 同源解决方案：trade 在反查 BundleDefinition 取 ProductCode 的同一次调用里
//     一并取 SubProductCode，不让 ctl 透传。
//   - Q41 修订一致性 — Region 字段不入参，trade 内部固定 region.LighthouseRegionID=1（广州）。
type deleteResourceRequest struct {
	UIN      string `json:"uin"`
	AppID    int64  `json:"appId"`
	BundleID string `json:"bundleId"`
}

// deleteResourceResponse 是 POST /internal/trade/resources/:resourceID/delete 出参。
//
// 设计稿 §3.5 出参：返 ReferenceID 给 ctl（透传给前端便于审计）。
type deleteResourceResponse struct {
	ReferenceID string `json:"referenceId"`
}

// deleteResourceHandler 处理 ctl→trade 销毁链路用户主动入口。
//
// 设计稿：.tmp/trade-pass-destroy-design.md §3.5 入口 A + §11-A Q2/Q20/Q26
//
// 行为：
//   - 入参：path param resourceID（= passID）+ body UIN/AppID/BundleID/SubProductCode
//   - 反查 BundleStore.GetBundleDefinitionByID(req.BundleID) 取 ProductCode（Q26）
//   - 拼装 jifeiclient.ModifyResourceStatusRequest（OperateName=PRE_DESTROY）
//   - ReferenceID 格式 = `<resourceID>_<UnixNano>`（Q20 ✅ 方案 C：纳秒精度防重 + 长度收敛）
//   - 调 JifeiClient.ModifyResourceStatus → 成功 200 + 返 ReferenceID；失败按错误类型分类
//
// 不做的事情（设计稿 §3.5 末尾 "为什么不在 trade 端抢占 trade_flow slot"）：
//   - 不抢占 trade_flow slot — 该阶段属"用户表达销毁意愿、还没经过 jifei 确认"的前置阶段，
//     不应消耗 destroy_resource slot；slot 在 destroyResource 入向 handler 抢占（D-1 已落地）
//   - 不维护 pass 状态 — 状态由 ctl.DeletePass 入口的 CAS isolated→deleting 负责
//
// 错误响应：
//   - 400 InvalidRequest：body decode / 必填字段校验失败
//   - 404 BundleDefinitionNotFound：req.BundleID 在 trade_bundle_definition 不存在
//   - 502 UpstreamBusinessError：jifei CGW 业务错（returnCode != 0）
//   - 502 UpstreamHTTPError：jifei CGW HTTP 非 2xx / 网络错
//   - 502 UpstreamInvalidResponse：jifei CGW 响应 envelope 解码失败
//   - 500 InternalError：其他基础设施错（DB / 反序列化等）
func deleteResourceHandler(
	jifeiClient jifeiclient.Client,
	bundleStore store.BundleDefinitionStore,
	lighthouseRegion region.LighthouseRegion,
) gin.HandlerFunc {
	return func(c *gin.Context) {
		resourceID := strings.TrimSpace(c.Param("resourceID"))
		if resourceID == "" {
			c.JSON(http.StatusBadRequest, gin.H{
				"code":    "InvalidRequest",
				"message": "resourceID path param is required",
			})
			return
		}

		var req deleteResourceRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{
				"code":    "InvalidRequest",
				"message": "decode JSON: " + err.Error(),
			})
			return
		}
		if msg := validateDeleteResourceRequest(&req); msg != "" {
			c.JSON(http.StatusBadRequest, gin.H{
				"code":    "InvalidRequest",
				"message": msg,
			})
			return
		}

		// Q26 ✅：productCode 运行时按 BundleID 反查（与 placeorder/inquiry/resourcequery 链路一致）。
		bundleDef, err := bundleStore.GetBundleDefinitionByID(c.Request.Context(), req.BundleID)
		if err != nil {
			if errors.Is(err, store.ErrBundleDefinitionNotFound) {
				c.JSON(http.StatusNotFound, gin.H{
					"code":    "BundleDefinitionNotFound",
					"message": "bundle definition not found: " + req.BundleID,
				})
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{
				"code":    "InternalError",
				"message": "lookup bundle definition: " + err.Error(),
			})
			return
		}

		// Q20 ✅ 方案 C：ReferenceID = `<resourceID>_<UnixNano>`，纳秒精度防重 + 长度收敛
		// （resourceID 通常 ~30 字符 + "_" + 19 字符纳秒戳 ≈ 50 字符，远低于常见 VARCHAR 64/128 限制）。
		referenceID := fmt.Sprintf("%s_%d", resourceID, time.Now().UnixNano())

		jifeiReq := &jifeiclient.ModifyResourceStatusRequest{
			ClientType:   jifeiclient.ClientTypeProduct, // 4 = 产品方
			SubmitByUser: jifeiclient.SubmitByUserYes,   // 1 = 用户主动
			ReferenceID:  referenceID,
			ProductCode:  bundleDef.ProductCode, // Q26 ✅ 运行时反查取值
			// v1.7.29 修复：OwnerUIN 中转到 envelope.interface.extraPara.ownerUin
			// （PDF 资源中心 §1.1 协议要求；与 para.uin 同值，主账号即 owner — 与 jifei
			// adapter OwnerUin/Uin 双字段语义一致）。jifei 网关侧硬校验 extraPara.ownerUin
			// 非空，缺则返 returnCode=100000 "param error,need ownerUin or site"。
			OwnerUIN: req.UIN,
			UIN:      req.UIN,
			// v1.7.30 修复：SubAccountUIN 实测必填（jifei 资源中心网关返
			// returnCode=100000 "call resource-center error:invalid param: subAccountUin
			// must not be null"），与 PDF §1.1 协议描述"可选，不传则等同 uin"不一致，
			// 是 jifei 协议文档与实际网关行为的偏差。本期销毁链路是用户主动入口
			// （SubmitByUser=1），操作者 == 资源所有者，故填与 UIN 同值；未来如果接入
			// 子账号 / 协作者主动销毁场景，需要从上游 (ctl) 传入真实操作者 uin。
			SubAccountUIN: req.UIN,
			AppID:         req.AppID,
			// v1.7.x 国际站接入 A6.1：region 按 deps.SiteKind 在装配期解析（cn=1 / intl=9），
			// 与 placeorder / inquiry / resourcequery 出向同源同值。
			RegionID: lighthouseRegion.RegionID,
			PayMode:  jifeiclient.PayModePrepaid, // 1 = 预付费
			ResourcesParamSet: []jifeiclient.ModifyResourceStatusItem{
				{
					SubProductCode: bundleDef.SubProductCode, // Q27 ✅ 运行时反查取值（与 ProductCode 同源）
					ResourceIDs:    []string{resourceID},
				},
			},
			OperateName: jifeiclient.OperateNamePreDestroy, // PRE_DESTROY
		}

		if _, err := jifeiClient.ModifyResourceStatus(c.Request.Context(), jifeiReq); err != nil {
			code, status := classifyDeleteResourceError(err)
			c.JSON(status, gin.H{
				"code":        code,
				"message":     err.Error(),
				"referenceId": referenceID, // 透传便于排障
			})
			return
		}

		c.JSON(http.StatusOK, deleteResourceResponse{ReferenceID: referenceID})
	}
}

// validateDeleteResourceRequest 校验 deleteResourceRequest 必填字段。
//
// 返回空 string 表示校验通过；非空 string 是 4xx 错误描述。
func validateDeleteResourceRequest(req *deleteResourceRequest) string {
	if strings.TrimSpace(req.UIN) == "" {
		return "uin is required"
	}
	if req.AppID <= 0 {
		return "appId must be positive"
	}
	if strings.TrimSpace(req.BundleID) == "" {
		return "bundleId is required"
	}
	return ""
}

// classifyDeleteResourceError 把 ModifyResourceStatus 调用错误映射为 (errorCode, httpStatus)。
//
// 错误模型对齐 jifeiclient.Q68：
//   - *CGWError（业务错 returnCode != 0）→ 502 UpstreamBusinessError
//   - ErrCGWHTTPNon200（HTTP 非 2xx / 网络错）→ 502 UpstreamHTTPError
//   - ErrCGWInvalidEnvelope（响应 envelope 解码失败）→ 502 UpstreamInvalidResponse
//   - 其他 → 500 InternalError
func classifyDeleteResourceError(err error) (string, int) {
	var cgwErr *jifeiclient.CGWError
	if errors.As(err, &cgwErr) {
		return "UpstreamBusinessError", http.StatusBadGateway
	}
	switch {
	case errors.Is(err, jifeiclient.ErrCGWHTTPNon200):
		return "UpstreamHTTPError", http.StatusBadGateway
	case errors.Is(err, jifeiclient.ErrCGWInvalidEnvelope):
		return "UpstreamInvalidResponse", http.StatusBadGateway
	default:
		return "InternalError", http.StatusInternalServerError
	}
}

// ============================================================================
// refund resource (ctl→trade 退款链路用户主动入口；设计稿 .tmp/trade-pass-refund-design.md v0.5)
// ============================================================================

// refundResourceRequest 是 POST /internal/trade/resources/:resourceID/refund 入参。
//
// 设计稿对齐：.tmp/trade-pass-refund-design.md v0.5 §4 + §11 拍板项汇总：
//   - Q3=a 单条退款（resourceIdList 固定长度 1）
//   - Q5=a OnlineRefund 不传 category_ids / goodsCategoryId
//   - Q8b=b trade 端无状态翻译层，不写 trade_flow 行
//
// 字段（与 deleteResource 同款的最小集 + v0.7 加回 OwnerUin）：
//   - OwnerUin：pass.uin（必填，jifei.OnlineRefund.ownerUin，para 内平铺）
//   - UIN：pass.uin（必填，jifei.OnlineRefund.uin）
//   - AppID：pass.app_id（int64，必填，jifei.OnlineRefund.appId）
//   - BundleID：pass.bundle_id（必填，trade 内部反查 BundleDefinition.SubProductCode）
//
// **路由演进史（v0.5.1 → v0.6 → v0.7）**：
//   - v0.5.1：OwnerUin 错放到 envelope.interface.extraPara（销毁链路 ModifyResourceStatus
//     资源中心专有路径），路由错到 resource-center 入口被 jifei 网关拒
//   - v0.6（2026-06-23）：路由切到 jifei-test CGW 非签名链路（与 generateDeals 同入口），
//     但**过度纠正**地把 OwnerUin 字段整体删除。pass-fg77bhed e2e 实测 jifei 返
//     returnCode=100001 "invalid ownerUin" — Deal 接口族在 jifei-test 入口仍要求 ownerUin。
//   - **v0.7（2026-06-24，本次修订）**：协议是唯一真源 — 仓库内 generateDeals.go:37 /
//     generateDealsAndPay.go:31 / getPrice.go:66 / getmidasearmarking.go:33 都明示
//     `OwnerUin string json:"ownerUin"` para 内平铺；OnlineRefund 同属 qcloud.Deal.* 必须遵循
//     同款范式。本字段加回 refundResourceRequest，由 ctl 端从 pass.uin 透传（ctl pass 表
//     单 uin 模型，OwnerUin == UIN）。
type refundResourceRequest struct {
	OwnerUin string `json:"ownerUin"`
	UIN      string `json:"uin"`
	AppID    int64  `json:"appId"`
	BundleID string `json:"bundleId"`
}

// refundResourceResponse 是 POST /internal/trade/resources/:resourceID/refund 出参。
//
// 设计稿 §3 / §4 出参：trade 透传 jifei OnlineRefund 同步返的 dealNames[0] / bigDealIds[0]
// 给 ctl，ctl 再透传给前端 / 客服面板用于审计追账。本期 Q3=a 单条退款，dealNames /
// bigDealIds 数组长度固定为 1，取第一个元素即可。
type refundResourceResponse struct {
	DealName  string `json:"dealName"`
	BigDealID string `json:"bigDealId"`
}

// refundResourceHandler 处理 ctl→trade 退款链路用户主动入口。
//
// 设计稿：.tmp/trade-pass-refund-design.md v0.5 §3 + §4 + §11 全部拍板项
//
// 行为（**无状态翻译层**，Q8b=b 拍板）：
//   - 入参：path param resourceID（= passID）+ body UIN/AppID/BundleID
//   - 反查 BundleStore.GetBundleDefinitionByID(req.BundleID) 取 SubProductCode（doc §4.1）
//   - 拼装 jifeiclient.OnlineRefundRequest（GoodsInfo 是以 SubProductCode 作 map key）
//   - 调 JifeiClient.OnlineRefund（同步接口） → 成功 200 + 返 dealName/bigDealId；失败按错误类型分类
//
// 不做的事情（**Q8b=b 拍板核心**）：
//   - 不抢占 trade_flow slot — jifei OnlineRefund 是同步接口，业务成功 / 失败都立即返响应
//     （不存在"中间 in_progress"中态需要持久化），并发抑制完全交由 jifei 协议层 + 后续
//     jifei 异步回 isolateResource 的退费分支 v1.7.30 BUG-35 抢占式幂等兜底
//     （`flow_type='isolate_resource' + dealName=<本次 jifei 返回的单号>`）
//   - 不维护 pass 状态 — 状态由 jifei 异步回 isolateResource 后通过 IsolatePass 路径推进
//     （active → isolating → isolated + 写 expired_time = newDeadline）
//   - 不写 trade_order / trade_flow / 其他 DB 行
//
// 错误响应：
//   - 400 InvalidRequest：body decode / 必填字段校验失败
//   - 404 BundleDefinitionNotFound：req.BundleID 在 trade_bundle_definition 不存在
//   - 502 UpstreamBusinessError：jifei CGW 业务错（returnCode != 0；包括 101103 订单未发货、
//     allowReturn!=1 业务侧拒退、pid not found 价格表缺失等）
//   - 502 UpstreamHTTPError：jifei CGW HTTP 非 2xx / 网络错
//   - 502 UpstreamInvalidResponse：jifei CGW 响应 envelope 解码失败
//   - 500 InternalError：其他基础设施错（DB / 反序列化等）
func refundResourceHandler(
	jifeiClient jifeiclient.Client,
	bundleStore store.BundleDefinitionStore,
	lighthouseRegion region.LighthouseRegion,
) gin.HandlerFunc {
	return func(c *gin.Context) {
		resourceID := strings.TrimSpace(c.Param("resourceID"))
		if resourceID == "" {
			c.JSON(http.StatusBadRequest, gin.H{
				"code":    "InvalidRequest",
				"message": "resourceID path param is required",
			})
			return
		}

		var req refundResourceRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{
				"code":    "InvalidRequest",
				"message": "decode JSON: " + err.Error(),
			})
			return
		}
		if msg := validateRefundResourceRequest(&req); msg != "" {
			c.JSON(http.StatusBadRequest, gin.H{
				"code":    "InvalidRequest",
				"message": msg,
			})
			return
		}

		// 反查 BundleDefinition 取 SubProductCode（jifei OnlineRefund.goodsInfo 的 map key）。
		// 与 deleteResource / placeorder / inquiry / resourcequery 链路同款的 SubProductCode 取值路径。
		bundleDef, err := bundleStore.GetBundleDefinitionByID(c.Request.Context(), req.BundleID)
		if err != nil {
			if errors.Is(err, store.ErrBundleDefinitionNotFound) {
				c.JSON(http.StatusNotFound, gin.H{
					"code":    "BundleDefinitionNotFound",
					"message": "bundle definition not found: " + req.BundleID,
				})
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{
				"code":    "InternalError",
				"message": "lookup bundle definition: " + err.Error(),
			})
			return
		}

		// 拼装 jifei OnlineRefund 入参（doc §4.1）。
		// goodsInfo 是以 sub_product_code 作 map key 的动态对象（与 ModifyResourceStatus
		// 的 resourcesParamSet[] 数组形态有本质区别，详见 jifeiclient/onlinerefund.go 注释）。
		// **v0.7 修订 2026-06-24**：para 内平铺 OwnerUin（与 generateDeals 同款 Deal 接口族范式，
		// 撤回 v0.6 误删；jifei-test 入口对 Deal 接口族 ownerUin 仍做硬校验，缺则返
		// returnCode=100001 "invalid ownerUin"）。详见 jifeiclient/onlinerefund.go 头部 v0.7 注释。
		jifeiReq := &jifeiclient.OnlineRefundRequest{
			OwnerUin:    req.OwnerUin,
			UIN:         req.UIN,
			AppID:       req.AppID,
			FromConsole: jifeiclient.FromConsoleYes, // 1 = 控制台（ctl admin 入口固定）
			GoodsInfo: map[string]jifeiclient.OnlineRefundGoodsEntry{
				bundleDef.SubProductCode: {
					PayMode:        jifeiclient.PayModePrepaid, // 1 = 预付费
					RegionID:       lighthouseRegion.RegionID,  // 同 deleteResource 装配期解析
					ResourceIDList: []string{resourceID},       // Q3=a 单条退款 → 数组长度 1
				},
			},
		}

		resp, err := jifeiClient.OnlineRefund(c.Request.Context(), jifeiReq)
		if err != nil {
			code, status := classifyRefundResourceError(err)
			c.JSON(status, gin.H{
				"code":    code,
				"message": err.Error(),
			})
			return
		}

		// jifei 同步返成功：透传 dealNames[0] / bigDealIds[0] 给 ctl。
		// 防御性校验：协议正本 doc §5 / §6.1 明确返 dealNames + bigDealIds 数组，
		// 长度为 1（本期 Q3=a 单条退款）。若 jifei 返空数组属上游协议违约，按 502 透出。
		if len(resp.DealNames) == 0 || len(resp.BigDealIDs) == 0 {
			c.JSON(http.StatusBadGateway, gin.H{
				"code": "UpstreamInvalidResponse",
				"message": fmt.Sprintf(
					"jifei returnCode=0 but dealNames/bigDealIds is empty: dealNames=%v bigDealIds=%v",
					resp.DealNames, resp.BigDealIDs),
			})
			return
		}

		c.JSON(http.StatusOK, refundResourceResponse{
			DealName:  resp.DealNames[0],
			BigDealID: resp.BigDealIDs[0],
		})
	}
}

// validateRefundResourceRequest 校验 refundResourceRequest 必填字段（与 deleteResource 同款）。
//
// 返回空 string 表示校验通过；非空 string 是 4xx 错误描述。
//
// **v0.7 修订 2026-06-24**：加回 ownerUin 必填校验（v0.6 路由切换误删；与 generateDeals
// 同款 Deal 接口族范式，jifei-test 入口对 ownerUin 做硬校验）。
func validateRefundResourceRequest(req *refundResourceRequest) string {
	if strings.TrimSpace(req.OwnerUin) == "" {
		return "ownerUin is required"
	}
	if strings.TrimSpace(req.UIN) == "" {
		return "uin is required"
	}
	if req.AppID <= 0 {
		return "appId must be positive"
	}
	if strings.TrimSpace(req.BundleID) == "" {
		return "bundleId is required"
	}
	return ""
}

// classifyRefundResourceError 把 OnlineRefund 调用错误映射为 (errorCode, httpStatus)。
//
// 错误模型对齐 jifeiclient 现有 Q68 + deleteResource handler 同款分类：
//   - *CGWError（业务错 returnCode != 0）→ 502 UpstreamBusinessError
//     （含 101103 订单未发货 / allowReturn!=1 业务侧拒退 / pid not found 等所有 jifei 业务码）
//   - ErrCGWHTTPNon200（HTTP 非 2xx / 网络错）→ 502 UpstreamHTTPError
//   - ErrCGWInvalidEnvelope（响应 envelope 解码失败）→ 502 UpstreamInvalidResponse
//   - 其他 → 500 InternalError
//
// 注：本期 trade 不为 jifei 业务码做细粒度路由（设计稿 §6 错误处理表对齐）；
// ctl admin 调用方按 message 文本 / 后台运维判断"是否值得重试"。未来如需把
// 101103 单独提示用户"订单刚下完未发货完成"等，可在 ctl 层做映射。
func classifyRefundResourceError(err error) (string, int) {
	var cgwErr *jifeiclient.CGWError
	if errors.As(err, &cgwErr) {
		return "UpstreamBusinessError", http.StatusBadGateway
	}
	switch {
	case errors.Is(err, jifeiclient.ErrCGWHTTPNon200):
		return "UpstreamHTTPError", http.StatusBadGateway
	case errors.Is(err, jifeiclient.ErrCGWInvalidEnvelope):
		return "UpstreamInvalidResponse", http.StatusBadGateway
	default:
		return "InternalError", http.StatusInternalServerError
	}
}
