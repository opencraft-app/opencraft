package transport

import "time"

// === Bundle Transport DTOs ===

// ImportBundleRequest 导入套餐请求（不存在则创建，存在则覆盖）
type ImportBundleRequest struct {
	BundleID              string           `json:"bundle_id"`
	BundleName            string           `json:"bundle_name"`
	Description           []BundleDescItem `json:"description"`
	AgentQuota            int64            `json:"agent_quota"`
	Credit                int64            `json:"credit"`
	TimeSpan              int              `json:"time_span"`
	TimeUnit              string           `json:"time_unit"`
	AiGatewayPlanID       string           `json:"ai_gateway_plan_id"`
	StaticSoldOut         bool             `json:"static_sold_out"`
	BundleSalesAvailCount int              `json:"bundle_sales_available_count"`
	BundleSalesTotalCount int              `json:"bundle_sales_total_count"`
}

// BundleDescItem description JSON 中的单个 KV 条目
type BundleDescItem struct {
	Key   string `json:"Key"`
	Value string `json:"Value"`
}

// ModifyBundlesRequest 批量修改套餐请求
type ModifyBundlesRequest struct {
	BundleIDs             []string `json:"bundle_ids"`
	BundleName            *string  `json:"bundle_name,omitempty"`
	Description           *string  `json:"description,omitempty"` // raw JSON string
	BundleState           *string  `json:"bundle_state,omitempty"`
	AgentQuota            *int64   `json:"agent_quota,omitempty"`
	Credit                *int64   `json:"credit,omitempty"`
	TimeSpan              *int     `json:"time_span,omitempty"`
	TimeUnit              *string  `json:"time_unit,omitempty"`
	AiGatewayPlanID       *string  `json:"ai_gateway_plan_id,omitempty"`
	StaticSoldOut         *bool    `json:"static_sold_out,omitempty"`
	BundleSalesAvailCount *int     `json:"bundle_sales_available_count,omitempty"`
	BundleSalesTotalCount *int     `json:"bundle_sales_total_count,omitempty"`
}

// BundleResponse 单个 Bundle 响应（后台管理端，含所有字段）
type BundleResponse struct {
	BundleID              string      `json:"bundle_id"`
	BundleName            string      `json:"bundle_name"`
	Description           interface{} `json:"description"`
	BundleState           string      `json:"bundle_state"`
	AgentQuota            int64       `json:"agent_quota"`
	Credit                int64       `json:"credit"`
	TimeSpan              int         `json:"time_span"`
	TimeUnit              string      `json:"time_unit"`
	AiGatewayPlanID       string      `json:"ai_gateway_plan_id,omitempty"`
	StaticSoldOut         *bool       `json:"static_sold_out,omitempty"`
	BundleSalesAvailCount int         `json:"bundle_sales_available_count"`
	BundleSalesTotalCount int         `json:"bundle_sales_total_count"`
	BundleSalesState      string      `json:"bundle_sales_state"`
	CreatedTime           time.Time   `json:"created_time"`
	UpdatedTime           time.Time   `json:"updated_time"`
}

// ListBundlesResponse 查询套餐列表响应
type ListBundlesResponse struct {
	Bundles []*BundleResponse `json:"bundles"`
}

// ModifyBundlesResponse 批量修改套餐响应
type ModifyBundlesResponse struct {
	AffectedCount int64 `json:"affected_count"`
}

// UserBundleResponse 面向用户的 Bundle 响应（仅暴露用户可见字段）
type UserBundleResponse struct {
	BundleID         string      `json:"bundle_id"`
	BundleName       string      `json:"bundle_name"`
	Description      interface{} `json:"description"`
	BundleState      string      `json:"bundle_state"`
	AgentQuota       int64       `json:"agent_quota"`
	Credit           int64       `json:"credit"`
	BundleSalesState string      `json:"bundle_sales_state"`
}

// DescribeBundlesResponse 面向用户的套餐列表响应
type DescribeBundlesResponse struct {
	Bundles []*UserBundleResponse `json:"bundles"`
}
