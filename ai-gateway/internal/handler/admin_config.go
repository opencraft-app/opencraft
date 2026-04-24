package handler

import (
	"git.woa.com/wisp/mono/ai-gateway/internal/pkg/response"
	"git.woa.com/wisp/mono/ai-gateway/internal/service"
	"github.com/gin-gonic/gin"
)

// ConfigHandler 管理运行时配置的 API 处理器。
type ConfigHandler struct {
	configStore *service.RuntimeConfigStore
}

// NewConfigHandler 创建 ConfigHandler。
func NewConfigHandler(configStore *service.RuntimeConfigStore) *ConfigHandler {
	return &ConfigHandler{configStore: configStore}
}

// --- 响应类型 ---

// PortkeyStrategyResponse 路由策略响应。
type PortkeyStrategyResponse struct {
	Mode             string `json:"mode"`
	OnStatusCodes    []int  `json:"on_status_codes"`
	RetryAttempts    int    `json:"retry_attempts"`
	RetryStatusCodes []int  `json:"retry_status_codes"`
}

// CircuitBreakerConfigResponse 熔断器配置响应。
type CircuitBreakerConfigResponse struct {
	FailureThreshold  int `json:"failure_threshold"`
	CooldownDurationS int `json:"cooldown_duration_s"`
}

// RoutingConfigResponse 路由配置完整响应（熔断 + 路由策略）。
type RoutingConfigResponse struct {
	FailureThreshold  int                     `json:"failure_threshold"`
	CooldownDurationS int                     `json:"cooldown_duration_s"`
	DefaultModel      string                  `json:"default_model"`
	Strategy          PortkeyStrategyResponse `json:"strategy"`
}

// --- 请求类型 ---

// UpdatePortkeyStrategyRequest 更新路由策略请求（PATCH 语义）。
type UpdatePortkeyStrategyRequest struct {
	DefaultModel     *string `json:"default_model"`
	Mode             *string `json:"mode"`
	OnStatusCodes    *[]int  `json:"on_status_codes"`
	RetryAttempts    *int    `json:"retry_attempts"`
	RetryStatusCodes *[]int  `json:"retry_status_codes"`
}

// UpdateCircuitBreakerRequest 更新熔断器配置请求（PATCH 语义）。
type UpdateCircuitBreakerRequest struct {
	FailureThreshold  *int `json:"failure_threshold"`
	CooldownDurationS *int `json:"cooldown_duration_s"`
}

// --- GET 完整配置 ---

// GetRoutingConfig 返回完整路由配置（GET /api/admin/config/routing）。
// @Summary Get routing config
// @Description Returns the current routing configuration including circuit breaker and strategy settings
// @Tags Admin - Config
// @Produce json
// @Success 200 {object} RoutingConfigResponse "Current routing configuration"
// @Failure 401 {object} SwaggerErrorResponse "Unauthorized - invalid admin token"
// @Router /api/admin/config/routing [get]
func (h *ConfigHandler) GetRoutingConfig(c *gin.Context) {
	cfg := h.configStore.Get()
	response.SuccessResponse(c, h.buildRoutingResponse(cfg))
}

// --- PUT 路由策略 ---

// UpdateStrategy 更新路由策略（PUT /api/admin/config/routing/strategy）。
// @Summary Update routing strategy
// @Description Update Portkey routing strategy configuration and default auto-selected model (PATCH semantics)
// @Tags Admin - Config
// @Accept json
// @Produce json
// @Param request body UpdatePortkeyStrategyRequest true "Strategy config (all fields optional)"
// @Success 200 {object} RoutingConfigResponse "Updated routing config"
// @Failure 400 {object} SwaggerErrorResponse "Bad request"
// @Failure 500 {object} SwaggerErrorResponse "Internal error"
// @Router /api/admin/config/routing/strategy [put]
func (h *ConfigHandler) UpdateStrategy(c *gin.Context) {
	var req UpdatePortkeyStrategyRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.ErrBadRequest(c, "无效的请求参数: "+err.Error())
		return
	}

	cfg := h.configStore.Get()

	if req.DefaultModel != nil {
		cfg.DefaultModel = *req.DefaultModel
	}
	if req.Mode != nil {
		mode := *req.Mode
		if mode != "loadbalance" && mode != "fallback" {
			response.ErrBadRequest(c, "mode 必须为 loadbalance 或 fallback")
			return
		}
		cfg.Strategy.Mode = mode
	}
	if req.OnStatusCodes != nil {
		cfg.Strategy.OnStatusCodes = *req.OnStatusCodes
	}
	if req.RetryAttempts != nil {
		if *req.RetryAttempts < 0 || *req.RetryAttempts > 5 {
			response.ErrBadRequest(c, "retry_attempts 取值范围: 0~5")
			return
		}
		cfg.Strategy.RetryAttempts = *req.RetryAttempts
	}
	if req.RetryStatusCodes != nil {
		cfg.Strategy.RetryStatusCodes = *req.RetryStatusCodes
	}

	if err := h.configStore.Update(cfg); err != nil {
		response.ErrInternal(c)
		return
	}

	response.SuccessResponse(c, h.buildRoutingResponse(cfg))
}

// --- PUT 熔断器 ---

// UpdateCircuitBreaker 更新熔断器配置（PUT /api/admin/config/routing/circuit-breaker）。
// @Summary Update circuit breaker config
// @Description Update circuit breaker configuration (PATCH semantics)
// @Tags Admin - Config
// @Accept json
// @Produce json
// @Param request body UpdateCircuitBreakerRequest true "Circuit breaker config (all fields optional)"
// @Success 200 {object} CircuitBreakerConfigResponse "Updated circuit breaker config"
// @Failure 400 {object} SwaggerErrorResponse "Bad request"
// @Failure 500 {object} SwaggerErrorResponse "Internal error"
// @Router /api/admin/config/routing/circuit-breaker [put]
func (h *ConfigHandler) UpdateCircuitBreaker(c *gin.Context) {
	var req UpdateCircuitBreakerRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.ErrBadRequest(c, "无效的请求参数: "+err.Error())
		return
	}

	cfg := h.configStore.Get()

	if req.FailureThreshold != nil {
		if *req.FailureThreshold < 1 || *req.FailureThreshold > 50 {
			response.ErrBadRequest(c, "failure_threshold 取值范围: 1~50")
			return
		}
		cfg.FailureThreshold = *req.FailureThreshold
	}
	if req.CooldownDurationS != nil {
		if *req.CooldownDurationS < 5 || *req.CooldownDurationS > 300 {
			response.ErrBadRequest(c, "cooldown_duration_s 取值范围: 5~300")
			return
		}
		cfg.CooldownDurationS = *req.CooldownDurationS
	}

	if err := h.configStore.Update(cfg); err != nil {
		response.ErrInternal(c)
		return
	}

	response.SuccessResponse(c, CircuitBreakerConfigResponse{
		FailureThreshold:  cfg.FailureThreshold,
		CooldownDurationS: cfg.CooldownDurationS,
	})
}

// --- 内部辅助 ---

func (h *ConfigHandler) buildRoutingResponse(cfg service.RoutingConfig) RoutingConfigResponse {
	return RoutingConfigResponse{
		FailureThreshold:  cfg.FailureThreshold,
		CooldownDurationS: cfg.CooldownDurationS,
		DefaultModel:      cfg.DefaultModel,
		Strategy: PortkeyStrategyResponse{
			Mode:             cfg.Strategy.Mode,
			OnStatusCodes:    cfg.Strategy.OnStatusCodes,
			RetryAttempts:    cfg.Strategy.RetryAttempts,
			RetryStatusCodes: cfg.Strategy.RetryStatusCodes,
		},
	}
}
