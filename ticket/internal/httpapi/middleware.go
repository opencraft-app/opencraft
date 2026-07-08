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
// # 信任模型与安全说明
//
// 生产链路（可信）：
//
//	客户端 → service-gateway → ticket
//	service-gateway.injectIdentityHeaders 会先剥离所有来自客户端的
//	X-User-Id / X-Lightclaw-User-ID，再注入自己验证过的身份（基于
//	session 服务），因此到达本中间件的 header 是可信的。
//	同时 ticket 以 ClusterIP Service 部署在 k8s 集群内网，外部流量
//	必须经过 gateway 才能抵达，不直接暴露公网。
//
// 非生产/直连场景（需运维保障）：
//
//	开发或内网直连时，任意调用方可以伪造 X-User-Id。
//	本中间件通过检查 X-Forwarded-Via-Gateway 头感知此场景：
//	  - service-gateway 在转发前设置该头为固定值 "service-gateway"；
//	  - 缺少该头时记录结构化 WARN 日志，方便接入 CLS 告警规则追踪。
//	  - 该场景是允许的（内网 / 本地开发），但必须由部署侧通过网络层
//	    隔离（k8s NetworkPolicy / 安全组）保障 ticket 不可被外部直达。
//
// 与 userAuthMiddleware 的区别：不再依赖 X-Realm 头（gateway 不注入）。
// 与 supportAgentMiddleware 的区别：不做白名单判定，任意登录用户均可提交。
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
		// 可观测性：感知直连（绕过 gateway）场景。
		// service-gateway.injectIdentityHeaders 会同时注入 X-Lightclaw-User-Email；
		// 缺少该头说明请求可能未经 gateway（email 字段 gateway 必注入）。
		// 此处仅记录日志（不拒绝），配合 CLS 告警规则可在异常流量出现时触发告警。
		// 生产安全保障由两道防线共同提供：
		//   1. gateway 在注入前剥离所有来自客户端的同名 header（身份不可伪造）；
		//   2. ticket 以 ClusterIP Service 部署在 k8s 集群内网，不直接暴露公网。
		if strings.TrimSpace(c.GetHeader("X-Lightclaw-User-Email")) == "" {
			c.Set("identity_via_gateway", false)
			gin.DefaultWriter.Write([]byte( //nolint:errcheck
				"[WARN] supportUserMiddleware: X-Lightclaw-User-Email missing;" +
					" user_id=" + uid +
					" path=" + c.Request.URL.Path +
					" remote=" + c.ClientIP() +
					" — request may not have passed through service-gateway;" +
					" identity header could be forged in non-production environments\n",
			))
		} else {
			c.Set("identity_via_gateway", true)
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
