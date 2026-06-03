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
	"sync"
	"syscall"
	"time"

	"cloudagent/channelgateway/internal/acp"
	"cloudagent/channelgateway/internal/channel"
	"cloudagent/channelgateway/internal/channel/wecom"
	"cloudagent/channelgateway/internal/config"
	"cloudagent/channelgateway/internal/router"
	"cloudagent/channelgateway/internal/store"
)

func main() {
	if err := run(); err != nil && !errors.Is(err, context.Canceled) {
		log.Fatalf("channelgateway: %v", err)
	}
}

func run() error {
	cfg := config.LoadFromEnv()
	signalCtx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithCancel(signalCtx)
	defer cancel()

	st, err := store.Open(ctx, cfg.DBPath)
	if err != nil {
		return fmt.Errorf("open store: %w", err)
	}
	defer st.Close()

	leaseState := &channelLeaseState{}
	httpSrv := startHTTPServer(cfg.ListenAddr, cfg, leaseState)
	defer func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = httpSrv.Shutdown(shutdownCtx)
	}()

	if !cfg.WeCom.Enabled {
		log.Printf("channelgateway started without enabled adapters; health addr=%s db=%s", cfg.ListenAddr, cfg.DBPath)
		<-ctx.Done()
		return ctx.Err()
	}
	account, err := ensureWeComAccount(ctx, st, cfg)
	if err != nil {
		return err
	}
	lease, err := st.AcquireChannelLease(ctx, account.ChannelAccountID, cfg.OwnerID, cfg.LeaseTTL)
	if err != nil {
		return fmt.Errorf("acquire channel lease: %w", err)
	}
	leaseState.Set(lease)
	defer func() {
		releaseCtx, releaseCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer releaseCancel()
		if err := st.ReleaseChannelLease(releaseCtx, leaseState.Get()); err != nil {
			log.Printf("release channel lease account=%s: %v", leaseState.Get().ChannelAccountID, err)
		}
	}()

	go renewLeaseLoop(ctx, cancel, st, cfg, leaseState)

	acpClient := acp.NewClient(normalizeACPURL(cfg.ACPURL), acpHeaders(cfg))
	defer acpClient.Close()
	if err := initializeACPWithRetry(ctx, acpClient, 2*time.Second); err != nil {
		return fmt.Errorf("initialize acp: %w", err)
	}

	adapter := wecom.NewAdapter(wecom.Config{
		AccountID:        cfg.WeCom.AccountID,
		BotID:            cfg.WeCom.BotID,
		Secret:           cfg.WeCom.Secret,
		WebSocketURL:     cfg.WeCom.WebSocketURL,
		DMPolicy:         cfg.WeCom.DMPolicy,
		GroupPolicy:      cfg.WeCom.GroupPolicy,
		HandlerWorkers:   cfg.WeCom.HandlerWorkers,
		HandlerQueueSize: cfg.WeCom.HandlerQueueSize,
	})
	dispatcher := router.NewDispatcher(st, account, acpClient, "/workspace")
	go outboxLoop(ctx, st, leaseState, adapter)
	return adapter.Start(ctx, dispatcher)
}

func ensureWeComAccount(ctx context.Context, st *store.Store, cfg config.Config) (store.ChannelAccount, error) {
	configJSON, _ := json.Marshal(map[string]any{
		"websocket_url": cfg.WeCom.WebSocketURL,
		"dm_policy":     cfg.WeCom.DMPolicy,
		"group_policy":  cfg.WeCom.GroupPolicy,
	})
	account := store.ChannelAccount{
		ChannelAccountID: cfg.WeCom.AccountID,
		ChannelType:      string(channel.TypeWeCom),
		TenantID:         cfg.WeCom.TenantID,
		ProjectID:        cfg.WeCom.ProjectID,
		AgentID:          cfg.WeCom.AgentID,
		ConfigJSON:       string(configJSON),
		Status:           "active",
	}
	if err := st.UpsertChannelAccount(ctx, account); err != nil {
		return store.ChannelAccount{}, err
	}
	return account, nil
}

type channelLeaseState struct {
	mu    sync.RWMutex
	lease store.ChannelLease
}

func (s *channelLeaseState) Set(lease store.ChannelLease) {
	s.mu.Lock()
	s.lease = lease
	s.mu.Unlock()
}

func (s *channelLeaseState) Get() store.ChannelLease {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.lease
}

func startHTTPServer(addr string, cfg config.Config, leaseState *channelLeaseState) *http.Server {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", healthHandler(cfg, leaseState))
	srv := &http.Server{Addr: addr, Handler: mux}
	go func() {
		log.Printf("channelgateway health listening on %s", addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("channelgateway http failed: %v", err)
		}
	}()
	return srv
}

func healthHandler(cfg config.Config, leaseState *channelLeaseState) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		lease := leaseState.Get()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":                 true,
			"owner_id":           cfg.OwnerID,
			"channel_account_id": lease.ChannelAccountID,
			"fencing_token":      lease.FencingToken,
			"lease_expires_at":   lease.ExpiresAt.Format(time.RFC3339Nano),
			"wecom_enabled":      cfg.WeCom.Enabled,
		})
	}
}

func renewLeaseLoop(ctx context.Context, cancel context.CancelFunc, st *store.Store, cfg config.Config, leaseState *channelLeaseState) {
	interval := cfg.LeaseTTL / 3
	if interval < 5*time.Second {
		interval = 5 * time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			lease := leaseState.Get()
			if lease.ChannelAccountID == "" {
				continue
			}
			renewed, err := st.RenewChannelLease(ctx, lease, cfg.LeaseTTL)
			if err != nil {
				log.Printf("renew channel lease account=%s owner=%s fence=%d failed; stopping channel owner: %v", lease.ChannelAccountID, lease.OwnerID, lease.FencingToken, err)
				cancel()
				return
			}
			leaseState.Set(renewed)
		}
	}
}

func outboxLoop(ctx context.Context, st *store.Store, leaseState *channelLeaseState, sender router.OutboxSender) {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			lease := leaseState.Get()
			if lease.ChannelAccountID == "" {
				continue
			}
			if _, err := router.DrainOutbox(ctx, st, lease, sender, 16); err != nil {
				log.Printf("drain outbox failed: %v", err)
			}
		}
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

type acpInitializer interface {
	Initialize(context.Context) error
}

func initializeACPWithRetry(ctx context.Context, client acpInitializer, retryInterval time.Duration) error {
	if retryInterval <= 0 {
		retryInterval = time.Second
	}
	attempt := 0
	for {
		attempt++
		err := client.Initialize(ctx)
		if err == nil {
			if attempt > 1 {
				log.Printf("channelgateway acp initialized after %d attempts", attempt)
			}
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		log.Printf("channelgateway acp initialize attempt=%d failed; retrying in %s: %v", attempt, retryInterval, err)
		timer := time.NewTimer(retryInterval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
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
