package middleware

import (
	"time"

	"git.woa.com/wisp/mono/ai-gateway/internal/model"
	"git.woa.com/wisp/mono/ai-gateway/internal/pkg/response"
	"github.com/gin-gonic/gin"
)

// BillingCheck verifies that the subscription has positive token balance and is not expired.
// Token balance is enforced later by Reserve() against Redis-backed balance state.
// This middleware only checks subscription presence, status, and period validity.
func BillingCheck() gin.HandlerFunc {
	return func(c *gin.Context) {
		sub := GetSubscriptionFromContext(c)
		if sub == nil {
			response.ErrInternal(c)
			return
		}

		// Check plan — if MonthlyTokens == 0, this plan is unlimited, skip billing
		plan := GetPlanFromContext(c)
		if plan != nil && plan.MonthlyTokens == 0 {
			c.Next()
			return
		}

		if sub.Status != "" && sub.Status != model.SubscriptionStatusActive {
			response.ErrQuotaExceeded(c)
			return
		}

		if sub.TokenBalance <= 0 {
			response.ErrQuotaExceeded(c)
			return
		}

		if time.Now().After(sub.PeriodEnd) {
			response.ErrQuotaExceeded(c)
			return
		}

		c.Next()
	}
}
