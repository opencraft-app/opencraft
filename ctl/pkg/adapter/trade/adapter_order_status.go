package trade

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

// OrderStatusResult 是 QueryOrderStatus 的响应 DTO，与 trade orderstatus.QueryStatusResult
// 字段集严格对齐（v1.7.32 引入）。
//
// 设计稿：.tmp/ctl-order-status-query-design.md §3.3 + §5.2 + §5.5。
//
// 字段语义：
//   - DealName：jifei 子订单号
//   - OrderType：'create' / 'renew'，前端按需展示新购 / 续费标签
//   - LocalStatus：trade_order.status 原值（运维 / 排障可见，前端透传 OrderStatusResponse 时可保留）
//   - Status：统一 5 态 'pending' / 'paid' / 'success' / 'cancelled' / 'failed'（B8）
//   - Source：'local' / 'jifei'（B7 jifei 不可达降级时为 'local'）
//   - BigOrderID：jifei 大订单号
//   - UpstreamErr：jifei 不可达时的 error 描述（B7 fallback signal）
type OrderStatusResult struct {
	DealName    string `json:"deal_name"`
	OrderType   string `json:"order_type"`
	LocalStatus string `json:"local_status,omitempty"`
	Status      string `json:"status"`
	Source      string `json:"source"`
	BigOrderID  string `json:"big_order_id,omitempty"`
	UpstreamErr string `json:"upstream_err,omitempty"`
}

// queryOrderStatusRequest 是发送给 trade 的 body 结构（v1.7.32 引入）。
//
// 协议：POST /internal/trade/orders/{dealName}/query-status，body { external_user_id, skip_jifei }。
type queryOrderStatusRequest struct {
	ExternalUserID string `json:"external_user_id"`
	SkipJifei      bool   `json:"skip_jifei,omitempty"`
}

// QueryOrderStatus 详见 Adapter.QueryOrderStatus 接口注释（v1.7.32）。
//
// HTTP 调用骨架与 GeneratePayURL / DeleteResource 完全对偶：
//   - PathEscape(dealName) 防御特殊字符
//   - body 透传 external_user_id
//   - doJSON 处理 4xx / 5xx → *Error；2xx → 解码到 OrderStatusResult
//
// **B7 关键**：trade 在 jifei 不可达时返 200 + Source="local" + UpstreamErr 非空，
// 不返 5xx，因此 doJSON 不会触发 *Error 转换；调用方应根据 result.Source 自行判断
// 是否为降级路径。
func (a *adapter) QueryOrderStatus(ctx context.Context, dealName, externalUserID string) (*OrderStatusResult, error) {
	if a.config.BaseURL == "" {
		return nil, fmt.Errorf("trade adapter: base_url not configured")
	}
	dealName = strings.TrimSpace(dealName)
	if dealName == "" {
		return nil, fmt.Errorf("trade adapter: QueryOrderStatus: dealName is required")
	}
	externalUserID = strings.TrimSpace(externalUserID)
	if externalUserID == "" {
		return nil, fmt.Errorf("trade adapter: QueryOrderStatus: externalUserID is required")
	}

	// dealName 来自 jifei 生成的订单号，PathEscape 防御特殊字符（与 GeneratePayURL 同范式）。
	endpoint := strings.TrimRight(a.config.BaseURL, "/") +
		"/internal/trade/orders/" + url.PathEscape(dealName) + "/query-status"

	body := &queryOrderStatusRequest{
		ExternalUserID: externalUserID,
	}

	var result OrderStatusResult
	if err := a.doJSON(ctx, http.MethodPost, endpoint, body, &result); err != nil {
		return nil, err
	}
	return &result, nil
}
