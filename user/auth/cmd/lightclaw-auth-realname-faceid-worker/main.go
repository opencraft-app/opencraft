package main

import (
	"context"
	"encoding/base64"
	"log/slog"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/openclaw/openclaw/mono/backend/auth/internal/dbconfig"
	"github.com/openclaw/openclaw/mono/backend/auth/internal/logging"
	"github.com/openclaw/openclaw/mono/backend/auth/internal/realname"
	"github.com/openclaw/openclaw/mono/backend/auth/internal/service"
	"github.com/openclaw/openclaw/mono/backend/auth/internal/shadowbinding"
)

func main() {
	logger := logging.New(logging.Config{
		Service: "lightclaw-auth-realname-worker",
		Level:   envOrDefault("LIGHTCLAW_LOG_LEVEL", "info"),
	})
	slog.SetDefault(logger)

	authStore, shadowStore := newStores()
	realnameClient := buildRealnameClient(logger)
	shadowSvc := buildShadowBindingService(shadowStore, logger)
	realnameCipher := buildRealnameCipher(logger)
	realnameFaceIDConfig := buildRealnameFaceIDConfig()
	shadowBasicAuthSyncEnabled := envOrDefault("SHADOW_BASIC_AUTH_SYNC_ENABLED", "false") == "true"
	_, durableStore := authStore.(*service.MySQLStore)
	if err := service.ValidateRealnameFaceIDStartup(realnameFaceIDConfig, realnameClient, realnameCipher, shadowSvc, shadowBasicAuthSyncEnabled, durableStore); err != nil {
		logger.Error("invalid realname FaceID startup config", "err", err)
		os.Exit(1)
	}
	svc := service.NewWithStore(authStore, service.Options{
		RealnameCipher:             realnameCipher,
		RealnameFaceIDVerifier:     realnameClient,
		RealnameFaceID:             realnameFaceIDConfig,
		ShadowBinding:              shadowSvc,
		ShadowBasicAuthSyncEnabled: shadowBasicAuthSyncEnabled,
	})

	interval := parseDurationEnv("LIGHTCLAW_REALNAME_FACEID_WORKER_INTERVAL", 10*time.Second)
	limit := int(envInt64OrDefault("LIGHTCLAW_REALNAME_FACEID_WORKER_LIMIT", 20))
	owner := envOrDefault("LIGHTCLAW_REALNAME_FACEID_WORKER_OWNER", "realname-worker")
	slog.Info("realname faceid worker started", "interval", interval.String(), "limit", limit, "owner", owner)
	for {
		count, err := svc.ReconcilePendingRealnameFaceIDAttempts(context.Background(), owner, limit)
		if err != nil {
			slog.Error("realname faceid worker reconcile failed", "err", err)
		} else if count > 0 {
			slog.Info("realname faceid worker reconciled attempts", "count", count)
		}
		time.Sleep(interval)
	}
}

func newStores() (service.Store, shadowbinding.Store) {
	dsn := dbconfig.ResolveMySQLDSN()
	if dsn == "" {
		authStore := service.NewMemoryStore(service.StoreOptions{SeedDefaultInvites: true})
		return authStore, shadowbinding.NewMemoryStore()
	}
	store, err := service.NewMySQLStore(dsn, service.StoreOptions{})
	if err != nil {
		slog.Error("init mysql store failed", "err", err)
		os.Exit(1)
	}
	return store, shadowbinding.NewMySQLStore(store.DB())
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
	return cipher
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
			Caller:         envOrDefault("SHADOW_CLOUDLADDER_CALLER", "shadow"),
			Secret:         shadowCloudLadderSecret(),
		},
	})
	if err != nil {
		logger.Warn("shadow binding enabled with unavailable TencentCloud client", "err", err)
		client = shadowbinding.NewUnavailableClient(err.Error())
	} else {
		client = tencentClient
	}
	return shadowbinding.New(store, client, shadowbinding.Options{
		Enabled: envOrDefault("SHADOW_BINDING_ENABLED", "false") == "true",
		Now:     time.Now,
	})
}

func shadowCloudLadderSecret() string {
	return envOrDefault("SHADOW_CLOUDLADDER_HMAC_SECRET", envOrDefault("CLOUDLADDER_SHADOW_HMAC_SECRET", ""))
}

func envOrDefault(key string, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
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

func parseDurationEnv(key string, fallback time.Duration) time.Duration {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	value, err := time.ParseDuration(raw)
	if err != nil {
		slog.Warn("invalid duration env, using fallback", "key", key, "value", raw, "fallback", fallback.String())
		return fallback
	}
	return value
}
