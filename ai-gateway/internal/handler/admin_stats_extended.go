package handler

import (
	"fmt"
	"strconv"
	"time"

	"git.woa.com/wisp/mono/ai-gateway/internal/model"
	"git.woa.com/wisp/mono/ai-gateway/internal/pkg/response"
	"git.woa.com/wisp/mono/ai-gateway/internal/repository"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

// StatsUsage handles GET /api/admin/stats/usage
// @Summary Get usage statistics
// @Description Returns today's total token consumption, interaction count, and change percentages compared to yesterday
// @Tags Admin - Stats
// @Produce json
// @Success 200 {object} SwaggerStatsUsageResponse "Today's usage statistics with day-over-day change"
// @Failure 401 {object} SwaggerErrorResponse "Unauthorized - invalid admin token"
// @Router /api/admin/stats/usage [get]
// 返回今日总 token 消耗、交互次数及较昨日变化百分比
func (h *AdminHandler) StatsUsage(c *gin.Context) {
	now := time.Now().UTC()
	todayStart := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	yesterdayStart := todayStart.AddDate(0, 0, -1)

	todayTokens, _ := h.usageRepo.SumTokensBetween(todayStart, now)
	todayInteractions, _ := h.usageRepo.CountRequestsBetween(todayStart, now)
	yesterdayTokens, _ := h.usageRepo.SumTokensBetween(yesterdayStart, todayStart)
	yesterdayInteractions, _ := h.usageRepo.CountRequestsBetween(yesterdayStart, todayStart)

	tokensPct := calcChangePct(todayTokens, yesterdayTokens)
	interactionsPct := calcChangePct(todayInteractions, yesterdayInteractions)

	response.SuccessResponse(c, gin.H{
		"total_tokens":            todayTokens,
		"total_interactions":      todayInteractions,
		"tokens_change_pct":       tokensPct,
		"interactions_change_pct": interactionsPct,
	})
}

// StatsUsers handles GET /api/admin/stats/users
// @Summary Get user statistics
// @Description Returns user counts by status: total, active, disabled (suspended), and expired
// @Tags Admin - Stats
// @Produce json
// @Success 200 {object} SwaggerStatsUsersResponse "User statistics by status"
// @Failure 401 {object} SwaggerErrorResponse "Unauthorized - invalid admin token"
// @Router /api/admin/stats/users [get]
// 返回用户总数、活跃数、禁用数、订阅过期数
func (h *AdminHandler) StatsUsers(c *gin.Context) {
	total, _ := h.userSvc.CountAll()
	active, _ := h.userSvc.CountByStatus(model.UserStatusActive)
	suspended, _ := h.userSvc.CountByStatus(model.UserStatusSuspended)

	// 过期用户：有活跃状态用户但其订阅已过期
	// 简化方式：总数 - 活跃 - 禁用 - 已删除
	deleted, _ := h.userSvc.CountByStatus(model.UserStatusDeleted)
	expired := total - active - suspended - deleted
	if expired < 0 {
		expired = 0
	}

	response.SuccessResponse(c, gin.H{
		"total":    total,
		"active":   active,
		"disabled": suspended,
		"expired":  expired,
	})
}

// StatsTopUsers handles GET /api/admin/stats/users/top
// @Summary Get top users by token usage
// @Description Returns the top users ranked by token consumption over the specified number of days
// @Tags Admin - Stats
// @Produce json
// @Param days query int false "Number of days to look back" default(7)
// @Param limit query int false "Maximum number of users to return" default(5)
// @Success 200 {object} SwaggerTopUsersResponse "Top users by token usage"
// @Failure 401 {object} SwaggerErrorResponse "Unauthorized - invalid admin token"
// @Router /api/admin/stats/users/top [get]
func (h *AdminHandler) StatsTopUsers(c *gin.Context) {
	days, _ := strconv.Atoi(c.DefaultQuery("days", "7"))
	if days <= 0 {
		days = 7
	}

	limit, _ := strconv.Atoi(c.DefaultQuery("limit", "5"))
	if limit <= 0 {
		limit = 5
	}
	if limit > 20 {
		limit = 20
	}

	since := time.Now().UTC().AddDate(0, 0, -days)
	rows, _ := h.usageRepo.TopUsersByTokens(since, limit)

	items := make([]gin.H, 0, len(rows))
	for _, row := range rows {
		user, err := h.userSvc.GetByID(row.UserID)
		if err != nil {
			continue
		}
		items = append(items, gin.H{
			"id":                 user.ID,
			"user_id":            user.UserID,
			"nickname":           user.Nickname,
			"status":             user.Status,
			"total_tokens":       row.TotalTokens,
			"total_interactions": row.TotalInteractions,
		})
	}

	response.SuccessResponse(c, gin.H{
		"days":  days,
		"limit": limit,
		"items": items,
	})
}

// StatsTokenPool handles GET /api/admin/stats/token-pool
// @Summary Get token pool statistics
// @Description Returns global token pool information: total distributed, consumed, remaining, and 7-day change percentage
// @Tags Admin - Stats
// @Produce json
// @Success 200 {object} SwaggerStatsTokenPoolResponse "Global token pool statistics"
// @Failure 401 {object} SwaggerErrorResponse "Unauthorized - invalid admin token"
// @Router /api/admin/stats/token-pool [get]
// 返回全局 token 池信息
func (h *AdminHandler) StatsTokenPool(c *gin.Context) {
	// 已分配 = 所有活跃订阅的初始额度（月额度 × 订阅月数） - 用 token_balance + consumed 估算
	// 简化实现：total_distributed = sum of all active subscription token_balance + total_consumed
	totalConsumed, _ := h.usageRepo.SumAllConsumedTokens()

	// 获取所有活跃订阅的 token_balance 总和
	activeSubs := h.getActiveSubsTokenSum()
	totalDistributed := activeSubs + totalConsumed

	// 7日变化
	now := time.Now().UTC()
	sevenDaysAgo := now.AddDate(0, 0, -7)
	fourteenDaysAgo := now.AddDate(0, 0, -14)
	recent7d, _ := h.usageRepo.SumTokensBetween(sevenDaysAgo, now)
	prev7d, _ := h.usageRepo.SumTokensBetween(fourteenDaysAgo, sevenDaysAgo)
	changePct := calcChangePct(recent7d, prev7d)

	response.SuccessResponse(c, gin.H{
		"total_distributed":      totalDistributed,
		"total_consumed":         totalConsumed,
		"global_remaining":       activeSubs,
		"consumed_change_7d_pct": changePct,
	})
}

// StatsUsageTrend handles GET /api/admin/stats/usage/trend
// @Summary Get usage trend
// @Description Returns daily usage trend data and model distribution for the specified period (7d or 30d)
// @Tags Admin - Stats
// @Produce json
// @Param period query string false "Time period: '7d' or '30d'" default(7d)
// @Param granularity query string false "Data granularity: 'daily'" default(daily)
// @Success 200 {object} SwaggerStatsUsageTrendResponse "Usage trend with daily data and model distribution"
// @Failure 401 {object} SwaggerErrorResponse "Unauthorized - invalid admin token"
// @Router /api/admin/stats/usage/trend [get]
func (h *AdminHandler) StatsUsageTrend(c *gin.Context) {
	period := c.DefaultQuery("period", "7d")
	granularity := c.DefaultQuery("granularity", "daily")

	days := 7
	if period == "30d" {
		days = 30
	}

	end := time.Now().UTC()
	start := end.AddDate(0, 0, -days)

	dailyData, _ := h.usageRepo.DailyTrend(start, end)
	modelDist, _ := h.usageRepo.ModelDistribution(start, end)
	modelDailyDist, _ := h.usageRepo.ModelDailyDistribution(start, end)
	fillModelDailyShares(modelDailyDist)

	response.SuccessResponse(c, gin.H{
		"period":                   period,
		"granularity":              granularity,
		"data":                     dailyData,
		"model_distribution":       modelDist,
		"model_daily_distribution": modelDailyDist,
	})
}

func fillModelDailyShares(points []repository.ModelDailyDistPoint) {
	totalsByDate := make(map[string]int64, len(points))
	for _, point := range points {
		totalsByDate[point.Date] += point.Tokens
	}
	for i := range points {
		total := totalsByDate[points[i].Date]
		if total <= 0 {
			points[i].Share = 0
			continue
		}
		points[i].Share = float64(points[i].Tokens) / float64(total) * 100
	}
}

// GetUserUsage handles GET /api/admin/users/:user_id/usage
// @Summary Get user usage
// @Description Returns token usage statistics for a specific user identified by business user_id over the specified number of days
// @Tags Admin - Stats
// @Produce json
// @Param user_id path string true "Business user ID"
// @Param days query int false "Number of days to look back" default(7)
// @Success 200 {object} SwaggerUserUsageResponse "User usage statistics with daily breakdown"
// @Failure 400 {object} SwaggerErrorResponse "Invalid user ID"
// @Failure 401 {object} SwaggerErrorResponse "Unauthorized - invalid admin token"
// @Failure 404 {object} SwaggerErrorResponse "User not found"
// @Router /api/admin/users/{user_id}/usage [get]
func (h *AdminHandler) GetUserUsage(c *gin.Context) {
	user, ok := h.requireUserByParam(c)
	if !ok {
		return
	}

	daysStr := c.DefaultQuery("days", "7")
	days, _ := strconv.Atoi(daysStr)
	if days <= 0 {
		days = 7
	}

	daily, _ := h.usageRepo.UserDailyUsage(user.ID, days)
	since := time.Now().UTC().AddDate(0, 0, -days)
	totalTokens, totalInteractions, _ := h.usageRepo.UserTotalUsage(user.ID, since)

	response.SuccessResponse(c, gin.H{
		"user_id":            user.UserID,
		"days":               days,
		"daily":              daily,
		"total_tokens":       totalTokens,
		"total_interactions": totalInteractions,
	})
}

// GetUserUsageLogs handles GET /api/admin/users/:user_id/usage-logs
// @Summary Get user usage logs
// @Description Returns raw request-level usage evidence for a specific user without exposing internal billing logic
// @Tags Admin - Stats
// @Produce json
// @Param user_id path string true "Business user ID"
// @Param range query string false "Time range: 7d, 30d, custom" default(7d)
// @Param start query string false "Custom start date in YYYY-MM-DD format"
// @Param end query string false "Custom end date in YYYY-MM-DD format"
// @Param page query int false "Page number" default(1)
// @Param page_size query int false "Page size" default(20)
// @Success 200 {object} map[string]any "Paginated raw usage logs"
// @Failure 400 {object} SwaggerErrorResponse "Invalid query params"
// @Failure 401 {object} SwaggerErrorResponse "Unauthorized - invalid admin token"
// @Failure 404 {object} SwaggerErrorResponse "User not found"
// @Router /api/admin/users/{user_id}/usage-logs [get]
func (h *AdminHandler) GetUserUsageLogs(c *gin.Context) {
	user, ok := h.requireUserByParam(c)
	if !ok {
		return
	}

	query, err := parseUserUsageLogsQuery(c)
	if err != nil {
		response.ErrBadRequest(c, err.Error())
		return
	}

	offset := (query.Page - 1) * query.PageSize
	items, total, summary, err := h.usageRepo.ListUserUsageLogs(user.ID, query.Start, query.End, offset, query.PageSize)
	if err != nil {
		response.ErrBadRequest(c, err.Error())
		return
	}

	response.SuccessResponse(c, gin.H{
		"items":     items,
		"total":     total,
		"page":      query.Page,
		"page_size": query.PageSize,
		"summary":   summary,
	})
}

// GetProviderUsage handles GET /api/admin/providers/:id/usage
// @Summary Get provider usage
// @Description Returns quota usage, request count, and last used time for a specific provider
// @Tags Admin - Stats
// @Produce json
// @Param id path string true "Provider ID (UUID)"
// @Success 200 {object} SwaggerProviderUsageResponse "Provider usage statistics"
// @Failure 400 {object} SwaggerErrorResponse "Invalid provider ID format"
// @Failure 401 {object} SwaggerErrorResponse "Unauthorized - invalid admin token"
// @Failure 404 {object} SwaggerErrorResponse "Provider not found"
// @Router /api/admin/providers/{id}/usage [get]
func (h *AdminHandler) GetProviderUsage(c *gin.Context) {
	providerID, err := parseUUID(c.Param("id"))
	if err != nil {
		response.ErrBadRequest(c, "Invalid provider ID")
		return
	}

	provider, err := h.providerSvc.GetByID(providerID)
	if err != nil {
		response.ErrNotFound(c, "Provider not found")
		return
	}

	requestCount, _ := h.usageRepo.ProviderRequestCount(providerID)
	lastUsedAt, _ := h.usageRepo.ProviderLastUsedAt(providerID)

	var lastUsedStr *string
	if lastUsedAt != nil {
		s := lastUsedAt.Format(time.RFC3339)
		lastUsedStr = &s
	}

	response.SuccessResponse(c, gin.H{
		"used_quota":    provider.UsedQuota,
		"total_quota":   provider.TotalQuota,
		"request_count": requestCount,
		"last_used_at":  lastUsedStr,
	})
}

type userUsageLogsQuery struct {
	Range    string
	Start    time.Time
	End      time.Time
	Page     int
	PageSize int
}

func parseUserUsageLogsQuery(c *gin.Context) (userUsageLogsQuery, error) {
	rangeValue := c.DefaultQuery("range", "7d")
	page, err := strconv.Atoi(c.DefaultQuery("page", "1"))
	if err != nil || page < 1 {
		return userUsageLogsQuery{}, fmt.Errorf("invalid page")
	}
	pageSize, err := strconv.Atoi(c.DefaultQuery("page_size", "20"))
	if err != nil || pageSize < 1 || pageSize > 100 {
		return userUsageLogsQuery{}, fmt.Errorf("invalid page_size")
	}

	now := time.Now().UTC()
	switch rangeValue {
	case "7d":
		return userUsageLogsQuery{
			Range:    rangeValue,
			Start:    now.AddDate(0, 0, -7),
			End:      now,
			Page:     page,
			PageSize: pageSize,
		}, nil
	case "30d":
		return userUsageLogsQuery{
			Range:    rangeValue,
			Start:    now.AddDate(0, 0, -30),
			End:      now,
			Page:     page,
			PageSize: pageSize,
		}, nil
	case "custom":
		startRaw := c.Query("start")
		endRaw := c.Query("end")
		if startRaw == "" || endRaw == "" {
			return userUsageLogsQuery{}, fmt.Errorf("custom range requires start and end")
		}

		start, err := time.ParseInLocation("2006-01-02", startRaw, time.UTC)
		if err != nil {
			return userUsageLogsQuery{}, fmt.Errorf("invalid start date")
		}
		endInclusive, err := time.ParseInLocation("2006-01-02", endRaw, time.UTC)
		if err != nil {
			return userUsageLogsQuery{}, fmt.Errorf("invalid end date")
		}
		endExclusive := endInclusive.AddDate(0, 0, 1)
		if !start.Before(endExclusive) {
			return userUsageLogsQuery{}, fmt.Errorf("invalid custom date range")
		}

		return userUsageLogsQuery{
			Range:    rangeValue,
			Start:    start,
			End:      endExclusive,
			Page:     page,
			PageSize: pageSize,
		}, nil
	default:
		return userUsageLogsQuery{}, fmt.Errorf("invalid range")
	}
}

// AdjustTokens handles PUT /api/admin/subscriptions/:id/tokens
// @Summary Adjust token balance
// @Description Adjust a subscription's token balance by a delta value. Positive delta adds tokens, negative delta removes tokens.
// @Tags Admin - Subscriptions
// @Accept json
// @Produce json
// @Param id path string true "Subscription ID (UUID)"
// @Param request body SwaggerAdjustTokensRequest true "Token adjustment request"
// @Success 200 {object} SwaggerSubscription "Updated subscription with new token balance"
// @Failure 400 {object} SwaggerErrorResponse "Bad request - missing delta or resulting balance would be negative"
// @Failure 401 {object} SwaggerErrorResponse "Unauthorized - invalid admin token"
// @Failure 404 {object} SwaggerErrorResponse "Subscription not found"
// @Router /api/admin/subscriptions/{id}/tokens [put]
func (h *AdminHandler) AdjustTokens(c *gin.Context) {
	subID, err := parseUUID(c.Param("id"))
	if err != nil {
		response.ErrBadRequest(c, "Invalid subscription ID")
		return
	}

	var req struct {
		Delta int64 `json:"delta" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.ErrBadRequest(c, "Missing required field: delta")
		return
	}

	sub, err := h.subSvc.GetByID(subID)
	if err != nil {
		response.ErrNotFound(c, "Subscription not found")
		return
	}

	newBalance := sub.TokenBalance + req.Delta
	if newBalance < 0 {
		response.ErrBadRequest(c, "Resulting token balance cannot be negative")
		return
	}

	sub.TokenBalance = newBalance
	if err := h.subSvc.Update(sub); err != nil {
		response.ErrBadRequest(c, err.Error())
		return
	}

	response.SuccessResponse(c, sub)
}

// --- 辅助函数 ---

func calcChangePct(current, previous int64) float64 {
	if previous == 0 {
		if current > 0 {
			return 100.0
		}
		return 0.0
	}
	return float64(current-previous) / float64(previous) * 100.0
}

func parseUUID(s string) (uuid.UUID, error) {
	return uuid.Parse(s)
}

// getActiveSubsTokenSum 获取所有活跃订阅的 token_balance 总和
func (h *AdminHandler) getActiveSubsTokenSum() int64 {
	total, err := h.subSvc.SumActiveTokenBalance()
	if err != nil {
		return 0
	}
	return total
}
