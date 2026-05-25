package handler

import (
	"net/http"
	"strconv"

	"acp-client/internal/service"

	"github.com/gin-gonic/gin"
)

// EventsBefore 返回指定轮次之前的历史事件（用于向上滚动加载）。
// 参数: ?before=<turnIndex>&limit=<count>
func EventsBefore(bridge *service.Bridge) gin.HandlerFunc {
	return func(c *gin.Context) {
		beforeStr := c.DefaultQuery("before", "0")
		limitStr := c.DefaultQuery("limit", "10")
		before, _ := strconv.Atoi(beforeStr)
		limit, _ := strconv.Atoi(limitStr)
		if limit <= 0 || limit > 50 {
			limit = 10
		}
		events, hasMore := bridge.EventLogTurnsBefore(before, limit)
		c.JSON(http.StatusOK, gin.H{
			"events":  events,
			"hasMore": hasMore,
		})
	}
}
