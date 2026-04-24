package middleware

import (
	"log/slog"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

// RequestLogger logs each request with method, path, status, latency, user_id, and request_id.
func RequestLogger() gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		requestID := uuid.New().String()
		c.Set("request_id", requestID)
		c.Header("X-Request-ID", requestID)

		c.Next()

		latency := time.Since(start)
		user := GetUserFromContext(c)
		userID := ""
		if user != nil {
			userID = user.ID.String()
		}

		slog.Info("request",
			"method", c.Request.Method,
			"path", c.Request.URL.Path,
			"status", c.Writer.Status(),
			"latency_ms", latency.Milliseconds(),
			"user_id", userID,
			"request_id", requestID,
			"client_ip", c.ClientIP(),
		)
	}
}
