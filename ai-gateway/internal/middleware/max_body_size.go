package middleware

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

// MaxBodySize limits the request body to maxBytes using http.MaxBytesReader.
func MaxBodySize(maxBytes int64) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxBytes)
		c.Next()
	}
}
