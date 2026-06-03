package main

import (
	"context"
	"net/http"
	"sync"
	"testing"
	"time"

	"cloudagent/channelgateway/internal/acp"
	"cloudagent/channelgateway/internal/channel"
	"cloudagent/channelgateway/internal/channel/wecom"
	"cloudagent/channelgateway/internal/config"
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

func TestWeComSupervisorSkipsAccountWhenLeaseHeld(t *testing.T) {
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
	if _, err := st.AcquireChannelLease(ctx, "wecom-a", "owner-existing", time.Minute); err != nil {
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
		t.Fatal("expected skipped runner to be recorded until next reconcile")
	}
	select {
	case <-runner.done:
	case <-time.After(3 * time.Second):
		t.Fatal("lease-held runner did not exit")
	}
	select {
	case accountID := <-started:
		t.Fatalf("adapter should not start for held lease, got %s", accountID)
	default:
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

type fakeACPClient struct{}

func (c *fakeACPClient) Initialize(context.Context) error { return nil }
func (c *fakeACPClient) Close() error                     { return nil }
func (c *fakeACPClient) NewSession(context.Context, string) (string, error) {
	return "session-test", nil
}
func (c *fakeACPClient) LoadSession(context.Context, string, string) error { return nil }
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
