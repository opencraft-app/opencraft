package main

import (
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/openclaw/openclaw/mono/backend/auth/internal/avatar"
	"github.com/openclaw/openclaw/mono/backend/auth/internal/httpapi"
	"github.com/openclaw/openclaw/mono/backend/auth/internal/logging"
	"github.com/openclaw/openclaw/mono/backend/auth/internal/realname"
	"github.com/openclaw/openclaw/mono/backend/auth/internal/service"
)

func main() {
	logger := logging.New(logging.Config{
		Service: "lightclaw-auth",
		Level:   envOrDefault("LIGHTCLAW_LOG_LEVEL", "info"),
	})
	slog.SetDefault(logger)

	sessionTTL := 30 * 24 * time.Hour
	authStore := newStore()
	authService := service.NewWithStore(authStore, service.Options{
		SessionTTL:       sessionTTL,
		DefaultSMSCode:   envOrDefault("LIGHTCLAW_DEV_SMS_CODE", ""),
		RealnameVerifier: buildRealnameVerifier(logger),
		RealnameCipher:   buildRealnameCipher(logger),
	})
	avatarStore := buildAvatarStore(logger)

	router := httpapi.NewRouter(authService, httpapi.ServerConfig{
		CookieSecure:   envOrDefault("LIGHTCLAW_COOKIE_SECURE", "false") == "true",
		CookieSameSite: parseSameSite(envOrDefault("LIGHTCLAW_COOKIE_SAME_SITE", "lax")),
		SessionTTL:     sessionTTL,
		QQOAuth:        buildQQOAuthConfig(),
		GoogleOAuth:    buildGoogleOAuthConfig(),
		GitHubOAuth:    buildGitHubOAuthConfig(),
		WeChatOAuth:    buildWeChatOAuthConfig(),
		AvatarStore:    avatarStore,
		Logger:         logger,
		PublicBaseURL:  envOrDefault("LIGHTCLAW_PUBLIC_BASE_URL", "https://lightclaw.tech"),
		AdminToken:     envOrDefault("LIGHTCLAW_ADMIN_TOKEN", ""),
	})

	address := envOrDefault("LIGHTCLAW_AUTH_ADDR", ":8081")
	server := &http.Server{
		Addr:              address,
		Handler:           router,
		ReadHeaderTimeout: 5 * time.Second,
	}

	slog.Info("lightclaw auth listening", "addr", address)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		slog.Error("lightclaw auth exited unexpectedly", "err", err)
		os.Exit(1)
	}
}

func newStore() service.Store {
	dsn := strings.TrimSpace(os.Getenv("LIGHTCLAW_MYSQL_DSN"))
	if dsn == "" {
		dsn = strings.TrimSpace(os.Getenv("MYSQL_DSN"))
	}
	if dsn == "" {
		slog.Info("lightclaw auth using in-memory store")
		return service.NewMemoryStore(service.StoreOptions{
			SeedDefaultInvites: true,
			SeedDemoUser:       envOrDefault("LIGHTCLAW_SEED_DEMO_USER", "false") == "true",
		})
	}

	store, err := service.NewMySQLStore(dsn, service.StoreOptions{
		SeedDefaultInvites: false,
		SeedDemoUser:       false,
	})
	if err != nil {
		slog.Error("init mysql store failed", "err", err)
		os.Exit(1)
	}
	slog.Info("lightclaw auth using MySQL store")
	return store
}

func envOrDefault(key string, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func parseSameSite(value string) http.SameSite {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "", "lax":
		return http.SameSiteLaxMode
	case "none":
		return http.SameSiteNoneMode
	case "strict":
		return http.SameSiteStrictMode
	default:
		slog.Warn("invalid LIGHTCLAW_COOKIE_SAME_SITE, defaulting to lax", "value", value)
		return http.SameSiteLaxMode
	}
}

func oauthBaseURLs() (string, string) {
	return envOrDefault("LIGHTCLAW_FRONTEND_BASE_URL", "https://lightclaw.pages.dev"),
		envOrDefault("LIGHTCLAW_PUBLIC_BASE_URL", "https://lightclaw.tech")
}

func buildQQOAuthConfig() *httpapi.QQOAuthConfig {
	appID := strings.TrimSpace(os.Getenv("LIGHTCLAW_QQ_APP_ID"))
	appKey := strings.TrimSpace(os.Getenv("LIGHTCLAW_QQ_APP_KEY"))
	if appID == "" || appKey == "" {
		return nil
	}
	frontendBaseURL, publicBaseURL := oauthBaseURLs()

	return &httpapi.QQOAuthConfig{
		AppID:           appID,
		AppKey:          appKey,
		RedirectURI:     envOrDefault("LIGHTCLAW_QQ_REDIRECT_URI", "https://lightclaw.tech/auth/oauth/qq/callback"),
		FrontendBaseURL: frontendBaseURL,
		PublicBaseURL:   publicBaseURL,
	}
}

func buildWeChatOAuthConfig() *httpapi.WeChatOAuthConfig {
	appID := strings.TrimSpace(os.Getenv("LIGHTCLAW_WECHAT_APP_ID"))
	appSecret := strings.TrimSpace(os.Getenv("LIGHTCLAW_WECHAT_APP_SECRET"))
	if appID == "" || appSecret == "" {
		return nil
	}
	frontendBaseURL, publicBaseURL := oauthBaseURLs()

	return &httpapi.WeChatOAuthConfig{
		AppID:           appID,
		AppSecret:       appSecret,
		RedirectURI:     envOrDefault("LIGHTCLAW_WECHAT_REDIRECT_URI", "https://lightclaw.tech/auth/oauth/wechat/callback"),
		FrontendBaseURL: frontendBaseURL,
		PublicBaseURL:   publicBaseURL,
	}
}

func buildGoogleOAuthConfig() *httpapi.GoogleOAuthConfig {
	clientID := strings.TrimSpace(os.Getenv("LIGHTCLAW_GOOGLE_CLIENT_ID"))
	clientSecret := strings.TrimSpace(os.Getenv("LIGHTCLAW_GOOGLE_CLIENT_SECRET"))
	if clientID == "" || clientSecret == "" {
		return nil
	}

	return &httpapi.GoogleOAuthConfig{
		ClientID:        clientID,
		ClientSecret:    clientSecret,
		RedirectURI:     envOrDefault("LIGHTCLAW_GOOGLE_REDIRECT_URI", "https://lightclaw.tech/auth/oauth/google/callback"),
		FrontendBaseURL: envOrDefault("LIGHTCLAW_FRONTEND_BASE_URL", "https://lightclaw.pages.dev"),
		PublicBaseURL:   envOrDefault("LIGHTCLAW_PUBLIC_BASE_URL", "https://lightclaw.tech"),
	}
}

func buildGitHubOAuthConfig() *httpapi.GitHubOAuthConfig {
	clientID := strings.TrimSpace(os.Getenv("LIGHTCLAW_GITHUB_CLIENT_ID"))
	clientSecret := strings.TrimSpace(os.Getenv("LIGHTCLAW_GITHUB_CLIENT_SECRET"))
	if clientID == "" || clientSecret == "" {
		return nil
	}

	return &httpapi.GitHubOAuthConfig{
		ClientID:        clientID,
		ClientSecret:    clientSecret,
		RedirectURI:     envOrDefault("LIGHTCLAW_GITHUB_REDIRECT_URI", "https://lightclaw.tech/auth/oauth/github/callback"),
		FrontendBaseURL: envOrDefault("LIGHTCLAW_FRONTEND_BASE_URL", "https://lightclaw.pages.dev"),
		PublicBaseURL:   envOrDefault("LIGHTCLAW_PUBLIC_BASE_URL", "https://lightclaw.tech"),
	}
}

func buildRealnameVerifier(logger *slog.Logger) service.RealnameVerifier {
	secretID := strings.TrimSpace(os.Getenv("TENCENT_REALNAME_SECRET_ID"))
	secretKey := strings.TrimSpace(os.Getenv("TENCENT_REALNAME_SECRET_KEY"))
	if secretID == "" || secretKey == "" {
		logger.Warn("realname verifier disabled due to incomplete Tencent FaceID config")
		return nil
	}
	client, err := realname.New(realname.Config{
		SecretID:  secretID,
		SecretKey: secretKey,
		Endpoint:  envOrDefault("TENCENT_REALNAME_ENDPOINT", "faceid.tencentcloudapi.com"),
	})
	if err != nil {
		logger.Error("init realname verifier failed", "err", err)
		return nil
	}
	logger.Info("realname verifier enabled")
	return client
}

func buildRealnameCipher(logger *slog.Logger) service.RealnameCipher {
	key := strings.TrimSpace(os.Getenv("REALNAME_ENCRYPTION_KEY"))
	if key == "" {
		logger.Warn("realname cipher disabled due to missing REALNAME_ENCRYPTION_KEY")
		return nil
	}
	cipher, err := service.NewAESGCMRealnameCipher(key)
	if err != nil {
		logger.Error("init realname cipher failed", "err", err)
		return nil
	}
	logger.Info("realname cipher enabled")
	return cipher
}

func buildAvatarStore(logger *slog.Logger) httpapi.AvatarStore {
	bucketURL := strings.TrimSpace(os.Getenv("LIGHTCLAW_COS_BUCKET_URL"))
	secretID := strings.TrimSpace(os.Getenv("LIGHTCLAW_COS_SECRET_ID"))
	secretKey := strings.TrimSpace(os.Getenv("LIGHTCLAW_COS_SECRET_KEY"))
	if bucketURL == "" || secretID == "" || secretKey == "" {
		logger.Warn("avatar store disabled due to incomplete COS config")
		return nil
	}

	store, err := avatar.NewCOSStore(avatar.COSConfig{
		BucketURL:    bucketURL,
		SecretID:     secretID,
		SecretKey:    secretKey,
		SignedURLTTL: 5 * time.Minute,
		MaxBytes:     200 * 1024,
	})
	if err != nil {
		logger.Error("init avatar store failed", "err", err)
		return nil
	}
	logger.Info("avatar store enabled", "bucket_url", bucketURL)
	return store
}
