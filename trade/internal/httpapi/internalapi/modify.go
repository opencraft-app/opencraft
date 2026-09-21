package internalapi

import (
	"context"
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"

	"git.woa.com/wisp/mono/trade/internal/logic/inquiry"
	"git.woa.com/wisp/mono/trade/internal/logic/placeorder"
)

// 同 SP 变配（升配）的内部 RPC。需求：TAPD 1010132091137784162 §5.1 / §7.1
//
// 三个端点，调用方都是 CTL 的用户面 pass 变配入口：
//   - POST /internal/trade/inquiry/modify              升配询价（差价）
//   - POST /internal/trade/orders/modify               升配下单（两步式，生产链路）
//   - POST /internal/trade/orders/modify/place-and-pay 下单+代扣一体化（联调 / e2e）
//
// 入参都带 (resourceId, sourceBundleId, targetBundleId, curDeadline) 四件套：
// 变配是"把某个 pass 从 A 换成 B"，少任何一个都无法确定这笔账。
// 不带 period / timeUnit / goodsNum：变配不改到期时间，goodsNum 协议固定 1。

// modifyRequest 是三个变配端点共用的入参。
//
// 三个端点共用一个 DTO 是刻意的：询价和下单必须基于**同一组**入参，
// 否则用户在确认页看到的差价和实际扣款可以不一致。
type modifyRequest struct {
	ExternalUserID string `json:"externalUserId"`
	Uin            string `json:"uin"`
	AppID          string `json:"appId"`
	ResourceID     string `json:"resourceId"`
	SourceBundleID string `json:"sourceBundleId"`
	TargetBundleID string `json:"targetBundleId"`
	// CurDeadline 是 pass.expired_time 的 jifei 字面值（"2006-01-02 15:04:05"，CST）。
	// 真源在 CTL，由调用方拼好透传；trade 不解析业务语义，只做非空校验和原样传给 jifei。
	CurDeadline string `json:"curDeadline"`
	PayMode     int    `json:"payMode"`
}

// inquiryModifyResponse 与 inquiryRenewResponse 同形：数组承载，为将来一次询多个
// 升配目标留出形状，当前恒长度 1。
type inquiryModifyResponse struct {
	Prices []*inquiry.QuoteResult `json:"prices"`
}

func inquiryModifyHandler(svc *inquiry.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req modifyRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{
				"code":    "InvalidRequest",
				"message": "decode JSON: " + err.Error(),
			})
			return
		}
		r, err := svc.QuoteModify(c.Request.Context(), inquiry.QuoteModifyRequest{
			ExternalUserID: req.ExternalUserID,
			Uin:            req.Uin,
			AppID:          req.AppID,
			ResourceID:     req.ResourceID,
			SourceBundleID: req.SourceBundleID,
			TargetBundleID: req.TargetBundleID,
			CurDeadline:    req.CurDeadline,
			PayMode:        req.PayMode,
		})
		if err != nil {
			code, status := classifyModifyInquiryError(err)
			c.JSON(status, gin.H{
				"code":           code,
				"message":        err.Error(),
				"targetBundleId": req.TargetBundleID,
			})
			return
		}
		c.JSON(http.StatusOK, inquiryModifyResponse{Prices: []*inquiry.QuoteResult{r}})
	}
}

func placeModifyOrderHandler(svc *placeorder.Service) gin.HandlerFunc {
	return modifyOrderHandler(svc.PlaceModifyOrder)
}

func placeModifyOrderAndPayHandler(svc *placeorder.Service) gin.HandlerFunc {
	return modifyOrderHandler(svc.PlaceModifyOrderAndPay)
}

// modifyOrderHandler 把两个下单变体收敛成同一个 gin handler。
//
// 出参 schema 与新购/续费的 placeOrderResponse 完全一致（dealName / bigOrderId），
// 调用方可平滑共用 DTO 和后续的 pay-url 端点。
func modifyOrderHandler(
	place func(ctx context.Context, req placeorder.PlaceModifyOrderRequest) (*placeorder.PlaceOrderResult, error),
) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req modifyRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{
				"code":    "InvalidRequest",
				"message": "decode JSON: " + err.Error(),
			})
			return
		}
		res, err := place(c.Request.Context(), placeorder.PlaceModifyOrderRequest{
			ExternalUserID: req.ExternalUserID,
			Uin:            req.Uin,
			AppID:          req.AppID,
			ResourceID:     req.ResourceID,
			SourceBundleID: req.SourceBundleID,
			TargetBundleID: req.TargetBundleID,
			CurDeadline:    req.CurDeadline,
			PayMode:        req.PayMode,
		})
		if err != nil {
			code, status := classifyModifyPlaceOrderError(err)
			c.JSON(status, gin.H{
				"code":    code,
				"message": err.Error(),
			})
			return
		}
		c.JSON(http.StatusOK, placeOrderResponse{
			DealName:   res.DealName,
			BigOrderID: res.BigOrderID,
		})
	}
}

// classifyModifyInquiryError 在 classifyInquiryError 基础上加变配独有的跨 SP 错。
func classifyModifyInquiryError(err error) (string, int) {
	if errors.Is(err, inquiry.ErrModifyCrossSubProduct) {
		return "ModifyCrossSubProduct", http.StatusUnprocessableEntity
	}
	return classifyInquiryError(err)
}

// classifyModifyPlaceOrderError 同上，作用于下单侧的 sentinel。
func classifyModifyPlaceOrderError(err error) (string, int) {
	if errors.Is(err, placeorder.ErrModifyCrossSubProduct) {
		return "ModifyCrossSubProduct", http.StatusUnprocessableEntity
	}
	return classifyPlaceOrderError(err)
}
