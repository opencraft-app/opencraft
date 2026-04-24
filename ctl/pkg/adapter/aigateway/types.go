package aigateway

import "encoding/json"

// CreateApiKeyRequest 调用 AI-Gateway POST /api/admin/users/:user_id/api-keys 的请求体
type CreateApiKeyRequest struct {
	Name string `json:"name,omitempty"` // 可选，默认 "default"
}

// CreateApiKeyResponse AI-Gateway 创建 API Key 的响应体（data 字段）
type CreateApiKeyResponse struct {
	APIKey    string `json:"api_key"`
	KeyID     string `json:"key_id"`
	KeyPrefix string `json:"key_prefix"`
	Name      string `json:"name"`
	CreatedAt string `json:"created_at"`
}

type EnsureUserRequest struct {
	UserID   string `json:"user_id"`
	Nickname string `json:"nickname,omitempty"`
}

type EnsureUserResponse struct {
	Result string `json:"result"`
	UserID string `json:"user_id"`
}

// apiResponse 包装 AI-Gateway 的标准响应格式
type apiResponse struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data"`
}

// UserUsageResponse AI-Gateway GET /api/admin/users/:user_id/usage 响应
type UserUsageResponse struct {
	UserID        string `json:"user_id"`
	Days          int    `json:"days"`
	TotalTokens   int64  `json:"total_tokens"`
	TotalRequests int64  `json:"total_requests"`
}

// Plan ai-gateway 的 Plan 结构（只保留 CTL 校验需要的字段）
type Plan struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	MonthlyTokens int64  `json:"monthly_tokens"`
	PeriodValue   int    `json:"period_value"`
	PeriodUnit    string `json:"period_unit"` // "months" / "days"
	IsActive      bool   `json:"is_active"`
}

// ApplySubscriptionRequest 开通订阅请求体
type ApplySubscriptionRequest struct {
	UserID   string `json:"user_id"`
	PlanID   string `json:"plan_id"`
	Nickname string `json:"nickname,omitempty"`
	Phone    string `json:"phone,omitempty"`
}

// CancelSubscriptionRequest 取消订阅请求体
type CancelSubscriptionRequest struct {
	UserID string `json:"user_id"`
}

// Subscription ai-gateway 订阅返回体（精简）
type Subscription struct {
	ID           string `json:"id"`
	UserID       string `json:"user_id"`
	PlanID       string `json:"plan_id"`
	Status       string `json:"status"`
	TokenBalance int64  `json:"token_balance"`
	PeriodStart  string `json:"period_start"`
	PeriodEnd    string `json:"period_end"`
}
