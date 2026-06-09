package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"cloudagent/channelgateway/internal/acp"
	"cloudagent/channelgateway/internal/channel"
	"cloudagent/channelgateway/internal/channel/wecom"
	"cloudagent/channelgateway/internal/config"
	"cloudagent/channelgateway/internal/store"
)

type rolloutAdapterStart struct {
	OwnerID   string
	AccountID string
}

func TestRolloutE2EStandbyPodReadyAndTakesOverAfterOldDrain(t *testing.T) {
	ctx := context.Background()
	path := t.TempDir() + "/channelgateway.db"
	oldStore := openRolloutStore(t, ctx, path)
	defer oldStore.Close()
	newStore := openRolloutStore(t, ctx, path)
	defer newStore.Close()

	accountCfg := config.WeComConfig{Enabled: true, AccountID: "wecom-a", BotID: "bot-a", Secret: "secret-a", AgentID: "agent-a"}
	oldCfg := config.Config{OwnerID: "owner-old", LeaseTTL: time.Minute, WeComAccounts: []config.WeComConfig{accountCfg}}
	if err := seedWeComAccounts(ctx, oldStore, oldCfg); err != nil {
		t.Fatalf("seed accounts: %v", err)
	}

	started := make(chan rolloutAdapterStart, 4)
	oldStates := newChannelRuntimeStates()
	oldSupervisor := newRolloutSupervisor(oldCfg, oldStore, oldStates, "owner-old", started)
	if err := oldSupervisor.reconcile(ctx); err != nil {
		t.Fatalf("old reconcile: %v", err)
	}
	expectAdapterStart(t, started, rolloutAdapterStart{OwnerID: "owner-old", AccountID: "wecom-a"})
	assertReadyz(t, oldCfg, oldStates, newRuntimeLifecycle(), http.StatusOK)

	newCfg := config.Config{OwnerID: "owner-new", LeaseTTL: time.Minute, WeComAccounts: []config.WeComConfig{accountCfg}}
	newStates := newChannelRuntimeStates()
	newSupervisor := newRolloutSupervisor(newCfg, newStore, newStates, "owner-new", started)
	if err := newSupervisor.reconcile(ctx); err != nil {
		t.Fatalf("new reconcile: %v", err)
	}
	waitStateForAccount(t, newStates, "wecom-a", func(state channelRuntimeState) bool {
		return state.Status == "standby_lease_held"
	})
	assertReadyz(t, newCfg, newStates, newRuntimeLifecycle(), http.StatusOK)
	assertNoAdapterStart(t, started, 200*time.Millisecond)

	oldLifecycle := newRuntimeLifecycle()
	oldDrainDone := make(chan struct{})
	drain := drainHandler(oldLifecycle, func(string) {
		oldSupervisor.stopAll()
		close(oldDrainDone)
	})
	req := httptest.NewRequest(http.MethodPost, "/drainz", nil)
	req.RemoteAddr = "127.0.0.1:1234"
	rec := httptest.NewRecorder()
	drain.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("old drain code=%d body=%s", rec.Code, rec.Body.String())
	}
	waitClosedRollout(t, oldDrainDone, "old drain")
	assertReadyz(t, oldCfg, oldStates, oldLifecycle, http.StatusServiceUnavailable)

	expectAdapterStart(t, started, rolloutAdapterStart{OwnerID: "owner-new", AccountID: "wecom-a"})
	assertReadyz(t, newCfg, newStates, newRuntimeLifecycle(), http.StatusOK)
	if _, err := oldStore.AcquireChannelLease(ctx, "wecom-a", "owner-third", time.Minute); !isLeaseHeld(err) {
		t.Fatalf("new owner should hold lease after takeover, got %v", err)
	}
	newSupervisor.stopAll()
}

func TestRolloutE2EStandbyPodCanStopWithoutGhostTakeover(t *testing.T) {
	ctx := context.Background()
	path := t.TempDir() + "/channelgateway.db"
	oldStore := openRolloutStore(t, ctx, path)
	defer oldStore.Close()
	newStore := openRolloutStore(t, ctx, path)
	defer newStore.Close()

	accountCfg := config.WeComConfig{Enabled: true, AccountID: "wecom-a", BotID: "bot-a", Secret: "secret-a", AgentID: "agent-a"}
	oldCfg := config.Config{OwnerID: "owner-old", LeaseTTL: time.Minute, WeComAccounts: []config.WeComConfig{accountCfg}}
	if err := seedWeComAccounts(ctx, oldStore, oldCfg); err != nil {
		t.Fatalf("seed accounts: %v", err)
	}
	oldLease, err := oldStore.AcquireChannelLease(ctx, "wecom-a", "owner-old", time.Minute)
	if err != nil {
		t.Fatalf("pre-acquire old lease: %v", err)
	}

	started := make(chan rolloutAdapterStart, 2)
	newCfg := config.Config{OwnerID: "owner-new", LeaseTTL: time.Minute, WeComAccounts: []config.WeComConfig{accountCfg}}
	newStates := newChannelRuntimeStates()
	newSupervisor := newRolloutSupervisor(newCfg, newStore, newStates, "owner-new", started)
	if err := newSupervisor.reconcile(ctx); err != nil {
		t.Fatalf("new reconcile: %v", err)
	}
	waitStateForAccount(t, newStates, "wecom-a", func(state channelRuntimeState) bool {
		return state.Status == "standby_lease_held"
	})
	newSupervisor.stopAll()
	if err := oldStore.ReleaseChannelLease(ctx, oldLease); err != nil {
		t.Fatalf("release old lease: %v", err)
	}
	assertNoAdapterStart(t, started, 1200*time.Millisecond)
	if _, err := oldStore.AcquireChannelLease(ctx, "wecom-a", "owner-third", time.Minute); err != nil {
		t.Fatalf("stopped standby runner must not steal released lease: %v", err)
	}
}

func TestRolloutE2EInFlightInboundRecoveredAfterOldPodDrain(t *testing.T) {
	ctx := context.Background()
	path := t.TempDir() + "/channelgateway.db"
	oldStore := openRolloutStore(t, ctx, path)
	defer oldStore.Close()
	newStore := openRolloutStore(t, ctx, path)
	defer newStore.Close()

	accountCfg := config.WeComConfig{Enabled: true, AccountID: "wecom-a", BotID: "bot-a", Secret: "secret-a", AgentID: "agent-a"}
	oldCfg := config.Config{OwnerID: "owner-old", LeaseTTL: time.Minute, RequestTimeout: 30 * time.Second, WeComAccounts: []config.WeComConfig{accountCfg}}
	if err := seedWeComAccounts(ctx, oldStore, oldCfg); err != nil {
		t.Fatalf("seed accounts: %v", err)
	}

	inbound := channel.Message{
		ChannelAccountID:       "wecom-a",
		ChannelType:            channel.TypeWeCom,
		ExternalMessageID:      "msg-rollout-inflight",
		ExternalConversationID: "chat-rollout-inflight",
		ExternalUserID:         "user-rollout",
		ChatType:               channel.ChatDM,
		Kind:                   channel.MessageText,
		Text:                   "hello during rollout",
	}
	started := make(chan rolloutAdapterStart, 4)
	oldPromptStarted := make(chan struct{})
	var oldPromptStartedOnce sync.Once
	oldHandled := make(chan error, 1)
	oldStates := newChannelRuntimeStates()
	oldSupervisor := newWeComSupervisor(oldCfg, oldStore, oldStates)
	oldSupervisor.acpFactory = func(config.Config, store.ChannelAccount) acpRuntimeClient {
		return &rolloutACPClient{
			sessionID: "session-rollout",
			prompt: func(ctx context.Context, _ string, _ string) (string, error) {
				oldPromptStartedOnce.Do(func() { close(oldPromptStarted) })
				<-ctx.Done()
				return "", ctx.Err()
			},
		}
	}
	oldSupervisor.adapterFactory = func(cfg wecom.Config) channelRuntimeAdapter {
		return &rolloutInboundAdapter{ownerID: "owner-old", accountID: cfg.AccountID, started: started, inbound: inbound, handled: oldHandled}
	}
	if err := oldSupervisor.reconcile(ctx); err != nil {
		t.Fatalf("old reconcile: %v", err)
	}
	expectAdapterStart(t, started, rolloutAdapterStart{OwnerID: "owner-old", AccountID: "wecom-a"})
	waitClosedRollout(t, oldPromptStarted, "old prompt start")

	newCfg := config.Config{OwnerID: "owner-new", LeaseTTL: time.Minute, RequestTimeout: 30 * time.Second, WeComAccounts: []config.WeComConfig{accountCfg}}
	recoveredReply := make(chan channel.Reply, 2)
	newStates := newChannelRuntimeStates()
	newSupervisor := newWeComSupervisor(newCfg, newStore, newStates)
	newSupervisor.acpFactory = func(config.Config, store.ChannelAccount) acpRuntimeClient {
		return &rolloutACPClient{
			sessionID: "session-rollout",
			prompt: func(context.Context, string, string) (string, error) {
				return "recovered after rollout", nil
			},
		}
	}
	newSupervisor.adapterFactory = func(cfg wecom.Config) channelRuntimeAdapter {
		return &rolloutRuntimeAdapter{ownerID: "owner-new", accountID: cfg.AccountID, started: started, sent: recoveredReply}
	}
	if err := newSupervisor.reconcile(ctx); err != nil {
		t.Fatalf("new reconcile: %v", err)
	}
	waitStateForAccount(t, newStates, "wecom-a", func(state channelRuntimeState) bool {
		return state.Status == "standby_lease_held"
	})
	assertNoAdapterStart(t, started, 200*time.Millisecond)

	oldDrainDone := make(chan struct{})
	drain := drainHandler(newRuntimeLifecycle(), func(string) {
		oldSupervisor.stopAll()
		close(oldDrainDone)
	})
	req := httptest.NewRequest(http.MethodPost, "/drainz", nil)
	req.RemoteAddr = "127.0.0.1:1234"
	rec := httptest.NewRecorder()
	drain.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("old drain code=%d body=%s", rec.Code, rec.Body.String())
	}
	waitClosedRollout(t, oldDrainDone, "old drain")
	select {
	case err := <-oldHandled:
		if err == nil {
			t.Fatal("old in-flight handler should be canceled during drain")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("old in-flight handler did not finish after drain")
	}
	expectAdapterStart(t, started, rolloutAdapterStart{OwnerID: "owner-new", AccountID: "wecom-a"})

	var reply channel.Reply
	select {
	case reply = <-recoveredReply:
	case <-time.After(8 * time.Second):
		t.Fatal("new owner did not recover in-flight inbound and send reply")
	}
	if reply.ExternalConversationID != inbound.ExternalConversationID || reply.Text != "recovered after rollout" {
		t.Fatalf("unexpected recovered reply: %#v", reply)
	}
	assertNoReply(t, recoveredReply, 500*time.Millisecond)
	lease := newStates.GetLease("wecom-a")
	items, err := newStore.ClaimPendingOutbox(ctx, lease, 10)
	if err != nil {
		t.Fatalf("claim pending outbox after recovery: %v", err)
	}
	if len(items) != 0 {
		t.Fatalf("recovered reply should have been sent, pending outbox=%#v", items)
	}
	newSupervisor.stopAll()
}

func TestRolloutE2EDrainCommandPostsToLocalEndpoint(t *testing.T) {
	var gotMethod string
	called := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		if r.URL.Path != "/drainz" {
			t.Fatalf("unexpected drain path: %s", r.URL.Path)
		}
		close(called)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
	}))
	defer server.Close()

	if err := runDrainCommand([]string{"--addr", server.URL}); err != nil {
		t.Fatalf("run drain command: %v", err)
	}
	waitClosedRollout(t, called, "drain command")
	if gotMethod != http.MethodPost {
		t.Fatalf("drain command method=%s, want POST", gotMethod)
	}
}

func TestRolloutE2EDrainCommandFailsOnRejectedEndpoint(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte(`{"ok":false}`))
	}))
	defer server.Close()

	if err := runDrainCommand([]string{"--addr", server.URL}); err == nil || !strings.Contains(err.Error(), "503") {
		t.Fatalf("expected drain command to fail on rejected endpoint, got %v", err)
	}
}

func TestRolloutE2EDevcloudDeploymentUsesGracefulHandoffContract(t *testing.T) {
	data, err := os.ReadFile("../../../../argocd/services/channelgateway/devcloud-dep/channelgateway.yaml")
	if err != nil {
		t.Fatalf("read deployment yaml: %v", err)
	}
	text := string(data)
	for _, want := range []string{
		"maxSurge: 1",
		"maxUnavailable: 0",
		"terminationGracePeriodSeconds: 45",
		"path: /readyz",
		"- /usr/local/bin/channelgateway",
		"- drain",
		"- --addr",
		"- http://127.0.0.1:8094",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("deployment yaml should contain %q, got:\n%s", want, text)
		}
	}
}

func newRolloutSupervisor(cfg config.Config, st *store.Store, states *channelRuntimeStates, ownerID string, started chan<- rolloutAdapterStart) *weComSupervisor {
	supervisor := newWeComSupervisor(cfg, st, states)
	supervisor.acpFactory = func(config.Config, store.ChannelAccount) acpRuntimeClient {
		return &fakeACPClient{}
	}
	supervisor.adapterFactory = func(cfg wecom.Config) channelRuntimeAdapter {
		return &rolloutRuntimeAdapter{ownerID: ownerID, accountID: cfg.AccountID, started: started}
	}
	return supervisor
}

type rolloutRuntimeAdapter struct {
	ownerID   string
	accountID string
	started   chan<- rolloutAdapterStart
	sent      chan<- channel.Reply
}

func (a *rolloutRuntimeAdapter) Start(ctx context.Context, _ channel.InboundHandler) error {
	if a.started != nil {
		a.started <- rolloutAdapterStart{OwnerID: a.ownerID, AccountID: a.accountID}
	}
	<-ctx.Done()
	return ctx.Err()
}

func (a *rolloutRuntimeAdapter) Send(_ context.Context, reply channel.Reply) (channel.SendResult, error) {
	if a.sent != nil {
		a.sent <- reply
	}
	return channel.SendResult{}, nil
}

type rolloutInboundAdapter struct {
	ownerID   string
	accountID string
	started   chan<- rolloutAdapterStart
	inbound   channel.Message
	handled   chan<- error
}

func (a *rolloutInboundAdapter) Start(ctx context.Context, handler channel.InboundHandler) error {
	if a.started != nil {
		a.started <- rolloutAdapterStart{OwnerID: a.ownerID, AccountID: a.accountID}
	}
	err := handler.HandleInbound(ctx, a.inbound)
	if a.handled != nil {
		a.handled <- err
	}
	return err
}

func (a *rolloutInboundAdapter) Send(context.Context, channel.Reply) (channel.SendResult, error) {
	return channel.SendResult{}, nil
}

type rolloutACPClient struct {
	sessionID string
	prompt    func(context.Context, string, string) (string, error)
}

func (c *rolloutACPClient) Initialize(context.Context) error                           { return nil }
func (c *rolloutACPClient) SetWorkspaceLifecycleHandler(acp.WorkspaceLifecycleHandler) {}
func (c *rolloutACPClient) Close() error                                               { return nil }
func (c *rolloutACPClient) NewSession(context.Context, string, string) (string, error) {
	if c.sessionID == "" {
		return "session-rollout", nil
	}
	return c.sessionID, nil
}
func (c *rolloutACPClient) LoadSession(context.Context, string, string) error { return nil }
func (c *rolloutACPClient) CloseSession(context.Context, string) error        { return nil }
func (c *rolloutACPClient) EnsureRuntimeReady(context.Context, string, string) (acp.RuntimeReadyResult, error) {
	return acp.RuntimeReadyResult{}, nil
}
func (c *rolloutACPClient) Prompt(ctx context.Context, sessionID, text string) (acp.PromptResult, error) {
	if c.prompt != nil {
		reply, err := c.prompt(ctx, sessionID, text)
		if err != nil {
			return acp.PromptResult{}, err
		}
		return acp.PromptResult{StopReason: "end_turn", Text: reply}, nil
	}
	return acp.PromptResult{StopReason: "end_turn", Text: "ok"}, nil
}

func openRolloutStore(t *testing.T, ctx context.Context, path string) *store.Store {
	t.Helper()
	st, err := store.Open(ctx, path)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	return st
}

func assertReadyz(t *testing.T, cfg config.Config, states *channelRuntimeStates, lifecycle *runtimeLifecycle, want int) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/readyz", nil)
	rec := httptest.NewRecorder()
	readyHandler(cfg, states, lifecycle).ServeHTTP(rec, req)
	if rec.Code != want {
		t.Fatalf("readyz code=%d want=%d body=%s states=%#v", rec.Code, want, rec.Body.String(), states.Snapshot())
	}
}

func expectAdapterStart(t *testing.T, started <-chan rolloutAdapterStart, want rolloutAdapterStart) {
	t.Helper()
	select {
	case got := <-started:
		if got != want {
			t.Fatalf("adapter start=%#v, want %#v", got, want)
		}
	case <-time.After(3 * time.Second):
		t.Fatalf("timed out waiting for adapter start %#v", want)
	}
}

func assertNoAdapterStart(t *testing.T, started <-chan rolloutAdapterStart, window time.Duration) {
	t.Helper()
	select {
	case got := <-started:
		t.Fatalf("unexpected adapter start: %#v", got)
	case <-time.After(window):
	}
}

func assertNoReply(t *testing.T, replies <-chan channel.Reply, window time.Duration) {
	t.Helper()
	select {
	case got := <-replies:
		t.Fatalf("unexpected reply: %#v", got)
	case <-time.After(window):
	}
}

func waitClosedRollout(t *testing.T, ch <-chan struct{}, name string) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(3 * time.Second):
		t.Fatalf("timed out waiting for %s", name)
	}
}
