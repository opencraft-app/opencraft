package handler

import (
	"encoding/json"
	"errors"
	"strconv"
	"strings"

	"git.woa.com/wisp/mono/ai-gateway/internal/model"
	"git.woa.com/wisp/mono/ai-gateway/internal/pkg/response"
	"git.woa.com/wisp/mono/ai-gateway/internal/service"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"gorm.io/datatypes"
)

// validProviderTypes 定义允许的 ProviderType 值
var validProviderTypes = map[string]bool{
	model.ProviderTypeOpenAI:    true,
	model.ProviderTypeDeepSeek:  true,
	model.ProviderTypeQwen:      true,
	model.ProviderTypeAnthropic: true,
}

// validProviderStatuses 定义允许的 ProviderStatus 值
var validProviderStatuses = map[string]bool{
	model.ProviderStatusActive:    true,
	model.ProviderStatusExhausted: true,
	model.ProviderStatusDisabled:  true,
	model.ProviderStatusUnhealthy: true,
}

type createProviderRequest struct {
	Name                   string   `json:"name" binding:"required"`
	ProviderType           string   `json:"provider_type" binding:"required"`
	APIKey                 string   `json:"api_key" binding:"required"`
	BaseURL                string   `json:"base_url" binding:"required"`
	TotalQuota             int64    `json:"total_quota" binding:"required"`
	Priority               int      `json:"priority"`
	Weight                 int      `json:"weight"`
	HealthCheckURL         string   `json:"health_check_url"`
	ModelDiscoveryProtocol string   `json:"model_discovery_protocol"`
	SupportedModels        []string `json:"supported_models"`
}

type updateProviderRequest struct {
	Name                   string   `json:"name"`
	ProviderType           string   `json:"provider_type"`
	APIKey                 string   `json:"api_key"`
	BaseURL                string   `json:"base_url"`
	TotalQuota             *int64   `json:"total_quota"`
	Priority               *int     `json:"priority"`
	Weight                 *int     `json:"weight"`
	Status                 string   `json:"status"`
	HealthCheckURL         *string  `json:"health_check_url"`
	ModelDiscoveryProtocol *string  `json:"model_discovery_protocol"`
	SupportedModels        []string `json:"supported_models"`
}

type validateProviderRequest struct {
	ProviderID     string `json:"provider_id"`
	ProviderType   string `json:"provider_type"`
	APIKey         string `json:"api_key"`
	BaseURL        string `json:"base_url"`
	HealthCheckURL string `json:"health_check_url"`
}

type discoverProviderModelsRequest struct {
	ProviderID             string `json:"provider_id"`
	ModelDiscoveryProtocol string `json:"model_discovery_protocol"`
	APIKey                 string `json:"api_key"`
	BaseURL                string `json:"base_url"`
	HealthCheckURL         string `json:"health_check_url"`
}

type validateProviderModelRequest struct {
	ProviderID             string `json:"provider_id"`
	ModelDiscoveryProtocol string `json:"model_discovery_protocol"`
	APIKey                 string `json:"api_key"`
	BaseURL                string `json:"base_url"`
	Model                  string `json:"model"`
}

// maskAPIKey returns the first 8 and last 4 characters with "***" in between.
func maskAPIKey(key string) string {
	if len(key) <= 12 {
		return key[:len(key)/2] + "***" + key[len(key)/2:]
	}
	return key[:8] + "***" + key[len(key)-4:]
}

func looksLikeMaskedAPIKey(key string) bool {
	return strings.Contains(strings.TrimSpace(key), "***")
}

// CreateProvider handles POST /api/admin/providers
// @Summary Create provider
// @Description Register a new LLM provider. The API key will be encrypted at rest and masked in the response.
// @Tags Admin - Providers
// @Accept json
// @Produce json
// @Param request body createProviderRequest true "Create provider request"
// @Success 200 {object} SwaggerProvider "Created provider (API key masked in response)"
// @Failure 400 {object} SwaggerErrorResponse "Bad request - missing required fields"
// @Failure 401 {object} SwaggerErrorResponse "Unauthorized - invalid admin token"
// @Router /api/admin/providers [post]
func (h *AdminHandler) CreateProvider(c *gin.Context) {
	var req createProviderRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.ErrBadRequest(c, "Missing required fields: name, provider_type, api_key, base_url, total_quota")
		return
	}

	if !validProviderTypes[req.ProviderType] {
		response.ErrBadRequest(c, "invalid provider_type: must be one of openai, deepseek, qwen, anthropic")
		return
	}

	weight := req.Weight
	if weight <= 0 {
		weight = 100
	}

	provider := &model.Provider{
		Name:                   req.Name,
		ProviderType:           req.ProviderType,
		APIKey:                 req.APIKey,
		BaseURL:                req.BaseURL,
		TotalQuota:             req.TotalQuota,
		Priority:               req.Priority,
		Weight:                 weight,
		HealthCheckURL:         req.HealthCheckURL,
		ModelDiscoveryProtocol: req.ModelDiscoveryProtocol,
		RegistrationSource:     model.RegistrationSourceManual,
		Status:                 model.ProviderStatusActive,
	}

	// 设置 supported_models
	if len(req.SupportedModels) > 0 {
		modelsJSON, _ := json.Marshal(req.SupportedModels)
		provider.SupportedModels = datatypes.JSON(modelsJSON)
	} else {
		provider.SupportedModels = datatypes.JSON([]byte("[]"))
	}

	if err := h.providerSvc.Create(provider); err != nil {
		response.ErrBadRequest(c, err.Error())
		return
	}

	// Mask the API key in response
	provider.APIKey = maskAPIKey(provider.APIKey)
	response.SuccessResponse(c, provider)
}

// ListProviders handles GET /api/admin/providers
// @Summary List providers
// @Description List all registered LLM providers with pagination (API keys masked in response)
// @Tags Admin - Providers
// @Produce json
// @Param page query int false "Page number" default(1)
// @Param page_size query int false "Page size (max 100)" default(20)
// @Success 200 {object} SwaggerProviderListResponse "Paginated provider list"
// @Failure 400 {object} SwaggerErrorResponse "Bad request"
// @Failure 401 {object} SwaggerErrorResponse "Unauthorized - invalid admin token"
// @Router /api/admin/providers [get]
func (h *AdminHandler) ListProviders(c *gin.Context) {
	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	pageSize, _ := strconv.Atoi(c.DefaultQuery("page_size", "20"))
	if page < 1 {
		page = 1
	}
	if pageSize < 1 || pageSize > 100 {
		pageSize = 20
	}

	providers, err := h.providerSvc.List()
	if err != nil {
		response.ErrBadRequest(c, err.Error())
		return
	}

	activeCount, _ := h.providerSvc.CountActive()

	// Mask API keys in response
	for i := range providers {
		providers[i].APIKey = maskAPIKey(providers[i].APIKey)
	}

	// 手动分页（provider 数量通常较少）
	total := len(providers)
	offset := (page - 1) * pageSize
	end := offset + pageSize
	if offset > total {
		offset = total
	}
	if end > total {
		end = total
	}
	paged := providers[offset:end]

	response.SuccessResponse(c, gin.H{
		"items":        paged,
		"total":        total,
		"active_count": activeCount,
		"page":         page,
		"page_size":    pageSize,
	})
}

// GetProvider handles GET /api/admin/providers/:id
// @Summary Get provider
// @Description Get provider details by ID (API key masked in response)
// @Tags Admin - Providers
// @Produce json
// @Param id path string true "Provider ID (UUID)"
// @Success 200 {object} SwaggerProvider "Provider details (API key masked)"
// @Failure 400 {object} SwaggerErrorResponse "Invalid provider ID format"
// @Failure 401 {object} SwaggerErrorResponse "Unauthorized - invalid admin token"
// @Failure 404 {object} SwaggerErrorResponse "Provider not found"
// @Router /api/admin/providers/{id} [get]
func (h *AdminHandler) GetProvider(c *gin.Context) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		response.ErrBadRequest(c, "Invalid provider ID")
		return
	}

	provider, err := h.providerSvc.GetByID(id)
	if err != nil {
		response.ErrNotFound(c, "Provider not found")
		return
	}

	// Mask API key in response
	provider.APIKey = maskAPIKey(provider.APIKey)
	response.SuccessResponse(c, provider)
}

// UpdateProvider handles PUT /api/admin/providers/:id
// @Summary Update provider
// @Description Update an existing LLM provider (partial update, only non-empty fields are updated)
// @Tags Admin - Providers
// @Accept json
// @Produce json
// @Param id path string true "Provider ID (UUID)"
// @Param request body updateProviderRequest true "Update provider request"
// @Success 200 {object} SwaggerProvider "Updated provider (API key masked in response)"
// @Failure 400 {object} SwaggerErrorResponse "Bad request - invalid request body"
// @Failure 401 {object} SwaggerErrorResponse "Unauthorized - invalid admin token"
// @Failure 404 {object} SwaggerErrorResponse "Provider not found"
// @Router /api/admin/providers/{id} [put]
func (h *AdminHandler) UpdateProvider(c *gin.Context) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		response.ErrBadRequest(c, "Invalid provider ID")
		return
	}

	provider, err := h.providerSvc.GetByID(id)
	if err != nil {
		response.ErrNotFound(c, "Provider not found")
		return
	}

	var req updateProviderRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.ErrBadRequest(c, "Invalid request body")
		return
	}

	if req.Name != "" {
		provider.Name = req.Name
	}
	if req.ProviderType != "" {
		if !validProviderTypes[req.ProviderType] {
			response.ErrBadRequest(c, "invalid provider_type: must be one of openai, deepseek, qwen, anthropic")
			return
		}
		provider.ProviderType = req.ProviderType
	}
	if req.APIKey != "" && !looksLikeMaskedAPIKey(req.APIKey) {
		provider.APIKey = req.APIKey
	}
	if req.BaseURL != "" {
		provider.BaseURL = req.BaseURL
	}
	if req.TotalQuota != nil {
		provider.TotalQuota = *req.TotalQuota
	}
	if req.Priority != nil {
		provider.Priority = *req.Priority
	}
	if req.Weight != nil {
		provider.Weight = *req.Weight
	}
	if req.HealthCheckURL != nil {
		provider.HealthCheckURL = *req.HealthCheckURL
	}
	if req.ModelDiscoveryProtocol != nil {
		provider.ModelDiscoveryProtocol = *req.ModelDiscoveryProtocol
	}
	if req.SupportedModels != nil {
		modelsJSON, _ := json.Marshal(req.SupportedModels)
		provider.SupportedModels = datatypes.JSON(modelsJSON)
	}
	if req.Status != "" {
		if !validProviderStatuses[req.Status] {
			response.ErrBadRequest(c, "invalid status: must be one of active, exhausted, disabled, unhealthy")
			return
		}
		provider.Status = req.Status
	}

	if err := h.providerSvc.Update(provider); err != nil {
		response.ErrBadRequest(c, err.Error())
		return
	}

	// Mask API key in response
	provider.APIKey = maskAPIKey(provider.APIKey)
	response.SuccessResponse(c, provider)
}

// ValidateProvider handles POST /api/admin/providers/validate
// @Summary Validate provider configuration
// @Description Tests provider base_url/api_key reachability without saving changes.
// @Tags Admin - Providers
// @Accept json
// @Produce json
// @Param request body validateProviderRequest true "Provider validation request"
// @Success 200 {object} service.ProviderValidationResult "Validation result"
// @Failure 400 {object} SwaggerErrorResponse "Bad request"
// @Failure 404 {object} SwaggerErrorResponse "Provider not found"
// @Failure 401 {object} SwaggerErrorResponse "Unauthorized - invalid admin token"
// @Router /api/admin/providers/validate [post]
func (h *AdminHandler) ValidateProvider(c *gin.Context) {
	var req validateProviderRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.ErrBadRequest(c, "Invalid request body")
		return
	}

	var providerID uuid.UUID
	if req.ProviderID != "" {
		parsed, err := uuid.Parse(req.ProviderID)
		if err != nil {
			response.ErrBadRequest(c, "Invalid provider ID")
			return
		}
		providerID = parsed
	}

	result, err := h.providerSvc.ValidateConnectivity(c.Request.Context(), service.ProviderValidationInput{
		ProviderID:     providerID,
		ProviderType:   req.ProviderType,
		APIKey:         req.APIKey,
		BaseURL:        req.BaseURL,
		HealthCheckURL: req.HealthCheckURL,
	})
	if err != nil {
		if errors.Is(err, model.ErrProviderNotFound) {
			response.ErrNotFound(c, "Provider not found")
			return
		}
		response.ErrBadRequest(c, err.Error())
		return
	}

	response.SuccessResponse(c, result)
}

// DiscoverProviderModels handles POST /api/admin/providers/discover-models
func (h *AdminHandler) DiscoverProviderModels(c *gin.Context) {
	var req discoverProviderModelsRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.ErrBadRequest(c, "Invalid request body")
		return
	}

	providerID, ok := parseOptionalProviderID(c, req.ProviderID)
	if !ok {
		return
	}

	result, err := h.providerSvc.DiscoverModels(c.Request.Context(), service.ProviderModelDiscoveryInput{
		ProviderID:             providerID,
		ModelDiscoveryProtocol: req.ModelDiscoveryProtocol,
		APIKey:                 req.APIKey,
		BaseURL:                req.BaseURL,
		HealthCheckURL:         req.HealthCheckURL,
	})
	if err != nil {
		if errors.Is(err, model.ErrProviderNotFound) {
			response.ErrNotFound(c, "Provider not found")
			return
		}
		response.ErrBadRequest(c, err.Error())
		return
	}

	response.SuccessResponse(c, result)
}

// ValidateProviderModelRequest handles POST /api/admin/providers/validate-model-request
func (h *AdminHandler) ValidateProviderModelRequest(c *gin.Context) {
	var req validateProviderModelRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.ErrBadRequest(c, "Invalid request body")
		return
	}

	providerID, ok := parseOptionalProviderID(c, req.ProviderID)
	if !ok {
		return
	}

	result, err := h.providerSvc.ValidateModelRequest(c.Request.Context(), service.ProviderModelRequestValidationInput{
		ProviderID:             providerID,
		ModelDiscoveryProtocol: req.ModelDiscoveryProtocol,
		APIKey:                 req.APIKey,
		BaseURL:                req.BaseURL,
		Model:                  req.Model,
	})
	if err != nil {
		if errors.Is(err, model.ErrProviderNotFound) {
			response.ErrNotFound(c, "Provider not found")
			return
		}
		response.ErrBadRequest(c, err.Error())
		return
	}

	response.SuccessResponse(c, result)
}

func parseOptionalProviderID(c *gin.Context, raw string) (uuid.UUID, bool) {
	if raw == "" {
		return uuid.Nil, true
	}
	parsed, err := uuid.Parse(raw)
	if err != nil {
		response.ErrBadRequest(c, "Invalid provider ID")
		return uuid.Nil, false
	}
	return parsed, true
}
