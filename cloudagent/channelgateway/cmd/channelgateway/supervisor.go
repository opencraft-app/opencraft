package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"cloudagent/channelgateway/internal/acp"
	"cloudagent/channelgateway/internal/channel"
	"cloudagent/channelgateway/internal/channel/wecom"
	"cloudagent/channelgateway/internal/config"
	"cloudagent/channelgateway/internal/router"
	"cloudagent/channelgateway/internal/store"
)

type acpRuntimeClient interface {
	router.ACPClient
	Initialize(context.Context) error
	Close() error
}

type channelRuntimeAdapter interface {
	router.OutboxSender
	Start(context.Context, channel.InboundHandler) error
}

type acpClientFactory func(config.Config, store.ChannelAccount) acpRuntimeClient
type weComAdapterFactory func(wecom.Config) channelRuntimeAdapter

type weComSupervisor struct {
	cfg            config.Config
	store          *store.Store
	states         *channelRuntimeStates
	acpFactory     acpClientFactory
	adapterFactory weComAdapterFactory
	reconcileEvery time.Duration

	mu      sync.Mutex
	runners map[string]*accountRunner
}

func newWeComSupervisor(cfg config.Config, st *store.Store, states *channelRuntimeStates) *weComSupervisor {
	return &weComSupervisor{
		cfg:            cfg,
		store:          st,
		states:         states,
		acpFactory:     newAccountACPClient,
		adapterFactory: func(cfg wecom.Config) channelRuntimeAdapter { return wecom.NewAdapter(cfg) },
		reconcileEvery: 15 * time.Second,
		runners:        map[string]*accountRunner{},
	}
}

func (s *weComSupervisor) Start(ctx context.Context) error {
	if err := seedWeComAccounts(ctx, s.store, s.cfg); err != nil {
		return err
	}
	if err := s.reconcile(ctx); err != nil {
		return err
	}
	ticker := time.NewTicker(s.reconcileEvery)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			s.stopAll()
			return ctx.Err()
		case <-ticker.C:
			if err := s.reconcile(ctx); err != nil {
				log.Printf("wecom supervisor reconcile failed: %v", err)
			}
		}
	}
}

func (s *weComSupervisor) reconcile(ctx context.Context) error {
	accounts, err := s.store.ListActiveChannelAccounts(ctx, string(channel.TypeWeCom))
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for accountID, runner := range s.runners {
		if runner.Done() {
			delete(s.runners, accountID)
		}
	}
	for _, account := range accounts {
		if strings.TrimSpace(account.ChannelAccountID) == "" {
			continue
		}
		if _, ok := s.runners[account.ChannelAccountID]; ok {
			continue
		}
		runner := newAccountRunner(s.cfg, s.store, s.states, account, s.acpFactory, s.adapterFactory)
		s.runners[account.ChannelAccountID] = runner
		runner.Start(ctx)
	}
	return nil
}

func (s *weComSupervisor) stopAll() {
	s.mu.Lock()
	runners := make([]*accountRunner, 0, len(s.runners))
	for _, runner := range s.runners {
		runners = append(runners, runner)
	}
	s.mu.Unlock()
	for _, runner := range runners {
		runner.Stop()
	}
}

type accountRunner struct {
	cfg            config.Config
	store          *store.Store
	states         *channelRuntimeStates
	account        store.ChannelAccount
	acpFactory     acpClientFactory
	adapterFactory weComAdapterFactory

	ctx    context.Context
	cancel context.CancelFunc
	done   chan struct{}
}

func newAccountRunner(cfg config.Config, st *store.Store, states *channelRuntimeStates, account store.ChannelAccount, acpFactory acpClientFactory, adapterFactory weComAdapterFactory) *accountRunner {
	return &accountRunner{
		cfg:            cfg,
		store:          st,
		states:         states,
		account:        account,
		acpFactory:     acpFactory,
		adapterFactory: adapterFactory,
		done:           make(chan struct{}),
	}
}

func (r *accountRunner) Start(parent context.Context) {
	r.ctx, r.cancel = context.WithCancel(parent)
	go func() {
		defer close(r.done)
		if err := r.run(r.ctx); err != nil && !errors.Is(err, context.Canceled) {
			log.Printf("wecom account=%s runner stopped: %v", r.account.ChannelAccountID, err)
		}
	}()
}

func (r *accountRunner) Stop() {
	if r.cancel != nil {
		r.cancel()
	}
}

func (r *accountRunner) Done() bool {
	select {
	case <-r.done:
		return true
	default:
		return false
	}
}

func (r *accountRunner) run(ctx context.Context) error {
	runtimeCfg, err := weComConfigForAccount(r.account)
	if err != nil {
		r.states.SetError(r.account.ChannelAccountID, err)
		return err
	}
	lease, err := r.store.AcquireChannelLease(ctx, r.account.ChannelAccountID, r.cfg.OwnerID, r.cfg.LeaseTTL)
	if err != nil {
		r.states.SetError(r.account.ChannelAccountID, err)
		if errors.Is(err, store.ErrLeaseHeld) {
			return nil
		}
		var held store.LeaseHeldError
		if errors.As(err, &held) {
			return nil
		}
		return fmt.Errorf("acquire channel lease: %w", err)
	}
	r.states.SetLease(lease)
	log.Printf("channelgateway runtime_trace account_id=%s owner_id=%s fence=%d action=lease_acquired lease_expires_at=%s",
		runtimeLogValue(lease.ChannelAccountID), runtimeLogValue(lease.OwnerID), lease.FencingToken, lease.ExpiresAt.Format(time.RFC3339Nano))
	defer func() {
		releaseCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := r.store.ReleaseChannelLease(releaseCtx, lease); err != nil {
			log.Printf("release channel lease account=%s: %v", lease.ChannelAccountID, err)
		} else {
			log.Printf("channelgateway runtime_trace account_id=%s owner_id=%s fence=%d action=lease_released",
				runtimeLogValue(lease.ChannelAccountID), runtimeLogValue(lease.OwnerID), lease.FencingToken)
		}
		r.states.ClearLease(r.account.ChannelAccountID)
	}()
	acpClient := r.acpFactory(r.cfg, r.account)
	defer acpClient.Close()
	initTimeout := r.cfg.ACPInitializeTimeout
	if initTimeout <= 0 {
		initTimeout = 15 * time.Second
	}
	r.states.SetStatus(r.account.ChannelAccountID, "initializing_acp")
	initStartedAt := time.Now()
	log.Printf("channelgateway runtime_trace account_id=%s agent_id=%s action=acp_initialize_start timeout_ms=%d",
		runtimeLogValue(r.account.ChannelAccountID), runtimeLogValue(r.account.AgentID), initTimeout.Milliseconds())
	initCtx, initCancel := context.WithTimeout(ctx, initTimeout)
	defer initCancel()
	if err := acpClient.Initialize(initCtx); err != nil {
		r.states.SetError(r.account.ChannelAccountID, err)
		log.Printf("channelgateway runtime_trace account_id=%s agent_id=%s action=acp_initialize_failed duration_ms=%d error=%s",
			runtimeLogValue(r.account.ChannelAccountID), runtimeLogValue(r.account.AgentID), time.Since(initStartedAt).Milliseconds(), runtimeLogValue(err.Error()))
		return fmt.Errorf("initialize acp: %w", err)
	}
	log.Printf("channelgateway runtime_trace account_id=%s agent_id=%s action=acp_initialize_done duration_ms=%d",
		runtimeLogValue(r.account.ChannelAccountID), runtimeLogValue(r.account.AgentID), time.Since(initStartedAt).Milliseconds())
	adapter := r.adapterFactory(runtimeCfg)
	dispatcher := router.NewDispatcherWithOptions(
		r.store,
		r.account,
		acpClient,
		"/workspace",
		router.DispatcherOptions{RequestTimeout: r.cfg.RequestTimeout},
	)
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	go r.renewLeaseLoop(runCtx, cancel)
	go r.outboxLoop(runCtx, adapter)
	r.states.SetStatus(r.account.ChannelAccountID, "running")
	log.Printf("channelgateway runtime_trace account_id=%s agent_id=%s action=wecom_adapter_start websocket_url=%s",
		runtimeLogValue(r.account.ChannelAccountID), runtimeLogValue(r.account.AgentID), runtimeLogValue(runtimeCfg.WebSocketURL))
	err = adapter.Start(runCtx, dispatcher)
	if err != nil {
		r.states.SetError(r.account.ChannelAccountID, err)
	}
	log.Printf("channelgateway runtime_trace account_id=%s agent_id=%s action=wecom_adapter_stopped error=%s",
		runtimeLogValue(r.account.ChannelAccountID), runtimeLogValue(r.account.AgentID), runtimeLogValue(errorString(err)))
	return err
}

func (r *accountRunner) renewLeaseLoop(ctx context.Context, cancel context.CancelFunc) {
	interval := r.cfg.LeaseTTL / 3
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
			lease := r.states.GetLease(r.account.ChannelAccountID)
			if lease.ChannelAccountID == "" {
				continue
			}
			renewed, err := r.store.RenewChannelLease(ctx, lease, r.cfg.LeaseTTL)
			if err != nil {
				log.Printf("renew channel lease account=%s owner=%s fence=%d failed; stopping channel owner: %v", lease.ChannelAccountID, lease.OwnerID, lease.FencingToken, err)
				r.states.SetError(lease.ChannelAccountID, err)
				cancel()
				return
			}
			r.states.SetLease(renewed)
		}
	}
}

func (r *accountRunner) outboxLoop(ctx context.Context, sender router.OutboxSender) {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			lease := r.states.GetLease(r.account.ChannelAccountID)
			if lease.ChannelAccountID == "" {
				continue
			}
			if _, err := router.DrainOutbox(ctx, r.store, lease, sender, 16); err != nil {
				log.Printf("drain outbox account=%s failed: %v", lease.ChannelAccountID, err)
			}
		}
	}
}

func seedWeComAccounts(ctx context.Context, st *store.Store, cfg config.Config) error {
	for _, accountCfg := range cfg.EnabledWeComAccounts() {
		account, err := weComChannelAccount(accountCfg)
		if err != nil {
			return err
		}
		if err := st.UpsertChannelAccount(ctx, account); err != nil {
			return err
		}
	}
	return nil
}

func weComChannelAccount(cfg config.WeComConfig) (store.ChannelAccount, error) {
	if strings.TrimSpace(cfg.AccountID) == "" {
		return store.ChannelAccount{}, errors.New("wecom account_id is required")
	}
	if strings.TrimSpace(cfg.AgentID) == "" {
		return store.ChannelAccount{}, errors.New("wecom agent_id is required")
	}
	configJSON, err := json.Marshal(map[string]any{
		"bot_id":             cfg.BotID,
		"secret":             cfg.Secret,
		"websocket_url":      cfg.WebSocketURL,
		"dm_policy":          cfg.DMPolicy,
		"group_policy":       cfg.GroupPolicy,
		"handler_workers":    cfg.HandlerWorkers,
		"handler_queue_size": cfg.HandlerQueueSize,
	})
	if err != nil {
		return store.ChannelAccount{}, err
	}
	return store.ChannelAccount{
		ChannelAccountID: strings.TrimSpace(cfg.AccountID),
		ChannelType:      string(channel.TypeWeCom),
		TenantID:         strings.TrimSpace(cfg.TenantID),
		ProjectID:        strings.TrimSpace(cfg.ProjectID),
		AgentID:          strings.TrimSpace(cfg.AgentID),
		ConfigJSON:       string(configJSON),
		Status:           "active",
	}, nil
}

func weComConfigForAccount(account store.ChannelAccount) (wecom.Config, error) {
	var raw struct {
		BotID            string `json:"bot_id"`
		Secret           string `json:"secret"`
		WebSocketURL     string `json:"websocket_url"`
		DMPolicy         string `json:"dm_policy"`
		GroupPolicy      string `json:"group_policy"`
		HandlerWorkers   int    `json:"handler_workers"`
		HandlerQueueSize int    `json:"handler_queue_size"`
	}
	if strings.TrimSpace(account.ConfigJSON) != "" {
		if err := json.Unmarshal([]byte(account.ConfigJSON), &raw); err != nil {
			return wecom.Config{}, fmt.Errorf("decode wecom account config: %w", err)
		}
	}
	cfg := wecom.Config{
		AccountID:        account.ChannelAccountID,
		BotID:            strings.TrimSpace(raw.BotID),
		Secret:           strings.TrimSpace(raw.Secret),
		WebSocketURL:     strings.TrimSpace(raw.WebSocketURL),
		DMPolicy:         strings.TrimSpace(raw.DMPolicy),
		GroupPolicy:      strings.TrimSpace(raw.GroupPolicy),
		HandlerWorkers:   raw.HandlerWorkers,
		HandlerQueueSize: raw.HandlerQueueSize,
	}
	if cfg.WebSocketURL == "" {
		cfg.WebSocketURL = "wss://openws.work.weixin.qq.com"
	}
	if cfg.DMPolicy == "" {
		cfg.DMPolicy = "open"
	}
	if cfg.GroupPolicy == "" {
		cfg.GroupPolicy = "open"
	}
	return cfg, nil
}

func newAccountACPClient(cfg config.Config, account store.ChannelAccount) acpRuntimeClient {
	return acp.NewClient(normalizeACPURL(cfg.ACPURL), acpHeadersForAccount(cfg, account))
}

func acpHeadersForAccount(cfg config.Config, account store.ChannelAccount) http.Header {
	headers := acpHeaders(cfg)
	if strings.TrimSpace(account.TenantID) != "" {
		headers.Set("X-Tenant-ID", strings.TrimSpace(account.TenantID))
	}
	if strings.TrimSpace(account.ProjectID) != "" {
		headers.Set("X-Project-ID", strings.TrimSpace(account.ProjectID))
	}
	return headers
}

type channelRuntimeState struct {
	AccountID      string `json:"account_id"`
	Status         string `json:"status"`
	OwnerID        string `json:"owner_id,omitempty"`
	FencingToken   int64  `json:"fencing_token,omitempty"`
	LeaseExpiresAt string `json:"lease_expires_at,omitempty"`
	LastError      string `json:"last_error,omitempty"`
}

type channelRuntimeStates struct {
	mu     sync.RWMutex
	states map[string]channelRuntimeState
	leases map[string]store.ChannelLease
}

func newChannelRuntimeStates() *channelRuntimeStates {
	return &channelRuntimeStates{
		states: map[string]channelRuntimeState{},
		leases: map[string]store.ChannelLease{},
	}
}

func (s *channelRuntimeStates) SetLease(lease store.ChannelLease) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.leases[lease.ChannelAccountID] = lease
	state := s.states[lease.ChannelAccountID]
	state.AccountID = lease.ChannelAccountID
	if state.Status == "" || state.Status == "stopped" || state.Status == "error" {
		state.Status = "leased"
	}
	state.OwnerID = lease.OwnerID
	state.FencingToken = lease.FencingToken
	state.LeaseExpiresAt = lease.ExpiresAt.Format(time.RFC3339Nano)
	state.LastError = ""
	s.states[lease.ChannelAccountID] = state
}

func (s *channelRuntimeStates) GetLease(accountID string) store.ChannelLease {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.leases[accountID]
}

func (s *channelRuntimeStates) ClearLease(accountID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.leases, accountID)
	state := s.states[accountID]
	state.AccountID = accountID
	state.Status = "stopped"
	state.OwnerID = ""
	state.FencingToken = 0
	state.LeaseExpiresAt = ""
	s.states[accountID] = state
}

func (s *channelRuntimeStates) SetStatus(accountID, status string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	state := s.states[accountID]
	state.AccountID = accountID
	state.Status = status
	s.states[accountID] = state
}

func (s *channelRuntimeStates) SetError(accountID string, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	state := s.states[accountID]
	state.AccountID = accountID
	state.Status = "error"
	if err != nil {
		state.LastError = err.Error()
	}
	s.states[accountID] = state
}

func (s *channelRuntimeStates) Snapshot() []channelRuntimeState {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]channelRuntimeState, 0, len(s.states))
	for _, state := range s.states {
		out = append(out, state)
	}
	return out
}

func runtimeLogValue(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return "-"
	}
	value = strings.NewReplacer("\n", "\\n", "\r", "\\r", "\t", "\\t").Replace(value)
	if len(value) > 200 {
		return value[:200] + "...[truncated]"
	}
	return value
}

func errorString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
