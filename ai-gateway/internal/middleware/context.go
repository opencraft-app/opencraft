package middleware

import (
	"git.woa.com/wisp/mono/ai-gateway/internal/model"
	"github.com/gin-gonic/gin"
)

// Context keys for user/subscription/plan data set by auth middleware.
const (
	ContextKeyUser         = "gateway_user"
	ContextKeySubscription = "gateway_subscription"
	ContextKeyPlan         = "gateway_plan"
)

// SetUserContext stores user, subscription, and plan in the gin context.
func SetUserContext(c *gin.Context, user *model.User, sub *model.Subscription, plan *model.Plan) {
	c.Set(ContextKeyUser, user)
	c.Set(ContextKeySubscription, sub)
	c.Set(ContextKeyPlan, plan)
}

// GetUserFromContext retrieves the authenticated user from gin context.
func GetUserFromContext(c *gin.Context) *model.User {
	v, exists := c.Get(ContextKeyUser)
	if !exists {
		return nil
	}
	user, _ := v.(*model.User)
	return user
}

// GetSubscriptionFromContext retrieves the active subscription from gin context.
func GetSubscriptionFromContext(c *gin.Context) *model.Subscription {
	v, exists := c.Get(ContextKeySubscription)
	if !exists {
		return nil
	}
	sub, _ := v.(*model.Subscription)
	return sub
}

// GetPlanFromContext retrieves the plan from gin context.
func GetPlanFromContext(c *gin.Context) *model.Plan {
	v, exists := c.Get(ContextKeyPlan)
	if !exists {
		return nil
	}
	plan, _ := v.(*model.Plan)
	return plan
}
