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

	// PeriodValue + PeriodUnit (v0.2.4 bundle ↔ plan decoupling — Q9=i1 source of truth):
	// caller (CTL CompletePass / CreateTrialPass) passes the purchased duration
	// directly; ai-gateway computes PeriodEnd = AddPeriod(NOW, value, unit) using
	// the same algorithm as ctl CalcExpiredTime, so a single plan_id can serve
	// multiple time spans (1m / 3m / 1y) without per-duration plan rows.
	//
	// Q10=j1 backwards compatibility: when the caller omits these fields
	// (zero / empty), the service falls back to plan.PeriodValue / plan.PeriodUnit,
	// preserving pre-v0.2.4 behaviour for legacy callers (admin UI, scripts).
	PeriodValue int    `json:"period_value,omitempty"`
	PeriodUnit  string `json:"period_unit,omitempty"`
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

// internalExtendSubscriptionRequest is the body of POST /api/internal/subscriptions/extend.
//
// 语义：把指定 user 的 active 订阅 period_end **强制对齐**到入参 NewPeriodEnd
// （2026-05-24 用户拍板）。既支持续费向后延期，也支持退费向前缩短，统一保证
// ctl pass.expired_time 与 ai-gateway subscription.period_end 天级一致。
//
// pass.expired_time 是 ctl 真源（无论 R-MR-3 新购 Q9=i1 由 ai-gateway 算
// 期初 PeriodEnd，还是 R-MR-4 续费/退费由 ctl 推动 expired_time 变更，
// ctl 与 ai-gateway 的算法 helper 保持一致；本接口只负责把 ctl 算好的
// 新值同步落到 ai-gateway，不做业务侧时间计算）。
//
// Idempotency: ExtendActivePeriodEnd 现采用 "等值即 no-op，不等强制覆盖"
// 语义；重复调用同一 NewPeriodEnd 返回 affected=0 + 200 OK，调用方可安全重试。
type internalExtendSubscriptionRequest struct {
	UserID       string    `json:"user_id" binding:"required"`
	NewPeriodEnd time.Time `json:"new_period_end" binding:"required"`
}

type internalExtendSubscriptionResponse struct {
	Subscription *model.Subscription `json:"subscription"`
	Updated      bool                `json:"updated"` // false => 等值幂等 no-op
}

// ExtendSubscription handles POST /api/internal/subscriptions/extend.
// 用于 ctl 在以下场景把新的 pass.expired_time 强制对齐到 ai-gateway：
//   - 续费 active 同步分支 / renewPassTask 异步分支收尾（向后延期）
//   - isolatePassTask 退费分支 MarkIsolatedWithExpiredTime 后（向前缩短）
func (h *InternalHandler) ExtendSubscription(c *gin.Context) {
	var req internalExtendSubscriptionRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.ErrBadRequest(c, "Missing required fields: user_id, new_period_end")
		return
	}
	if req.NewPeriodEnd.IsZero() {
		response.ErrBadRequest(c, "new_period_end is required")
		return
	}

	user, err := h.userSvc.GetByUserID(req.UserID)
	if err != nil {
		if errors.Is(err, model.ErrUserNotFound) {
			response.ErrNotFound(c, "user not found")
			return
		}
		response.ErrBadRequest(c, err.Error())
		return
	}

	sub, updated, err := h.subSvc.ExtendSubscription(c.Request.Context(), user.ID, req.NewPeriodEnd)
	if err != nil {
		if errors.Is(err, model.ErrSubscriptionNotFound) {
			response.ErrNotFound(c, "active subscription not found")
			return
		}
		response.ErrorResponse(c, http.StatusInternalServerError, "server_error", "extend_failed", err.Error())
		return
	}

	response.SuccessResponse(c, internalExtendSubscriptionResponse{
		Subscription: sub,
		Updated:      updated,
	})
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
