package handler

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"git.woa.com/wisp/mono/ai-gateway/internal/model"
	"git.woa.com/wisp/mono/ai-gateway/internal/pkg/response"
	"git.woa.com/wisp/mono/ai-gateway/internal/service"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

type InternalHandler struct {
	userSvc *service.UserService
	planSvc *service.PlanService
	subSvc  *service.SubscriptionService
}

type internalApplySubscriptionRequest struct {
	UserID      string     `json:"user_id" binding:"required"`
	PlanID      string     `json:"plan_id" binding:"required"`
	Phone       string     `json:"phone"`
	Nickname    string     `json:"nickname"`
	PeriodStart *time.Time `json:"period_start"`
}

type internalCancelSubscriptionRequest struct {
	UserID string `json:"user_id" binding:"required"`
}

type internalEnsureUserRequest struct {
	UserID   string `json:"user_id" binding:"required"`
	Nickname string `json:"nickname"`
}

type internalEnsureUserResponse struct {
	Result string `json:"result"`
	UserID string `json:"user_id"`
}

func NewInternalHandler(
	userSvc *service.UserService,
	planSvc *service.PlanService,
	subSvc *service.SubscriptionService,
) *InternalHandler {
	return &InternalHandler{
		userSvc: userSvc,
		planSvc: planSvc,
		subSvc:  subSvc,
	}
}

func (h *InternalHandler) EnsureUser(c *gin.Context) {
	var req internalEnsureUserRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.ErrBadRequest(c, "Missing required field: user_id")
		return
	}
	if strings.TrimSpace(req.UserID) == "" {
		response.ErrBadRequest(c, "Missing required field: user_id")
		return
	}

	user, result, err := h.userSvc.EnsureUser(req.UserID, req.Nickname)
	if err != nil {
		response.ErrorResponse(c, http.StatusInternalServerError, "server_error", "ensure_user_failed", "Failed to ensure user")
		return
	}

	response.SuccessResponse(c, internalEnsureUserResponse{
		Result: result,
		UserID: user.UserID,
	})
}

func (h *InternalHandler) GetPlan(c *gin.Context) {
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

func (h *InternalHandler) ApplySubscription(c *gin.Context) {
	var req internalApplySubscriptionRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.ErrBadRequest(c, "Missing required fields: user_id, plan_id")
		return
	}

	if req.PeriodStart != nil {
		earliest := time.Now().AddDate(0, 0, -maxPastDays)
		if req.PeriodStart.Before(earliest) {
			response.ErrBadRequest(c, "period_start 不能早于当前时间 90 天前")
			return
		}
	}

	planID, err := uuid.Parse(req.PlanID)
	if err != nil {
		response.ErrBadRequest(c, "Invalid plan ID")
		return
	}

	user, err := h.userSvc.GetByUserID(req.UserID)
	if err != nil {
		if !errors.Is(err, model.ErrUserNotFound) {
			response.ErrBadRequest(c, err.Error())
			return
		}
		user, _, err = h.userSvc.EnsureUserWithPhone(req.UserID, req.Nickname, req.Phone)
		if err != nil {
			response.ErrorResponse(c, http.StatusInternalServerError, "server_error", "ensure_user_failed", "Failed to ensure user")
			return
		}
	}

	sub, err := h.subSvc.Subscribe(user.ID, planID, req.PeriodStart)
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

// GetUserActiveSubscription handles GET /api/internal/users/:user_id/subscriptions
// 查询用户当前活跃订阅，返回 token 余量和周期信息，供上游服务（CTL）换算 credit
func (h *InternalHandler) GetUserActiveSubscription(c *gin.Context) {
	businessUserID := c.Param("user_id")
	if businessUserID == "" {
		response.ErrBadRequest(c, "user_id is required")
		return
	}

	user, err := h.userSvc.GetByUserID(businessUserID)
	if err != nil {
		if errors.Is(err, model.ErrUserNotFound) {
			response.ErrNotFound(c, "user not found")
			return
		}
		response.ErrBadRequest(c, err.Error())
		return
	}

	sub, err := h.subSvc.GetActiveByUserID(user.ID)
	if err != nil {
		if errors.Is(err, model.ErrSubscriptionNotFound) {
			response.ErrNotFound(c, "no active subscription")
			return
		}
		response.ErrBadRequest(c, err.Error())
		return
	}

	response.SuccessResponse(c, sub)
}

func (h *InternalHandler) CancelSubscription(c *gin.Context) {
	var req internalCancelSubscriptionRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.ErrBadRequest(c, "Missing required field: user_id")
		return
	}

	user, err := h.userSvc.GetByUserID(req.UserID)
	if err != nil {
		if errors.Is(err, model.ErrUserNotFound) {
			response.SuccessResponse(c, gin.H{"status": "not_found"})
			return
		}
		response.ErrBadRequest(c, err.Error())
		return
	}

	sub, err := h.subSvc.Cancel(user.ID)
	if err != nil {
		if errors.Is(err, model.ErrSubscriptionNotFound) {
			response.SuccessResponse(c, gin.H{"status": "not_found"})
			return
		}
		response.ErrBadRequest(c, err.Error())
		return
	}

	response.SuccessResponse(c, sub)
}
