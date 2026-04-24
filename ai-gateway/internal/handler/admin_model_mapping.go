package handler

import (
	"encoding/json"

	"git.woa.com/wisp/mono/ai-gateway/internal/model"
	"git.woa.com/wisp/mono/ai-gateway/internal/pkg/response"
	"git.woa.com/wisp/mono/ai-gateway/internal/repository"
	"git.woa.com/wisp/mono/ai-gateway/internal/service"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"gorm.io/datatypes"
)

// ModelMappingHandler 处理模型映射管理的 Admin API。
type ModelMappingHandler struct {
	mappingRepo repository.ModelMappingRepo
	providerSvc *service.ProviderService
}

// NewModelMappingHandler 创建新的 ModelMappingHandler。
func NewModelMappingHandler(mappingRepo repository.ModelMappingRepo, providerSvc *service.ProviderService) *ModelMappingHandler {
	return &ModelMappingHandler{
		mappingRepo: mappingRepo,
		providerSvc: providerSvc,
	}
}

type createModelMappingRequest struct {
	ModelPattern   string                  `json:"model_pattern" binding:"required"` // 如 "gpt-4*", "claude-*"
	ProviderID     uuid.UUID               `json:"provider_id" binding:"required"`
	Priority       int                     `json:"priority"`
	Weight         *int                    `json:"weight"` // 权重，默认 100
	IsActive       *bool                   `json:"is_active"`
	StrategyMode   *string                 `json:"strategy_mode"`   // "loadbalance" / "fallback"，留空继承全局
	RetryAttempts  *int                    `json:"retry_attempts"`  // 重试次数覆盖
	OnStatusCodes  *[]int                  `json:"on_status_codes"` // 策略触发状态码覆盖
	OverrideParams *map[string]interface{} `json:"override_params"` // Portkey target 参数覆盖
}

type updateModelMappingRequest struct {
	ModelPattern   *string                 `json:"model_pattern"`
	ProviderID     *uuid.UUID              `json:"provider_id"`
	Priority       *int                    `json:"priority"`
	Weight         *int                    `json:"weight"`
	IsActive       *bool                   `json:"is_active"`
	StrategyMode   *string                 `json:"strategy_mode"`
	RetryAttempts  *int                    `json:"retry_attempts"`
	OnStatusCodes  *[]int                  `json:"on_status_codes"`
	OverrideParams *map[string]interface{} `json:"override_params"`
}

// CreateModelMapping 处理 POST /api/admin/model-mappings
// @Summary 创建模型映射
// @Description 创建模型名到提供商的映射规则，支持通配符（如 "gpt-4*", "claude-*"）
// @Tags Admin - Model Mappings
// @Accept json
// @Produce json
// @Param request body createModelMappingRequest true "Create mapping request"
// @Success 200 {object} SwaggerModelMapping "Created mapping"
// @Failure 400 {object} SwaggerErrorResponse "Bad request - missing fields or provider not found"
// @Router /api/admin/model-mappings [post]
func (h *ModelMappingHandler) CreateModelMapping(c *gin.Context) {
	var req createModelMappingRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.ErrBadRequest(c, "缺少必填字段: model_pattern, provider_id")
		return
	}

	// 验证 provider 存在
	if _, err := h.providerSvc.GetByID(req.ProviderID); err != nil {
		response.ErrBadRequest(c, "提供商不存在")
		return
	}

	isActive := true
	if req.IsActive != nil {
		isActive = *req.IsActive
	}

	weight := 100
	if req.Weight != nil {
		weight = *req.Weight
	}

	mapping := &model.ModelProviderMapping{
		ModelPattern: req.ModelPattern,
		ProviderID:   req.ProviderID,
		Priority:     req.Priority,
		Weight:       weight,
		IsActive:     isActive,
	}

	// 设置 Portkey 策略覆盖字段
	if req.StrategyMode != nil && *req.StrategyMode != "" {
		mapping.StrategyMode = req.StrategyMode
	}
	if req.RetryAttempts != nil {
		mapping.RetryAttempts = req.RetryAttempts
	}
	if req.OnStatusCodes != nil {
		data, _ := json.Marshal(*req.OnStatusCodes)
		mapping.OnStatusCodes = datatypes.JSON(data)
	}
	if req.OverrideParams != nil {
		data, _ := json.Marshal(*req.OverrideParams)
		mapping.OverrideParams = datatypes.JSON(data)
	}

	if err := h.mappingRepo.Create(mapping); err != nil {
		response.ErrBadRequest(c, err.Error())
		return
	}

	response.SuccessResponse(c, mapping)
}

// ListModelMappings 处理 GET /api/admin/model-mappings
// @Summary 列出所有模型映射
// @Description 返回所有模型映射规则，包含关联的提供商信息
// @Tags Admin - Model Mappings
// @Produce json
// @Success 200 {object} SwaggerModelMappingListResponse "Mapping list with provider details"
// @Router /api/admin/model-mappings [get]
func (h *ModelMappingHandler) ListModelMappings(c *gin.Context) {
	mappings, err := h.mappingRepo.ListAll()
	if err != nil {
		response.ErrBadRequest(c, err.Error())
		return
	}

	response.SuccessResponse(c, gin.H{
		"items": mappings,
		"total": len(mappings),
	})
}

// DeleteModelMapping 处理 DELETE /api/admin/model-mappings/:id
// @Summary 删除模型映射
// @Description 删除指定的模型映射规则
// @Tags Admin - Model Mappings
// @Produce json
// @Param id path string true "Mapping ID (UUID)"
// @Success 200 {object} SwaggerMessageResponse "Mapping deleted successfully"
// @Failure 400 {object} SwaggerErrorResponse "Invalid mapping ID format"
// @Router /api/admin/model-mappings/{id} [delete]
func (h *ModelMappingHandler) DeleteModelMapping(c *gin.Context) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		response.ErrBadRequest(c, "无效的映射 ID")
		return
	}

	if err := h.mappingRepo.Delete(id); err != nil {
		response.ErrBadRequest(c, err.Error())
		return
	}

	response.SuccessResponse(c, gin.H{"message": "映射已删除"})
}

// ResolveModel 处理 GET /api/admin/model-mappings/resolve?model=xxx
// @Summary 测试模型路由
// @Description 输入模型名，返回匹配的提供商列表（API key 已脱敏）
// @Tags Admin - Model Mappings
// @Produce json
// @Param model query string true "Model name to resolve (e.g. gpt-4, claude-3-opus)"
// @Success 200 {object} SwaggerResolveModelResponse "Resolved providers for the model"
// @Router /api/admin/model-mappings/resolve [get]
func (h *ModelMappingHandler) ResolveModel(c *gin.Context) {
	modelName := c.Query("model")
	if modelName == "" {
		response.ErrBadRequest(c, "缺少 model 参数")
		return
	}

	resolution, err := h.providerSvc.ResolveCandidatesForModel(modelName)
	if err != nil {
		mismatches := []service.ProviderRouteMismatch{}
		if resolution != nil {
			mismatches = resolution.Mismatches
		}
		response.SuccessResponse(c, gin.H{
			"model":      modelName,
			"providers":  []interface{}{},
			"mismatches": mismatches,
			"fallback":   len(mismatches) == 0,
			"message":    "未找到匹配的提供商",
		})
		return
	}

	// 脱敏 API key
	type providerInfo struct {
		ID           uuid.UUID `json:"id"`
		Name         string    `json:"name"`
		ProviderType string    `json:"provider_type"`
		BaseURL      string    `json:"base_url"`
		Priority     int       `json:"priority"`
		Weight       int       `json:"weight"`
		Status       string    `json:"status"`
	}

	var providers []providerInfo
	for _, p := range resolution.Candidates {
		providers = append(providers, providerInfo{
			ID:           p.ID,
			Name:         p.Name,
			ProviderType: p.ProviderType,
			BaseURL:      p.BaseURL,
			Priority:     p.Priority,
			Weight:       p.Weight,
			Status:       p.Status,
		})
	}

	resp := gin.H{
		"model":      modelName,
		"providers":  providers,
		"mismatches": resolution.Mismatches,
		"count":      len(providers),
	}
	if len(resolution.Mismatches) > 0 {
		resp["message"] = "检测到部分 provider 的模型映射与 supported_models 不一致，已从候选集中剔除"
	}

	response.SuccessResponse(c, resp)
}

// UpdateModelMapping 处理 PUT /api/admin/model-mappings/:id
// @Summary 更新模型映射
// @Description 更新指定模型映射规则的属性（部分更新，仅非 nil 字段会被修改）
// @Tags Admin - Model Mappings
// @Accept json
// @Produce json
// @Param id path string true "Mapping ID (UUID)"
// @Param request body updateModelMappingRequest true "Update mapping request"
// @Success 200 {object} SwaggerModelMapping "Updated mapping"
// @Failure 400 {object} SwaggerErrorResponse "Bad request - invalid ID or provider not found"
// @Router /api/admin/model-mappings/{id} [put]
func (h *ModelMappingHandler) UpdateModelMapping(c *gin.Context) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		response.ErrBadRequest(c, "无效的映射 ID")
		return
	}

	var req updateModelMappingRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.ErrBadRequest(c, "请求体格式错误")
		return
	}

	// 获取现有映射
	existing, err := h.mappingRepo.GetByID(id)
	if err != nil {
		response.ErrBadRequest(c, "映射不存在")
		return
	}

	// 按需更新字段
	if req.ModelPattern != nil {
		existing.ModelPattern = *req.ModelPattern
	}
	if req.ProviderID != nil {
		// 验证 provider 存在
		if _, err := h.providerSvc.GetByID(*req.ProviderID); err != nil {
			response.ErrBadRequest(c, "提供商不存在")
			return
		}
		existing.ProviderID = *req.ProviderID
	}
	if req.Priority != nil {
		existing.Priority = *req.Priority
	}
	if req.Weight != nil {
		existing.Weight = *req.Weight
	}
	if req.IsActive != nil {
		existing.IsActive = *req.IsActive
	}
	// Portkey 策略覆盖字段
	if req.StrategyMode != nil {
		if *req.StrategyMode == "" {
			existing.StrategyMode = nil // 清除覆盖，回退到全局
		} else {
			existing.StrategyMode = req.StrategyMode
		}
	}
	if req.RetryAttempts != nil {
		existing.RetryAttempts = req.RetryAttempts
	}
	if req.OnStatusCodes != nil {
		data, _ := json.Marshal(*req.OnStatusCodes)
		existing.OnStatusCodes = datatypes.JSON(data)
	}
	if req.OverrideParams != nil {
		data, _ := json.Marshal(*req.OverrideParams)
		existing.OverrideParams = datatypes.JSON(data)
	}

	if err := h.mappingRepo.Update(existing); err != nil {
		response.ErrBadRequest(c, err.Error())
		return
	}

	response.SuccessResponse(c, existing)
}
