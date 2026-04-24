package middleware

import (
	"crypto/subtle"
	"strings"

	"git.woa.com/wisp/mono/ai-gateway/internal/pkg/response"
	"github.com/gin-gonic/gin"
)

// InternalServiceAuth validates bearer auth for trusted internal services.
func InternalServiceAuth(serviceToken string) gin.HandlerFunc {
	return func(c *gin.Context) {
		authHeader := c.GetHeader("Authorization")
		if authHeader == "" || !strings.HasPrefix(authHeader, "Bearer ") {
			response.ErrInvalidAPIKey(c)
			return
		}
		token := strings.TrimPrefix(authHeader, "Bearer ")
		if subtle.ConstantTimeCompare([]byte(token), []byte(serviceToken)) != 1 {
			response.ErrInvalidAPIKey(c)
			return
		}
		c.Next()
	}
}
