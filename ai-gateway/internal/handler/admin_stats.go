package handler

import (
	"git.woa.com/wisp/mono/ai-gateway/internal/pkg/response"
	"github.com/gin-gonic/gin"
)

// StatsOverview handles GET /api/admin/stats
// @Summary Get stats overview
// @Description Get high-level platform statistics: total users, active subscriptions, providers, and active plans
// @Tags Admin - Stats
// @Produce json
// @Success 200 {object} SwaggerStatsOverviewResponse "Platform statistics overview"
// @Failure 401 {object} SwaggerErrorResponse "Unauthorized - invalid admin token"
// @Router /api/admin/stats [get]
func (h *AdminHandler) StatsOverview(c *gin.Context) {
	totalUsers, err := h.userSvc.CountAll()
	if err != nil {
		totalUsers = 0
	}

	activeSubs, err := h.subSvc.CountActive()
	if err != nil {
		activeSubs = 0
	}

	providers, err := h.providerSvc.List()
	totalProviders := 0
	if err == nil {
		totalProviders = len(providers)
	}

	plans, err := h.planSvc.List(true)
	activePlans := 0
	if err == nil {
		activePlans = len(plans)
	}

	response.SuccessResponse(c, gin.H{
		"total_users":          totalUsers,
		"active_subscriptions": activeSubs,
		"total_providers":      totalProviders,
		"active_plans":         activePlans,
	})
}
