package httpapi

import (
	"crypto/subtle"
	"net/http"

	"github.com/gin-gonic/gin"
)

// corsMiddleware 按 AllowedOrigins 白名单放行跨域请求。
// 白名单为空时不设置任何 Access-Control-* 头（等价于禁用跨域）。
func corsMiddleware(allowed []string) gin.HandlerFunc {
	set := make(map[string]struct{}, len(allowed))
	for _, o := range allowed {
		set[o] = struct{}{}
	}
	return func(c *gin.Context) {
		origin := c.GetHeader("Origin")
		if _, ok := set[origin]; ok {
			c.Header("Access-Control-Allow-Origin", origin)
			c.Header("Access-Control-Allow-Credentials", "true")
			c.Header("Access-Control-Allow-Headers", "Content-Type, Authorization")
			c.Header("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS")
		}
		if c.Request.Method == http.MethodOptions {
			c.AbortWithStatus(http.StatusNoContent)
			return
		}
		c.Next()
	}
}

// userAuthMiddleware 校验用户身份。
//
// TODO: 对接统一登录（session cookie）。骨架期用 X-User-Id / X-Realm 头，
// 仅内网 / 开发环境使用；上线前必须替换。
func userAuthMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := c.GetHeader("X-User-Id")
		realm := c.GetHeader("X-Realm")
		if uid == "" || realm == "" {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
			return
		}
		c.Set("user_id", uid)
		c.Set("realm", realm)
		c.Next()
	}
}

// adminAuthMiddleware 校验运营侧共享 AdminToken + realm/agent header。
// 使用 subtle.ConstantTimeCompare 避免定时侧信道。
// 后续替换为 admin-gateway 下发的 JWT。
func adminAuthMiddleware(expected string) gin.HandlerFunc {
	return func(c *gin.Context) {
		got := c.GetHeader("X-Admin-Token")
		if expected == "" || subtle.ConstantTimeCompare([]byte(got), []byte(expected)) != 1 {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
			return
		}
		realm := c.GetHeader("X-Realm")
		agent := c.GetHeader("X-Agent-Id")
		if realm == "" || agent == "" {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
			return
		}
		c.Set("realm", realm)
		c.Set("agent_id", agent)
		c.Next()
	}
}
