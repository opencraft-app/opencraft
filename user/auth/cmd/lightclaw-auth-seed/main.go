package main

import (
	"log/slog"
	"os"
	"strings"

	"github.com/openclaw/openclaw/mono/backend/auth/internal/logging"
	"github.com/openclaw/openclaw/mono/backend/auth/internal/service"
)

func main() {
	logger := logging.New(logging.Config{
		Service: "lightclaw-auth-seed",
		Level:   envOrDefault("LIGHTCLAW_LOG_LEVEL", "info"),
	})
	slog.SetDefault(logger)

	dsn := strings.TrimSpace(os.Getenv("LIGHTCLAW_MYSQL_DSN"))
	if dsn == "" {
		dsn = strings.TrimSpace(os.Getenv("MYSQL_DSN"))
	}
	if dsn == "" {
		slog.Error("missing MySQL DSN")
		os.Exit(1)
	}

	_, err := service.NewMySQLStore(dsn, service.StoreOptions{
		SeedDefaultInvites: envBoolOrDefault("LIGHTCLAW_SEED_DEFAULT_INVITES", true),
		SeedDemoUser:       envBoolOrDefault("LIGHTCLAW_SEED_DEMO_USER", false),
	})
	if err != nil {
		slog.Error("seed bootstrap data failed", "err", err)
		os.Exit(1)
	}

	slog.Info("bootstrap data seeded successfully")
}

func envOrDefault(key string, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func envBoolOrDefault(key string, fallback bool) bool {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return strings.EqualFold(value, "true")
	}
	return fallback
}
