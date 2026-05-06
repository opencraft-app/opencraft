package api

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

const corsAllowAllOrigins = "*"

func (r *RestApi) CORSMiddleware() gin.HandlerFunc {
	allowedOrigins := normalizeAllowedOrigins(r.conf.CORS.AllowedOrigins)
	allowAll := containsOrigin(allowedOrigins, corsAllowAllOrigins)

	return func(ct *gin.Context) {
		origin := strings.TrimSpace(ct.GetHeader("Origin"))
		if origin == "" || len(allowedOrigins) == 0 {
			ct.Next()
			return
		}

		if allowAll {
			ct.Header("Access-Control-Allow-Origin", corsAllowAllOrigins)
		} else if containsOrigin(allowedOrigins, origin) {
			ct.Header("Access-Control-Allow-Origin", origin)
			ct.Header("Vary", "Origin")
		} else {
			ct.Next()
			return
		}

		ct.Header("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS")
		ct.Header("Access-Control-Allow-Headers", strings.Join([]string{
			"Authorization",
			"Content-Type",
			staticPagesRepositoryHeader,
			staticPagesBranchHeader,
			staticPagesSHAHeader,
			staticPagesEnvironmentHeader,
		}, ", "))
		ct.Header("Access-Control-Max-Age", "600")

		if ct.Request.Method == http.MethodOptions {
			ct.AbortWithStatus(http.StatusNoContent)
			return
		}

		ct.Next()
	}
}

func normalizeAllowedOrigins(origins []string) []string {
	normalized := make([]string, 0, len(origins))
	for _, origin := range origins {
		origin = strings.TrimSpace(origin)
		if origin == "" {
			continue
		}
		normalized = append(normalized, origin)
	}
	return normalized
}

func containsOrigin(origins []string, target string) bool {
	for _, origin := range origins {
		if origin == target {
			return true
		}
	}
	return false
}
