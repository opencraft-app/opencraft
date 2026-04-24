package handler

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"git.woa.com/wisp/mono/ai-gateway/internal/adapter"
	"git.woa.com/wisp/mono/ai-gateway/internal/middleware"
	"git.woa.com/wisp/mono/ai-gateway/internal/model"
	"git.woa.com/wisp/mono/ai-gateway/internal/pkg/response"
	"git.woa.com/wisp/mono/ai-gateway/internal/serverstate"
	"git.woa.com/wisp/mono/ai-gateway/internal/service"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

const requestModelContextKey = "request_model"

const (
	fallbackReasonNoAvailableProvider = "no_available_provider"
	fallbackReasonProvidersFiltered   = "providers_filtered"
	fallbackReasonProviderKeysInvalid = "provider_keys_invalid"
	fallbackReasonProvidersExhausted  = "providers_exhausted"
)

type providerFailureAction string

const (
	providerFailureRetryNextProvider providerFailureAction = "retry_next_provider"
	providerFailureFallbackNextModel providerFailureAction = "fallback_next_model"
	providerFailureReturnToClient    providerFailureAction = "return_to_client"
)

type modelExecutionPlan struct {
	OriginalModel   string
	ResolvedModel   string
	FallbackReason  string
	FallbackApplied bool
	Candidates      []model.Provider
	DecryptedKeys   map[string]string
	MappingStrategy *MappingStrategy
}

// CircuitBreakerOps 定义熔断器操作接口，支持分布式和本地实现。
type CircuitBreakerOps interface {
	IsOpen(providerID uuid.UUID) bool
	RecordSuccess(providerID uuid.UUID) string
	RecordFailure(providerID uuid.UUID) (string, int)
}

type ProxyHandler struct {
	billingSvc     *service.BillingService
	providerSvc    *service.ProviderService
	portkeyURL     string
	httpClient     *http.Client
	circuitBreaker CircuitBreakerOps // 支持 DistributedCircuitBreaker 或 CircuitBreaker
	configStore    *service.RuntimeConfigStore
	cacheSvc       *service.CacheService // 语义缓存服务（可为 nil）
	inflightBudget *serverstate.InflightBudget
	cooldownStore  *service.ProviderCooldownStore
	gatewayConfig  service.GatewayConfig
	usageSink      service.UsageSink
}

type completionProxyRequest struct {
	Model       string   `json:"model,omitempty"`
	Prompt      any      `json:"prompt"`
	MaxTokens   *int     `json:"max_tokens,omitempty"`
	Temperature *float64 `json:"temperature,omitempty"`
	Stream      *bool    `json:"stream,omitempty"`
}

type completionProxyResponse struct {
	ID      string                    `json:"id"`
	Object  string                    `json:"object"`
	Created int64                     `json:"created"`
	Model   string                    `json:"model"`
	Choices []SwaggerCompletionChoice `json:"choices"`
	Usage   SwaggerUsage              `json:"usage"`
}

func NewProxyHandler(
	billingSvc *service.BillingService,
	providerSvc *service.ProviderService,
	portkeyURL string,
	cb CircuitBreakerOps,
	configStore *service.RuntimeConfigStore,
	cacheSvc *service.CacheService,
	httpClient *http.Client,
	inflightBudget *serverstate.InflightBudget,
	cooldownStore *service.ProviderCooldownStore,
	gatewayConfig service.GatewayConfig,
) *ProxyHandler {
	return &ProxyHandler{
		billingSvc:     billingSvc,
		providerSvc:    providerSvc,
		portkeyURL:     strings.TrimRight(portkeyURL, "/"),
		httpClient:     httpClient,
		circuitBreaker: cb,
		configStore:    configStore,
		cacheSvc:       cacheSvc,
		inflightBudget: inflightBudget,
		cooldownStore:  cooldownStore,
		gatewayConfig:  gatewayConfig,
	}
}

func (h *ProxyHandler) SetUsageSink(sink service.UsageSink) {
	h.usageSink = sink
}

// ChatCompletions handles POST /v1/chat/completions
// @Summary Create chat completion
// @Description Proxy request to LLM provider for chat completions (OpenAI-compatible). Supports streaming via stream=true.
// @Tags Proxy
// @Accept json
// @Produce json
// @Param request body SwaggerChatCompletionRequest true "Chat completion request (OpenAI format)"
// @Security BearerAuth
// @Success 200 {object} SwaggerChatCompletionResponse "Chat completion response"
// @Failure 400 {object} SwaggerErrorResponse "Bad request"
// @Failure 401 {object} SwaggerErrorResponse "Unauthorized - invalid API key"
// @Failure 429 {object} SwaggerErrorResponse "Quota or rate limit exceeded"
// @Failure 502 {object} SwaggerErrorResponse "Upstream provider error"
// @Router /v1/chat/completions [post]
func (h *ProxyHandler) ChatCompletions(c *gin.Context) {
	h.proxyRequest(c, "/v1/chat/completions")
}

// Completions handles POST /v1/completions
// @Summary Create completion
// @Description Proxy request to LLM provider for text completions (OpenAI-compatible, legacy endpoint)
// @Tags Proxy
// @Accept json
// @Produce json
// @Param request body SwaggerCompletionRequest true "Completion request (OpenAI format)"
// @Security BearerAuth
// @Success 200 {object} SwaggerCompletionResponse "Completion response"
// @Failure 400 {object} SwaggerErrorResponse "Bad request"
// @Failure 401 {object} SwaggerErrorResponse "Unauthorized - invalid API key"
// @Router /v1/completions [post]
func (h *ProxyHandler) Completions(c *gin.Context) {
	body, err := io.ReadAll(c.Request.Body)
	if err != nil {
		response.ErrBadRequest(c, "Failed to read request body")
		return
	}

	convertedBody, err := convertCompletionRequestToChat(body)
	if err != nil {
		response.ErrBadRequest(c, err.Error())
		return
	}

	c.Request.Body = io.NopCloser(bytes.NewReader(convertedBody))
	c.Request.ContentLength = int64(len(convertedBody))
	c.Set("request_body", convertedBody)
	c.Set("completion_response_mode", true)

	var req struct {
		Model string `json:"model"`
	}
	if err := json.Unmarshal(convertedBody, &req); err == nil {
		c.Set(requestModelContextKey, req.Model)
	}

	h.proxyRequest(c, "/v1/chat/completions")
}

// Embeddings handles POST /v1/embeddings (no streaming)
// @Summary Create embeddings
// @Description Proxy request to LLM provider for text embeddings (OpenAI-compatible, no streaming)
// @Tags Embeddings
// @Accept json
// @Produce json
// @Param request body SwaggerEmbeddingRequest true "Embeddings request (OpenAI format)"
// @Security BearerAuth
// @Success 200 {object} SwaggerEmbeddingResponse "Embeddings response"
// @Failure 400 {object} SwaggerErrorResponse "Bad request"
// @Failure 401 {object} SwaggerErrorResponse "Unauthorized - invalid API key"
// @Router /v1/embeddings [post]
func (h *ProxyHandler) Embeddings(c *gin.Context) {
	h.proxyRequest(c, "/v1/embeddings")
}

// Models returns the user's allowed models as OpenAI-compatible model list.
// @Summary List models
// @Description Returns the list of models allowed for the authenticated user's plan (OpenAI-compatible format)
// @Tags Models
// @Produce json
// @Security BearerAuth
// @Success 200 {object} SwaggerModelListResponse "Model list (OpenAI format)"
// @Failure 401 {object} SwaggerErrorResponse "Unauthorized - invalid API key"
// @Router /v1/models [get]
func (h *ProxyHandler) Models(c *gin.Context) {
	plan := middleware.GetPlanFromContext(c)
	if plan == nil {
		response.ErrInternal(c)
		return
	}

	var allowedModels []string
	if err := json.Unmarshal(plan.AllowedModels, &allowedModels); err != nil {
		allowedModels = []string{}
	}

	var models []map[string]interface{}
	for _, m := range allowedModels {
		models = append(models, map[string]interface{}{
			"id":       m,
			"object":   "model",
			"created":  time.Now().Unix(),
			"owned_by": "organization",
		})
	}

	c.JSON(http.StatusOK, gin.H{
		"object": "list",
		"data":   models,
	})
}

// AnthropicMessages handles POST /v1/messages (Anthropic Claude Messages API).
// FormatAdapter 将 Anthropic 格式转为 OpenAI 格式，ResponseAdapter 将响应转回 Anthropic 格式。
// @Summary Claude Messages API
// @Description Anthropic Claude Messages API 端点，支持 messages、system、streaming。FormatAdapter 自动将 Anthropic 格式转为 OpenAI 格式，ResponseAdapter 将响应转回 Anthropic 格式。
// @Tags Proxy
// @Accept json
// @Produce json, text/event-stream
// @Param request body SwaggerAnthropicRequest true "Claude Messages API 请求体"
// @Security BearerAuth
// @Success 200 {object} SwaggerAnthropicResponse
// @Failure 400 {object} SwaggerErrorResponse "Bad request"
// @Failure 401 {object} SwaggerErrorResponse "Unauthorized - invalid API key"
// @Failure 429 {object} SwaggerErrorResponse "Quota or rate limit exceeded"
// @Failure 502 {object} SwaggerErrorResponse "Upstream provider error"
// @Router /v1/messages [post]
func (h *ProxyHandler) AnthropicMessages(c *gin.Context) {
	h.proxyRequest(c, "/v1/chat/completions")
}

// GeminiGenerate handles POST /v1beta/models/{path} (Google Gemini API).
// FormatAdapter 将 Gemini 格式转为 OpenAI 格式，ResponseAdapter 将响应转回 Gemini 格式。
// @Summary Gemini Generate Content API
// @Description Google Gemini generateContent API 端点，支持 generateContent 和 streamGenerateContent。FormatAdapter 自动将 Gemini 格式转为 OpenAI 格式，ResponseAdapter 将响应转回 Gemini 格式。
// @Tags Proxy
// @Accept json
// @Produce json, text/event-stream
// @Param path path string true "Gemini 模型路径，如 gemini-2.0-flash:generateContent"
// @Param request body SwaggerGeminiRequest true "Gemini generateContent 请求体"
// @Security BearerAuth
// @Success 200 {object} SwaggerGeminiResponse
// @Failure 400 {object} SwaggerErrorResponse "Bad request"
// @Failure 401 {object} SwaggerErrorResponse "Unauthorized - invalid API key"
// @Failure 429 {object} SwaggerErrorResponse "Quota or rate limit exceeded"
// @Failure 502 {object} SwaggerErrorResponse "Upstream provider error"
// @Router /v1beta/models/{path} [post]
func (h *ProxyHandler) GeminiGenerate(c *gin.Context) {
	h.proxyRequest(c, "/v1/chat/completions")
}

// getRequestID retrieves the request_id set by the logging middleware.
func getRequestID(c *gin.Context) string {
	if v, exists := c.Get("request_id"); exists {
		if id, ok := v.(string); ok {
			return id
		}
	}
	return uuid.New().String()
}

func resolveAutoModel(plan *model.Plan, defaultModel string) (string, error) {
	var allowedModels []string
	if err := json.Unmarshal(plan.AllowedModels, &allowedModels); err != nil {
		return "", fmt.Errorf("parse allowed models: %w", err)
	}

	normalizedDefault := strings.TrimSpace(defaultModel)
	if normalizedDefault != "" {
		for _, modelName := range allowedModels {
			if strings.EqualFold(strings.TrimSpace(modelName), normalizedDefault) {
				return normalizedDefault, nil
			}
		}
	}

	for _, modelName := range allowedModels {
		if trimmed := strings.TrimSpace(modelName); trimmed != "" {
			return trimmed, nil
		}
	}

	return "", fmt.Errorf("no allowed models available")
}

func listFallbackModels(plan *model.Plan, originalModel string) []string {
	var allowedModels []string
	if err := json.Unmarshal(plan.AllowedModels, &allowedModels); err != nil {
		return nil
	}

	normalizedOriginal := strings.ToLower(strings.TrimSpace(originalModel))
	seen := make(map[string]struct{}, len(allowedModels))
	var result []string
	for _, modelName := range allowedModels {
		trimmed := strings.TrimSpace(modelName)
		normalized := strings.ToLower(trimmed)
		if trimmed == "" || normalized == normalizedOriginal {
			continue
		}
		if _, exists := seen[normalized]; exists {
			continue
		}
		seen[normalized] = struct{}{}
		result = append(result, trimmed)
	}
	return result
}

func selectFallbackModel(ctx context.Context, providerSvc *service.ProviderService, plan *model.Plan, originalModel string) (*modelExecutionPlan, error) {
	for _, modelName := range listFallbackModels(plan, originalModel) {
		resolution, err := providerSvc.ResolveCandidatesForModel(modelName)
		if err != nil || resolution == nil || len(resolution.Candidates) == 0 {
			continue
		}
		return &modelExecutionPlan{
			OriginalModel:   strings.TrimSpace(originalModel),
			ResolvedModel:   modelName,
			FallbackReason:  fallbackReasonNoAvailableProvider,
			FallbackApplied: true,
		}, nil
	}

	return nil, model.ErrProviderUnavailable
}

func classifyProviderFailure(statusCode int, body []byte) providerFailureAction {
	switch {
	case statusCode == http.StatusUnauthorized,
		statusCode == http.StatusForbidden,
		statusCode == http.StatusNotFound,
		statusCode == http.StatusTooManyRequests,
		statusCode >= http.StatusInternalServerError:
		return providerFailureRetryNextProvider
	case statusCode == http.StatusBadRequest:
		if isRetryableProviderBadRequest(body) {
			return providerFailureRetryNextProvider
		}
	}
	return providerFailureReturnToClient
}

func isRetryableProviderBadRequest(body []byte) bool {
	rawText := strings.ToLower(strings.TrimSpace(string(body)))

	var payload struct {
		Error struct {
			Message string `json:"message"`
			Code    string `json:"code"`
		} `json:"error"`
		Detail string `json:"detail"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return isRetryableProviderModelErrorText(rawText)
	}

	candidateText := strings.ToLower(strings.TrimSpace(payload.Error.Message + " " + payload.Error.Code + " " + payload.Detail + " " + rawText))
	return isRetryableProviderModelErrorText(candidateText)
}

func isRetryableProviderModelErrorText(text string) bool {
	return strings.Contains(text, "invalid model") ||
		strings.Contains(text, "unsupported model") ||
		strings.Contains(text, "model not found") ||
		strings.Contains(text, "unknown model") ||
		strings.Contains(text, "20033")
}

func applyModelResolutionHeaders(c *gin.Context, plan *modelExecutionPlan) {
	if plan == nil {
		return
	}
	c.Header("X-AI-Gateway-Original-Model", plan.OriginalModel)
	c.Header("X-AI-Gateway-Resolved-Model", plan.ResolvedModel)
	if plan.FallbackApplied {
		c.Header("X-AI-Gateway-Model-Fallback", "true")
		c.Header("X-AI-Gateway-Fallback-Reason", plan.FallbackReason)
	}
}

func convertCompletionRequestToChat(body []byte) ([]byte, error) {
	var req completionProxyRequest
	if err := json.Unmarshal(body, &req); err != nil {
		return nil, fmt.Errorf("invalid completion request: %w", err)
	}

	promptText := flattenCompletionPrompt(req.Prompt)
	if strings.TrimSpace(promptText) == "" {
		return nil, fmt.Errorf("missing or invalid 'prompt' field")
	}

	chatReq := map[string]any{
		"messages": []map[string]string{
			{
				"role":    "user",
				"content": promptText,
			},
		},
	}
	if strings.TrimSpace(req.Model) != "" {
		chatReq["model"] = strings.TrimSpace(req.Model)
	}
	if req.MaxTokens != nil {
		chatReq["max_tokens"] = *req.MaxTokens
	}
	if req.Temperature != nil {
		chatReq["temperature"] = *req.Temperature
	}
	if req.Stream != nil {
		chatReq["stream"] = *req.Stream
	}

	return json.Marshal(chatReq)
}

func flattenCompletionPrompt(prompt any) string {
	switch p := prompt.(type) {
	case string:
		return p
	case []any:
		parts := make([]string, 0, len(p))
		for _, item := range p {
			if s, ok := item.(string); ok && strings.TrimSpace(s) != "" {
				parts = append(parts, s)
			}
		}
		return strings.Join(parts, "\n")
	default:
		return ""
	}
}

func convertChatResponseToCompletion(body []byte) ([]byte, error) {
	var chatResp struct {
		ID      string `json:"id"`
		Object  string `json:"object"`
		Created int64  `json:"created"`
		Model   string `json:"model"`
		Choices []struct {
			Index   int `json:"index"`
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
			FinishReason string `json:"finish_reason"`
		} `json:"choices"`
		Usage struct {
			PromptTokens     int `json:"prompt_tokens"`
			CompletionTokens int `json:"completion_tokens"`
			TotalTokens      int `json:"total_tokens"`
		} `json:"usage"`
		Error any `json:"error"`
	}
	if err := json.Unmarshal(body, &chatResp); err != nil {
		return nil, err
	}
	if chatResp.Error != nil {
		return body, nil
	}

	resp := completionProxyResponse{
		ID:      strings.Replace(chatResp.ID, "chatcmpl", "cmpl", 1),
		Object:  "text_completion",
		Created: chatResp.Created,
		Model:   chatResp.Model,
		Usage: SwaggerUsage{
			PromptTokens:     chatResp.Usage.PromptTokens,
			CompletionTokens: chatResp.Usage.CompletionTokens,
			TotalTokens:      chatResp.Usage.TotalTokens,
		},
	}
	for _, choice := range chatResp.Choices {
		resp.Choices = append(resp.Choices, SwaggerCompletionChoice{
			Text:         choice.Message.Content,
			Index:        choice.Index,
			FinishReason: choice.FinishReason,
		})
	}

	return json.Marshal(resp)
}

func (h *ProxyHandler) resolveLocalExecutionTargets(ctx context.Context, modelName string) ([]model.Provider, map[string]string, *MappingStrategy, string, error) {
	candidates, err := h.providerSvc.GetCandidatesForModel(modelName)
	if err != nil || len(candidates) == 0 {
		return nil, nil, nil, fallbackReasonNoAvailableProvider, model.ErrProviderUnavailable
	}

	var available []model.Provider
	for _, provider := range candidates {
		if h.circuitBreaker != nil && h.circuitBreaker.IsOpen(provider.ID) {
			slog.Warn("跳过已熔断的提供商", "provider", provider.Name, "id", provider.ID)
			continue
		}
		if h.cooldownStore != nil {
			coolingDown, cooldownErr := h.cooldownStore.Is429CoolingDown(ctx, provider.ID, modelName)
			if cooldownErr != nil {
				slog.Warn("查询 provider cooldown 失败", "provider", provider.Name, "model", modelName, "error", cooldownErr)
			}
			if coolingDown {
				slog.Warn("跳过 429 cooldown 中的提供商", "provider", provider.Name, "id", provider.ID, "model", modelName)
				continue
			}
		}
		available = append(available, provider)
	}
	if len(available) == 0 {
		return nil, nil, nil, fallbackReasonProvidersFiltered, model.ErrProviderUnavailable
	}

	decryptedKeys := make(map[string]string, len(available))
	var decryptedCandidates []model.Provider
	for _, provider := range available {
		decryptedKey, decryptErr := h.providerSvc.DecryptProviderKey(&provider)
		if decryptErr != nil {
			slog.Error("解密提供商密钥失败", "provider", provider.Name, "error", decryptErr)
			continue
		}
		decryptedKeys[provider.ID.String()] = decryptedKey
		decryptedCandidates = append(decryptedCandidates, provider)
	}
	if len(decryptedKeys) == 0 {
		return nil, nil, nil, fallbackReasonProviderKeysInvalid, model.ErrProviderUnavailable
	}

	var mappingStrat *MappingStrategy
	if mappings, mapErr := h.providerSvc.GetMappingsForModel(modelName); mapErr == nil && len(mappings) > 0 {
		mappingStrat = getMappingStrategy(mappings)
	}

	return decryptedCandidates, decryptedKeys, mappingStrat, "", nil
}

// proxyRequest 是核心代理逻辑，通过 Portkey Gateway 的 x-portkey-config 实现 loadbalance/fallback。
func (h *ProxyHandler) proxyRequest(c *gin.Context, endpoint string) {
	start := time.Now()
	user := middleware.GetUserFromContext(c)
	sub := middleware.GetSubscriptionFromContext(c)
	plan := middleware.GetPlanFromContext(c)

	if user == nil || sub == nil || plan == nil {
		response.ErrInternal(c)
		return
	}

	// 动态获取路由配置
	routingCfg := h.configStore.Get()

	// 1. Read request body (may already be buffered by model_auth middleware)
	var body []byte
	if cached, exists := c.Get("request_body"); exists {
		if b, ok := cached.([]byte); ok {
			body = b
		}
	} else {
		var err error
		body, err = io.ReadAll(c.Request.Body)
		if err != nil {
			response.ErrBadRequest(c, "Failed to read request body")
			return
		}
	}

	// 2. Parse model and stream flag
	var reqBody map[string]interface{}
	if err := json.Unmarshal(body, &reqBody); err != nil {
		response.ErrBadRequest(c, "Invalid JSON body")
		return
	}

	modelName, _ := reqBody["model"].(string)
	modelName = strings.TrimSpace(modelName)
	if modelName == "" {
		var resolveErr error
		modelName, resolveErr = resolveAutoModel(plan, routingCfg.DefaultModel)
		if resolveErr != nil {
			response.ErrBadRequest(c, "No available model configured for auto selection")
			return
		}
		reqBody["model"] = modelName
		body, _ = json.Marshal(reqBody)
		c.Set("request_body", body)
		c.Set(requestModelContextKey, modelName)
	} else {
		c.Set(requestModelContextKey, modelName)
	}
	isStream, _ := reqBody["stream"].(bool)

	weight := h.gatewayConfig.NonStreamRequestWeight
	if isStream {
		weight = h.gatewayConfig.StreamRequestWeight
	}
	if h.inflightBudget != nil {
		releaseBudget, ok := h.inflightBudget.TryAcquire(weight)
		if !ok {
			slog.Warn("reject request due to inflight budget exhaustion",
				"model", modelName,
				"is_stream", isStream,
				"weight", weight,
			)
			response.ErrOverloaded(c, h.gatewayConfig.OverloadStatusCode)
			return
		}
		defer releaseBudget()
	}

	requestModel := modelName
	attemptModels := []string{requestModel}
	attemptModels = append(attemptModels, listFallbackModels(plan, requestModel)...)

	lastFailureReason := fallbackReasonNoAvailableProvider
	requestID := getRequestID(c)

modelAttempts:
	for attemptIdx, candidateModel := range attemptModels {
		candidates, decryptedKeys, mappingStrat, failureReason, resolveErr := h.resolveLocalExecutionTargets(c.Request.Context(), candidateModel)
		if resolveErr != nil {
			lastFailureReason = failureReason
			if attemptIdx == 0 {
				slog.Warn("no available provider", "model", candidateModel, "error", resolveErr)
			}
			continue
		}

		executionPlan := &modelExecutionPlan{
			OriginalModel:   requestModel,
			ResolvedModel:   candidateModel,
			FallbackReason:  "",
			FallbackApplied: attemptIdx > 0,
			Candidates:      candidates,
			DecryptedKeys:   decryptedKeys,
			MappingStrategy: mappingStrat,
		}
		if executionPlan.FallbackApplied {
			executionPlan.FallbackReason = lastFailureReason
		}

		reqBody["model"] = candidateModel
		body, _ = json.Marshal(reqBody)
		c.Set("request_body", body)
		c.Set(requestModelContextKey, candidateModel)

		reserved, err := h.billingSvc.Reserve(c.Request.Context(), sub.ID, candidateModel, plan)
		if err != nil {
			response.ErrQuotaExceeded(c)
			return
		}

		for _, provider := range executionPlan.Candidates {
			providerKeys := map[string]string{
				provider.ID.String(): executionPlan.DecryptedKeys[provider.ID.String()],
			}
			portkeyConfig, err := buildPortkeyConfig([]model.Provider{provider}, providerKeys, routingCfg, executionPlan.MappingStrategy, h.providerSvc)
			if err != nil || len(portkeyConfig.Targets) == 0 {
				h.billingSvc.RefundReservation(c.Request.Context(), sub.ID, reserved)
				response.ErrUpstreamError(c, "构建路由配置失败")
				return
			}

			configJSON, err := json.Marshal(portkeyConfig)
			if err != nil {
				h.billingSvc.RefundReservation(c.Request.Context(), sub.ID, reserved)
				response.ErrInternal(c)
				return
			}

			slog.Debug("Portkey 路由配置",
				"model", candidateModel,
				"provider", provider.Name,
				"strategy", portkeyConfig.Strategy.Mode,
				"targets", len(portkeyConfig.Targets),
				"request_id", requestID,
			)

			upstreamURL := h.portkeyURL + endpoint
			upReq, err := http.NewRequestWithContext(c.Request.Context(), "POST", upstreamURL, bytes.NewReader(body))
			if err != nil {
				h.billingSvc.RefundReservation(c.Request.Context(), sub.ID, reserved)
				response.ErrInternal(c)
				return
			}

			upReq.Header.Set("Content-Type", "application/json")
			upReq.Header.Set("x-portkey-config", string(configJSON))
			upReq.Header.Set("X-Request-ID", requestID)

			upResp, err := h.httpClient.Do(upReq)
			if err != nil {
				slog.Error("Portkey 请求失败", "error", err, "request_id", requestID)
				h.billingSvc.RefundReservation(c.Request.Context(), sub.ID, reserved)
				response.ErrUpstreamError(c, "上游请求失败: "+err.Error())
				return
			}

			actualProviderID := resolveActualProvider(upResp, []model.Provider{provider})
			if h.circuitBreaker != nil {
				if upResp.StatusCode < 400 {
					h.circuitBreaker.RecordSuccess(actualProviderID)
				} else {
					h.circuitBreaker.RecordFailure(actualProviderID)
				}
			}
			if h.cooldownStore != nil && actualProviderID != uuid.Nil {
				if upResp.StatusCode == http.StatusTooManyRequests {
					ttl := h.cooldownStore.Mark429Cooldown(c.Request.Context(), actualProviderID, candidateModel, upResp.Header.Get("Retry-After"))
					slog.Warn("provider entered 429 cooldown",
						"provider_id", actualProviderID,
						"model", candidateModel,
						"ttl", ttl.String(),
						"request_id", requestID,
					)
				} else if upResp.StatusCode < 400 {
					if err := h.cooldownStore.Clear429Cooldown(c.Request.Context(), actualProviderID, candidateModel); err != nil {
						slog.Warn("clear provider cooldown failed", "provider_id", actualProviderID, "model", candidateModel, "error", err)
					}
				}
			}

			if upResp.StatusCode >= 400 {
				respBody, _ := io.ReadAll(upResp.Body)
				upResp.Body.Close()
				if len(respBody) == 0 {
					respBody = []byte(fmt.Sprintf(
						`{"error":{"message":"upstream returned %d with empty body","type":"upstream_error","code":%d}}`,
						upResp.StatusCode, upResp.StatusCode,
					))
				}

				action := classifyProviderFailure(upResp.StatusCode, respBody)
				if action == providerFailureRetryNextProvider {
					slog.Warn("provider failed, trying next provider",
						"provider", provider.Name,
						"model", candidateModel,
						"status_code", upResp.StatusCode,
						"request_id", requestID,
					)
					continue
				}

				if actualProviderID == uuid.Nil {
					h.billingSvc.RefundReservation(c.Request.Context(), sub.ID, reserved)
				} else {
					h.billingSvc.Settle(c.Request.Context(), sub.ID, actualProviderID, reserved, 0, candidateModel, plan)
				}
				if isStream {
					if aw, ok := c.Writer.(*adapter.AdaptedResponseWriter); ok {
						aw.WriteError(upResp.StatusCode, respBody)
					} else {
						c.Data(upResp.StatusCode, "application/json", respBody)
					}
				} else {
					c.Data(upResp.StatusCode, "application/json", respBody)
				}
				c.Abort()
				return
			}

			latencyMs := int(time.Since(start).Milliseconds())
			applyModelResolutionHeaders(c, executionPlan)
			if isStream {
				h.handleStreaming(c, upResp, user, sub, plan, actualProviderID, requestModel, candidateModel, reserved, requestID, latencyMs)
			} else {
				h.handleNonStreaming(c, upResp, user, sub, plan, actualProviderID, requestModel, candidateModel, reserved, requestID, latencyMs)
			}
			return
		}

		h.billingSvc.RefundReservation(c.Request.Context(), sub.ID, reserved)
		lastFailureReason = fallbackReasonProvidersExhausted
		if attemptIdx == len(attemptModels)-1 {
			break modelAttempts
		}
	}

	response.ErrProviderUnavailable(c)
}

// resolveActualProvider 从 Portkey 响应头中解析实际使用的 provider ID。
// 如果无法解析，返回第一个候选的 ID。
func resolveActualProvider(resp *http.Response, candidates []model.Provider) uuid.UUID {
	if len(candidates) == 0 {
		return uuid.Nil
	}

	// 尝试从 Portkey 响应头获取实际 target 信息
	// Portkey 可能在以下 header 中返回实际使用的 provider 信息：
	// - x-portkey-target-index: target 索引
	// - x-portkey-last-used-option-index: Portkey 最后一次命中的 option
	// - x-portkey-provider: 提供商名称
	if indexStr := firstNonEmptyHeader(resp.Header, "x-portkey-target-index", "x-portkey-last-used-option-index"); indexStr != "" {
		if idx64, err := json.Number(indexStr).Int64(); err == nil {
			idx := int(idx64)
			if idx >= 0 && idx < len(candidates) {
				return candidates[idx].ID
			}
		}
	}

	if providerName := strings.TrimSpace(resp.Header.Get("x-portkey-provider")); providerName != "" {
		for _, candidate := range candidates {
			if strings.EqualFold(candidate.Name, providerName) || strings.EqualFold(candidate.ProviderType, providerName) {
				return candidate.ID
			}
		}
	}

	if len(candidates) == 1 {
		return candidates[0].ID
	}

	// 无法从响应头解析实际 provider，保持 unknown，避免错误归因到任意候选 provider。
	return uuid.Nil
}

func firstNonEmptyHeader(header http.Header, keys ...string) string {
	for _, key := range keys {
		if value := strings.TrimSpace(header.Get(key)); value != "" {
			return value
		}
	}
	return ""
}

// handleNonStreaming reads full response, extracts usage, settles billing.
func (h *ProxyHandler) handleNonStreaming(c *gin.Context, resp *http.Response, user *model.User, sub *model.Subscription, plan *model.Plan, providerID uuid.UUID, requestedModel, resolvedModel string, reserved int64, requestID string, latencyMs int) {
	// 检查是否因 drain 被取消（context 已关闭）
	if err := checkContextDone(c, requestID); err != nil {
		h.billingSvc.Settle(c.Request.Context(), sub.ID, providerID, reserved, 0, resolvedModel, plan)
		return
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		h.billingSvc.Settle(c.Request.Context(), sub.ID, providerID, reserved, 0, resolvedModel, plan)
		response.ErrUpstreamError(c, "Failed to read upstream response")
		return
	}

	// Extract usage from response
	var openAIResp struct {
		Usage struct {
			PromptTokens     int `json:"prompt_tokens"`
			CompletionTokens int `json:"completion_tokens"`
			TotalTokens      int `json:"total_tokens"`
		} `json:"usage"`
	}
	json.Unmarshal(body, &openAIResp)

	totalTokens := int64(openAIResp.Usage.TotalTokens)

	// Settle billing with actual usage
	h.billingSvc.Settle(c.Request.Context(), sub.ID, providerID, reserved, totalTokens, resolvedModel, plan)

	// Track provider usage
	go h.providerSvc.TrackUsage(providerID, totalTokens)

	// Log usage asynchronously
	go h.logUsage(user.ID, sub.ID, providerID, requestedModel, resolvedModel, openAIResp.Usage.PromptTokens, openAIResp.Usage.CompletionTokens, openAIResp.Usage.TotalTokens, latencyMs, resp.StatusCode, requestID, "api")

	// 异步写入语义缓存
	if h.cacheSvc != nil {
		if embedding := middleware.GetCacheEmbedding(c); embedding != nil {
			contentHash := middleware.GetCacheContentHash(c)
			scopeKey := middleware.GetCacheScopeKey(c)
			go func() {
				if err := h.cacheSvc.Store(context.Background(), service.StoreParams{
					Model:            resolvedModel,
					ScopeKey:         scopeKey,
					ContentHash:      contentHash,
					Embedding:        embedding,
					Response:         body,
					PromptTokens:     openAIResp.Usage.PromptTokens,
					CompletionTokens: openAIResp.Usage.CompletionTokens,
					TotalTokens:      openAIResp.Usage.TotalTokens,
				}); err != nil {
					slog.Error("缓存写入失败", "error", err, "request_id", requestID)
				}
			}()
		}
	}

	// Return response to client
	if completionMode, _ := c.Get("completion_response_mode"); completionMode == true {
		convertedBody, err := convertChatResponseToCompletion(body)
		if err == nil {
			body = convertedBody
		} else {
			slog.Error("completion 响应转换失败", "error", err, "request_id", requestID)
		}
	}
	c.Data(resp.StatusCode, "application/json", body)
}

// handleStreaming forwards SSE chunks to the client using line-based scanning
// to ensure SSE events are not split across reads (which would break JSON parsing).
func (h *ProxyHandler) handleStreaming(c *gin.Context, resp *http.Response, user *model.User, sub *model.Subscription, plan *model.Plan, providerID uuid.UUID, requestedModel, resolvedModel string, reserved int64, requestID string, latencyMs int) {
	// Set SSE headers
	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-cache")
	c.Header("Connection", "keep-alive")
	c.Header("X-Request-ID", requestID)
	c.Status(http.StatusOK)

	flusher, ok := c.Writer.(http.Flusher)
	if !ok {
		h.billingSvc.Settle(c.Request.Context(), sub.ID, providerID, reserved, 0, resolvedModel, plan)
		response.ErrInternal(c)
		return
	}

	var totalPromptTokens, totalCompletionTokens, totalTokens int

	// 收集流式响应用于缓存重组
	needCache := h.cacheSvc != nil && middleware.GetCacheEmbedding(c) != nil
	var streamChunks []streamChunkData

	// Use bufio.Scanner to read complete lines, preventing SSE events from being
	// split across buffer boundaries (which caused JSON parse failures).
	// 当 drain 触发时，context 取消会关闭 TCP 连接，scanner.Scan() 会返回 false 退出循环。
	scanner := bufio.NewScanner(resp.Body)
	// Allow up to 256KB per line for large SSE events
	scanner.Buffer(make([]byte, 4096), 256*1024)

	for scanner.Scan() {
		line := scanner.Text()

		// Forward the line + newline to client
		c.Writer.Write([]byte(line + "\n"))
		flusher.Flush()

		// Parse SSE data lines for usage extraction
		if strings.HasPrefix(line, "data: ") {
			data := strings.TrimPrefix(line, "data: ")
			if data != "[DONE]" {
				var event struct {
					ID      string `json:"id"`
					Object  string `json:"object"`
					Created int64  `json:"created"`
					Model   string `json:"model"`
					Choices []struct {
						Index int `json:"index"`
						Delta struct {
							Role    string `json:"role"`
							Content string `json:"content"`
						} `json:"delta"`
						FinishReason *string `json:"finish_reason"`
					} `json:"choices"`
					Usage struct {
						PromptTokens     int `json:"prompt_tokens"`
						CompletionTokens int `json:"completion_tokens"`
						TotalTokens      int `json:"total_tokens"`
					} `json:"usage"`
				}
				if err := json.Unmarshal([]byte(data), &event); err == nil {
					if event.Usage.TotalTokens > 0 {
						totalPromptTokens = event.Usage.PromptTokens
						totalCompletionTokens = event.Usage.CompletionTokens
						totalTokens = event.Usage.TotalTokens
					}
					// 收集用于缓存重组的内容
					if needCache && len(event.Choices) > 0 {
						for _, ch := range event.Choices {
							streamChunks = append(streamChunks, streamChunkData{
								ID:           event.ID,
								Created:      event.Created,
								Model:        event.Model,
								Index:        ch.Index,
								Role:         ch.Delta.Role,
								Content:      ch.Delta.Content,
								FinishReason: ch.FinishReason,
							})
						}
					}
				}
			}
		}
	}

	if err := scanner.Err(); err != nil {
		slog.Error("streaming scan error", "error", err, "request_id", requestID)
	}

	// Settle billing with accumulated usage
	actualTokens := int64(totalTokens)
	h.billingSvc.Settle(c.Request.Context(), sub.ID, providerID, reserved, actualTokens, resolvedModel, plan)

	// Track provider usage
	go h.providerSvc.TrackUsage(providerID, actualTokens)

	// Log usage
	go h.logUsage(user.ID, sub.ID, providerID, requestedModel, resolvedModel, totalPromptTokens, totalCompletionTokens, totalTokens, latencyMs, http.StatusOK, requestID, "api")

	// 异步写入语义缓存（重组为非流式格式）
	if needCache && len(streamChunks) > 0 {
		embedding := middleware.GetCacheEmbedding(c)
		contentHash := middleware.GetCacheContentHash(c)
		scopeKey := middleware.GetCacheScopeKey(c)
		nonStreamResp := rebuildNonStreamResponse(streamChunks, totalPromptTokens, totalCompletionTokens, totalTokens)
		if nonStreamResp != nil {
			go func() {
				if err := h.cacheSvc.Store(context.Background(), service.StoreParams{
					Model:            resolvedModel,
					ScopeKey:         scopeKey,
					ContentHash:      contentHash,
					Embedding:        embedding,
					Response:         nonStreamResp,
					PromptTokens:     totalPromptTokens,
					CompletionTokens: totalCompletionTokens,
					TotalTokens:      totalTokens,
				}); err != nil {
					slog.Error("流式缓存写入失败", "error", err, "request_id", requestID)
				}
			}()
		}
	}
}

// checkContextDone 检查请求 context 是否已取消（drain 时触发）。
// 返回 nil 表示正常， 返回 error 表示 context 已取消。
func checkContextDone(c *gin.Context, requestID string) error {
	select {
	case <-c.Request.Context().Done():
		slog.Info("request interrupted by shutdown", "request_id", requestID)
		return c.Request.Context().Err()
	default:
		return nil
	}
}

// streamChunkData 收集流式 chunk 的数据用于重组非流式响应。
type streamChunkData struct {
	ID           string
	Created      int64
	Model        string
	Index        int
	Role         string
	Content      string
	FinishReason *string
}

// rebuildNonStreamResponse 将流式 chunk 重组为非流式 OpenAI 响应格式。
func rebuildNonStreamResponse(chunks []streamChunkData, promptTokens, completionTokens, totalTokens int) []byte {
	if len(chunks) == 0 {
		return nil
	}

	// 按 index 合并 chunks
	choiceContents := make(map[int]*struct {
		role         string
		content      strings.Builder
		finishReason string
	})

	var chatID string
	var created int64
	var chatModel string

	for _, ch := range chunks {
		if chatID == "" && ch.ID != "" {
			chatID = ch.ID
		}
		if created == 0 && ch.Created > 0 {
			created = ch.Created
		}
		if chatModel == "" && ch.Model != "" {
			chatModel = ch.Model
		}

		choice, ok := choiceContents[ch.Index]
		if !ok {
			choice = &struct {
				role         string
				content      strings.Builder
				finishReason string
			}{}
			choiceContents[ch.Index] = choice
		}
		if ch.Role != "" {
			choice.role = ch.Role
		}
		choice.content.WriteString(ch.Content)
		if ch.FinishReason != nil {
			choice.finishReason = *ch.FinishReason
		}
	}

	// 构建非流式响应
	var choices []map[string]interface{}
	for idx, ch := range choiceContents {
		role := ch.role
		if role == "" {
			role = "assistant"
		}
		finishReason := ch.finishReason
		if finishReason == "" {
			finishReason = "stop"
		}
		choices = append(choices, map[string]interface{}{
			"index": idx,
			"message": map[string]interface{}{
				"role":    role,
				"content": ch.content.String(),
			},
			"finish_reason": finishReason,
		})
	}

	resp := map[string]interface{}{
		"id":      chatID,
		"object":  "chat.completion",
		"created": created,
		"model":   chatModel,
		"choices": choices,
		"usage": map[string]interface{}{
			"prompt_tokens":     promptTokens,
			"completion_tokens": completionTokens,
			"total_tokens":      totalTokens,
		},
	}

	data, err := json.Marshal(resp)
	if err != nil {
		slog.Error("重组非流式响应失败", "error", err)
		return nil
	}
	return data
}

// extractUsageFromSSE tries to parse usage info from SSE data lines.
func extractUsageFromSSE(chunk []byte, promptTokens, completionTokens, totalTokens *int) {
	lines := strings.Split(string(chunk), "\n")
	for _, line := range lines {
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		data := strings.TrimPrefix(line, "data: ")
		if data == "[DONE]" {
			continue
		}
		var event struct {
			Usage struct {
				PromptTokens     int `json:"prompt_tokens"`
				CompletionTokens int `json:"completion_tokens"`
				TotalTokens      int `json:"total_tokens"`
			} `json:"usage"`
		}
		if err := json.Unmarshal([]byte(data), &event); err == nil && event.Usage.TotalTokens > 0 {
			*promptTokens = event.Usage.PromptTokens
			*completionTokens = event.Usage.CompletionTokens
			*totalTokens = event.Usage.TotalTokens
		}
	}
}

// logUsage persists a usage record to the database and logs it.
func (h *ProxyHandler) logUsage(userID, subID, providerID uuid.UUID, requestedModel, resolvedModel string, prompt, completion, total, latencyMs, statusCode int, requestID string, source string) {
	if source == "" {
		source = "api"
	}
	log := &model.UsageLog{
		UserID:           userID,
		SubscriptionID:   subID,
		ProviderID:       providerID,
		Model:            resolvedModel,
		PromptTokens:     prompt,
		CompletionTokens: completion,
		TotalTokens:      total,
		LatencyMs:        latencyMs,
		StatusCode:       statusCode,
		RequestID:        requestID,
		Source:           source,
	}

	if h.usageSink != nil {
		if err := h.usageSink.Enqueue(*log); err != nil {
			slog.Error("failed to enqueue usage log", "request_id", requestID, "error", err)
		}
		return
	}

	if err := h.billingSvc.LogUsage(log); err != nil {
		slog.Error("failed to log usage to DB", "request_id", requestID, "error", err)
	}

	slog.Info("usage",
		"user_id", userID,
		"subscription_id", subID,
		"provider_id", providerID,
		"requested_model", requestedModel,
		"resolved_model", resolvedModel,
		"prompt_tokens", prompt,
		"completion_tokens", completion,
		"total_tokens", total,
		"latency_ms", latencyMs,
		"status_code", statusCode,
		"request_id", requestID,
		"source", source,
	)
}

// providerTypeFromModel maps model names to provider types.
// In production, this would be configurable.
func providerTypeFromModel(modelName string) string {
	modelName = strings.ToLower(strings.TrimSpace(modelName))
	switch {
	case strings.HasPrefix(modelName, "gpt"):
		return "openai"
	case strings.HasPrefix(modelName, "deepseek"):
		return "deepseek"
	case strings.HasPrefix(modelName, "qwen"):
		return "qwen"
	case strings.HasPrefix(modelName, "claude"):
		return "anthropic"
	default:
		return "openai" // fallback
	}
}
