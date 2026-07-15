package aigateway

import (
	"encoding/json"
	"time"
)

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
//
// PeriodValue / PeriodUnit (R-MR-3 v0.3.0 bundle ↔ plan 解耦, Q9=i1 拍板):
// 调用方传入实际购买时长，ai-gateway 内部按 (NOW + period) 计算 PeriodEnd。
// 同算法约束：ai-gateway 端走 timex.AddPeriod，与 ctl/pkg/logic/pass.CalcExpiredTime
// 输出完全一致 — 无双源不一致风险。
//
// Q10=j1 向后兼容：未传时（PeriodValue==0 || PeriodUnit==""）ai-gateway 回退到
// plan.PeriodValue / plan.PeriodUnit 兜底。CTL 端 R-MR-3 改造后默认会传入
// bundle.TimeSpan/TimeUnit 或 req.TimeSpan/TimeUnit。
type ApplySubscriptionRequest struct {
	IdempotencyKey string `json:"idempotency_key"`
	UserID         string `json:"user_id"`
	PlanID         string `json:"plan_id"`
	Nickname       string `json:"nickname,omitempty"`
	Phone          string `json:"phone,omitempty"`
	PeriodValue    int    `json:"period_value,omitempty"`
	PeriodUnit     string `json:"period_unit,omitempty"` // "m" / "d" / "y" / "months" / "days" / "years"
}

// CancelSubscriptionRequest 取消订阅请求体
type CancelSubscriptionRequest struct {
	UserID string `json:"user_id"`
}

// ExtendSubscriptionRequest R-MR-4 续费链路：把 ctl 算好的新 PeriodEnd 推到 ai-gateway。
//
// 续费场景下 ctl 是 PeriodEnd 真源（与 Q9=i1 不矛盾 — Q9=i1 是新购场景，
// 续费场景 ctl renewPassTask 已经 CAS pass.expired_time，必须把这个时间镜像到
// ai-gateway。算法等价：ctl CalcExpiredTime 与 ai-gateway timex.AddMonthsNatural
// 同 helper，所以即使两边各算一次，结果也完全相同）。
//
// 幂等：ai-gateway 端用 CAS（仅当当前 < new 才更新），重复调用同一 NewPeriodEnd
// 返回 200 OK + updated=false。
type ExtendSubscriptionRequest struct {
	UserID       string    `json:"user_id"`
	NewPeriodEnd time.Time `json:"new_period_end"`
}

// ExtendSubscriptionResponse 包含 ai-gateway 端 CAS 后的最新订阅状态 + 是否真的更新了。
// Updated=false 表示 idempotent no-op（PeriodEnd 已是新值或更靠后）。
type ExtendSubscriptionResponse struct {
	Subscription *Subscription `json:"subscription"`
	Updated      bool          `json:"updated"`
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
