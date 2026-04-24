package handler

import (
	"net/http"
	"strconv"

	"git.woa.com/wisp/mono/ai-gateway/internal/middleware"
	"git.woa.com/wisp/mono/ai-gateway/internal/model"
	"git.woa.com/wisp/mono/ai-gateway/internal/pkg/response"
	"git.woa.com/wisp/mono/ai-gateway/internal/repository"
	"git.woa.com/wisp/mono/ai-gateway/internal/service"
	"github.com/gin-gonic/gin"
)

// UserSelfHandler handles user self-service endpoints.
type UserSelfHandler struct {
	usageRepo repository.UsageRepo
}

// NewUserSelfHandler creates a new UserSelfHandler.
func NewUserSelfHandler(usageRepo repository.UsageRepo) *UserSelfHandler {
	return &UserSelfHandler{usageRepo: usageRepo}
}

// Me returns the authenticated user's info, subscription, and plan.
// @Summary Get current user info
// @Description Returns the authenticated user's profile, active subscription, and plan details
// @Tags User
// @Produce json
// @Security BearerAuth
// @Success 200 {object} SwaggerMeResponse "User info with subscription and plan"
// @Failure 401 {object} SwaggerErrorResponse "Unauthorized - invalid API key"
// @Router /v1/me [get]
func (h *UserSelfHandler) Me(c *gin.Context) {
	user := middleware.GetUserFromContext(c)
	sub := middleware.GetSubscriptionFromContext(c)
	plan := middleware.GetPlanFromContext(c)

	if user == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Not authenticated"})
		return
	}

	result := gin.H{
		"user": user,
	}

	if sub != nil {
		result["subscription"] = gin.H{
			"id":            sub.ID,
			"status":        sub.Status,
			"token_balance": sub.TokenBalance,
			"period_start":  sub.PeriodStart,
			"period_end":    sub.PeriodEnd,
		}
	}

	if plan != nil {
		result["plan"] = plan
	}

	c.JSON(http.StatusOK, result)
}

// Usage returns the authenticated user's package overview.
// @Summary Get usage statistics
// @Description Returns package total, used tokens, remaining tokens, and billing period for the authenticated user. The query user_id must match the authenticated user.
// @Tags User
// @Produce json
// @Security BearerAuth
// @Param user_id query string true "Business user ID"
// @Success 200 {object} SwaggerUsageStatsResponse "Usage overview"
// @Failure 400 {object} SwaggerErrorResponse "Bad request - missing or invalid user_id"
// @Failure 403 {object} SwaggerErrorResponse "Forbidden - user_id does not match the authenticated user"
// @Failure 401 {object} SwaggerErrorResponse "Unauthorized - invalid API key"
// @Router /v1/me/usage [get]
func (h *UserSelfHandler) Usage(c *gin.Context) {
	user := middleware.GetUserFromContext(c)
	if user == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Not authenticated"})
		return
	}

	requestedUserID := c.Query("user_id")
	if requestedUserID == "" {
		response.ErrBadRequest(c, "Missing required query parameter: user_id")
		return
	}
	if requestedUserID != user.UserID {
		response.ErrorResponse(c, http.StatusForbidden,
			"permission_error", "user_id_mismatch",
			"The requested user_id does not match the authenticated user.")
		return
	}

	sub := middleware.GetSubscriptionFromContext(c)
	plan := middleware.GetPlanFromContext(c)

	resp, err := h.buildUsageSummary(user, sub, plan)
	if err != nil {
		response.ErrInternal(c)
		return
	}
	response.SuccessResponse(c, resp)
}

// TokenBalance returns the authenticated user's remaining token balance.
// @Summary Get current user token balance
// @Description Returns the authenticated user's token balance, subscription status, and period end. Unlimited plans are explicitly marked.
// @Tags User
// @Produce json
// @Security BearerAuth
// @Success 200 {object} SwaggerTokenBalanceResponse "Token balance information"
// @Failure 401 {object} SwaggerErrorResponse "Unauthorized - invalid API key"
// @Router /v1/me/token-balance [get]
func (h *UserSelfHandler) TokenBalance(c *gin.Context) {
	user := middleware.GetUserFromContext(c)
	if user == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Not authenticated"})
		return
	}

	sub := middleware.GetSubscriptionFromContext(c)
	plan := middleware.GetPlanFromContext(c)
	resp := buildTokenBalanceResponse(sub, plan)
	c.JSON(http.StatusOK, resp)
}

func buildTokenBalanceResponse(sub *model.Subscription, plan *model.Plan) gin.H {
	if sub == nil {
		return gin.H{
			"token_balance": 0,
			"status":        "inactive",
			"period_end":    nil,
			"is_unlimited":  false,
			"display_text":  "0",
		}
	}

	if plan != nil && plan.MonthlyTokens == 0 {
		return gin.H{
			"token_balance": nil,
			"status":        sub.Status,
			"period_end":    sub.PeriodEnd,
			"is_unlimited":  true,
			"display_text":  "无限额度",
		}
	}

	return gin.H{
		"token_balance": sub.TokenBalance,
		"status":        sub.Status,
		"period_end":    sub.PeriodEnd,
		"is_unlimited":  false,
		"display_text":  formatTokenDisplay(sub.TokenBalance),
	}
}

func (h *UserSelfHandler) buildUsageSummary(user *model.User, sub *model.Subscription, plan *model.Plan) (gin.H, error) {
	var (
		usedTokens    int64
		totalRequests int64
		periodStart   any
		periodEnd     any
		planTotal     any = int64(0)
		remaining     any = int64(0)
	)

	isUnlimited := plan != nil && plan.MonthlyTokens == 0
	status := "inactive"
	if sub != nil {
		status = sub.Status
		periodStart = sub.PeriodStart
		periodEnd = sub.PeriodEnd
		if h.usageRepo != nil {
			modelUsage, err := h.usageRepo.SubscriptionModelUsage(sub.ID)
			if err != nil {
				return nil, err
			}
			usedTokens, totalRequests = billedUsageSummary(modelUsage, plan)
		}
		if isUnlimited {
			planTotal = nil
			remaining = nil
		} else {
			remaining = sub.TokenBalance
			planTotal = usedTokens + sub.TokenBalance
		}
	}

	if plan != nil && sub == nil {
		if isUnlimited {
			planTotal = nil
		} else {
			total, err := service.CalcTokenBalance(plan)
			if err != nil {
				return nil, err
			}
			planTotal = total
		}
	}

	return gin.H{
		"user_id":           user.UserID,
		"status":            status,
		"period_start":      periodStart,
		"period_end":        periodEnd,
		"is_unlimited":      isUnlimited,
		"plan_total_tokens": planTotal,
		"used_tokens":       usedTokens,
		"remaining_tokens":  remaining,
		"total_requests":    totalRequests,
	}, nil
}

func billedUsageSummary(modelUsage []repository.ModelDistPoint, plan *model.Plan) (int64, int64) {
	var usedTokens int64
	var totalRequests int64
	for _, point := range modelUsage {
		multiplier := service.GetMultiplier(plan, point.Model)
		usedTokens += int64(float64(point.Tokens) * multiplier)
		totalRequests += point.Requests
	}
	return usedTokens, totalRequests
}

func formatTokenDisplay(balance int64) string {
	digits := []byte(strconv.FormatInt(balance, 10))
	if len(digits) <= 3 {
		return string(digits)
	}

	negative := false
	if digits[0] == '-' {
		negative = true
		digits = digits[1:]
	}

	var out []byte
	if negative {
		out = append(out, '-')
	}
	first := len(digits) % 3
	if first == 0 {
		first = 3
	}
	out = append(out, digits[:first]...)
	for i := first; i < len(digits); i += 3 {
		out = append(out, ',')
		out = append(out, digits[i:i+3]...)
	}
	return string(out)
}
