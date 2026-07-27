package main

import (
	"encoding/base64"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/openclaw/openclaw/mono/backend/auth/internal/avatar"
	"github.com/openclaw/openclaw/mono/backend/auth/internal/contentaudit"
	"github.com/openclaw/openclaw/mono/backend/auth/internal/dbconfig"
	"github.com/openclaw/openclaw/mono/backend/auth/internal/httpapi"
	"github.com/openclaw/openclaw/mono/backend/auth/internal/logging"
	"github.com/openclaw/openclaw/mono/backend/auth/internal/realname"
	"github.com/openclaw/openclaw/mono/backend/auth/internal/service"
	"github.com/openclaw/openclaw/mono/backend/auth/internal/ses"
	"github.com/openclaw/openclaw/mono/backend/auth/internal/shadowbinding"
	phonesms "github.com/openclaw/openclaw/mono/backend/auth/internal/sms"
	"github.com/openclaw/openclaw/mono/backend/auth/internal/tat"
)

func main() {
	logger := logging.New(logging.Config{
		Service: "lightclaw-auth",
		Level:   envOrDefault("LIGHTCLAW_LOG_LEVEL", "info"),
	})
	slog.SetDefault(logger)

	sessionTTL := 30 * 24 * time.Hour
	contentAuditConfig := buildContentAuditConfig(logger)
	contentAuditClient := buildContentAuditClient(logger, contentAuditConfig)
	stores := newStores(contentAuditConfig.Enabled)
	shadowBinding := buildShadowBindingService(stores.shadow, logger)
	phoneAuthEnabled := envOrDefault("LIGHTCLAW_PHONE_AUTH_ENABLED", "false") == "true"
	phoneAuthSMSSender := buildPhoneAuthSMSSender(logger)
	realnameClient := buildRealnameClient(logger)
	realnameCipher := buildRealnameCipher(logger)
	realnameFaceIDConfig := buildRealnameFaceIDConfig()
	shadowBasicAuthSyncEnabled := envOrDefault("SHADOW_BASIC_AUTH_SYNC_ENABLED", "false") == "true"
	_, durableStore := stores.auth.(*service.MySQLStore)
	if err := service.ValidateRealnameFaceIDStartup(realnameFaceIDConfig, realnameClient, realnameCipher, shadowBinding, shadowBasicAuthSyncEnabled, durableStore); err != nil {
		logger.Error("invalid realname FaceID startup config", "err", err)
		os.Exit(1)
	}
	publicBaseURL := envOrDefault("LIGHTCLAW_PUBLIC_BASE_URL", "https://lightclaw.tech")
	frontendBaseURL := envOrDefault("LIGHTCLAW_FRONTEND_BASE_URL", publicBaseURL)
	authService := service.NewWithStore(stores.auth, service.Options{
		SessionTTL: sessionTTL,
		PhoneAuth: service.PhoneAuthConfig{
			Enabled:   phoneAuthEnabled,
			SMSSender: phoneAuthSMSSender,
		},
		RealnameVerifier:       realnameClient,
		RealnameFaceIDVerifier: realnameClient,
		RealnameCipher:         realnameCipher,
		RealnameFaceID:         realnameFaceIDConfig,
		ContentAudit:           contentAuditConfig,
		ContentAuditClient:     contentAuditClient,
		ShadowBinding:          shadowBinding,
		PassBillingMigration: service.NewHTTPPassBillingMigrationNotifier(service.PassBillingMigrationNotifierConfig{
			BaseURL: envOrDefault("CTL_INTERNAL_BASE_URL", ""),
			Token:   envOrDefault("LIGHTCLAW_INTERNAL_SERVICE_TOKEN", ""),
			Timeout: parseDurationEnv("PASS_BILLING_MIGRATION_TIMEOUT", 10*time.Second),
		}),
		ShadowBasicAuthSyncEnabled: shadowBasicAuthSyncEnabled,
		EmailBind: service.EmailBindConfig{
			Enabled:         envOrDefault("LIGHTCLAW_EMAIL_BIND_ENABLED", "false") == "true",
			TokenTTL:        time.Duration(envInt64OrDefault("LIGHTCLAW_EMAIL_BIND_TOKEN_TTL_SECONDS", 1800)) * time.Second,
			Cooldown:        time.Duration(envInt64OrDefault("LIGHTCLAW_EMAIL_BIND_COOLDOWN_SECONDS", 60)) * time.Second,
			PublicBaseURL:   publicBaseURL,
			FrontendBaseURL: frontendBaseURL,
			Sender:          buildEmailBindSender(logger),
		},
	})
	avatarStore := buildAvatarStore(logger)

	router := httpapi.NewRouter(authService, httpapi.ServerConfig{
		CookieSecure:               envOrDefault("LIGHTCLAW_COOKIE_SECURE", "false") == "true",
		CookieSameSite:             parseSameSite(envOrDefault("LIGHTCLAW_COOKIE_SAME_SITE", "lax")),
		SessionTTL:                 sessionTTL,
		OAuthReturnToAllowedHosts:  parseCSVEnv("LIGHTCLAW_OAUTH_RETURN_TO_ALLOWED_HOSTS"),
		QQOAuth:                    buildQQOAuthConfig(),
		GoogleOAuth:                buildGoogleOAuthConfig(),
		GitHubOAuth:                buildGitHubOAuthConfig(),
		WeChatOAuth:                buildWeChatOAuthConfig(),
		AvatarStore:                avatarStore,
		TATRegisterIssuer:          buildTATRegisterIssuer(logger),
		DeviceBindTokenSecret:      envOrDefault("LIGHTCLAW_DEVICE_BIND_TOKEN_SECRET", ""),
		DeviceBindTokenTTL:         time.Duration(envInt64OrDefault("LIGHTCLAW_DEVICE_BIND_TOKEN_TTL_SECONDS", 600)) * time.Second,
		Logger:                     logger,
		PublicBaseURL:              publicBaseURL,
		FrontendBaseURL:            frontendBaseURL,
		AdminToken:                 envOrDefault("LIGHTCLAW_ADMIN_TOKEN", ""),
		E2EAuthEnabled:             envOrDefault("LIGHTVELA_E2E_AUTH_ENABLED", "false") == "true",
		E2EAuthToken:               envOrDefault("LIGHTVELA_E2E_AUTH_TOKEN", ""),
		ShadowBindingInternalToken: envOrDefault("SHADOW_BINDING_INTERNAL_TOKEN", ""),
		ShadowTencentCallbackToken: envOrDefault("SHADOW_TENCENT_CALLBACK_TOKEN", envOrDefault("SHADOW_CALLBACK_TOKEN", "")),
		TrustedProxyCIDRs:          parseCSVEnv("LIGHTCLAW_TRUSTED_PROXY_CIDRS"),
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

func envInt64OrDefault(key string, fallback int64) int64 {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		slog.Warn("invalid integer env, using fallback", "key", key, "value", raw, "fallback", fallback)
		return fallback
	}
	return value
}

func buildContentAuditConfig(logger *slog.Logger) service.ContentAuditConfig {
	enabled := envOrDefault("CONTENT_AUDIT_ENABLED", "false") == "true"
	nameAuditEnabled := enabled && boolEnvOrDefault("CONTENT_AUDIT_NAME_ENABLED", true)
	avatarAuditEnabled := enabled && boolEnvOrDefault("CONTENT_AUDIT_AVATAR_ENABLED", false)
	cfg := service.ContentAuditConfig{
		Enabled:            enabled && (nameAuditEnabled || avatarAuditEnabled),
		NameAuditEnabled:   nameAuditEnabled,
		AvatarAuditEnabled: avatarAuditEnabled,
		ProductID:          strings.TrimSpace(os.Getenv("CONTENT_AUDIT_PRODUCT_ID")),
		UserSID:            strings.TrimSpace(os.Getenv("CONTENT_AUDIT_USER_SID")),
	}
	if !cfg.Enabled {
		logger.Info("content audit disabled")
		return cfg
	}
	if cfg.ProductID == "" || cfg.UserSID == "" {
		logger.Warn("content audit enabled but config is incomplete")
		return cfg
	}
	logger.Info("content audit enabled", "name_audit", cfg.NameAuditEnabled, "avatar_audit", cfg.AvatarAuditEnabled)
	return cfg
}

func buildContentAuditClient(logger *slog.Logger, cfg service.ContentAuditConfig) service.ContentAuditClient {
	if !cfg.Ready() {
		return nil
	}
	endpoint := strings.TrimSpace(os.Getenv("CONTENT_AUDIT_ENDPOINT"))
	if endpoint == "" {
		logger.Warn("content audit direct client disabled because CONTENT_AUDIT_ENDPOINT is empty")
		return nil
	}
	client, err := contentaudit.New(contentaudit.Config{
		Endpoint:   endpoint,
		ProxyToken: os.Getenv("CONTENT_AUDIT_PROXY_TOKEN"),
	})
	if err != nil {
		logger.Warn("content audit direct client disabled", "err", err)
		return nil
	}
	logger.Info("content audit direct client enabled")
	return client
}

type stores struct {
	auth   service.Store
	shadow shadowbinding.Store
}

func newStores(contentAuditEnabled bool) stores {
	dsn := dbconfig.ResolveMySQLDSN()
	if dsn == "" {
		slog.Info("lightclaw auth using in-memory store")
		return stores{
			auth: service.NewMemoryStore(service.StoreOptions{
				SeedDefaultInvites:  true,
				SeedDemoUser:        envOrDefault("LIGHTCLAW_SEED_DEMO_USER", "false") == "true",
				ContentAuditEnabled: contentAuditEnabled,
			}),
			shadow: shadowbinding.NewMemoryStore(),
		}
	}

	store, err := service.NewMySQLStore(dsn, service.StoreOptions{
		SeedDefaultInvites:  false,
		SeedDemoUser:        false,
		ContentAuditEnabled: contentAuditEnabled,
	})
	if err != nil {
		slog.Error("init mysql store failed", "err", err)
		os.Exit(1)
	}
	slog.Info("lightclaw auth using MySQL store")
	return stores{auth: store, shadow: shadowbinding.NewMySQLStore(store.DB())}
}

func envOrDefault(key string, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func boolEnvOrDefault(key string, fallback bool) bool {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	return value == "true" || value == "1" || strings.EqualFold(value, "yes")
}

func envFirst(keys ...string) string {
	for _, key := range keys {
		if value := strings.TrimSpace(os.Getenv(key)); value != "" {
			return value
		}
	}
	return ""
}

func parseCSVEnv(key string) []string {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	values := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		values = append(values, part)
	}
	return values
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

func buildShadowBindingService(store shadowbinding.Store, logger *slog.Logger) *shadowbinding.Service {
	if envOrDefault("SHADOW_BINDING_ENABLED", "false") != "true" {
		return nil
	}
	if store == nil {
		logger.Warn("shadow binding disabled due to missing store")
		return nil
	}
	var client shadowbinding.TencentCloudClient
	tencentClient, err := shadowbinding.NewTencentCloudSDKClient(shadowbinding.TencentCloudConfig{
		SecretID:        envOrDefault("SHADOW_SECRET_ID", ""),
		SecretKey:       envOrDefault("SHADOW_SECRET_KEY", ""),
		Region:          envOrDefault("SHADOW_REGION", "ap-guangzhou"),
		AccountEndpoint: envOrDefault("SHADOW_ACCOUNT_ENDPOINT", "account.tencentcloudapi.com"),
		CAMEndpoint:     envOrDefault("SHADOW_CAM_ENDPOINT", "cam.tencentcloudapi.com"),
		STSEndpoint:     envOrDefault("SHADOW_STS_ENDPOINT", "sts.tencentcloudapi.com"),
		Platform:        envOrDefault("SHADOW_PLATFORM", "lightvela"),
		RequestTimeout:  parseDurationEnv("SHADOW_REQUEST_TIMEOUT", 10*time.Second),
		CloudLadder: shadowbinding.CloudLadderConfig{
			Enabled:        envOrDefault("SHADOW_CLOUDLADDER_ENABLED", "false") == "true",
			GatewayBaseURL: envOrDefault("SHADOW_CLOUDLADDER_GATEWAY_BASE_URL", ""),
			RouteID:        envOrDefault("SHADOW_CLOUDLADDER_ROUTE_ID", "tcapi-account-cn-dev"),
			CAMRouteID:     envOrDefault("SHADOW_CLOUDLADDER_CAM_ROUTE_ID", envOrDefault("SHADOW_CLOUDLADDER_ROUTE_ID", "tcapi-account-cn-dev")),
			STSRouteID:     envOrDefault("SHADOW_CLOUDLADDER_STS_ROUTE_ID", envOrDefault("SHADOW_CLOUDLADDER_ROUTE_ID", "tcapi-account-cn-dev")),
			Caller:         envOrDefault("SHADOW_CLOUDLADDER_CALLER", "shadow"),
			Secret:         envOrDefault("SHADOW_CLOUDLADDER_HMAC_SECRET", envOrDefault("CLOUDLADDER_SHADOW_HMAC_SECRET", "")),
		},
	})
	if err != nil {
		logger.Warn("shadow binding enabled with unavailable TencentCloud client", "err", err)
		client = shadowbinding.NewUnavailableClient(err.Error())
	} else {
		client = tencentClient
	}
	return shadowbinding.New(store, client, shadowbinding.Options{
		Enabled:        true,
		AuthCodeTTL:    parseDurationEnv("SHADOW_AUTH_CODE_TTL", 10*time.Minute),
		AuthCodePrefix: envOrDefault("SHADOW_AUTH_CODE_PREFIX", ""),
		UserNamePrefix: envOrDefault("SHADOW_USER_NAME_PREFIX", ""),
	})
}

func buildPhoneAuthSMSSender(logger *slog.Logger) service.PhoneAuthSMSSender {
	if envOrDefault("LIGHTCLAW_PHONE_AUTH_ENABLED", "false") != "true" {
		return nil
	}
	client, err := phonesms.New(phonesms.Config{
		SecretID:   envOrDefault("LIGHTCLAW_SMS_SECRET_ID", ""),
		SecretKey:  envOrDefault("LIGHTCLAW_SMS_SECRET_KEY", ""),
		Region:     envOrDefault("LIGHTCLAW_SMS_REGION", "ap-guangzhou"),
		Endpoint:   envOrDefault("LIGHTCLAW_SMS_ENDPOINT", "sms.internal.tencentcloudapi.com"),
		SDKAppID:   envOrDefault("LIGHTCLAW_SMS_SDK_APP_ID", "1401097405"),
		SignName:   envOrDefault("LIGHTCLAW_SMS_SIGN_NAME", "腾讯云"),
		TemplateID: envOrDefault("LIGHTCLAW_SMS_TEMPLATE_ID", "2683912"),
	})
	if err != nil {
		logger.Warn("phone auth sms sender disabled due to invalid config", "err", err)
		return nil
	}
	logger.Info("phone auth sms sender enabled")
	return client
}

func parseDurationEnv(key string, fallback time.Duration) time.Duration {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	value, err := time.ParseDuration(raw)
	if err != nil || value <= 0 {
		slog.Warn("invalid duration env, using fallback", "key", key, "value", raw, "fallback", fallback.String())
		return fallback
	}
	return value
}

func oauthBaseURLs() (string, string) {
	return envOrDefault("LIGHTCLAW_FRONTEND_BASE_URL", "https://lightclaw.pages.dev"),
		envOrDefault("LIGHTCLAW_PUBLIC_BASE_URL", "https://lightclaw.tech")
}

func oauthCallbackURL(publicBaseURL string, path string) string {
	return strings.TrimRight(strings.TrimSpace(publicBaseURL), "/") + path
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
		AuthorizeURL:    envOrDefault("LIGHTCLAW_QQ_AUTHORIZE_URL", ""),
		APIBaseURL:      envOrDefault("LIGHTCLAW_QQ_API_BASE_URL", ""),
		FrontendBaseURL: frontendBaseURL,
		PublicBaseURL:   publicBaseURL,
	}
}

func buildWeChatOAuthConfig() *httpapi.WeChatOAuthConfig {
	websiteAppID := envFirst("LIGHTVELA_WECHAT_WEBSITE_APP_ID", "LIGHTCLAW_WECHAT_APP_ID")
	websiteAppSecret := envFirst("LIGHTVELA_WECHAT_WEBSITE_APP_SECRET", "LIGHTCLAW_WECHAT_APP_SECRET")
	websiteRedirectURI := envFirst("LIGHTVELA_WECHAT_WEBSITE_REDIRECT_URI", "LIGHTCLAW_WECHAT_REDIRECT_URI")
	if websiteRedirectURI == "" {
		websiteRedirectURI = "https://lightclaw.tech/auth/oauth/wechat/callback"
	}

	officialAccountAppID := envFirst("LIGHTVELA_WECHAT_OFFICIAL_ACCOUNT_APP_ID")
	officialAccountAppSecret := envFirst("LIGHTVELA_WECHAT_OFFICIAL_ACCOUNT_APP_SECRET", "LIGHTCLAW_WECHAT_APP_SECRET")
	officialAccountRedirectURI := envFirst("LIGHTVELA_WECHAT_OFFICIAL_ACCOUNT_REDIRECT_URI")
	if officialAccountRedirectURI == "" {
		officialAccountRedirectURI = websiteRedirectURI
	}
	if (websiteAppID == "" || websiteAppSecret == "") && (officialAccountAppID == "" || officialAccountAppSecret == "") {
		return nil
	}
	frontendBaseURL, publicBaseURL := oauthBaseURLs()

	return &httpapi.WeChatOAuthConfig{
		Website: httpapi.WeChatOAuthAppConfig{
			AppID:       websiteAppID,
			AppSecret:   websiteAppSecret,
			RedirectURI: websiteRedirectURI,
		},
		OfficialAccount: httpapi.WeChatOAuthAppConfig{
			AppID:       officialAccountAppID,
			AppSecret:   officialAccountAppSecret,
			RedirectURI: officialAccountRedirectURI,
		},
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
	frontendBaseURL, publicBaseURL := oauthBaseURLs()

	return &httpapi.GitHubOAuthConfig{
		ClientID:        clientID,
		ClientSecret:    clientSecret,
		RedirectURI:     envOrDefault("LIGHTCLAW_GITHUB_REDIRECT_URI", oauthCallbackURL(publicBaseURL, "/auth/oauth/github/callback")),
		FrontendBaseURL: frontendBaseURL,
		PublicBaseURL:   publicBaseURL,
	}
}

func buildRealnameClient(logger *slog.Logger) *realname.Client {
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

func buildRealnameFaceIDConfig() service.RealnameFaceIDConfig {
	return service.RealnameFaceIDConfig{
		Mode:        service.RealnameAssuranceMode(strings.TrimSpace(envOrDefault("LIGHTCLAW_REALNAME_ASSURANCE_MODE", "legacy"))),
		RuleID:      strings.TrimSpace(os.Getenv("TENCENT_REALNAME_FACEID_RULE_ID")),
		AccountID:   strings.TrimSpace(os.Getenv("TENCENT_REALNAME_ACCOUNT_ID")),
		RedirectURL: strings.TrimSpace(os.Getenv("TENCENT_REALNAME_FACEID_REDIRECT_URL")),
		DigestKey:   decodeRealnameDigestKey(os.Getenv("REALNAME_ENCRYPTION_KEY")),
		DailyQuota:  int(envInt64OrDefault("LIGHTCLAW_REALNAME_FACEID_DAILY_QUOTA", 5)),
		AttemptTTL:  parseDurationEnv("LIGHTCLAW_REALNAME_FACEID_ATTEMPT_TTL", 2*time.Hour),
		LeaseTTL:    parseDurationEnv("LIGHTCLAW_REALNAME_FACEID_LEASE_TTL", 30*time.Second),
	}
}

func decodeRealnameDigestKey(value string) []byte {
	decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(value))
	if err != nil || len(decoded) != 32 {
		return nil
	}
	return decoded
}

func buildTATRegisterIssuer(logger *slog.Logger) tat.RegisterCodeIssuer {
	secretID := strings.TrimSpace(os.Getenv("TENCENT_TAT_SECRET_ID"))
	secretKey := strings.TrimSpace(os.Getenv("TENCENT_TAT_SECRET_KEY"))
	if secretID == "" || secretKey == "" {
		logger.Warn("tat register issuer disabled due to incomplete Tencent TAT config")
		return nil
	}

	client, err := tat.New(tat.Config{
		SecretID:           secretID,
		SecretKey:          secretKey,
		Region:             envOrDefault("TENCENT_TAT_REGION", "ap-guangzhou"),
		Endpoint:           envOrDefault("TENCENT_TAT_ENDPOINT", "tat.tencentcloudapi.com"),
		EffectiveTimeHours: envInt64OrDefault("TENCENT_TAT_REGISTER_EFFECTIVE_HOURS", 24),
		InstanceNamePrefix: envOrDefault("TENCENT_TAT_INSTANCE_NAME_PREFIX", "lightvela-mac"),
		IpAddressRange:     strings.TrimSpace(os.Getenv("TENCENT_TAT_REGISTER_IP_RANGE")),
	})
	if err != nil {
		logger.Error("init tat register issuer failed", "err", err)
		return nil
	}
	logger.Info("tat register issuer enabled", "region", envOrDefault("TENCENT_TAT_REGION", "ap-guangzhou"))
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

func buildEmailBindSender(logger *slog.Logger) service.EmailSender {
	secretID := envFirst(
		"LIGHTCLAW_SES_SECRET_ID",
		"TENCENTCLOUD_SECRET_ID",
		"LIGHTCLAW_COS_SECRET_ID",
	)
	secretKey := envFirst(
		"LIGHTCLAW_SES_SECRET_KEY",
		"TENCENTCLOUD_SECRET_KEY",
		"LIGHTCLAW_COS_SECRET_KEY",
	)
	if secretID == "" || secretKey == "" {
		logger.Warn("email bind sender falling back to log-only mode due to missing Tencent SES credentials")
		return &service.LogEmailSender{Logger: logger}
	}

	client, err := ses.New(ses.Config{
		SecretID:  secretID,
		SecretKey: secretKey,
		Region:    envOrDefault("LIGHTCLAW_SES_REGION", "ap-guangzhou"),
		Endpoint:  envOrDefault("LIGHTCLAW_SES_ENDPOINT", "ses.tencentcloudapi.com"),
	})
	if err != nil {
		logger.Error("init tencent ses sender failed, falling back to log-only mode", "err", err)
		return &service.LogEmailSender{Logger: logger}
	}

	from := envOrDefault("LIGHTCLAW_SES_FROM", "LightVela <noreply@service.lightvela.com>")
	logger.Info("email bind sender enabled", "region", envOrDefault("LIGHTCLAW_SES_REGION", "ap-guangzhou"), "from", from)
	return service.NewTencentSESSender(client, from, logger)
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
