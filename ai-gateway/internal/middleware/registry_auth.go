package middleware

import (
	"net/http"
	"strings"

	"git.woa.com/wisp/mono/ai-gateway/internal/pkg/response"
	"github.com/gin-gonic/gin"
)

// RegistryAuth 验证服务注册中心的 Bearer token。
func RegistryAuth(token string) gin.HandlerFunc {
	return func(c *gin.Context) {
		authHeader := c.GetHeader("Authorization")
		if authHeader == "" {
			response.ErrorResponse(c, http.StatusUnauthorized, "authentication_error", "missing_token", "Missing Authorization header")
			return
		}

		bearerToken := strings.TrimPrefix(authHeader, "Bearer ")
		if bearerToken == authHeader || bearerToken != token {
			response.ErrorResponse(c, http.StatusUnauthorized, "authentication_error", "invalid_token", "Invalid registry token")
			return
		}

		c.Next()
	}
}
