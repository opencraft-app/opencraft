package httpapi

import (
	"crypto/subtle"
	"net/http"

	"github.com/gin-gonic/gin"
)

// wildcardOrigin 是 CORS 白名单的通配符，命中时允许任意 Origin。
const wildcardOrigin = "*"

// corsMiddleware 按 AllowedOrigins 白名单放行跨域请求。
//
// AllowedOrigins 语义：
//   - nil / 空切片：关闭跨域（不设置任何 Access-Control-* 头）。
//   - 含 "*"：允许任意 Origin。此时 Access-Control-Allow-Credentials 被强制关闭，
//     以符合 W3C CORS 规范（浏览器会拒绝 `*` + credentials 的组合）。
//   - 其他：仅命中白名单的 Origin 才回显头，未命中的请求不设置 CORS 头
//     （浏览器会因缺少 Access-Control-Allow-Origin 而拒绝跨域）。
func corsMiddleware(allowed []string) gin.HandlerFunc {
	set := make(map[string]struct{}, len(allowed))
	allowAny := false
	for _, o := range allowed {
		if o == wildcardOrigin {
			allowAny = true
			continue
		}
		set[o] = struct{}{}
	}

	return func(c *gin.Context) {
		origin := c.GetHeader("Origin")

		// 判定当前 Origin 是否被允许。
		var (
			allowOrigin       string
			allowCredentials  bool
			originIsWhitelist bool
		)
		if origin != "" {
			if _, ok := set[origin]; ok {
				allowOrigin = origin
				allowCredentials = true
				originIsWhitelist = true
			} else if allowAny {
				// 通配符：回显 "*"，禁用 credentials（W3C 规定）。
				allowOrigin = wildcardOrigin
				allowCredentials = false
			}
		}

		if allowOrigin != "" {
			c.Header("Access-Control-Allow-Origin", allowOrigin)
			if allowCredentials {
				c.Header("Access-Control-Allow-Credentials", "true")
			}
			c.Header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Admin-Token, X-User-Id, X-Realm, X-Agent-Id")
			c.Header("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS")
			// Origin 在响应缓存中作为 vary 依据，避免中间层错误共享白名单/非白名单响应。
			if originIsWhitelist || allowAny {
				c.Header("Vary", "Origin")
			}
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
//
// 安全说明：
//   - 使用 subtle.ConstantTimeCompare 避免定时侧信道攻击。
//   - `expected` 由 NewRouter 在启动期硬校验为非空；此处仍保留 `expected == ""`
//     短路作为纵深防御（第二道防线），避免未来意外传入空 token 时被
//     ConstantTimeCompare("", "") 判定为相等而绕过。
//
// TODO: 后续替换为 admin-gateway 下发的 JWT。
func adminAuthMiddleware(expected string) gin.HandlerFunc {
	return func(c *gin.Context) {
		if expected == "" {
			// 纵深防御：正常调用路径下 NewRouter 已拒绝空 token，
			// 若此分支被触发说明有代码绕过 NewRouter 直接挂载，视为配置错误。
			c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "admin_token_not_configured"})
			return
		}

		got := c.GetHeader("X-Admin-Token")
		if got == "" || subtle.ConstantTimeCompare([]byte(got), []byte(expected)) != 1 {
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
