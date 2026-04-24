package main

import (
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/openclaw/openclaw/mono/nextgen-dashboard/internal/command"
	"github.com/openclaw/openclaw/mono/nextgen-dashboard/internal/data"
	"github.com/openclaw/openclaw/mono/nextgen-dashboard/internal/httpapi"
)

func main() {
	addr := envOrDefault("NEXTGEN_DASHBOARD_ADDR", ":18081")
	username := envOrDefault("NEXTGEN_DASHBOARD_BASIC_AUTH_USER", "admin")
	password := envOrDefault("NEXTGEN_DASHBOARD_BASIC_AUTH_PASSWORD", "admin")
	runnerToken := envOrDefault("NEXTGEN_DASHBOARD_RUNNER_TOKEN", "nextgen-runner-token")

	provider, err := buildProvider()
	if err != nil {
		slog.Error("build data provider failed", "err", err)
		os.Exit(1)
	}

	server := &http.Server{
		Addr: addr,
		Handler: httpapi.NewServer(httpapi.Config{
			Username:         username,
			Password:         password,
			Registry:         command.NewRegistry(provider),
			RunnerWS:         envOrDefault("NEXTGEN_DASHBOARD_RUNNER_WS", "ws://127.0.0.1:19091/ws/shell"),
			RunnerToken:      runnerToken,
			ProxyTokenSecret: envOrDefault("NEXTGEN_DASHBOARD_PROXY_TOKEN_SECRET", runnerToken),
			ProxyURL:         envOrDefault("NEXTGEN_DASHBOARD_PROXY_URL", "http://127.0.0.1:8084/admin/api/commands/proxy"),
		}),
		ReadHeaderTimeout: 5 * time.Second,
	}

	slog.Info("nextgen-dashboard admind listening", "addr", addr)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		slog.Error("nextgen-dashboard admind exited", "err", err)
		os.Exit(1)
	}
}

func buildProvider() (data.Provider, error) {
	authDSN := strings.TrimSpace(os.Getenv("NEXTGEN_DASHBOARD_AUTH_MYSQL_DSN"))
	sandboxDSN := strings.TrimSpace(os.Getenv("NEXTGEN_DASHBOARD_SANDBOX_MYSQL_DSN"))
	if authDSN == "" || sandboxDSN == "" {
		slog.Warn("mysql dsns not fully configured, using static provider")
		return data.StaticProvider{}, nil
	}
	return data.NewMySQLProvider(authDSN, sandboxDSN)
}

func envOrDefault(key string, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}
