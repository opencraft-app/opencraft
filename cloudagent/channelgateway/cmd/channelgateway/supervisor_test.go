package main

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"cloudagent/channelgateway/internal/acp"
	"cloudagent/channelgateway/internal/channel"
	"cloudagent/channelgateway/internal/channel/wecom"
	"cloudagent/channelgateway/internal/config"
	"cloudagent/channelgateway/internal/router"
	"cloudagent/channelgateway/internal/store"
)

func TestWeComSupervisorStartsOneRunnerPerClaimedAccount(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	st, err := store.Open(ctx, t.TempDir()+"/channelgateway.db")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer st.Close()
	cfg := config.Config{
		OwnerID:  "owner-a",
		LeaseTTL: time.Minute,
		WeComAccounts: []config.WeComConfig{
			{Enabled: true, AccountID: "wecom-a", BotID: "bot-a", Secret: "secret-a", AgentID: "agent-a", TenantID: "tenant-a", ProjectID: "project-a"},
			{Enabled: true, AccountID: "wecom-b", BotID: "bot-b", Secret: "secret-b", AgentID: "agent-b", TenantID: "tenant-b", ProjectID: "project-b"},
		},
	}
	states := newChannelRuntimeStates()
	supervisor := newWeComSupervisor(cfg, st, states)
	started := make(chan string, 2)
	supervisor.acpFactory = func(cfg config.Config, account store.ChannelAccount) acpRuntimeClient {
		return &fakeACPClient{}
	}
	supervisor.adapterFactory = func(cfg wecom.Config) channelRuntimeAdapter {
		return &fakeRuntimeAdapter{accountID: cfg.AccountID, started: started}
	}
	if err := seedWeComAccounts(ctx, st, cfg); err != nil {
		t.Fatalf("seed accounts: %v", err)
	}
	if err := supervisor.reconcile(ctx); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	got := map[string]bool{}
	for len(got) < 2 {
		select {
		case accountID := <-started:
			got[accountID] = true
		case <-time.After(3 * time.Second):
			t.Fatalf("timed out waiting for adapters, got %#v", got)
		}
	}
	if !got["wecom-a"] || !got["wecom-b"] {
		t.Fatalf("expected both accounts to start, got %#v", got)
	}
	supervisor.stopAll()
}

func TestWeComSupervisorUsesStoreRegistryWithoutEnvSeed(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	st, err := store.Open(ctx, t.TempDir()+"/channelgateway.db")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer st.Close()
	account, err := weComChannelAccount(config.WeComConfig{
		Enabled:   true,
		AccountID: "wecom-registry",
		BotID:     "bot-registry",
		Secret:    "secret-registry",
		AgentID:   "agent-registry",
		TenantID:  "tenant-registry",
		ProjectID: "project-registry",
	})
	if err != nil {
		t.Fatalf("build account: %v", err)
	}
	if err := st.UpsertChannelAccount(ctx, account); err != nil {
		t.Fatalf("upsert account: %v", err)
	}
	cfg := config.Config{OwnerID: "owner-a", LeaseTTL: time.Minute}
	started := make(chan string, 1)
	supervisor := newWeComSupervisor(cfg, st, newChannelRuntimeStates())
	supervisor.acpFactory = func(cfg config.Config, account store.ChannelAccount) acpRuntimeClient {
		return &fakeACPClient{}
	}
	supervisor.adapterFactory = func(cfg wecom.Config) channelRuntimeAdapter {
		return &fakeRuntimeAdapter{accountID: cfg.AccountID, started: started}
	}
	if err := supervisor.reconcile(ctx); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	select {
	case accountID := <-started:
		if accountID != "wecom-registry" {
			t.Fatalf("unexpected account started: %s", accountID)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("store registry account did not start")
	}
	supervisor.stopAll()
}

func TestWeComSupervisorStandbyTakesOverWhenLeaseReleased(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	st, err := store.Open(ctx, t.TempDir()+"/channelgateway.db")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer st.Close()
	cfg := config.Config{
		OwnerID:  "owner-new",
		LeaseTTL: time.Minute,
		WeComAccounts: []config.WeComConfig{
			{Enabled: true, AccountID: "wecom-a", BotID: "bot-a", Secret: "secret-a", AgentID: "agent-a"},
		},
	}
	if err := seedWeComAccounts(ctx, st, cfg); err != nil {
		t.Fatalf("seed accounts: %v", err)
	}
	existingLease, err := st.AcquireChannelLease(ctx, "wecom-a", "owner-existing", time.Minute)
	if err != nil {
		t.Fatalf("pre-acquire lease: %v", err)
	}
	started := make(chan string, 1)
	supervisor := newWeComSupervisor(cfg, st, newChannelRuntimeStates())
	supervisor.acpFactory = func(cfg config.Config, account store.ChannelAccount) acpRuntimeClient {
		return &fakeACPClient{}
	}
	supervisor.adapterFactory = func(cfg wecom.Config) channelRuntimeAdapter {
		return &fakeRuntimeAdapter{accountID: cfg.AccountID, started: started}
	}
	if err := supervisor.reconcile(ctx); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	runner := supervisor.runners["wecom-a"]
	if runner == nil {
		t.Fatal("expected standby runner to be recorded")
	}
	select {
	case accountID := <-started:
		t.Fatalf("adapter should not start for held lease, got %s", accountID)
	default:
	}
	state := waitStateForAccount(t, supervisor.states, "wecom-a", func(state channelRuntimeState) bool {
		return state.Status == "standby_lease_held"
	})
	if state.Status != "standby_lease_held" {
		t.Fatalf("lease-held account should be standby, got %#v", state)
	}
	if runner.Done() {
		t.Fatal("standby runner should keep waiting for lease handoff")
	}
	if err := st.ReleaseChannelLease(ctx, existingLease); err != nil {
		t.Fatalf("release existing lease: %v", err)
	}
	select {
	case accountID := <-started:
		if accountID != "wecom-a" {
			t.Fatalf("unexpected account started after lease release: %s", accountID)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("standby runner did not take over after lease release")
	}
	supervisor.stopAll()
}

func TestWeComSupervisorStopAllReleasesLeaseBeforeReturning(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	st, err := store.Open(ctx, t.TempDir()+"/channelgateway.db")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer st.Close()
	cfg := config.Config{
		OwnerID:  "owner-a",
		LeaseTTL: time.Minute,
		WeComAccounts: []config.WeComConfig{
			{Enabled: true, AccountID: "wecom-a", BotID: "bot-a", Secret: "secret-a", AgentID: "agent-a"},
		},
	}
	if err := seedWeComAccounts(ctx, st, cfg); err != nil {
		t.Fatalf("seed accounts: %v", err)
	}
	started := make(chan string, 1)
	supervisor := newWeComSupervisor(cfg, st, newChannelRuntimeStates())
	supervisor.acpFactory = func(cfg config.Config, account store.ChannelAccount) acpRuntimeClient {
		return &fakeACPClient{}
	}
	supervisor.adapterFactory = func(cfg wecom.Config) channelRuntimeAdapter {
		return &fakeRuntimeAdapter{accountID: cfg.AccountID, started: started}
	}
	if err := supervisor.reconcile(ctx); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("adapter did not start")
	}
	supervisor.stopAll()
	if _, err := st.AcquireChannelLease(ctx, "wecom-a", "owner-b", time.Minute); err != nil {
		t.Fatalf("lease should be released before stopAll returns: %v", err)
	}
}

func TestAccountRunnerACPInitializeTimeoutReleasesLease(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	st, err := store.Open(ctx, t.TempDir()+"/channelgateway.db")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer st.Close()
	account, err := weComChannelAccount(config.WeComConfig{
		Enabled:   true,
		AccountID: "wecom-a",
		BotID:     "bot-a",
		Secret:    "secret-a",
		AgentID:   "agent-a",
	})
	if err != nil {
		t.Fatalf("build account: %v", err)
	}
	states := newChannelRuntimeStates()
	started := make(chan string, 1)
	initializeStarted := make(chan struct{})
	cfg := config.Config{OwnerID: "owner-a", LeaseTTL: time.Minute, ACPInitializeTimeout: 20 * time.Millisecond}
	runner := newAccountRunner(
		cfg,
		st,
		states,
		account,
		func(config.Config, store.ChannelAccount) acpRuntimeClient {
			return &fakeACPClient{initialize: func(ctx context.Context) error {
				close(initializeStarted)
				<-ctx.Done()
				return ctx.Err()
			}}
		},
		func(cfg wecom.Config) channelRuntimeAdapter {
			return &fakeRuntimeAdapter{accountID: cfg.AccountID, started: started}
		},
	)
	runner.Start(ctx)
	select {
	case <-initializeStarted:
	case <-time.After(3 * time.Second):
		t.Fatal("ACP initialize did not start")
	}
	if state := stateForAccount(t, states, "wecom-a"); state.Status != "initializing_acp" {
		t.Fatalf("expected initializing_acp while initialize is in flight, got %#v", state)
	}
	select {
	case <-runner.done:
	case <-time.After(3 * time.Second):
		t.Fatal("runner did not exit after ACP initialize timeout")
	}
	select {
	case accountID := <-started:
		t.Fatalf("adapter should not start when ACP initialize times out, got %s", accountID)
	default:
	}
	lease, err := st.AcquireChannelLease(ctx, "wecom-a", "owner-b", time.Minute)
	if err != nil {
		t.Fatalf("lease should be released after initialize timeout: %v", err)
	}
	if lease.OwnerID != "owner-b" {
		t.Fatalf("unexpected reacquired lease: %#v", lease)
	}
	state := stateForAccount(t, states, "wecom-a")
	if state.Status != "stopped" || !strings.Contains(state.LastError, "context deadline exceeded") {
		t.Fatalf("expected stopped state with timeout error, got %#v", state)
	}
}

func TestAccountRunnerRecoverInboundOnceProcessesPendingJob(t *testing.T) {
	ctx := context.Background()
	st, err := store.Open(ctx, t.TempDir()+"/channelgateway.db")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer st.Close()
	account := store.ChannelAccount{ChannelAccountID: "wecom-a", ChannelType: "wecom", AgentID: "main"}
	lease, err := st.AcquireChannelLease(ctx, "wecom-a", "owner-a", time.Minute)
	if err != nil {
		t.Fatalf("acquire lease: %v", err)
	}
	msg := channel.Message{
		ChannelAccountID:       "wecom-a",
		ChannelType:            channel.TypeWeCom,
		ExternalMessageID:      "msg-recover",
		ExternalConversationID: "chat-recover",
		ExternalUserID:         "user-recover",
		ChatType:               channel.ChatDM,
		Kind:                   channel.MessageText,
		Text:                   "hello",
	}
	payload, err := json.Marshal(msg)
	if err != nil {
		t.Fatalf("marshal message: %v", err)
	}
	if _, err := st.InsertInboundMessage(ctx, store.MessageRecord{
		ChannelAccountID:       "wecom-a",
		ChannelType:            "wecom",
		ExternalMessageID:      "msg-recover",
		ExternalConversationID: "chat-recover",
		Direction:              "inbound",
		Status:                 "received",
		PayloadJSON:            string(payload),
	}); err != nil {
		t.Fatalf("insert inbound: %v", err)
	}
	states := newChannelRuntimeStates()
	states.SetLease(lease)
	client := &fakeACPClient{}
	dispatcher := router.NewDispatcherWithOptions(st, account, client, "/workspace", router.DispatcherOptions{
		InboundLease: lease,
		InboundStale: time.Nanosecond,
	})
	runner := newAccountRunner(config.Config{OwnerID: "owner-a", LeaseTTL: time.Minute}, st, states, account, nil, nil)
	runner.recoverInboundOnce(ctx, dispatcher)
	items, err := st.ClaimPendingOutbox(ctx, lease, 10)
	if err != nil {
		t.Fatalf("claim outbox: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("expected recovered inbound to enqueue one outbox item, got %#v", items)
	}
	if items[0].ExternalConversationID != "chat-recover" || items[0].ACPSessionID != "session-test" {
		t.Fatalf("unexpected recovered outbox item: %#v", items[0])
	}
	_, ok, err := st.ClaimInboundMessage(ctx, lease, "msg-recover", time.Nanosecond)
	if err != nil {
		t.Fatalf("reclaim inbound after done: %v", err)
	}
	if ok {
		t.Fatal("done inbound message should not be reclaimable")
	}
}

type fakeRuntimeAdapter struct {
	accountID string
	started   chan<- string
	once      sync.Once
}

func (a *fakeRuntimeAdapter) Start(ctx context.Context, _ channel.InboundHandler) error {
	a.once.Do(func() {
		if a.started != nil {
			a.started <- a.accountID
		}
	})
	<-ctx.Done()
	return ctx.Err()
}

func (a *fakeRuntimeAdapter) Send(context.Context, channel.Reply) (channel.SendResult, error) {
	return channel.SendResult{}, nil
}

type fakeACPClient struct {
	initialize func(context.Context) error
}

func (c *fakeACPClient) Initialize(ctx context.Context) error {
	if c.initialize != nil {
		return c.initialize(ctx)
	}
	return nil
}
func (c *fakeACPClient) SetWorkspaceLifecycleHandler(acp.WorkspaceLifecycleHandler) {}
func (c *fakeACPClient) Close() error                                               { return nil }
func (c *fakeACPClient) NewSession(context.Context, string, string) (string, error) {
	return "session-test", nil
}
func (c *fakeACPClient) LoadSession(context.Context, string, string) error { return nil }
func (c *fakeACPClient) CloseSession(context.Context, string) error        { return nil }
func (c *fakeACPClient) EnsureRuntimeReady(context.Context, string, string) (acp.RuntimeReadyResult, error) {
	return acp.RuntimeReadyResult{}, nil
}
func (c *fakeACPClient) Prompt(context.Context, string, string) (acp.PromptResult, error) {
	return acp.PromptResult{StopReason: "end_turn", Text: "ok"}, nil
}

func TestACPHeadersForAccountUseAccountScope(t *testing.T) {
	headers := acpHeadersForAccount(config.Config{
		ACPAuthorization: "Bearer token",
		TenantID:         "global-tenant",
		ProjectID:        "global-project",
	}, store.ChannelAccount{TenantID: "tenant-a", ProjectID: "project-a"})
	if headers.Get("Authorization") != "Bearer token" {
		t.Fatalf("missing authorization header: %#v", headers)
	}
	if headers.Get("X-Tenant-ID") != "tenant-a" || headers.Get("X-Project-ID") != "project-a" {
		t.Fatalf("account scope should override global scope: %#v", http.Header(headers))
	}
}

func stateForAccount(t *testing.T, states *channelRuntimeStates, accountID string) channelRuntimeState {
	t.Helper()
	for _, state := range states.Snapshot() {
		if state.AccountID == accountID {
			return state
		}
	}
	t.Fatalf("missing state for account %s", accountID)
	return channelRuntimeState{}
}

func waitStateForAccount(t *testing.T, states *channelRuntimeStates, accountID string, match func(channelRuntimeState) bool) channelRuntimeState {
	t.Helper()
	deadline := time.After(3 * time.Second)
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		for _, state := range states.Snapshot() {
			if state.AccountID == accountID && match(state) {
				return state
			}
		}
		select {
		case <-deadline:
			t.Fatalf("timed out waiting for state account=%s snapshot=%#v", accountID, states.Snapshot())
		case <-ticker.C:
		}
	}
}
