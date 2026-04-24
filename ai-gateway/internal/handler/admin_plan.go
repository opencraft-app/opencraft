package handler

import (
	"encoding/json"
	"strconv"

	"git.woa.com/wisp/mono/ai-gateway/internal/model"
	"git.woa.com/wisp/mono/ai-gateway/internal/pkg/response"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"gorm.io/datatypes"
)

type createPlanRequest struct {
	Name             string                `json:"name" binding:"required"`
	MonthlyTokens    *int64                `json:"monthly_tokens" binding:"required"`
	RateLimits       []model.RateLimitRule `json:"rate_limits" binding:"required,min=1"`
	AllowedModels    datatypes.JSON        `json:"allowed_models"`
	PriceCents       int                   `json:"price_cents"`
	TokenMultipliers datatypes.JSON        `json:"token_multipliers"`
	IsActive         *bool                 `json:"is_active"`
	// PeriodValue 订阅周期数值，默认为 1；显式传入时必须大于等于 1
	PeriodValue *int `json:"period_value"`
	// PeriodUnit 订阅周期单位，支持 "months"（默认）和 "days"
	PeriodUnit string `json:"period_unit"`
}

type updatePlanRequest struct {
	Name             string                 `json:"name"`
	MonthlyTokens    *int64                 `json:"monthly_tokens"`
	RateLimits       *[]model.RateLimitRule `json:"rate_limits"`
	AllowedModels    datatypes.JSON         `json:"allowed_models"`
	PriceCents       *int                   `json:"price_cents"`
	TokenMultipliers datatypes.JSON         `json:"token_multipliers"`
	IsActive         *bool                  `json:"is_active"`
	// PeriodValue 订阅周期数值
	PeriodValue *int `json:"period_value"`
	// PeriodUnit 订阅周期单位，支持 "months" 和 "days"
	PeriodUnit *string `json:"period_unit"`
}

// validateRateLimits 校验限流规则列表。
func validateRateLimits(rules []model.RateLimitRule) string {
	if len(rules) == 0 {
		return "至少需要一条限流规则"
	}
	seen := make(map[string]bool)
	for _, rule := range rules {
		if err := model.ValidateWindowFormat(rule.Window); err != nil {
			return err.Error()
		}
		if rule.MaxRequests <= 0 {
			return "max_requests 必须大于 0"
		}
		if seen[rule.Window] {
			return "存在重复的窗口: " + rule.Window
		}
		seen[rule.Window] = true
	}
	return ""
}

// CreatePlan handles POST /api/admin/plans
// @Summary Create plan
// @Description Create a new subscription plan with rate limits, allowed models, and token multipliers
// @Tags Admin - Plans
// @Accept json
// @Produce json
// @Param request body SwaggerCreatePlanRequest true "Create plan request"
// @Success 200 {object} SwaggerPlan "Created plan"
// @Failure 400 {object} SwaggerErrorResponse "Bad request - missing required fields or invalid rate limits"
// @Failure 401 {object} SwaggerErrorResponse "Unauthorized - invalid admin token"
// @Router /api/admin/plans [post]
func (h *AdminHandler) CreatePlan(c *gin.Context) {
	var req createPlanRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.ErrBadRequest(c, "缺少必填字段: name, monthly_tokens, rate_limits")
		return
	}

	if errMsg := validateRateLimits(req.RateLimits); errMsg != "" {
		response.ErrBadRequest(c, errMsg)
		return
	}

	// 校验并设置订阅周期默认值
	periodValue := 1
	if req.PeriodValue != nil {
		if *req.PeriodValue < 1 {
			response.ErrBadRequest(c, "period_value 必须大于等于 1")
			return
		}
		periodValue = *req.PeriodValue
	}
	periodUnit := req.PeriodUnit
	if periodUnit == "" {
		periodUnit = "months"
	}
	if periodUnit != "months" && periodUnit != "days" {
		response.ErrBadRequest(c, "period_unit 只支持 'months' 或 'days'")
		return
	}

	rateLimitsJSON, err := json.Marshal(req.RateLimits)
	if err != nil {
		response.ErrBadRequest(c, "限流规则序列化失败")
		return
	}

	plan := &model.Plan{
		Name:             req.Name,
		MonthlyTokens:    *req.MonthlyTokens,
		RateLimits:       datatypes.JSON(rateLimitsJSON),
		AllowedModels:    req.AllowedModels,
		PriceCents:       req.PriceCents,
		TokenMultipliers: req.TokenMultipliers,
		IsActive:         true,
		PeriodValue:      periodValue,
		PeriodUnit:       periodUnit,
	}
	if req.IsActive != nil {
		plan.IsActive = *req.IsActive
	}

	if err := h.planSvc.Create(plan); err != nil {
		response.ErrBadRequest(c, err.Error())
		return
	}

	response.SuccessResponse(c, plan)
}

// ListPlans handles GET /api/admin/plans
// @Summary List plans
// @Description List all subscription plans with pagination, optionally filtered by active status
// @Tags Admin - Plans
// @Produce json
// @Param active query bool false "Filter active plans only"
// @Param page query int false "Page number" default(1)
// @Param page_size query int false "Page size (max 100)" default(20)
// @Success 200 {object} SwaggerPlanListResponse "Paginated plan list"
// @Failure 400 {object} SwaggerErrorResponse "Bad request"
// @Failure 401 {object} SwaggerErrorResponse "Unauthorized - invalid admin token"
// @Router /api/admin/plans [get]
func (h *AdminHandler) ListPlans(c *gin.Context) {
	activeOnly := c.Query("active") == "true"
	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	pageSize, _ := strconv.Atoi(c.DefaultQuery("page_size", "20"))
	if page < 1 {
		page = 1
	}
	if pageSize < 1 || pageSize > 100 {
		pageSize = 20
	}

	plans, err := h.planSvc.List(activeOnly)
	if err != nil {
		response.ErrBadRequest(c, err.Error())
		return
	}

	// 手动分页（plan 数量通常较少）
	total := len(plans)
	offset := (page - 1) * pageSize
	end := offset + pageSize
	if offset > total {
		offset = total
	}
	if end > total {
		end = total
	}
	paged := plans[offset:end]

	response.SuccessResponse(c, gin.H{
		"items":     paged,
		"total":     total,
		"page":      page,
		"page_size": pageSize,
	})
}

// GetPlan handles GET /api/admin/plans/:id
// @Summary Get plan
// @Description Get a subscription plan by ID with full details
// @Tags Admin - Plans
// @Produce json
// @Param id path string true "Plan ID (UUID)"
// @Success 200 {object} SwaggerPlan "Plan details"
// @Failure 400 {object} SwaggerErrorResponse "Invalid plan ID format"
// @Failure 401 {object} SwaggerErrorResponse "Unauthorized - invalid admin token"
// @Failure 404 {object} SwaggerErrorResponse "Plan not found"
// @Router /api/admin/plans/{id} [get]
func (h *AdminHandler) GetPlan(c *gin.Context) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		response.ErrBadRequest(c, "Invalid plan ID")
		return
	}

	plan, err := h.planSvc.GetByID(id)
	if err != nil {
		response.ErrNotFound(c, "Plan not found")
		return
	}

	response.SuccessResponse(c, plan)
}

// UpdatePlan handles PUT /api/admin/plans/:id
// @Summary Update plan
// @Description Update an existing subscription plan (partial update, only non-nil fields are updated)
// @Tags Admin - Plans
// @Accept json
// @Produce json
// @Param id path string true "Plan ID (UUID)"
// @Param request body SwaggerUpdatePlanRequest true "Update plan request"
// @Success 200 {object} SwaggerPlan "Updated plan"
// @Failure 400 {object} SwaggerErrorResponse "Bad request - invalid rate limits or request body"
// @Failure 401 {object} SwaggerErrorResponse "Unauthorized - invalid admin token"
// @Failure 404 {object} SwaggerErrorResponse "Plan not found"
// @Router /api/admin/plans/{id} [put]
func (h *AdminHandler) UpdatePlan(c *gin.Context) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		response.ErrBadRequest(c, "Invalid plan ID")
		return
	}

	plan, err := h.planSvc.GetByID(id)
	if err != nil {
		response.ErrNotFound(c, "Plan not found")
		return
	}

	var req updatePlanRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.ErrBadRequest(c, "Invalid request body")
		return
	}

	if req.Name != "" {
		plan.Name = req.Name
	}
	if req.MonthlyTokens != nil {
		plan.MonthlyTokens = *req.MonthlyTokens
	}
	if req.RateLimits != nil {
		if errMsg := validateRateLimits(*req.RateLimits); errMsg != "" {
			response.ErrBadRequest(c, errMsg)
			return
		}
		rateLimitsJSON, err := json.Marshal(*req.RateLimits)
		if err != nil {
			response.ErrBadRequest(c, "限流规则序列化失败")
			return
		}
		plan.RateLimits = datatypes.JSON(rateLimitsJSON)
	}
	if req.AllowedModels != nil {
		plan.AllowedModels = req.AllowedModels
	}
	if req.PriceCents != nil {
		plan.PriceCents = *req.PriceCents
	}
	if req.TokenMultipliers != nil {
		plan.TokenMultipliers = req.TokenMultipliers
	}
	if req.IsActive != nil {
		plan.IsActive = *req.IsActive
	}
	if req.PeriodValue != nil {
		if *req.PeriodValue < 1 {
			response.ErrBadRequest(c, "period_value 必须大于等于 1")
			return
		}
		plan.PeriodValue = *req.PeriodValue
	}
	if req.PeriodUnit != nil {
		if *req.PeriodUnit != "months" && *req.PeriodUnit != "days" {
			response.ErrBadRequest(c, "period_unit 只支持 'months' 或 'days'")
			return
		}
		plan.PeriodUnit = *req.PeriodUnit
	}

	if err := h.planSvc.Update(plan); err != nil {
		response.ErrBadRequest(c, err.Error())
		return
	}

	response.SuccessResponse(c, plan)
}

// DeletePlan handles DELETE /api/admin/plans/:id (soft delete: set is_active = false)
// @Summary Delete plan
// @Description Soft delete a subscription plan by setting is_active to false
// @Tags Admin - Plans
// @Produce json
// @Param id path string true "Plan ID (UUID)"
// @Success 200 {object} SwaggerMessageResponse "Plan deleted successfully"
// @Failure 400 {object} SwaggerErrorResponse "Invalid plan ID format"
// @Failure 401 {object} SwaggerErrorResponse "Unauthorized - invalid admin token"
// @Failure 404 {object} SwaggerErrorResponse "Plan not found"
// @Router /api/admin/plans/{id} [delete]
func (h *AdminHandler) DeletePlan(c *gin.Context) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		response.ErrBadRequest(c, "Invalid plan ID")
		return
	}

	plan, err := h.planSvc.GetByID(id)
	if err != nil {
		response.ErrNotFound(c, "Plan not found")
		return
	}

	plan.IsActive = false
	if err := h.planSvc.Update(plan); err != nil {
		response.ErrBadRequest(c, err.Error())
		return
	}

	response.SuccessResponse(c, gin.H{"message": "Plan deleted"})
}
