package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"cloudagent/channelgateway/internal/config"
	"cloudagent/channelgateway/internal/store"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "drain" {
		if err := runDrainCommand(os.Args[2:]); err != nil {
			log.Fatalf("channelgateway drain: %v", err)
		}
		return
	}
	if err := run(); err != nil && !errors.Is(err, context.Canceled) {
		log.Fatalf("channelgateway: %v", err)
	}
}

func run() error {
	cfg := config.LoadFromEnv()
	if err := cfg.Validate(); err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(signals)

	st, err := store.OpenWithDriver(ctx, cfg.DBDriver, cfg.DBPath)
	if err != nil {
		return fmt.Errorf("open store: %w", err)
	}
	defer st.Close()

	runtimeStates := newChannelRuntimeStates()
	lifecycle := newRuntimeLifecycle()
	var drainOnce sync.Once
	beginDrain := func(reason string) {
		drainOnce.Do(func() {
			lifecycle.StartDraining(reason)
			log.Printf("channelgateway runtime_trace action=draining_start reason=%s", runtimeLogValue(reason))
			cancel()
		})
	}
	httpSrv := startHTTPServer(cfg.ListenAddr, cfg, runtimeStates, lifecycle, beginDrain)
	defer func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = httpSrv.Shutdown(shutdownCtx)
	}()

	log.Printf("channelgateway starting channel supervisors; health addr=%s db_driver=%s db_target=%s seeded_wecom_accounts=%d", cfg.ListenAddr, cfg.DBDriver, redactDBTarget(cfg.DBPath), len(cfg.EnabledWeComAccounts()))
	supervisor := newWeComSupervisor(cfg, st, runtimeStates)
	go func() {
		sig := <-signals
		beginDrain(sig.String())
	}()
	return supervisor.Start(ctx)
}

func redactDBTarget(raw string) string {
	value := strings.TrimSpace(raw)
	if value == "" {
		return ""
	}
	if parsed, err := url.Parse(value); err == nil && parsed.Scheme != "" && parsed.User != nil {
		parsed.User = url.UserPassword(parsed.User.Username(), "xxxxx")
		return parsed.String()
	}
	if at := strings.Index(value, "@"); at > 0 {
		return "xxxxx@" + value[at+1:]
	}
	return value
}

func startHTTPServer(addr string, cfg config.Config, runtimeStates *channelRuntimeStates, lifecycle *runtimeLifecycle, onDrain func(string)) *http.Server {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", healthHandler(cfg, runtimeStates))
	mux.HandleFunc("/readyz", readyHandler(cfg, runtimeStates, lifecycle))
	mux.HandleFunc("/drainz", drainHandler(lifecycle, onDrain))
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

func drainHandler(lifecycle *runtimeLifecycle, onDrain func(string)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "method_not_allowed"})
			return
		}
		if !isLoopbackRemote(r.RemoteAddr) {
			w.WriteHeader(http.StatusForbidden)
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "loopback_required"})
			return
		}
		lifecycle.StartDraining("pre_stop")
		if onDrain != nil {
			go onDrain("pre_stop")
		}
		draining, reason, startedAt := lifecycle.Draining()
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":               true,
			"draining":         draining,
			"drain_reason":     reason,
			"drain_started_at": startedAt,
		})
	}
}

func isLoopbackRemote(remoteAddr string) bool {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		host = strings.Trim(remoteAddr, "[]")
	}
	addr, parseErr := netip.ParseAddr(strings.Trim(host, "[]"))
	return parseErr == nil && addr.IsLoopback()
}

func readyHandler(cfg config.Config, runtimeStates *channelRuntimeStates, lifecycle *runtimeLifecycle) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		draining, reason, startedAt := lifecycle.Draining()
		ready := !draining && runtimeStates.HasReadyAccount()
		if !ready {
			w.WriteHeader(http.StatusServiceUnavailable)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":                  ready,
			"ready":               ready,
			"owner_id":            cfg.OwnerID,
			"draining":            draining,
			"drain_reason":        reason,
			"drain_started_at":    startedAt,
			"ready_account":       runtimeStates.HasReadyAccount(),
			"wecom_accounts":      runtimeStates.Snapshot(),
			"required_for_accept": "not_draining && (running || standby_lease_held)",
		})
	}
}

func runDrainCommand(args []string) error {
	fs := flag.NewFlagSet("drain", flag.ContinueOnError)
	addr := fs.String("addr", "http://127.0.0.1:8094", "local channelgateway health address")
	if err := fs.Parse(args); err != nil {
		return err
	}
	base := strings.TrimRight(strings.TrimSpace(*addr), "/")
	if base == "" {
		return errors.New("drain addr is required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/drainz", nil)
	if err != nil {
		return err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("drain endpoint returned %s", resp.Status)
	}
	return nil
}

type runtimeLifecycle struct {
	mu             sync.RWMutex
	draining       bool
	drainReason    string
	drainStartedAt string
}

func newRuntimeLifecycle() *runtimeLifecycle {
	return &runtimeLifecycle{}
}

func (l *runtimeLifecycle) StartDraining(reason string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.draining {
		return
	}
	l.draining = true
	l.drainReason = strings.TrimSpace(reason)
	l.drainStartedAt = time.Now().UTC().Format(time.RFC3339Nano)
}

func (l *runtimeLifecycle) Draining() (bool, string, string) {
	l.mu.RLock()
	defer l.mu.RUnlock()
	return l.draining, l.drainReason, l.drainStartedAt
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
