package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"cloudagent/channelgateway/internal/config"
	"cloudagent/channelgateway/internal/store"
)

func main() {
	if err := run(); err != nil && !errors.Is(err, context.Canceled) {
		log.Fatalf("channelgateway: %v", err)
	}
}

func run() error {
	cfg := config.LoadFromEnv()
	if err := cfg.Validate(); err != nil {
		return err
	}
	signalCtx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithCancel(signalCtx)
	defer cancel()

	st, err := store.OpenWithDriver(ctx, cfg.DBDriver, cfg.DBPath)
	if err != nil {
		return fmt.Errorf("open store: %w", err)
	}
	defer st.Close()

	runtimeStates := newChannelRuntimeStates()
	httpSrv := startHTTPServer(cfg.ListenAddr, cfg, runtimeStates)
	defer func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = httpSrv.Shutdown(shutdownCtx)
	}()

	log.Printf("channelgateway starting channel supervisors; health addr=%s db=%s seeded_wecom_accounts=%d", cfg.ListenAddr, cfg.DBPath, len(cfg.EnabledWeComAccounts()))
	supervisor := newWeComSupervisor(cfg, st, runtimeStates)
	return supervisor.Start(ctx)
}

func startHTTPServer(addr string, cfg config.Config, runtimeStates *channelRuntimeStates) *http.Server {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", healthHandler(cfg, runtimeStates))
	srv := &http.Server{Addr: addr, Handler: mux}
	go func() {
		log.Printf("channelgateway health listening on %s", addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("channelgateway http failed: %v", err)
		}
	}()
	return srv
}

func healthHandler(cfg config.Config, runtimeStates *channelRuntimeStates) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":             true,
			"owner_id":       cfg.OwnerID,
			"wecom_enabled":  true,
			"wecom_accounts": runtimeStates.Snapshot(),
		})
	}
}

func acpHeaders(cfg config.Config) http.Header {
	headers := http.Header{}
	if cfg.ACPAuthorization != "" {
		headers.Set("Authorization", cfg.ACPAuthorization)
	}
	if cfg.TenantID != "" {
		headers.Set("X-Tenant-ID", cfg.TenantID)
	}
	if cfg.ProjectID != "" {
		headers.Set("X-Project-ID", cfg.ProjectID)
	}
	return headers
}

func normalizeACPURL(raw string) string {
	value := strings.TrimSpace(raw)
	if value == "" {
		return "ws://127.0.0.1:18094/acp"
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme == "" {
		return value
	}
	switch parsed.Scheme {
	case "http":
		parsed.Scheme = "ws"
	case "https":
		parsed.Scheme = "wss"
	}
	if parsed.Path == "" || parsed.Path == "/" {
		parsed.Path = "/acp"
	}
	return parsed.String()
}
