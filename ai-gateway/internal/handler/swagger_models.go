package handler

import (
	"time"

	"github.com/google/uuid"
)

// ==================== 通用响应模型 ====================

// SwaggerErrorResponse OpenAI 兼容的错误响应格式。
type SwaggerErrorResponse struct {
	Error SwaggerErrorDetail `json:"error"`
}

// SwaggerErrorDetail 错误详情。
type SwaggerErrorDetail struct {
	Message string `json:"message" example:"Invalid API key provided."`
	Type    string `json:"type" example:"authentication_error"`
	Code    string `json:"code" example:"invalid_api_key"`
}

// SwaggerMessageResponse 简单消息响应。
type SwaggerMessageResponse struct {
	Message string `json:"message" example:"Operation successful"`
}

// ==================== Swagger 专用实体模型（避免 datatypes.JSON 解析错误） ====================

// SwaggerPlan 套餐（Swagger 文档专用，替代 model.Plan）。
type SwaggerPlan struct {
	ID               uuid.UUID          `json:"id" example:"550e8400-e29b-41d4-a716-446655440000"`
	Name             string             `json:"name" example:"Pro Plan"`
	MonthlyTokens    int64              `json:"monthly_tokens" example:"10000000"`
	RateLimits       []SwaggerRateLimit `json:"rate_limits"`
	AllowedModels    []string           `json:"allowed_models" example:"gpt-4,claude-3-opus"`
	PriceCents       int                `json:"price_cents" example:"9900"`
	TokenMultipliers map[string]float64 `json:"token_multipliers"`
	IsActive         bool               `json:"is_active" example:"true"`
	CreatedAt        time.Time          `json:"created_at"`
}

// SwaggerRateLimit 限流规则。
type SwaggerRateLimit struct {
	Window      string `json:"window" example:"1m"`
	MaxRequests int    `json:"max_requests" example:"60"`
	Label       string `json:"label" example:"每分钟"`
}

// SwaggerProvider 提供商（Swagger 文档专用，替代 model.Provider）。
type SwaggerProvider struct {
	ID                     uuid.UUID  `json:"id" example:"550e8400-e29b-41d4-a716-446655440000"`
	Name                   string     `json:"name" example:"OpenAI Primary"`
	ProviderType           string     `json:"provider_type" example:"openai"`
	APIKey                 string     `json:"api_key" example:"sk-xxxx***xxxx"`
	BaseURL                string     `json:"base_url" example:"https://api.openai.com"`
	TotalQuota             int64      `json:"total_quota" example:"10000000"`
	UsedQuota              int64      `json:"used_quota" example:"500000"`
	Status                 string     `json:"status" example:"active"`
	Priority               int        `json:"priority" example:"0"`
	Weight                 int        `json:"weight" example:"100"`
	HealthCheckURL         string     `json:"health_check_url" example:"https://api.openai.com/v1/models"`
	ModelDiscoveryProtocol string     `json:"model_discovery_protocol" example:"openai_compatible"`
	LastHeartbeat          *time.Time `json:"last_heartbeat"`
	RegistrationSource     string     `json:"registration_source" example:"manual"`
	SupportedModels        []string   `json:"supported_models" example:"gpt-4,gpt-3.5-turbo"`
	CreatedAt              time.Time  `json:"created_at"`
	UpdatedAt              time.Time  `json:"updated_at"`
}

// SwaggerSubscription 订阅（Swagger 文档专用，替代 model.Subscription）。
type SwaggerSubscription struct {
	ID           uuid.UUID `json:"id" example:"550e8400-e29b-41d4-a716-446655440000"`
	UserID       uuid.UUID `json:"user_id" example:"550e8400-e29b-41d4-a716-446655440000"`
	PlanID       uuid.UUID `json:"plan_id" example:"550e8400-e29b-41d4-a716-446655440000"`
	Status       string    `json:"status" example:"active"`
	TokenBalance int64     `json:"token_balance" example:"1000000"`
	PeriodStart  time.Time `json:"period_start"`
	PeriodEnd    time.Time `json:"period_end"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

// SwaggerUser 用户（Swagger 文档专用，替代 model.User）。
type SwaggerUser struct {
	ID        uuid.UUID `json:"id" example:"550e8400-e29b-41d4-a716-446655440000"`
	Phone     string    `json:"phone" example:"138****8000"`
	UserID    string    `json:"user_id" example:"usr_000001"`
	Nickname  string    `json:"nickname,omitempty" example:"张三"`
	Status    string    `json:"status" example:"active"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// SwaggerApiKey API Key（Swagger 文档专用，替代 model.ApiKey）。
type SwaggerApiKey struct {
	ID         uuid.UUID  `json:"id" example:"550e8400-e29b-41d4-a716-446655440000"`
	UserID     string     `json:"user_id" example:"usr_000001"`
	KeyPrefix  string     `json:"key_prefix" example:"sk-xxxxxxxx"`
	Name       string     `json:"name" example:"default"`
	IsActive   bool       `json:"is_active" example:"true"`
	LastUsedAt *time.Time `json:"last_used_at"`
	CreatedAt  time.Time  `json:"created_at"`
}

// SwaggerModelMapping 模型映射（Swagger 文档专用，替代 model.ModelProviderMapping）。
type SwaggerModelMapping struct {
	ID           uuid.UUID        `json:"id" example:"550e8400-e29b-41d4-a716-446655440000"`
	ModelPattern string           `json:"model_pattern" example:"gpt-4*"`
	ProviderID   uuid.UUID        `json:"provider_id" example:"550e8400-e29b-41d4-a716-446655440000"`
	Priority     int              `json:"priority" example:"0"`
	Weight       int              `json:"weight" example:"100"`
	IsActive     bool             `json:"is_active" example:"true"`
	CreatedAt    time.Time        `json:"created_at"`
	Provider     *SwaggerProvider `json:"provider,omitempty"`
}

// ==================== OpenAI 兼容接口模型 ====================

// SwaggerChatCompletionRequest OpenAI Chat Completion 请求体。
type SwaggerChatCompletionRequest struct {
	Model            string               `json:"model" example:"gpt-4"`
	Messages         []SwaggerChatMessage `json:"messages"`
	Temperature      *float64             `json:"temperature,omitempty" example:"0.7"`
	TopP             *float64             `json:"top_p,omitempty" example:"1.0"`
	N                *int                 `json:"n,omitempty" example:"1"`
	Stream           *bool                `json:"stream,omitempty" example:"false"`
	MaxTokens        *int                 `json:"max_tokens,omitempty" example:"1024"`
	PresencePenalty  *float64             `json:"presence_penalty,omitempty" example:"0"`
	FrequencyPenalty *float64             `json:"frequency_penalty,omitempty" example:"0"`
	User             string               `json:"user,omitempty" example:"user-123"`
}

// SwaggerChatMessage 单条聊天消息。
type SwaggerChatMessage struct {
	Role    string `json:"role" example:"user"`
	Content string `json:"content" example:"Hello, how are you?"`
}

// SwaggerChatCompletionResponse OpenAI Chat Completion 响应体。
type SwaggerChatCompletionResponse struct {
	ID      string                        `json:"id" example:"chatcmpl-abc123"`
	Object  string                        `json:"object" example:"chat.completion"`
	Created int64                         `json:"created" example:"1677858242"`
	Model   string                        `json:"model" example:"gpt-4"`
	Choices []SwaggerChatCompletionChoice `json:"choices"`
	Usage   SwaggerUsage                  `json:"usage"`
}

// SwaggerChatCompletionChoice 单个 completion 选项。
type SwaggerChatCompletionChoice struct {
	Index        int                `json:"index" example:"0"`
	Message      SwaggerChatMessage `json:"message"`
	FinishReason string             `json:"finish_reason" example:"stop"`
}

// SwaggerUsage Token 使用量统计。
type SwaggerUsage struct {
	PromptTokens     int `json:"prompt_tokens" example:"10"`
	CompletionTokens int `json:"completion_tokens" example:"20"`
	TotalTokens      int `json:"total_tokens" example:"30"`
}

// SwaggerCompletionRequest OpenAI Completion 请求体（legacy）。
type SwaggerCompletionRequest struct {
	Model       string   `json:"model" example:"gpt-3.5-turbo-instruct"`
	Prompt      string   `json:"prompt" example:"Say this is a test"`
	MaxTokens   *int     `json:"max_tokens,omitempty" example:"256"`
	Temperature *float64 `json:"temperature,omitempty" example:"0.7"`
	Stream      *bool    `json:"stream,omitempty" example:"false"`
}

// SwaggerCompletionResponse OpenAI Completion 响应体。
type SwaggerCompletionResponse struct {
	ID      string                    `json:"id" example:"cmpl-abc123"`
	Object  string                    `json:"object" example:"text_completion"`
	Created int64                     `json:"created" example:"1677858242"`
	Model   string                    `json:"model" example:"gpt-3.5-turbo-instruct"`
	Choices []SwaggerCompletionChoice `json:"choices"`
	Usage   SwaggerUsage              `json:"usage"`
}

// SwaggerCompletionChoice 单个 completion 选项。
type SwaggerCompletionChoice struct {
	Text         string `json:"text" example:"This is a test."`
	Index        int    `json:"index" example:"0"`
	FinishReason string `json:"finish_reason" example:"stop"`
}

// SwaggerEmbeddingRequest OpenAI Embedding 请求体。
type SwaggerEmbeddingRequest struct {
	Model string `json:"model" example:"text-embedding-ada-002"`
	Input string `json:"input" example:"The quick brown fox jumps over the lazy dog"`
}

// SwaggerEmbeddingResponse OpenAI Embedding 响应体。
type SwaggerEmbeddingResponse struct {
	Object string                 `json:"object" example:"list"`
	Data   []SwaggerEmbeddingData `json:"data"`
	Model  string                 `json:"model" example:"text-embedding-ada-002"`
	Usage  SwaggerEmbeddingUsage  `json:"usage"`
}

// SwaggerEmbeddingData 单条 embedding 数据。
type SwaggerEmbeddingData struct {
	Object    string    `json:"object" example:"embedding"`
	Embedding []float64 `json:"embedding"`
	Index     int       `json:"index" example:"0"`
}

// SwaggerEmbeddingUsage Embedding 使用量统计。
type SwaggerEmbeddingUsage struct {
	PromptTokens int `json:"prompt_tokens" example:"8"`
	TotalTokens  int `json:"total_tokens" example:"8"`
}

// SwaggerModelObject OpenAI Model 对象。
type SwaggerModelObject struct {
	ID      string `json:"id" example:"gpt-4"`
	Object  string `json:"object" example:"model"`
	Created int64  `json:"created" example:"1677858242"`
	OwnedBy string `json:"owned_by" example:"organization"`
}

// SwaggerModelListResponse OpenAI Model 列表响应。
type SwaggerModelListResponse struct {
	Object string               `json:"object" example:"list"`
	Data   []SwaggerModelObject `json:"data"`
}

// ==================== User Self 接口模型 ====================

// SwaggerMeResponse /v1/me 响应体。
type SwaggerMeResponse struct {
	User         SwaggerUser        `json:"user"`
	Subscription *SwaggerSubSummary `json:"subscription,omitempty"`
	Plan         *SwaggerPlan       `json:"plan,omitempty"`
}

// SwaggerSubSummary 订阅摘要信息。
type SwaggerSubSummary struct {
	ID           uuid.UUID `json:"id" example:"550e8400-e29b-41d4-a716-446655440000"`
	Status       string    `json:"status" example:"active"`
	TokenBalance int64     `json:"token_balance" example:"1000000"`
	PeriodStart  time.Time `json:"period_start"`
	PeriodEnd    time.Time `json:"period_end"`
}

// SwaggerUsageStatsResponse /v1/me/usage 响应体。
type SwaggerUsageStatsResponse struct {
	UserID          string     `json:"user_id" example:"usr_000001"`
	Status          string     `json:"status" example:"active"`
	PeriodStart     *time.Time `json:"period_start,omitempty"`
	PeriodEnd       *time.Time `json:"period_end,omitempty"`
	IsUnlimited     bool       `json:"is_unlimited" example:"false"`
	PlanTotalTokens *int64     `json:"plan_total_tokens,omitempty" example:"1000000" extensions:"x-nullable"`
	UsedTokens      int64      `json:"used_tokens" example:"300000"`
	RemainingTokens *int64     `json:"remaining_tokens,omitempty" example:"700000" extensions:"x-nullable"`
	TotalRequests   int64      `json:"total_requests" example:"120"`
}

// SwaggerTokenBalanceResponse /v1/me/token-balance 响应体。
type SwaggerTokenBalanceResponse struct {
	TokenBalance *int64     `json:"token_balance,omitempty" example:"1000000" extensions:"x-nullable"`
	Status       string     `json:"status" example:"active"`
	PeriodEnd    *time.Time `json:"period_end,omitempty"`
	IsUnlimited  bool       `json:"is_unlimited" example:"false"`
	DisplayText  string     `json:"display_text" example:"1000000"`
}

// ==================== Health 接口模型 ====================

// SwaggerHealthResponse /health 响应体。
type SwaggerHealthResponse struct {
	Status string `json:"status" example:"ok"`
}

// SwaggerReadyResponse /ready 响应体。
type SwaggerReadyResponse struct {
	Status string             `json:"status" example:"ready"`
	Checks SwaggerReadyChecks `json:"checks"`
}

// SwaggerReadyChecks 就绪检查结果。
type SwaggerReadyChecks struct {
	Database string `json:"database" example:"ok"`
	Redis    string `json:"redis" example:"ok"`
}

// ==================== Admin - Users 接口模型 ====================

// SwaggerUserWithPlan 用户列表项（含套餐信息）。
type SwaggerUserWithPlan struct {
	ID           uuid.UUID `json:"id" example:"550e8400-e29b-41d4-a716-446655440000"`
	Phone        string    `json:"phone" example:"138****8000"`
	UserID       string    `json:"user_id" example:"usr_000001"`
	Nickname     string    `json:"nickname,omitempty" example:"张三"`
	Status       string    `json:"status" example:"active"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
	CurrentPlan  string    `json:"current_plan,omitempty" example:"Pro Plan"`
	TokenBalance *int64    `json:"token_balance,omitempty" example:"500000"`
	IsUnlimited  bool      `json:"is_unlimited" example:"false"`
}

// SwaggerUserListResponse 用户分页列表响应。
type SwaggerUserListResponse struct {
	Items    []SwaggerUserWithPlan `json:"items"`
	Total    int64                 `json:"total" example:"100"`
	Page     int                   `json:"page" example:"1"`
	PageSize int                   `json:"page_size" example:"20"`
}

// SwaggerUserDetailResponse 用户详情响应（含订阅和套餐）。
type SwaggerUserDetailResponse struct {
	ID           uuid.UUID            `json:"id" example:"550e8400-e29b-41d4-a716-446655440000"`
	UserID       string               `json:"user_id" example:"usr_000001"`
	Phone        string               `json:"phone" example:"138****8000"`
	Nickname     string               `json:"nickname,omitempty" example:"张三"`
	Status       string               `json:"status" example:"active"`
	CreatedAt    time.Time            `json:"created_at"`
	UpdatedAt    time.Time            `json:"updated_at"`
	Subscription *SwaggerSubscription `json:"subscription,omitempty"`
	Plan         *SwaggerPlan         `json:"plan,omitempty"`
}

// ==================== Admin - Plans 接口模型 ====================

// SwaggerCreatePlanRequest 创建套餐请求（Swagger 文档专用，替代 createPlanRequest 避免 datatypes.JSON）。
type SwaggerCreatePlanRequest struct {
	Name             string             `json:"name" binding:"required" example:"Pro Plan"`
	MonthlyTokens    *int64             `json:"monthly_tokens" binding:"required" example:"10000000"`
	RateLimits       []SwaggerRateLimit `json:"rate_limits" binding:"required,min=1"`
	AllowedModels    []string           `json:"allowed_models" example:"gpt-4,claude-3-opus"`
	PriceCents       int                `json:"price_cents" example:"9900"`
	TokenMultipliers map[string]float64 `json:"token_multipliers"`
	IsActive         *bool              `json:"is_active" example:"true"`
}

// SwaggerUpdatePlanRequest 更新套餐请求（Swagger 文档专用，替代 updatePlanRequest 避免 datatypes.JSON）。
type SwaggerUpdatePlanRequest struct {
	Name             string              `json:"name" example:"Pro Plan"`
	MonthlyTokens    *int64              `json:"monthly_tokens" example:"10000000"`
	RateLimits       *[]SwaggerRateLimit `json:"rate_limits"`
	AllowedModels    []string            `json:"allowed_models" example:"gpt-4,claude-3-opus"`
	PriceCents       *int                `json:"price_cents" example:"9900"`
	TokenMultipliers map[string]float64  `json:"token_multipliers"`
	IsActive         *bool               `json:"is_active" example:"true"`
}

// SwaggerPlanListResponse 套餐分页列表响应。
type SwaggerPlanListResponse struct {
	Items    []SwaggerPlan `json:"items"`
	Total    int           `json:"total" example:"5"`
	Page     int           `json:"page" example:"1"`
	PageSize int           `json:"page_size" example:"20"`
}

// ==================== Admin - Providers 接口模型 ====================

// SwaggerProviderListResponse 提供商分页列表响应。
type SwaggerProviderListResponse struct {
	Items    []SwaggerProvider `json:"items"`
	Total    int               `json:"total" example:"3"`
	Page     int               `json:"page" example:"1"`
	PageSize int               `json:"page_size" example:"20"`
}

// ==================== Admin - API Keys 接口模型 ====================

// SwaggerCreateApiKeyResponse 创建 API Key 响应。
type SwaggerCreateApiKeyResponse struct {
	ApiKey    string    `json:"api_key" example:"sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxx"`
	KeyID     uuid.UUID `json:"key_id" example:"550e8400-e29b-41d4-a716-446655440000"`
	KeyPrefix string    `json:"key_prefix" example:"sk-xxxxxxxx"`
	Name      string    `json:"name" example:"default"`
	CreatedAt time.Time `json:"created_at"`
}

// SwaggerApiKeyListResponse 用户 API Key 列表响应。
type SwaggerApiKeyListResponse struct {
	ApiKeys []SwaggerApiKey `json:"api_keys"`
}

// SwaggerApiKeyItem 跨用户 API Key 列表项。
type SwaggerApiKeyItem struct {
	ID            uuid.UUID `json:"id" example:"550e8400-e29b-41d4-a716-446655440000"`
	KeyPrefix     string    `json:"key_prefix" example:"sk-xxxxxxxx"`
	Name          string    `json:"name" example:"default"`
	UserID        string    `json:"user_id" example:"usr_000001"`
	GatewayUserID uuid.UUID `json:"gateway_user_id" example:"550e8400-e29b-41d4-a716-446655440000"`
	UserPhone     string    `json:"user_phone" example:"138****8000"`
	Status        string    `json:"status" example:"active"`
	IsActive      bool      `json:"is_active" example:"true"`
	CreatedAt     string    `json:"created_at" example:"2024-01-01T00:00:00Z"`
}

// SwaggerAllApiKeyListResponse 跨用户 API Key 分页列表响应。
type SwaggerAllApiKeyListResponse struct {
	Items    []SwaggerApiKeyItem `json:"items"`
	Total    int64               `json:"total" example:"50"`
	Page     int                 `json:"page" example:"1"`
	PageSize int                 `json:"page_size" example:"20"`
}

// ==================== Admin - Subscriptions 接口模型 ====================

// SwaggerAdjustTokensRequest 调整 token 余额请求。
type SwaggerAdjustTokensRequest struct {
	Delta int64 `json:"delta" binding:"required" example:"100000"`
}

// ==================== Admin - Stats 接口模型 ====================

// SwaggerStatsOverviewResponse 平台概览统计响应。
type SwaggerStatsOverviewResponse struct {
	TotalUsers          int64 `json:"total_users" example:"1000"`
	ActiveSubscriptions int64 `json:"active_subscriptions" example:"800"`
	TotalProviders      int   `json:"total_providers" example:"5"`
	ActivePlans         int   `json:"active_plans" example:"3"`
}

// SwaggerStatsUsageResponse 使用量统计响应（今日 vs 昨日）。
type SwaggerStatsUsageResponse struct {
	TotalTokens           int64   `json:"total_tokens" example:"1500000"`
	TotalInteractions     int64   `json:"total_interactions" example:"5000"`
	TokensChangePct       float64 `json:"tokens_change_pct" example:"12.5"`
	InteractionsChangePct float64 `json:"interactions_change_pct" example:"8.3"`
}

// SwaggerStatsUsersResponse 用户统计响应。
type SwaggerStatsUsersResponse struct {
	Total    int64 `json:"total" example:"1000"`
	Active   int64 `json:"active" example:"800"`
	Disabled int64 `json:"disabled" example:"50"`
	Expired  int64 `json:"expired" example:"150"`
}

type SwaggerTopUserItem struct {
	ID                uuid.UUID `json:"id" example:"550e8400-e29b-41d4-a716-446655440000"`
	UserID            string    `json:"user_id" example:"usr_000001"`
	Nickname          string    `json:"nickname,omitempty" example:"张三"`
	Status            string    `json:"status" example:"active"`
	TotalTokens       int64     `json:"total_tokens" example:"50000"`
	TotalInteractions int64     `json:"total_interactions" example:"120"`
}

type SwaggerTopUsersResponse struct {
	Days  int                  `json:"days" example:"7"`
	Limit int                  `json:"limit" example:"5"`
	Items []SwaggerTopUserItem `json:"items"`
}

// SwaggerStatsTokenPoolResponse Token 池统计响应。
type SwaggerStatsTokenPoolResponse struct {
	TotalDistributed    int64   `json:"total_distributed" example:"10000000"`
	TotalConsumed       int64   `json:"total_consumed" example:"5000000"`
	GlobalRemaining     int64   `json:"global_remaining" example:"5000000"`
	ConsumedChange7dPct float64 `json:"consumed_change_7d_pct" example:"15.2"`
}

// SwaggerDailyTrendPoint 每日趋势数据点。
type SwaggerDailyTrendPoint struct {
	Date              string `json:"date" example:"2024-01-15"`
	TotalTokens       int64  `json:"total_tokens" example:"50000"`
	TotalInteractions int64  `json:"total_interactions" example:"200"`
}

// SwaggerModelDistPoint 模型分布数据点。
type SwaggerModelDistPoint struct {
	Model    string `json:"model" example:"gpt-4"`
	Tokens   int64  `json:"tokens" example:"30000"`
	Requests int64  `json:"requests" example:"100"`
}

// SwaggerModelDailyDistPoint 模型每日分布数据点。
type SwaggerModelDailyDistPoint struct {
	Date     string  `json:"date" example:"2024-01-15"`
	Model    string  `json:"model" example:"gpt-4"`
	Tokens   int64   `json:"tokens" example:"30000"`
	Requests int64   `json:"requests" example:"100"`
	Share    float64 `json:"share" example:"62.5"`
}

// SwaggerStatsUsageTrendResponse 使用趋势响应。
type SwaggerStatsUsageTrendResponse struct {
	Period                 string                       `json:"period" example:"7d"`
	Granularity            string                       `json:"granularity" example:"daily"`
	Data                   []SwaggerDailyTrendPoint     `json:"data"`
	ModelDistribution      []SwaggerModelDistPoint      `json:"model_distribution"`
	ModelDailyDistribution []SwaggerModelDailyDistPoint `json:"model_daily_distribution"`
}

// SwaggerUserUsageResponse 用户使用量响应。
type SwaggerUserUsageResponse struct {
	UserID            string                   `json:"user_id" example:"usr_000001"`
	Days              int                      `json:"days" example:"7"`
	Daily             []SwaggerDailyTrendPoint `json:"daily"`
	TotalTokens       int64                    `json:"total_tokens" example:"50000"`
	TotalInteractions int64                    `json:"total_interactions" example:"200"`
}

// SwaggerProviderUsageResponse 提供商使用量响应。
type SwaggerProviderUsageResponse struct {
	UsedQuota    int64   `json:"used_quota" example:"500000"`
	TotalQuota   int64   `json:"total_quota" example:"10000000"`
	RequestCount int64   `json:"request_count" example:"2500"`
	LastUsedAt   *string `json:"last_used_at" example:"2024-01-15T10:30:00Z"`
}

// ==================== Admin - Provision 接口模型 ====================

// SwaggerProvisionResponse 一键开通用户响应。
type SwaggerProvisionResponse struct {
	User           SwaggerUser         `json:"user"`
	Subscription   SwaggerSubscription `json:"subscription"`
	ApiKey         *string             `json:"api_key" example:"sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxx"`
	ApiKeyAssigned bool                `json:"api_key_assigned" example:"false"`
}

// ==================== Admin - Model Mappings 接口模型 ====================

// SwaggerModelMappingListResponse 模型映射列表响应。
type SwaggerModelMappingListResponse struct {
	Items []SwaggerModelMapping `json:"items"`
	Total int                   `json:"total" example:"10"`
}

// SwaggerResolveModelResponse 模型路由测试响应。
type SwaggerResolveModelResponse struct {
	Model      string                    `json:"model" example:"gpt-4"`
	Providers  []SwaggerResolvedProvider `json:"providers"`
	Mismatches []SwaggerRouteMismatch    `json:"mismatches"`
	Count      int                       `json:"count" example:"2"`
	Message    string                    `json:"message,omitempty" example:"检测到部分 provider 的模型映射与 supported_models 不一致，已从候选集中剔除"`
}

// SwaggerResolvedProvider 脱敏的提供商信息。
type SwaggerResolvedProvider struct {
	ID           uuid.UUID `json:"id" example:"550e8400-e29b-41d4-a716-446655440000"`
	Name         string    `json:"name" example:"OpenAI Primary"`
	ProviderType string    `json:"provider_type" example:"openai"`
	BaseURL      string    `json:"base_url" example:"https://api.openai.com"`
	Priority     int       `json:"priority" example:"0"`
	Weight       int       `json:"weight" example:"100"`
	Status       string    `json:"status" example:"active"`
}

type SwaggerRouteMismatch struct {
	ProviderID   uuid.UUID `json:"provider_id" example:"550e8400-e29b-41d4-a716-446655440000"`
	ProviderName string    `json:"provider_name" example:"OpenAI Primary"`
	Reason       string    `json:"reason" example:"provider mapping matched model but supported_models does not include it"`
	Source       string    `json:"source" example:"mapping_vs_supported_models_mismatch"`
}

// ==================== Registry 接口模型 ====================

// SwaggerRegisterRequest 注册请求。
type SwaggerRegisterRequest struct {
	Name            string   `json:"name" binding:"required" example:"my-ai-service"`
	ProviderType    string   `json:"provider_type" binding:"required" example:"openai"`
	BaseURL         string   `json:"base_url" binding:"required" example:"https://api.openai.com"`
	APIKey          string   `json:"api_key" binding:"required" example:"sk-xxxx"`
	ModelsSupported []string `json:"models_supported" example:"gpt-4,gpt-3.5-turbo"`
	HealthCheckURL  string   `json:"health_check_url" example:"https://api.openai.com/v1/models"`
	Weight          int      `json:"weight" example:"100"`
	TotalQuota      int64    `json:"total_quota" example:"1000000000"`
}

// SwaggerRegisterResponse 注册响应。
type SwaggerRegisterResponse struct {
	ProviderID        uuid.UUID `json:"provider_id" example:"550e8400-e29b-41d4-a716-446655440000"`
	HeartbeatInterval int       `json:"heartbeat_interval_s" example:"30"`
}

// SwaggerRegistryStatusResponse Registry 通用状态响应。
type SwaggerRegistryStatusResponse struct {
	Status string `json:"status" example:"ok"`
}

// ==================== Anthropic Claude Messages API 模型 ====================

// SwaggerAnthropicRequest Anthropic Messages API 请求体。
type SwaggerAnthropicRequest struct {
	Model         string                    `json:"model" example:"claude-sonnet-4-20250514"`
	Messages      []SwaggerAnthropicMessage `json:"messages"`
	System        string                    `json:"system,omitempty" example:"你是一个有帮助的助手"`
	MaxTokens     int                       `json:"max_tokens" example:"1024"`
	Temperature   *float64                  `json:"temperature,omitempty" example:"1.0"`
	TopP          *float64                  `json:"top_p,omitempty" example:"0.9"`
	Stream        *bool                     `json:"stream,omitempty" example:"false"`
	StopSequences []string                  `json:"stop_sequences,omitempty" example:"[]"`
}

// SwaggerAnthropicMessage Anthropic 消息结构。
type SwaggerAnthropicMessage struct {
	Role    string `json:"role" example:"user"`
	Content string `json:"content" example:"Hello, Claude"`
}

// SwaggerAnthropicResponse Anthropic Messages API 非流式响应体。
type SwaggerAnthropicResponse struct {
	ID           string                  `json:"id" example:"msg_abc123"`
	Type         string                  `json:"type" example:"message"`
	Role         string                  `json:"role" example:"assistant"`
	Content      []SwaggerAnthropicBlock `json:"content"`
	Model        string                  `json:"model" example:"claude-sonnet-4-20250514"`
	StopReason   string                  `json:"stop_reason" example:"end_turn"`
	StopSequence string                  `json:"stop_sequence,omitempty" example:""`
	Usage        SwaggerAnthropicUsage   `json:"usage"`
}

// SwaggerAnthropicBlock Anthropic content block。
type SwaggerAnthropicBlock struct {
	Type string `json:"type" example:"text"`
	Text string `json:"text" example:"Hello! How can I help you?"`
}

// SwaggerAnthropicUsage Anthropic token 使用量。
type SwaggerAnthropicUsage struct {
	InputTokens  int `json:"input_tokens" example:"10"`
	OutputTokens int `json:"output_tokens" example:"20"`
}

// ==================== Google Gemini API 模型 ====================

// SwaggerGeminiRequest Gemini generateContent 请求体。
type SwaggerGeminiRequest struct {
	Contents          []SwaggerGeminiContent `json:"contents"`
	SystemInstruction *SwaggerGeminiPart     `json:"systemInstruction,omitempty"`
	GenerationConfig  *SwaggerGeminiGenCfg   `json:"generationConfig,omitempty"`
}

// SwaggerGeminiContent Gemini 对话内容。
type SwaggerGeminiContent struct {
	Role  string              `json:"role,omitempty" example:"user"`
	Parts []SwaggerGeminiPart `json:"parts"`
}

// SwaggerGeminiPart Gemini 内容片段。
type SwaggerGeminiPart struct {
	Text string `json:"text,omitempty" example:"Hello, Gemini"`
}

// SwaggerGeminiGenCfg Gemini 生成配置。
type SwaggerGeminiGenCfg struct {
	Temperature     *float64 `json:"temperature,omitempty" example:"0.9"`
	TopP            *float64 `json:"topP,omitempty" example:"0.95"`
	TopK            *int     `json:"topK,omitempty" example:"40"`
	MaxOutputTokens *int     `json:"maxOutputTokens,omitempty" example:"8192"`
	StopSequences   []string `json:"stopSequences,omitempty"`
}

// SwaggerGeminiResponse Gemini generateContent 非流式响应体。
type SwaggerGeminiResponse struct {
	Candidates     []SwaggerGeminiCandidate `json:"candidates"`
	PromptFeedback SwaggerGeminiPromptFB    `json:"promptFeedback,omitempty"`
	UsageMetadata  *SwaggerGeminiUsage      `json:"usageMetadata,omitempty"`
}

// SwaggerGeminiCandidate Gemini 响应候选项。
type SwaggerGeminiCandidate struct {
	Content      SwaggerGeminiContent `json:"content"`
	FinishReason string               `json:"finishReason,omitempty" example:"STOP"`
}

// SwaggerGeminiPromptFB Gemini prompt 反馈。
type SwaggerGeminiPromptFB struct {
	BlockReason string `json:"blockReason,omitempty" example:"NONE"`
}

// SwaggerGeminiUsage Gemini token 使用量。
type SwaggerGeminiUsage struct {
	PromptTokenCount     int `json:"promptTokenCount" example:"10"`
	CandidatesTokenCount int `json:"candidatesTokenCount" example:"20"`
	TotalTokenCount      int `json:"totalTokenCount" example:"30"`
}
