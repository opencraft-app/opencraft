package handler

import (
	"errors"
	"net/http"
	"time"

	"git.woa.com/wisp/mono/ai-gateway/internal/model"
	"git.woa.com/wisp/mono/ai-gateway/internal/pkg/response"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

// maxPastDays 允许订阅起始时间最多往前追溯的天数。
const maxPastDays = 90

type subscribeRequest struct {
	PlanID string `json:"plan_id" binding:"required"`
	// PeriodStart 可选，RFC3339 格式。nil 时使用当前时间作为订阅起始时间。
	PeriodStart *time.Time `json:"period_start"`
	// PeriodValue / PeriodUnit (v0.2.4 bundle ↔ plan decoupling, optional):
	// 当 admin 想以非 plan 默认时长开通订阅（如运营临时给客户开 6 个月而 plan
	// 配的是 3 个月）时填入；不填走 plan 默认（Q10=j1 兜底）。
	PeriodValue int    `json:"period_value,omitempty"`
	PeriodUnit  string `json:"period_unit,omitempty"`
}

// SubscribeUser handles POST /api/admin/users/:user_id/subscriptions
// @Summary Subscribe user to plan
// @Description Create a new subscription for a user identified by business user_id. PeriodStart is optional (defaults to now).
// @Tags Admin - Subscriptions
// @Accept json
// @Produce json
// @Param user_id path string true "Business user ID"
// @Param request body subscribeRequest true "Subscribe request"
// @Success 200 {object} SwaggerSubscription "Created subscription"
// @Failure 400 {object} SwaggerErrorResponse "Bad request - invalid plan ID or user already subscribed"
// @Failure 401 {object} SwaggerErrorResponse "Unauthorized - invalid admin token"
// @Failure 404 {object} SwaggerErrorResponse "User not found"
// @Router /api/admin/users/{user_id}/subscriptions [post]
func (h *AdminHandler) SubscribeUser(c *gin.Context) {
	user, ok := h.requireUserByParam(c)
	if !ok {
		return
	}

	var req subscribeRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.ErrBadRequest(c, "Missing required field: plan_id")
		return
	}

	planID, err := uuid.Parse(req.PlanID)
	if err != nil {
		response.ErrBadRequest(c, "Invalid plan ID")
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

	sub, err := h.subSvc.Subscribe(user.ID, planID, req.PeriodStart, req.PeriodValue, req.PeriodUnit)
	if err != nil {
		if errors.Is(err, model.ErrPlanNotFound) {
			response.ErrNotFound(c, "Plan not found")
		} else {
			response.ErrBadRequest(c, err.Error())
		}
		return
	}

	response.SuccessResponse(c, sub)
}

// GetUserSubscription handles GET /api/admin/users/:user_id/subscriptions
// @Summary Get user subscription
// @Description Get the active subscription for a user identified by business user_id, including plan details
// @Tags Admin - Subscriptions
// @Produce json
// @Param user_id path string true "Business user ID"
// @Success 200 {object} SwaggerSubscription "Active subscription"
// @Failure 400 {object} SwaggerErrorResponse "Invalid user ID"
// @Failure 401 {object} SwaggerErrorResponse "Unauthorized - invalid admin token"
// @Failure 404 {object} SwaggerErrorResponse "No active subscription found for this user"
// @Router /api/admin/users/{user_id}/subscriptions [get]
func (h *AdminHandler) GetUserSubscription(c *gin.Context) {
	user, ok := h.requireUserByParam(c)
	if !ok {
		return
	}

	sub, err := h.subSvc.GetActiveByUserID(user.ID)
	if err != nil {
		response.ErrNotFound(c, "No active subscription found")
		return
	}

	response.SuccessResponse(c, sub)
}

// CancelUserSubscription handles DELETE /api/admin/users/:user_id/subscriptions
// @Summary Cancel user subscription
// @Description Cancel the active subscription for a user identified by business user_id
// @Tags Admin - Subscriptions
// @Produce json
// @Param user_id path string true "Business user ID"
// @Success 200 {object} SwaggerSubscription "Cancelled subscription"
// @Failure 400 {object} SwaggerErrorResponse "Invalid user ID"
// @Failure 401 {object} SwaggerErrorResponse "Unauthorized - invalid admin token"
// @Failure 404 {object} SwaggerErrorResponse "No active subscription found for this user"
// @Failure 404 {object} SwaggerErrorResponse "User not found"
// @Router /api/admin/users/{user_id}/subscriptions [delete]
func (h *AdminHandler) CancelUserSubscription(c *gin.Context) {
	user, ok := h.requireUserByParam(c)
	if !ok {
		return
	}

	sub, err := h.subSvc.Cancel(user.ID)
	if err != nil {
		if err == model.ErrSubscriptionNotFound {
			response.ErrNotFound(c, "No active subscription found")
		} else {
			response.ErrorResponse(c, http.StatusInternalServerError, "server_error", "internal_error", err.Error())
		}
		return
	}

	response.SuccessResponse(c, sub)
}
