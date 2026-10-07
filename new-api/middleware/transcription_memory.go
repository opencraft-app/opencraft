package middleware

import (
	"net/http"

	"github.com/QuantumNous/new-api/common"
	"github.com/gin-gonic/gin"
)

// MemoryTranscriptionAdmission bounds memory-only uploads before any middleware
// reads their model/body. The lease spans the entire relay, including retries.
// Ordinary LLM and other audio endpoints retain their existing admission policy.
func MemoryTranscriptionAdmission() gin.HandlerFunc {
	limit := common.GetEnvOrDefault("TRANSCRIPTION_MAX_CONCURRENT", 4)
	if limit < 1 || limit > 64 {
		limit = 4
	}
	return memoryTranscriptionAdmission(limit)
}

func memoryTranscriptionAdmission(limit int) gin.HandlerFunc {
	leases := make(chan struct{}, limit)
	return func(c *gin.Context) {
		if !common.IsMemoryOnlyTranscription(c) {
			c.Next()
			return
		}
		select {
		case leases <- struct{}{}:
			defer func() { <-leases }()
			c.Next()
		default:
			c.Header("Retry-After", "1")
			c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{"error": gin.H{
				"message": "audio transcription concurrency limit reached", "type": "rate_limit_error", "code": "transcription_concurrency_limit",
			}})
		}
	}
}
