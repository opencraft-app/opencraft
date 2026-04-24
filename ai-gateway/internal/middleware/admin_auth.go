package middleware

import (
	"crypto/subtle"
	"net"
	"net/http"
	"strings"

	"git.woa.com/wisp/mono/ai-gateway/internal/pkg/response"
	"github.com/gin-gonic/gin"
)

// AdminAuth validates admin token and optionally checks IP whitelist.
// ipWhitelist entries can be CIDR notation (e.g. "10.0.0.0/8") or exact IPs.
func AdminAuth(adminToken string, ipWhitelist []string) gin.HandlerFunc {
	return func(c *gin.Context) {
		// Check token
		authHeader := c.GetHeader("Authorization")
		if authHeader == "" || !strings.HasPrefix(authHeader, "Bearer ") {
			response.ErrInvalidAPIKey(c)
			return
		}
		token := strings.TrimPrefix(authHeader, "Bearer ")
		if subtle.ConstantTimeCompare([]byte(token), []byte(adminToken)) != 1 {
			response.ErrInvalidAPIKey(c)
			return
		}

		// Check IP whitelist (if configured)
		if len(ipWhitelist) > 0 {
			clientIP := c.ClientIP()
			allowed := false
			for _, cidr := range ipWhitelist {
				_, network, err := net.ParseCIDR(cidr)
				if err != nil {
					// Try as exact IP
					if clientIP == cidr {
						allowed = true
						break
					}
					continue
				}
				if network.Contains(net.ParseIP(clientIP)) {
					allowed = true
					break
				}
			}
			if !allowed {
				c.JSON(http.StatusForbidden, gin.H{"error": "IP not allowed"})
				c.Abort()
				return
			}
		}

		c.Next()
	}
}
