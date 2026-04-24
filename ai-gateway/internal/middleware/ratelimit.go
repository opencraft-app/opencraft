package middleware

import (
	"context"
	"time"

	"git.woa.com/wisp/mono/ai-gateway/internal/model"
	"git.woa.com/wisp/mono/ai-gateway/internal/pkg/redisclient"
	"git.woa.com/wisp/mono/ai-gateway/internal/pkg/response"
	"github.com/gin-gonic/gin"
)

// RateLimiter 检查 Plan 中定义的所有限流规则（多维度固定窗口）。
// 每条规则使用对齐窗口的 Redis 计数器，超限时返回详细 429 响应。
// Redis 出错时采用 fail-open 策略（放行请求）。
func RateLimiter(redisClient *redisclient.Client) gin.HandlerFunc {
	return func(c *gin.Context) {
		if redisClient == nil {
			c.Next()
			return
		}

		user := GetUserFromContext(c)
		plan := GetPlanFromContext(c)

		if user == nil {
			response.ErrInternal(c)
			return
		}
		if plan == nil {
			c.Next()
			return
		}

		rules, err := plan.ParseRateLimits()
		if err != nil {
			// 解析失败，fail open
			c.Next()
			return
		}
		if len(rules) == 0 {
			// 没有限流规则，直接放行
			c.Next()
			return
		}

		ctx := context.Background()
		userID := user.ID.String()
		now := time.Now()

		for _, rule := range rules {
			// 计算对齐窗口的 Redis key
			key, err := model.AlignedWindowKey(userID, rule.Window, now)
			if err != nil {
				// key 计算失败，跳过该规则（fail open）
				continue
			}

			// 计算窗口剩余秒数作为 TTL
			windowSecs, err := model.WindowToSeconds(rule.Window)
			if err != nil {
				continue
			}

			// 计算当前窗口的剩余 TTL
			start, err := model.AlignedWindowStart(rule.Window, now)
			if err != nil {
				continue
			}
			elapsed := now.Unix() - start
			remaining := windowSecs - elapsed
			if remaining <= 0 {
				remaining = windowSecs // 安全兜底
			}
			ttl := time.Duration(remaining) * time.Second

			count, err := redisClient.IncrWithTTL(ctx, key, ttl)
			if err != nil {
				// Redis 出错，fail open
				continue
			}

			if count > int64(rule.MaxRequests) {
				retryAfter := int(remaining)
				if retryAfter <= 0 {
					retryAfter = int(windowSecs)
				}
				response.ErrRateLimitDetail(c, rule.Label, rule.Window, rule.MaxRequests, retryAfter)
				return
			}
		}

		c.Next()
	}
}
