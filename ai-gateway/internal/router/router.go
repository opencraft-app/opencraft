package router

import (
	"net/http"
	"time"

	"git.woa.com/wisp/mono/ai-gateway/internal/adapter"
	"git.woa.com/wisp/mono/ai-gateway/internal/config"
	"git.woa.com/wisp/mono/ai-gateway/internal/handler"
	"git.woa.com/wisp/mono/ai-gateway/internal/middleware"
	"git.woa.com/wisp/mono/ai-gateway/internal/pkg/redisclient"
	"git.woa.com/wisp/mono/ai-gateway/internal/repository"
	"git.woa.com/wisp/mono/ai-gateway/internal/serverstate"
	"git.woa.com/wisp/mono/ai-gateway/internal/service"
	"github.com/gin-gonic/gin"
	swaggerFiles "github.com/swaggo/files"
	ginSwagger "github.com/swaggo/gin-swagger"
	"gorm.io/gorm"

	_ "git.woa.com/wisp/mono/ai-gateway/docs" // swagger docs
)

// SetupResult 包含 router setup 的返回值。
type SetupResult struct {
	Engine            *gin.Engine
	SubSvc            *service.SubscriptionService
	ProviderRepo      repository.ProviderRepo
	ModelMappingRepo  repository.ModelMappingRepo
	RegistryCfg       *config.RegistryConfig
	CacheSvc          *service.CacheService       // 语义缓存服务（用于调度器）
	ProxyClient       *http.Client                // proxy handler 的共享 http client（用于 shutdown 关闭）
	ConfigStore       *service.RuntimeConfigStore // 运行时配置存储（用于 SIGHUP 重载）
	TokenBalanceStore *service.TokenBalanceStore  // token 余额存储（用于优雅关闭）
	UsageSink         service.UsageSink           // usage 批量写入器（用于优雅关闭）
}

// Setup creates and configures the Gin engine with all routes and middleware.
// tracker 用于追踪活跃请求以实现优雅关闭，drainState 用于 /ready 端点检测 draining 状态。
func Setup(cfg *config.Config, db *gorm.DB, redisClient *redisclient.Client,
	tracker *serverstate.ConnTracker, drainState *serverstate.DrainState) *SetupResult {
	r := gin.New()
	r.Use(gin.Recovery())
	r.Use(middleware.RequestLogger())
	r.Use(middleware.MaxBodySize(cfg.Server.MaxRequestBodySize))

	// 全局 Tracker 中间件：在 draining 状态下返回 503，拦截所有新请求
	// 注册在 /health 和 /ready 路由之前，确保健康检查不受影响
	if tracker != nil {
		r.Use(serverstate.TrackerMiddleware(tracker))
	}

	// --- Repositories ---
	userRepo := repository.NewUserRepo(db)
	planRepo := repository.NewPlanRepo(db)
	subRepo := repository.NewSubscriptionRepo(db)
	providerRepo := repository.NewProviderRepo(db)
	apiKeyRepo := repository.NewApiKeyRepo(db)
	usageRepo := repository.NewUsageRepo(db)
	modelMappingRepo := repository.NewModelMappingRepo(db)
	runtimeConfigRepo := repository.NewRuntimeConfigRepo(db)

	// --- Services ---
	encryptionKey := []byte(cfg.EncryptionKey)

	keySvc := service.NewApiKeyService(apiKeyRepo, userRepo, subRepo, planRepo, redisClient, 5*time.Minute)
	userSvc := service.NewUserService(userRepo, keySvc, encryptionKey)
	planSvc := service.NewPlanService(planRepo)
	subSvc := service.NewSubscriptionService(subRepo, planRepo, keySvc)
	providerSvc := service.NewProviderService(providerRepo, modelMappingRepo, encryptionKey)
	tokenBalanceStore := service.NewTokenBalanceStore(redisClient, subRepo)
	billingSvc := service.NewBillingService(
		tokenBalanceStore,
		providerRepo, usageRepo, cfg.Billing.DefaultReservationTokens)
	usageSink := service.NewUsageBatchWriter(usageRepo, 4096, 128, 200*time.Millisecond)
	provisionSvc := service.NewProvisionService(userSvc, subSvc, keySvc, planRepo)

	// --- RuntimeConfigStore ---
	configStore := service.NewRuntimeConfigStore(runtimeConfigRepo, service.RoutingConfig{
		FailureThreshold:  cfg.CircuitBreaker.FailureThreshold,
		CooldownDurationS: cfg.CircuitBreaker.CooldownDurationS,
		Strategy: service.PortkeyStrategyConfig{
			Mode:             cfg.Portkey.Strategy.Mode,
			OnStatusCodes:    cfg.Portkey.Strategy.OnStatusCodes,
			RetryAttempts:    cfg.Portkey.Strategy.RetryAttempts,
			RetryStatusCodes: cfg.Portkey.Strategy.RetryStatusCodes,
		},
	})

	// --- Circuit Breaker ---
	circuitBreaker := service.NewDistributedCircuitBreaker(redisClient, configStore)

	// --- Cache Services ---
	cacheConfigStore := service.NewCacheConfigStore(runtimeConfigRepo)
	embeddingSvc := service.NewEmbeddingService(cacheConfigStore)
	cacheSvc := service.NewCacheService(db, redisClient, cacheConfigStore, 1536)

	// --- Handlers ---
	// httpClient 独立创建，便于在 shutdown 时关闭 idle connections
	httpClient := &http.Client{
		Timeout: 5 * time.Minute,
	}
	inflightBudget := serverstate.NewInflightBudget(int64(cfg.Gateway.MaxInflightBudget))
	cooldownStore := service.NewProviderCooldownStore(redisClient, service.ProviderCooldownConfig{
		Default429TTLS: cfg.ProviderCooldown.Default429TTLS,
		Max429TTLS:     cfg.ProviderCooldown.Max429TTLS,
	})
	proxyHandler := handler.NewProxyHandler(
		billingSvc,
		providerSvc,
		cfg.Portkey.BaseURL,
		circuitBreaker,
		configStore,
		cacheSvc,
		httpClient,
		inflightBudget,
		cooldownStore,
		service.GatewayConfig{
			MaxInflightBudget:      cfg.Gateway.MaxInflightBudget,
			StreamRequestWeight:    cfg.Gateway.StreamRequestWeight,
			NonStreamRequestWeight: cfg.Gateway.NonStreamRequestWeight,
			OverloadStatusCode:     cfg.Gateway.OverloadStatusCode,
		},
	)
	proxyHandler.SetUsageSink(usageSink)
	adminHandler := handler.NewAdminHandler(userSvc, planSvc, subSvc, providerSvc, keySvc, provisionSvc, usageRepo)
	internalHandler := handler.NewInternalHandler(userSvc, planSvc, subSvc)
	healthHandler := handler.NewHealthHandlerWithDrainStateV2(db, redisClient, drainState, cfg.Portkey.BaseURL)
	userSelfHandler := handler.NewUserSelfHandler(usageRepo)
	configHandler := handler.NewConfigHandler(configStore)
	modelMappingHandler := handler.NewModelMappingHandler(modelMappingRepo, providerSvc)

	// --- Swagger ---
	r.GET("/swagger/*any", ginSwagger.WrapHandler(swaggerFiles.Handler))

	// --- Root ---
	// Keep "/" returning 200 so internal CLB default health checks do not flap.
	r.GET("/", func(c *gin.Context) {
		c.String(http.StatusOK, "ok")
	})

	// --- Health (public, no auth) ---
	r.GET("/health", healthHandler.Health)
	r.GET("/ready", healthHandler.Ready)

	// --- OpenAI-compatible API (authenticated via API key) ---
	v1 := r.Group("/v1")
	v1.Use(middleware.Auth(keySvc))
	v1.Use(middleware.RateLimiter(redisClient))
	{
		// Model listing (no billing/model check needed)
		v1.GET("/models", proxyHandler.Models)

		// User self-service
		v1.GET("/me", userSelfHandler.Me)

		// Proxy endpoints (require billing check + model auth)
		proxy := v1.Group("")
		proxy.Use(middleware.BillingCheck())
		proxy.Use(middleware.ModelAuth())
		{
			// chat/completions 经过语义缓存中间件
			chatProxy := proxy.Group("")
			chatProxy.Use(middleware.ResponseCache(cacheSvc, embeddingSvc))
			chatProxy.POST("/chat/completions", proxyHandler.ChatCompletions)

			// completions 和 embeddings 不经过缓存
			proxy.POST("/completions", proxyHandler.Completions)
			proxy.POST("/embeddings", proxyHandler.Embeddings)
		}

		// --- Anthropic Messages API (Claude Code 兼容) ---
		// Auth 中间件已支持 x-api-key header
		// FormatAdapter 将 Anthropic 格式转为 OpenAI 格式，ResponseAdapter 将响应转回
		anthropic := v1.Group("")
		anthropic.Use(adapter.FormatAdapter())
		anthropic.Use(adapter.ResponseAdapter())
		anthropic.Use(middleware.BillingCheck())
		anthropic.Use(middleware.ModelAuth())
		{
			anthropicChat := anthropic.Group("")
			anthropicChat.Use(middleware.ResponseCache(cacheSvc, embeddingSvc))
			anthropicChat.POST("/messages", proxyHandler.ChatCompletions)
		}
	}

	v1Self := r.Group("/v1")
	v1Self.Use(middleware.AuthAllowMissingSubscription(keySvc))
	v1Self.Use(middleware.RateLimiter(redisClient))
	{
		v1Self.GET("/me/usage", userSelfHandler.Usage)
		v1Self.GET("/me/token-balance", userSelfHandler.TokenBalance)
	}

	// --- Gemini API (Gemini CLI 兼容) ---
	// Auth 中间件已支持 ?key= query parameter
	gemini := r.Group("/v1beta")
	gemini.Use(middleware.Auth(keySvc))
	gemini.Use(middleware.RateLimiter(redisClient))
	gemini.Use(adapter.FormatAdapter())
	gemini.Use(adapter.ResponseAdapter())
	gemini.Use(middleware.BillingCheck())
	gemini.Use(middleware.ModelAuth())
	{
		geminiChat := gemini.Group("")
		geminiChat.Use(middleware.ResponseCache(cacheSvc, embeddingSvc))
		// *path 匹配 "gemini-pro:generateContent" 或 "gemini-pro:streamGenerateContent"
		geminiChat.POST("/models/*path", proxyHandler.ChatCompletions)
	}

	// --- Admin API (管理接口) ---
	admin := r.Group("/api/admin")
	admin.Use(middleware.AdminAuth(cfg.Server.AdminToken, cfg.Server.AdminIPWhitelist))
	{
		// Provision (one-shot: create user + subscription + API key)
		admin.POST("/provision", adminHandler.Provision)

		// Users CRUD
		admin.GET("/users", adminHandler.ListUsers)
		admin.GET("/users/:user_id", adminHandler.GetUser)
		admin.POST("/users", adminHandler.CreateUser)
		admin.PUT("/users/:user_id", adminHandler.UpdateUser)
		admin.DELETE("/users/:user_id", adminHandler.DeleteUser)

		// Plans CRUD
		admin.GET("/plans", adminHandler.ListPlans)
		admin.GET("/plans/:id", adminHandler.GetPlan)
		admin.POST("/plans", adminHandler.CreatePlan)
		admin.PUT("/plans/:id", adminHandler.UpdatePlan)
		admin.DELETE("/plans/:id", adminHandler.DeletePlan)

		// Subscriptions (nested under users)
		admin.POST("/users/:user_id/subscriptions", adminHandler.SubscribeUser)
		admin.GET("/users/:user_id/subscriptions", adminHandler.GetUserSubscription)
		admin.DELETE("/users/:user_id/subscriptions", adminHandler.CancelUserSubscription)

		// Token adjustment
		admin.PUT("/subscriptions/:id/tokens", adminHandler.AdjustTokens)

		// Providers CRUD
		admin.GET("/providers", adminHandler.ListProviders)
		admin.POST("/providers/validate", adminHandler.ValidateProvider)
		admin.POST("/providers/discover-models", adminHandler.DiscoverProviderModels)
		admin.POST("/providers/validate-model-request", adminHandler.ValidateProviderModelRequest)
		admin.GET("/providers/:id", adminHandler.GetProvider)
		admin.POST("/providers", adminHandler.CreateProvider)
		admin.PUT("/providers/:id", adminHandler.UpdateProvider)
		admin.GET("/providers/:id/usage", adminHandler.GetProviderUsage)

		// Model Mappings (路由规则管理)
		admin.POST("/model-mappings", modelMappingHandler.CreateModelMapping)
		admin.GET("/model-mappings", modelMappingHandler.ListModelMappings)
		admin.PUT("/model-mappings/:id", modelMappingHandler.UpdateModelMapping)
		admin.DELETE("/model-mappings/:id", modelMappingHandler.DeleteModelMapping)
		admin.GET("/model-mappings/resolve", modelMappingHandler.ResolveModel)

		// API Keys (nested under business user_id, revoke by key ID)
		admin.POST("/users/:user_id/api-keys", adminHandler.CreateApiKey)
		admin.GET("/users/:user_id/api-keys", adminHandler.ListApiKeys)
		admin.GET("/api-keys", adminHandler.ListAllApiKeys)
		admin.DELETE("/api-keys/:id", adminHandler.RevokeApiKey)

		// User usage
		admin.GET("/users/:user_id/usage", adminHandler.GetUserUsage)
		admin.GET("/users/:user_id/usage-logs", adminHandler.GetUserUsageLogs)

		// Stats
		admin.GET("/stats", adminHandler.StatsOverview)
		admin.GET("/stats/usage", adminHandler.StatsUsage)
		admin.GET("/stats/users", adminHandler.StatsUsers)
		admin.GET("/stats/users/top", adminHandler.StatsTopUsers)
		admin.GET("/stats/token-pool", adminHandler.StatsTokenPool)
		admin.GET("/stats/usage/trend", adminHandler.StatsUsageTrend)

		// Config（路由配置管理）
		admin.GET("/config/routing", configHandler.GetRoutingConfig)
		admin.PUT("/config/routing/strategy", configHandler.UpdateStrategy)
		admin.PUT("/config/routing/circuit-breaker", configHandler.UpdateCircuitBreaker)
		admin.GET("/config/retry", configHandler.GetRoutingConfig) // 向后兼容

	}

	// --- Internal API (trusted service-to-service) ---
	if cfg.Server.InternalServiceToken != "" {
		internal := r.Group("/api/internal")
		internal.Use(middleware.InternalServiceAuth(cfg.Server.InternalServiceToken))
		{
			internal.POST("/users/ensure", internalHandler.EnsureUser)
			internal.GET("/plans/:id", internalHandler.GetPlan)
			internal.POST("/subscriptions/apply", internalHandler.ApplySubscription)
			internal.POST("/subscriptions/cancel", internalHandler.CancelSubscription)
			internal.GET("/users/:user_id/subscriptions", internalHandler.GetUserActiveSubscription)
		}
	}

	// --- Registry API (服务注册中心，可选) ---
	if cfg.Registry.Token != "" {
		registrySvc := service.NewRegistryService(providerRepo, modelMappingRepo, encryptionKey)
		registryHandler := handler.NewRegistryHandler(registrySvc)

		registry := r.Group("/api/registry")
		registry.Use(middleware.RegistryAuth(cfg.Registry.Token))
		{
			registry.POST("/register", registryHandler.Register)
			registry.POST("/heartbeat", registryHandler.Heartbeat)
			registry.DELETE("/deregister", registryHandler.Deregister)
		}
	}

	return &SetupResult{
		Engine:            r,
		SubSvc:            subSvc,
		ProviderRepo:      providerRepo,
		ModelMappingRepo:  modelMappingRepo,
		RegistryCfg:       &cfg.Registry,
		CacheSvc:          cacheSvc,
		ProxyClient:       httpClient,
		ConfigStore:       configStore,
		TokenBalanceStore: tokenBalanceStore,
		UsageSink:         usageSink,
	}
}
