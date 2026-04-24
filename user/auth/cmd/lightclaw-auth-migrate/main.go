package main

import (
	"log/slog"
	"os"
	"strings"

	"github.com/openclaw/openclaw/mono/backend/auth/internal/logging"
	"github.com/openclaw/openclaw/mono/backend/auth/internal/migrations"
)

func main() {
	logger := logging.New(logging.Config{
		Service: "lightclaw-auth-migrate",
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

	if err := migrations.Run(dsn); err != nil {
		slog.Error("apply migrations failed", "err", err)
		os.Exit(1)
	}

	slog.Info("migrations applied successfully")
}

func envOrDefault(key string, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}
