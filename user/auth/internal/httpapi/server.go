package httpapi

import (
	cryptorand "crypto/rand"
	"encoding/hex"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/openclaw/openclaw/mono/backend/auth/internal/api"
	"github.com/openclaw/openclaw/mono/backend/auth/internal/service"
)

type ServerConfig struct {
	CookieSecure   bool
	CookieSameSite http.SameSite
	SessionTTL     time.Duration
	OAuthReturnToAllowedHosts []string
	QQOAuth        *QQOAuthConfig
	GoogleOAuth    *GoogleOAuthConfig
	GitHubOAuth    *GitHubOAuthConfig
	WeChatOAuth    *WeChatOAuthConfig
	AvatarStore    AvatarStore
	Logger         *slog.Logger
	PublicBaseURL  string
	AdminToken     string
}

func NewRouter(authService *service.Service, config ServerConfig) *gin.Engine {
	router := gin.New()
	router.Use(
		requestIDMiddleware(),
		requestLogMiddleware(config.Logger),
		gin.Recovery(),
	)

	router.GET("/healthz", func(ctx *gin.Context) {
		ctx.JSON(http.StatusOK, gin.H{"status": "ok"})
	})

	handler := NewHandler(authService, config.CookieSecure, config.CookieSameSite, config.SessionTTL, config.QQOAuth, config.GoogleOAuth, config.GitHubOAuth, config.WeChatOAuth, config.PublicBaseURL, config.OAuthReturnToAllowedHosts)
	handler.avatarStore = config.AvatarStore
	registerOAuthRoutes(router, handler)
	router.POST("/auth/invite/prepare", handler.PrepareInvite)
	router.GET("/users/:userID/avatar", handler.GetUserAvatar)
	router.DELETE("/auth/profile", handler.DeleteProfile)
	api.RegisterHandlers(router, api.NewStrictHandler(handler, nil))

	if strings.TrimSpace(config.AdminToken) != "" {
		admin := router.Group("/admin", bearerAdminMiddleware(config.AdminToken))
		registerAdminRoutes(admin, authService, config.AvatarStore)
	}

	return router
}

func registerOAuthRoutes(router gin.IRoutes, handler *Handler) {
	if handler.qqOAuth != nil {
		router.GET("/auth/oauth/qq/start", handler.StartQQOAuth)
		router.GET("/auth/oauth/qq/callback", handler.HandleQQOAuthCallback)
	}
	if handler.googleOAuth != nil {
		router.GET("/auth/oauth/google/start", handler.StartGoogleOAuth)
		router.GET("/auth/oauth/google/callback", handler.HandleGoogleOAuthCallback)
	}
	if handler.githubOAuth != nil {
		router.GET("/auth/oauth/github/start", handler.StartGitHubOAuth)
		router.GET("/auth/oauth/github/callback", handler.HandleGitHubOAuthCallback)
	}
	if handler.wechatOAuth != nil {
		router.GET("/auth/oauth/wechat/start", handler.StartWeChatOAuth)
		router.GET("/auth/oauth/wechat/callback", handler.HandleWeChatOAuthCallback)
	}
}

const requestIDHeader = "X-Request-ID"
const requestIDContextKey = "request_id"

func requestIDMiddleware() gin.HandlerFunc {
	return func(ctx *gin.Context) {
		requestID := strings.TrimSpace(ctx.GetHeader(requestIDHeader))
		if requestID == "" {
			requestID = newRequestID()
		}
		ctx.Set(requestIDContextKey, requestID)
		ctx.Header(requestIDHeader, requestID)
		ctx.Next()
	}
}

func requestLogMiddleware(logger *slog.Logger) gin.HandlerFunc {
	if logger == nil {
		logger = slog.Default()
	}

	return func(ctx *gin.Context) {
		startedAt := time.Now()
		ctx.Next()

		if shouldSkipRequestLog(ctx) {
			return
		}

		reqLogger := requestLogger(ctx, logger)
		attrs := []any{
			"status", ctx.Writer.Status(),
			"latency_ms", time.Since(startedAt).Milliseconds(),
			"client_ip", ctx.ClientIP(),
			"user_agent", ctx.Request.UserAgent(),
		}
		if origin := strings.TrimSpace(ctx.GetHeader("Origin")); origin != "" {
			attrs = append(attrs, "origin", origin)
		}
		if len(ctx.Errors) > 0 {
			attrs = append(attrs, "errors", ctx.Errors.String())
		}

		switch status := ctx.Writer.Status(); {
		case status >= http.StatusInternalServerError:
			reqLogger.Error("request completed", attrs...)
		case status >= http.StatusBadRequest:
			reqLogger.Warn("request completed", attrs...)
		default:
			reqLogger.Info("request completed", attrs...)
		}
	}
}

func requestLogger(ctx *gin.Context, base *slog.Logger) *slog.Logger {
	if base == nil {
		base = slog.Default()
	}
	return base.With(
		"request_id", requestIDFromContext(ctx),
		"method", ctx.Request.Method,
		"path", ctx.Request.URL.Path,
	)
}

func requestIDFromContext(ctx *gin.Context) string {
	value, exists := ctx.Get(requestIDContextKey)
	if !exists {
		return ""
	}
	requestID, _ := value.(string)
	return requestID
}

func shouldSkipRequestLog(ctx *gin.Context) bool {
	return ctx.Request.URL.Path == "/healthz" || (ctx.Request.Method == http.MethodHead && ctx.Request.URL.Path == "/")
}

func newRequestID() string {
	var raw [8]byte
	if _, err := cryptorand.Read(raw[:]); err != nil {
		return time.Now().UTC().Format("20060102150405.000000000")
	}
	return hex.EncodeToString(raw[:])
}

func bearerAdminMiddleware(expectedToken string) gin.HandlerFunc {
	expected := strings.TrimSpace(expectedToken)
	return func(ctx *gin.Context) {
		authHeader := strings.TrimSpace(ctx.GetHeader("Authorization"))
		if !strings.HasPrefix(strings.ToLower(authHeader), "bearer ") {
			ctx.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
			return
		}
		token := strings.TrimSpace(strings.TrimPrefix(authHeader, "Bearer "))
		if token == "" || token != expected {
			ctx.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
			return
		}
		ctx.Next()
	}
}
