package llmgateway

import (
	"encoding/json"
	"time"
)

// CreateApiKeyRequest 调用 LLMGateway POST /api/admin/users/:user_id/api-keys 的请求体
type CreateApiKeyRequest struct {
	Name string `json:"name,omitempty"` // 可选，默认 "default"
}

// CreateApiKeyResponse LLMGateway 创建 API Key 的响应体（data 字段）
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

// apiResponse 包装 LLMGateway 的标准响应格式
type apiResponse struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data"`
}

// UserUsageResponse LLMGateway GET /api/admin/users/:user_id/usage 响应
type UserUsageResponse struct {
	UserID        string `json:"user_id"`
	Days          int    `json:"days"`
	TotalTokens   int64  `json:"total_tokens"`
	TotalRequests int64  `json:"total_requests"`
}

// Plan 是 VelaGW 的稳定权益模板。周期额度和重置节奏属于模板，
// 订单购买时长不属于模板。
type Plan struct {
	ID                      string `json:"id"`
	Name                    string `json:"name"`
	MonthlyTokens           int64  `json:"monthly_tokens"`
	QuotaResetPeriod        string `json:"quota_reset_period,omitempty"`
	QuotaResetCustomSeconds int64  `json:"quota_reset_custom_seconds,omitempty"`
	IsActive                bool   `json:"is_active"`
	ReadyForAllSets         bool   `json:"ready_for_all_sets"`
	ActiveSetCount          int    `json:"active_set_count"`
	ReadySetCount           int    `json:"ready_set_count"`
	PeriodValue             int    `json:"period_value,omitempty"`
	PeriodUnit              string `json:"period_unit,omitempty"`
}

// ApplySubscriptionRequest 确保长期订阅存在。
// PeriodValue/PeriodUnit/PeriodEnd 只用于兼容旧 VelaGW，新 ctl 的普通权益不发送。
type ApplySubscriptionRequest struct {
	IdempotencyKey   string     `json:"idempotency_key"`
	UserID           string     `json:"user_id"`
	PlanID           string     `json:"plan_id"`
	SubscriptionName string     `json:"subscription_name,omitempty"`
	Nickname         string     `json:"nickname,omitempty"`
	Phone            string     `json:"phone,omitempty"`
	PeriodValue      int        `json:"period_value,omitempty"`
	PeriodUnit       string     `json:"period_unit,omitempty"` // "m" / "d" / "y" / "months" / "days" / "years"
	PeriodEnd        *time.Time `json:"period_end,omitempty"`
	IsUnique         bool       `json:"is_unique,omitempty"`
}

// CancelSubscriptionRequest 取消订阅请求体
type CancelSubscriptionRequest struct {
	UserID string `json:"user_id"`
}

// ExtendSubscriptionRequest R-MR-4 续费链路：把 ctl 算好的新 PeriodEnd 推到 llmgateway。
//
// 续费场景下 ctl 是 PeriodEnd 真源（与 Q9=i1 不矛盾 — Q9=i1 是新购场景，
// 续费场景 ctl renewPassTask 已经 CAS pass.expired_time，必须把这个时间镜像到
// llmgateway。算法等价：ctl CalcExpiredTime 与 llmgateway timex.AddMonthsNatural
// 同 helper，所以即使两边各算一次，结果也完全相同）。
//
// 幂等：llmgateway 端用 CAS（仅当当前 < new 才更新），重复调用同一 NewPeriodEnd
// 返回 200 OK + updated=false。
type ExtendSubscriptionRequest struct {
	UserID       string    `json:"user_id"`
	NewPeriodEnd time.Time `json:"new_period_end"`
}

// ExtendSubscriptionResponse 包含 llmgateway 端 CAS 后的最新订阅状态 + 是否真的更新了。
// Updated=false 表示 idempotent no-op（PeriodEnd 已是新值或更靠后）。
type ExtendSubscriptionResponse struct {
	Subscription *Subscription `json:"subscription"`
	Updated      bool          `json:"updated"`
}

// Subscription llmgateway 订阅返回体（精简）
type Subscription struct {
	ID           string `json:"id"`
	Name         string `json:"name,omitempty"`
	UserID       string `json:"user_id"`
	PlanID       string `json:"plan_id"`
	Status       string `json:"status"`
	TokenTotal   int64  `json:"token_total"`
	TokenBalance int64  `json:"token_balance"`
	PeriodStart  string `json:"period_start"`
	PeriodEnd    string `json:"period_end"`
}

// ActiveSubscriptionList 是 LLMGateway 多 active 订阅查询返回体（data 字段）。
type ActiveSubscriptionList struct {
	UserID        string         `json:"user_id"`
	Subscriptions []Subscription `json:"subscriptions"`
}
