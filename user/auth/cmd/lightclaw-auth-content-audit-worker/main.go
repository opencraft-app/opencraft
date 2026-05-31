package main

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/openclaw/openclaw/mono/backend/auth/internal/contentaudit"
	"github.com/openclaw/openclaw/mono/backend/auth/internal/logging"
	"github.com/openclaw/openclaw/mono/backend/auth/internal/service"
)

func main() {
	logger := logging.New(logging.Config{
		Service: "lightclaw-auth-content-audit-worker",
		Level:   envOrDefault("LIGHTCLAW_LOG_LEVEL", "info"),
	})
	slog.SetDefault(logger)

	cfg := buildContentAuditConfig()
	store := newStore(cfg.Enabled)
	client, err := buildContentAuditClient(cfg)
	if err != nil {
		logger.Error("init content audit client failed", "err", err)
		os.Exit(1)
	}

	worker := service.NewContentAuditWorker(store, client, cfg, service.ContentAuditWorkerOptions{
		Logger:         logger,
		TimeoutMinutes: intEnvOrDefault("CONTENT_AUDIT_TIMEOUT_MINUTES", contentaudit.DefaultTimeoutMinutes),
	})

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	interval := durationSecondsEnvOrDefault("CONTENT_AUDIT_WORKER_INTERVAL_SECONDS", 30)
	batchSize := intEnvOrDefault("CONTENT_AUDIT_WORKER_BATCH_SIZE", 20)
	logger.Info(
		"content audit worker started",
		"enabled", cfg.Enabled,
		"interval", interval.String(),
		"batch_size", batchSize,
		"timeout_minutes", intEnvOrDefault("CONTENT_AUDIT_TIMEOUT_MINUTES", contentaudit.DefaultTimeoutMinutes),
	)
	worker.Run(ctx, interval, batchSize)
	logger.Info("content audit worker stopped")
}

func buildContentAuditConfig() service.ContentAuditConfig {
	return service.ContentAuditConfig{
		Enabled:   envOrDefault("CONTENT_AUDIT_ENABLED", "false") == "true",
		ProductID: strings.TrimSpace(os.Getenv("CONTENT_AUDIT_PRODUCT_ID")),
		UserSID:   strings.TrimSpace(os.Getenv("CONTENT_AUDIT_USER_SID")),
	}
}

func buildContentAuditClient(cfg service.ContentAuditConfig) (*contentaudit.Client, error) {
	if !cfg.Enabled {
		return nil, nil
	}
	endpoint := strings.TrimSpace(os.Getenv("CONTENT_AUDIT_ENDPOINT"))
	if endpoint == "" || strings.TrimSpace(cfg.ProductID) == "" || strings.TrimSpace(cfg.UserSID) == "" {
		return nil, errMissingContentAuditConfig
	}
	return contentaudit.New(contentaudit.Config{
		Endpoint:   endpoint,
		ProxyToken: os.Getenv("CONTENT_AUDIT_PROXY_TOKEN"),
	})
}

var errMissingContentAuditConfig = errors.New("CONTENT_AUDIT_ENDPOINT, CONTENT_AUDIT_PRODUCT_ID and CONTENT_AUDIT_USER_SID are required when CONTENT_AUDIT_ENABLED=true")

func newStore(requireMySQL bool) service.Store {
	dsn := strings.TrimSpace(os.Getenv("LIGHTCLAW_MYSQL_DSN"))
	if dsn == "" {
		dsn = strings.TrimSpace(os.Getenv("MYSQL_DSN"))
	}
	if dsn == "" {
		if requireMySQL {
			slog.Error("missing MySQL DSN for enabled content audit worker")
			os.Exit(1)
		}
		slog.Info("lightclaw auth content audit worker using disabled in-memory store")
		return service.NewMemoryStore(service.StoreOptions{})
	}

	store, err := service.NewMySQLStore(dsn, service.StoreOptions{
		SeedDefaultInvites:  false,
		SeedDemoUser:        false,
		ContentAuditEnabled: requireMySQL,
	})
	if err != nil {
		slog.Error("init mysql store failed", "err", err)
		os.Exit(1)
	}
	slog.Info("lightclaw auth content audit worker using MySQL store")
	return store
}

func envOrDefault(key string, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func intEnvOrDefault(key string, fallback int) int {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value <= 0 {
		return fallback
	}
	return value
}

func durationSecondsEnvOrDefault(key string, fallbackSeconds int) time.Duration {
	return time.Duration(intEnvOrDefault(key, fallbackSeconds)) * time.Second
}
