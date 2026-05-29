package handler

import (
	"net/http"

	"acp-client/internal/service"

	"github.com/gin-gonic/gin"
)

// ModelsGET 返回当前 ACP 服务信息（不支持模型切换）。
func ModelsGET(bridge *service.Bridge) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{
			"models":  []any{},
			"current": "remote",
			"fixed":   true,
		})
	}
}

// ModelPOST 模型切换已禁用（使用远程 ACP 服务）。
func ModelPOST(bridge *service.Bridge) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.JSON(http.StatusForbidden, gin.H{"error": "远程 ACP 模式不支持模型切换"})
	}
}
