package handler

import (
	"errors"
	"time"

	"git.woa.com/wisp/mono/ai-gateway/internal/model"
	"git.woa.com/wisp/mono/ai-gateway/internal/pkg/response"
	"github.com/gin-gonic/gin"
)
type provisionRequest struct {
	UserID       string     `json:"user_id" binding:"required"`
	Phone        string     `json:"phone"`
	Nickname     string     `json:"nickname"`
	PlanID       string     `json:"plan_id" binding:"required"`
	AssignAPIKey bool       `json:"assign_api_key"`
	// PeriodStart 可选，RFC3339 格式。nil 时使用当前时间作为订阅起始时间。
	PeriodStart *time.Time `json:"period_start"`
}

// Provision creates a user and subscription in one call, and optionally generates an API key.
// @Summary Provision user
// @Description One-shot operation: create or reuse a user, subscribe to a plan, and optionally generate an API key
// @Tags Admin - Provision
// @Accept json
// @Produce json
// @Param request body provisionRequest true "Provision request"
// @Success 200 {object} SwaggerProvisionResponse "Provisioned user with subscription and optional API key"
// @Failure 400 {object} SwaggerErrorResponse "Bad request - missing required fields or plan not found"
// @Failure 401 {object} SwaggerErrorResponse "Unauthorized - invalid admin token"
// @Router /api/admin/provision [post]
func (h *AdminHandler) Provision(c *gin.Context) {
	var req provisionRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.ErrBadRequest(c, "Missing required fields: user_id, plan_id")
		return
	}

	// 校验 period_start：不允许早于 maxPastDays 天前（防止创建实际已过期的订阅）
	if req.PeriodStart != nil {
		earliest := time.Now().AddDate(0, 0, -maxPastDays)
		if req.PeriodStart.Before(earliest) {
			response.ErrBadRequest(c, "period_start 不能早于当前时间 90 天前")
			return
		}
	}

	user, sub, plainKey, err := h.provisionSvc.Provision(req.UserID, req.Phone, req.Nickname, req.PlanID, req.PeriodStart, req.AssignAPIKey)
	if err != nil {
		if errors.Is(err, model.ErrPlanNotFound) {
			response.ErrNotFound(c, "Plan not found")
		} else {
			response.ErrBadRequest(c, err.Error())
		}
		return
	}

	response.SuccessResponse(c, gin.H{
		"user":             user,
		"subscription":     sub,
		"api_key":          plainKey,
		"api_key_assigned": plainKey != nil,
	})
}
