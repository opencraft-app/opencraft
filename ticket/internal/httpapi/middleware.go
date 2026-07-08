package httpapi

import (
	"crypto/subtle"
	"net/http"
	"strings"

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

// supportUserMiddleware 校验反馈系统用户侧（/support/feedback/presign）身份。
//
// 与 userAuthMiddleware 的区别：不再依赖 X-Realm 头。
// 身份来源：上游鉴权网关在 access: authenticated 路由下注入的
// X-User-Id / X-Lightclaw-User-ID（service-gateway.injectIdentityHeaders
// 同时注入两者）。网关会先剥离外部传入的同名头再注入自己验证过的身份，
// 因此在生产链路中该头可信；开发/内网直连场景由部署侧保证。
//
// 与 supportAgentMiddleware 的区别：不做白名单判定——任意登录用户
// 都可提交反馈；运营白名单仅用于 /list、/sign 后台读取通道。
func supportUserMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := strings.TrimSpace(c.GetHeader("X-User-Id"))
		if uid == "" {
			uid = strings.TrimSpace(c.GetHeader("X-Lightclaw-User-ID"))
		}
		if uid == "" {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
			return
		}
		c.Set("user_id", uid)
		c.Next()
	}
}

// supportAgentMiddleware 校验当前登录用户是否在反馈后台运营白名单内。
//
// 身份来源：上游鉴权网关在 access: authenticated 路由下注入的 X-User-Id
// （service-gateway 的 injectIdentityHeaders 同时注入 X-User-Id 与
// X-Lightclaw-User-ID，本中间件两者都认，优先 X-User-Id）。网关会先剥离
// 外部传入的同名头再注入自己验证过的身份，因此该头可信。
//
// 与 adminAuthMiddleware 的区别：不依赖共享 X-Admin-Token，而是按具体用户
// ID 做白名单判定，从而支持「按个体运营用户」授权与审计。
//
// agentIDs 为空时仅校验登录态（有 X-User-Id 即放行），由上游鉴权网关保证身份可信；
// 非空时按白名单判定，仅允许指定运营用户访问。
func supportAgentMiddleware(agentIDs []string) gin.HandlerFunc {
	allow := make(map[string]struct{}, len(agentIDs))
	for _, id := range agentIDs {
		if id = strings.TrimSpace(id); id != "" {
			allow[id] = struct{}{}
		}
	}
	return func(c *gin.Context) {
		uid := strings.TrimSpace(c.GetHeader("X-User-Id"))
		if uid == "" {
			uid = strings.TrimSpace(c.GetHeader("X-Lightclaw-User-ID"))
		}
		if uid == "" {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
			return
		}
		if len(allow) > 0 {
			if _, ok := allow[uid]; !ok {
				c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "forbidden"})
				return
			}
		}
		c.Set("user_id", uid)
		c.Next()
	}
}
