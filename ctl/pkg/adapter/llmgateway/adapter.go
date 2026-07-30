package llmgateway

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"ctl/pkg/config"

	"go.uber.org/zap"
)

// Adapter 定义 LLMGateway 对外暴露的操作接口
type Adapter interface {
	// CreateApiKey 调用 LLMGateway 为指定用户创建 API Key
	CreateApiKey(ctx context.Context, userID string, name string) (*CreateApiKeyResponse, error)
	// EnsureUser 调用 LLMGateway Internal API 确保业务用户在网关内存在
	EnsureUser(ctx context.Context, userID string, nickname string) (*EnsureUserResponse, error)
	// GetUserUsage 调用 LLMGateway admin API 获取用户用量概览
	GetUserUsage(ctx context.Context, userID string) (*UserUsageResponse, error)

	// GetPlan 调用 LLMGateway Internal API 获取指定 Plan 详情
	// 用于 ImportBundle 校验 monthly_tokens / period 与 bundle 字段一致
	GetPlan(ctx context.Context, planID string) (*Plan, error)
	// ApplySubscription 调用 LLMGateway Internal API 为用户开通订阅
	// 幂等：重复调用会取消旧订阅并创建新订阅
	// R-MR-3 改造：req.PeriodValue/PeriodUnit 透传购买时长（Q9=i1 llmgateway 真源）；
	// 未传时 llmgateway 回退到 plan.PeriodValue/PeriodUnit 兜底（Q10=j1）。
	ApplySubscription(ctx context.Context, req *ApplySubscriptionRequest) (*Subscription, error)
	// CancelSubscription 调用 LLMGateway Internal API 取消用户当前订阅
	CancelSubscription(ctx context.Context, userID string) error
	// GetActiveSubscription 调用 LLMGateway Internal API 查询用户当前活跃订阅
	// 无订阅时返回 (nil, nil)
	GetActiveSubscription(ctx context.Context, userID string) (*Subscription, error)
	// ListActiveSubscriptions 调用 LLMGateway Internal API 查询用户所有活跃订阅
	ListActiveSubscriptions(ctx context.Context, userID string) (*ActiveSubscriptionList, error)
}

// LLMGatewayAdapter LLMGateway HTTP 适配器
type LLMGatewayAdapter struct {
	baseURL       string
	adminToken    string
	internalToken string
	httpClient    *http.Client
	logger        *zap.Logger
}

// NewLLMGatewayAdapter 创建 LLMGateway 适配器
func NewLLMGatewayAdapter(conf *config.LLMGatewayConfig, logger *zap.Logger) *LLMGatewayAdapter {
	if conf == nil {
		conf = &config.LLMGatewayConfig{}
	}
	if logger == nil {
		logger = zap.NewNop()
	}

	timeout := time.Duration(conf.Timeout) * time.Second
	if conf.Timeout <= 0 {
		timeout = 10 * time.Second
	}

	return &LLMGatewayAdapter{
		baseURL:       strings.TrimRight(conf.BaseURL, "/"),
		adminToken:    strings.TrimSpace(conf.AdminToken),
		internalToken: strings.TrimSpace(conf.InternalServiceToken),
		httpClient: &http.Client{
			Timeout: timeout,
			Transport: &http.Transport{
				DialContext: (&net.Dialer{
					Timeout:   timeout,
					KeepAlive: 30 * time.Second,
				}).DialContext,
				MaxIdleConns:        5,
				MaxIdleConnsPerHost: 5,
				IdleConnTimeout:     30 * time.Second,
			},
		},
		logger: logger.With(zap.String("component", "llmgateway-adapter")),
	}
}

// CreateApiKey 调用 POST /api/admin/users/:user_id/api-keys
func (a *LLMGatewayAdapter) CreateApiKey(ctx context.Context, userID string, name string) (*CreateApiKeyResponse, error) {
	if a.baseURL == "" {
		return nil, fmt.Errorf("llmgateway base_url not configured")
	}

	req := &CreateApiKeyRequest{Name: name}
	body, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("marshal create-api-key request: %w", err)
	}

	url := a.baseURL + "/api/admin/users/" + userID + "/api-keys"
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("create api-key request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Accept", "application/json")
	a.applyAdminAuth(httpReq)

	start := time.Now()
	resp, err := a.httpClient.Do(httpReq)
	duration := time.Since(start)

	if err != nil {
		a.logger.Warn("llmgateway create-api-key request failed",
			zap.String("url", url),
			zap.Duration("duration", duration),
			zap.Error(err),
		)
		return nil, fmt.Errorf("create-api-key request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read create-api-key response: %w", err)
	}

	a.logger.Info("llmgateway create-api-key response",
		zap.String("url", url),
		zap.Int("status", resp.StatusCode),
		zap.Duration("duration", duration),
	)

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("create-api-key returned status %d: %s", resp.StatusCode, string(respBody))
	}

	var result CreateApiKeyResponse
	var apiResp apiResponse
	if err := json.Unmarshal(respBody, &apiResp); err == nil && len(apiResp.Data) > 0 {
		if err := json.Unmarshal(apiResp.Data, &result); err != nil {
			return nil, fmt.Errorf("decode create-api-key data: %w", err)
		}
		return &result, nil
	}

	if err := json.Unmarshal(respBody, &result); err != nil {
		return nil, fmt.Errorf("decode create-api-key response body: %w", err)
	}
	return &result, nil
}

// GetUserUsage 调用 GET /api/admin/users/:user_id/usage
func (a *LLMGatewayAdapter) GetUserUsage(ctx context.Context, userID string) (*UserUsageResponse, error) {
	if a.baseURL == "" {
		return nil, fmt.Errorf("llmgateway base_url not configured")
	}
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return nil, fmt.Errorf("user_id is required")
	}

	reqURL := a.baseURL + "/api/admin/users/" + url.PathEscape(userID) + "/usage?days=30"
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return nil, fmt.Errorf("create get-user-usage request: %w", err)
	}
	httpReq.Header.Set("Accept", "application/json")
	a.applyAdminAuth(httpReq)

	start := time.Now()
	resp, err := a.httpClient.Do(httpReq)
	duration := time.Since(start)
	if err != nil {
		a.logger.Warn("llmgateway get-user-usage request failed",
			zap.String("url", reqURL),
			zap.Duration("duration", duration),
			zap.Error(err),
		)
		return nil, fmt.Errorf("get-user-usage request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read get-user-usage response: %w", err)
	}

	a.logger.Info("llmgateway get-user-usage response",
		zap.String("url", reqURL),
		zap.Int("status", resp.StatusCode),
		zap.Duration("duration", duration),
	)

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("get-user-usage returned status %d: %s", resp.StatusCode, string(respBody))
	}

	var result UserUsageResponse
	if err := json.Unmarshal(respBody, &result); err != nil {
		return nil, fmt.Errorf("decode get-user-usage response: %w", err)
	}
	return &result, nil
}

func (a *LLMGatewayAdapter) applyAdminAuth(req *http.Request) {
	if req == nil {
		return
	}
	if strings.TrimSpace(a.adminToken) == "" {
		return
	}
	req.Header.Set("Authorization", "Bearer "+a.adminToken)
}

// applyInternalAuth 应用 Internal API 认证头
func (a *LLMGatewayAdapter) applyInternalAuth(req *http.Request) {
	if req == nil {
		return
	}
	if a.internalToken == "" {
		return
	}
	req.Header.Set("Authorization", "Bearer "+a.internalToken)
}

// EnsureUser 调用 POST /api/internal/users/ensure
func (a *LLMGatewayAdapter) EnsureUser(ctx context.Context, userID string, nickname string) (*EnsureUserResponse, error) {
	if a.baseURL == "" {
		return nil, fmt.Errorf("llmgateway base_url not configured")
	}
	if a.internalToken == "" {
		return nil, fmt.Errorf("llmgateway internal_service_token not configured")
	}
	userID = strings.TrimSpace(userID)
	nickname = strings.TrimSpace(nickname)
	if userID == "" {
		return nil, fmt.Errorf("llmgateway user_id is required")
	}

	reqBody, err := json.Marshal(&EnsureUserRequest{UserID: userID, Nickname: nickname})
	if err != nil {
		return nil, fmt.Errorf("marshal ensure-user request: %w", err)
	}

	reqURL := a.baseURL + "/api/internal/users/ensure"
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, reqURL, bytes.NewReader(reqBody))
	if err != nil {
		return nil, fmt.Errorf("create ensure-user request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Accept", "application/json")
	a.applyInternalAuth(httpReq)

	start := time.Now()
	resp, err := a.httpClient.Do(httpReq)
	duration := time.Since(start)
	if err != nil {
		a.logger.Warn("llmgateway ensure-user request failed",
			zap.String("url", reqURL), zap.Duration("duration", duration), zap.Error(err))
		return nil, fmt.Errorf("ensure-user request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read ensure-user response: %w", err)
	}

	a.logger.Info("llmgateway ensure-user response",
		zap.String("url", reqURL), zap.Int("status", resp.StatusCode), zap.Duration("duration", duration))

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("ensure-user returned status %d: %s", resp.StatusCode, string(respBody))
	}

	var result EnsureUserResponse
	var wrapped apiResponse
	if err := json.Unmarshal(respBody, &wrapped); err == nil && len(wrapped.Data) > 0 {
		if err := json.Unmarshal(wrapped.Data, &result); err != nil {
			return nil, fmt.Errorf("decode ensure-user data: %w", err)
		}
		return &result, nil
	}
	if err := json.Unmarshal(respBody, &result); err != nil {
		return nil, fmt.Errorf("decode ensure-user response body: %w", err)
	}
	return &result, nil
}

// ErrLLMGatewayPlanNotFound Plan 不存在
var ErrLLMGatewayPlanNotFound = fmt.Errorf("llmgateway plan not found")

// ErrLLMGatewaySubscriptionNotFound 订阅不存在
var ErrLLMGatewaySubscriptionNotFound = fmt.Errorf("llmgateway active subscription not found")

// ErrLLMGatewayRouteNotFound llmgateway 路由不存在（gin 默认 404，返 'page not found' 纯文本）。
//
// 区分业务 404（用户/订阅不存在—llmgateway 返 OpenAI 风格 JSON 含 error.code）与
// 路由 404（llmgateway 镜像未升级 / 路由未注册，gin 其他默认文本）的哨兵。
var ErrLLMGatewayRouteNotFound = fmt.Errorf("llmgateway route not found (likely deployment lag)")

// GetPlan 调用 GET /api/internal/plans/:id
func (a *LLMGatewayAdapter) GetPlan(ctx context.Context, planID string) (*Plan, error) {
	if a.baseURL == "" {
		return nil, fmt.Errorf("llmgateway base_url not configured")
	}
	if a.internalToken == "" {
		return nil, fmt.Errorf("llmgateway internal_service_token not configured")
	}
	planID = strings.TrimSpace(planID)
	if planID == "" {
		return nil, fmt.Errorf("llmgateway plan_id is required")
	}

	reqURL := a.baseURL + "/api/internal/plans/" + url.PathEscape(planID)
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return nil, fmt.Errorf("create get-plan request: %w", err)
	}
	httpReq.Header.Set("Accept", "application/json")
	a.applyInternalAuth(httpReq)

	start := time.Now()
	resp, err := a.httpClient.Do(httpReq)
	duration := time.Since(start)
	if err != nil {
		a.logger.Warn("llmgateway get-plan request failed",
			zap.String("url", reqURL), zap.Duration("duration", duration), zap.Error(err))
		return nil, fmt.Errorf("get-plan request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read get-plan response: %w", err)
	}

	a.logger.Info("llmgateway get-plan response",
		zap.String("url", reqURL), zap.Int("status", resp.StatusCode), zap.Duration("duration", duration))

	if resp.StatusCode == http.StatusNotFound {
		return nil, ErrLLMGatewayPlanNotFound
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("get-plan returned status %d: %s", resp.StatusCode, string(respBody))
	}

	plan, err := decodePlan(respBody)
	if err != nil {
		return nil, fmt.Errorf("decode get-plan response: %w", err)
	}
	return plan, nil
}

// ApplySubscription 调用 POST /api/internal/subscriptions/apply
//
// PeriodValue/PeriodUnit 仅作为兼容输入透传；不再支持 period_end。
func (a *LLMGatewayAdapter) ApplySubscription(ctx context.Context, req *ApplySubscriptionRequest) (*Subscription, error) {
	if a.baseURL == "" {
		return nil, fmt.Errorf("llmgateway base_url not configured")
	}
	if a.internalToken == "" {
		return nil, fmt.Errorf("llmgateway internal_service_token not configured")
	}
	if req == nil {
		return nil, fmt.Errorf("llmgateway apply-subscription req is nil")
	}
	req.UserID = strings.TrimSpace(req.UserID)
	req.PlanID = strings.TrimSpace(req.PlanID)
	if req.UserID == "" || req.PlanID == "" {
		return nil, fmt.Errorf("llmgateway user_id and plan_id are required")
	}

	reqBody, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("marshal apply-subscription request: %w", err)
	}

	reqURL := a.baseURL + "/api/internal/subscriptions/apply"
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, reqURL, bytes.NewReader(reqBody))
	if err != nil {
		return nil, fmt.Errorf("create apply-subscription request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Accept", "application/json")
	a.applyInternalAuth(httpReq)

	start := time.Now()
	resp, err := a.httpClient.Do(httpReq)
	duration := time.Since(start)
	if err != nil {
		a.logger.Warn("llmgateway apply-subscription request failed",
			zap.String("url", reqURL), zap.Duration("duration", duration), zap.Error(err))
		return nil, fmt.Errorf("apply-subscription request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read apply-subscription response: %w", err)
	}

	a.logger.Info("llmgateway apply-subscription response",
		zap.String("url", reqURL), zap.Int("status", resp.StatusCode), zap.Duration("duration", duration))

	if resp.StatusCode == http.StatusNotFound {
		return nil, ErrLLMGatewayPlanNotFound
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("apply-subscription returned status %d: %s", resp.StatusCode, string(respBody))
	}

	sub, err := decodeSubscription(respBody)
	if err != nil {
		return nil, fmt.Errorf("decode apply-subscription response: %w", err)
	}
	return sub, nil
}

// CancelSubscription 调用 POST /api/internal/subscriptions/cancel
func (a *LLMGatewayAdapter) CancelSubscription(ctx context.Context, userID string) error {
	if a.baseURL == "" {
		return fmt.Errorf("llmgateway base_url not configured")
	}
	if a.internalToken == "" {
		return fmt.Errorf("llmgateway internal_service_token not configured")
	}
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return fmt.Errorf("llmgateway user_id is required")
	}

	reqBody, err := json.Marshal(&CancelSubscriptionRequest{UserID: userID})
	if err != nil {
		return fmt.Errorf("marshal cancel-subscription request: %w", err)
	}

	reqURL := a.baseURL + "/api/internal/subscriptions/cancel"
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, reqURL, bytes.NewReader(reqBody))
	if err != nil {
		return fmt.Errorf("create cancel-subscription request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Accept", "application/json")
	a.applyInternalAuth(httpReq)

	start := time.Now()
	resp, err := a.httpClient.Do(httpReq)
	duration := time.Since(start)
	if err != nil {
		a.logger.Warn("llmgateway cancel-subscription request failed",
			zap.String("url", reqURL), zap.Duration("duration", duration), zap.Error(err))
		return fmt.Errorf("cancel-subscription request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("read cancel-subscription response: %w", err)
	}

	a.logger.Info("llmgateway cancel-subscription response",
		zap.String("url", reqURL), zap.Int("status", resp.StatusCode), zap.Duration("duration", duration))

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("cancel-subscription returned status %d: %s", resp.StatusCode, string(respBody))
	}
	return nil
}

// GetActiveSubscription 调用 GET /api/internal/users/:user_id/subscriptions
// 无订阅或用户不存在时返回 (nil, nil)，调用方按需处理
func (a *LLMGatewayAdapter) GetActiveSubscription(ctx context.Context, userID string) (*Subscription, error) {
	if a.baseURL == "" {
		return nil, fmt.Errorf("llmgateway base_url not configured")
	}
	if a.internalToken == "" {
		return nil, fmt.Errorf("llmgateway internal_service_token not configured")
	}
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return nil, fmt.Errorf("llmgateway user_id is required")
	}

	reqURL := a.baseURL + "/api/internal/users/" + url.PathEscape(userID) + "/subscriptions"
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return nil, fmt.Errorf("create get-active-subscription request: %w", err)
	}
	httpReq.Header.Set("Accept", "application/json")
	a.applyInternalAuth(httpReq)

	start := time.Now()
	resp, err := a.httpClient.Do(httpReq)
	duration := time.Since(start)
	if err != nil {
		a.logger.Warn("llmgateway get-active-subscription request failed",
			zap.String("url", reqURL), zap.Duration("duration", duration), zap.Error(err))
		return nil, fmt.Errorf("get-active-subscription request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read get-active-subscription response: %w", err)
	}

	a.logger.Info("llmgateway get-active-subscription response",
		zap.String("url", reqURL), zap.Int("status", resp.StatusCode), zap.Duration("duration", duration))

	if resp.StatusCode == http.StatusNotFound {
		// 视为无订阅
		return nil, nil
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("get-active-subscription returned status %d: %s", resp.StatusCode, string(respBody))
	}

	sub, err := decodeSubscription(respBody)
	if err != nil {
		return nil, fmt.Errorf("decode get-active-subscription response: %w", err)
	}
	return sub, nil
}

// ListActiveSubscriptions 调用 GET /api/internal/users/:user_id/subscriptions/active
func (a *LLMGatewayAdapter) ListActiveSubscriptions(ctx context.Context, userID string) (*ActiveSubscriptionList, error) {
	if a.baseURL == "" {
		return nil, fmt.Errorf("llmgateway base_url not configured")
	}
	if a.internalToken == "" {
		return nil, fmt.Errorf("llmgateway internal_service_token not configured")
	}
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return nil, fmt.Errorf("llmgateway user_id is required")
	}

	reqURL := a.baseURL + "/api/internal/users/" + url.PathEscape(userID) + "/subscriptions/active"
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return nil, fmt.Errorf("create list-active-subscriptions request: %w", err)
	}
	httpReq.Header.Set("Accept", "application/json")
	a.applyInternalAuth(httpReq)

	start := time.Now()
	resp, err := a.httpClient.Do(httpReq)
	duration := time.Since(start)
	if err != nil {
		a.logger.Warn("llmgateway list-active-subscriptions request failed",
			zap.String("url", reqURL), zap.Duration("duration", duration), zap.Error(err))
		return nil, fmt.Errorf("list-active-subscriptions request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read list-active-subscriptions response: %w", err)
	}

	a.logger.Info("llmgateway list-active-subscriptions response",
		zap.String("url", reqURL), zap.Int("status", resp.StatusCode), zap.Duration("duration", duration))

	if resp.StatusCode == http.StatusNotFound {
		if isLLMGatewayBusinessErrorBody(respBody) {
			return &ActiveSubscriptionList{UserID: userID, Subscriptions: []Subscription{}}, nil
		}
		a.logger.Warn("llmgateway list-active-subscriptions returned route 404 (likely deployment lag)",
			zap.String("url", reqURL), zap.String("body", string(respBody)))
		return nil, ErrLLMGatewayRouteNotFound
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("list-active-subscriptions returned status %d: %s", resp.StatusCode, string(respBody))
	}

	list, err := decodeActiveSubscriptionList(respBody)
	if err != nil {
		return nil, fmt.Errorf("decode list-active-subscriptions response: %w", err)
	}
	if list.Subscriptions == nil {
		list.Subscriptions = []Subscription{}
	}
	return list, nil
}

// decodePlan 解析响应体（支持 apiResponse 包装或裸 Plan）
func decodePlan(body []byte) (*Plan, error) {
	var wrapped apiResponse
	if err := json.Unmarshal(body, &wrapped); err == nil && len(wrapped.Data) > 0 {
		var p Plan
		if err := json.Unmarshal(wrapped.Data, &p); err == nil {
			return &p, nil
		}
	}
	var p Plan
	if err := json.Unmarshal(body, &p); err != nil {
		return nil, err
	}
	return &p, nil
}

// decodeSubscription 解析响应体（支持 apiResponse 包装或裸 Subscription）
func decodeSubscription(body []byte) (*Subscription, error) {
	var wrapped apiResponse
	if err := json.Unmarshal(body, &wrapped); err == nil && len(wrapped.Data) > 0 {
		var s Subscription
		if err := json.Unmarshal(wrapped.Data, &s); err == nil {
			return &s, nil
		}
	}
	var s Subscription
	if err := json.Unmarshal(body, &s); err != nil {
		return nil, err
	}
	return &s, nil
}

// decodeActiveSubscriptionList 解析响应体（支持 apiResponse 包装或裸 ActiveSubscriptionList）
func decodeActiveSubscriptionList(body []byte) (*ActiveSubscriptionList, error) {
	var wrapped apiResponse
	if err := json.Unmarshal(body, &wrapped); err == nil && len(wrapped.Data) > 0 {
		var list ActiveSubscriptionList
		if err := json.Unmarshal(wrapped.Data, &list); err == nil {
			return &list, nil
		}
	}
	var list ActiveSubscriptionList
	if err := json.Unmarshal(body, &list); err != nil {
		return nil, err
	}
	return &list, nil
}

// isLLMGatewayBusinessErrorBody 判别 body 是否 llmgateway 业务错误 JSON（OpenAI 风格
// {error: {code, message, type}}）。路由 404（gin 默认 "404 page not found\n" 纯文本）
// 不能解析为该结构，返 false。采用严格判别：必须同时含 error.code 与 error.message 才
// 认为是业务错误（避免可能的路由 404 正好被偶然解析为空 JSON 有個误判）。
func isLLMGatewayBusinessErrorBody(body []byte) bool {
	var parsed struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return false
	}
	return parsed.Error.Code != "" && parsed.Error.Message != ""
}

var _ Adapter = (*LLMGatewayAdapter)(nil)
