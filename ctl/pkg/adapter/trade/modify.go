package trade

import (
	"context"
	"fmt"
	"net/http"
	"strings"
)

// 同 SP 升配的 ctl → trade 调用。需求：TAPD 1010132091137784162 §5.1 / §7.1
//
// 三个端点共用一个入参 DTO，和 trade 侧的 modifyRequest 一一对应。共用是刻意的：
// 询价和下单必须基于**同一组**入参，否则用户在确认页看到的差价可以和实际扣款不一致。

// ModifyOrderRequest 与 trade /internal/trade/{inquiry,orders}/modify 入参对齐。
//
// 不带 period / timeUnit / goodsNum：变配不改到期时间，时长语义完全由 CurDeadline
// 承载，goodsNum 协议固定 1。
type ModifyOrderRequest struct {
	ExternalUserID string `json:"externalUserId"`
	Uin            string `json:"uin,omitempty"`
	AppID          string `json:"appId,omitempty"`
	// ResourceID 是变配目标 pass_id。
	ResourceID     string `json:"resourceId"`
	SourceBundleID string `json:"sourceBundleId"`
	TargetBundleID string `json:"targetBundleId"`
	// CurDeadline 是 pass.expired_time 的 jifei 字面值（"2006-01-02 15:04:05"，CST）。
	// 真源在 ctl DB，由 ctl 拼好透传，不接受前端传入避免漂移。
	CurDeadline string `json:"curDeadline"`
	PayMode     int    `json:"payMode"`
}

// InquiryModifyResult 与 trade inquiryModifyResponse 对齐；单条结果在 Prices[0]。
type InquiryModifyResult struct {
	Prices []*BundleQuote `json:"prices"`
}

func (a *adapter) InquiryModify(ctx context.Context, req *ModifyOrderRequest) (*InquiryModifyResult, error) {
	if err := a.validateModifyRequest("InquiryModify", req); err != nil {
		return nil, err
	}
	endpoint := strings.TrimRight(a.config.BaseURL, "/") + "/internal/trade/inquiry/modify"
	var result InquiryModifyResult
	if err := a.doJSON(ctx, http.MethodPost, endpoint, req, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

func (a *adapter) PlaceModifyOrder(ctx context.Context, req *ModifyOrderRequest) (*PlaceOrderResult, error) {
	return a.placeModifyOrder(ctx, "PlaceModifyOrder", "/internal/trade/orders/modify", req)
}

func (a *adapter) PlaceModifyOrderAndPay(ctx context.Context, req *ModifyOrderRequest) (*PlaceOrderResult, error) {
	return a.placeModifyOrder(ctx, "PlaceModifyOrderAndPay", "/internal/trade/orders/modify/place-and-pay", req)
}

func (a *adapter) placeModifyOrder(
	ctx context.Context,
	method, path string,
	req *ModifyOrderRequest,
) (*PlaceOrderResult, error) {
	if err := a.validateModifyRequest(method, req); err != nil {
		return nil, err
	}
	endpoint := strings.TrimRight(a.config.BaseURL, "/") + path
	var result PlaceOrderResult
	if err := a.doJSON(ctx, http.MethodPost, endpoint, req, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// validateModifyRequest 只拦本地就能判定的空值，避免为必然失败的请求打一次网络往返。
// 业务语义（升配关系、SP 一致性、pass 归属）由 trade 和 ctl 各自的校验负责。
func (a *adapter) validateModifyRequest(method string, req *ModifyOrderRequest) error {
	if a.config.BaseURL == "" {
		return fmt.Errorf("trade adapter: base_url not configured")
	}
	if req == nil {
		return fmt.Errorf("trade adapter: %s request is nil", method)
	}
	for _, field := range []struct {
		name  string
		value string
	}{
		{"resourceId", req.ResourceID},
		{"sourceBundleId", req.SourceBundleID},
		{"targetBundleId", req.TargetBundleID},
		{"curDeadline", req.CurDeadline},
	} {
		if strings.TrimSpace(field.value) == "" {
			return fmt.Errorf("trade adapter: %s: %s is required", method, field.name)
		}
	}
	return nil
}
