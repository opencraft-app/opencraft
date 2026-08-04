package runtimehost

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"velachat/agent/internal/runtimeactor"
	"velachat/agent/internal/runtimeapi"
	"velachat/agent/internal/vela/host"
	"velachat/agent/internal/vela/im"
	"velachat/agent/internal/vela/platform"
)

func TestAdapterClassifiesGatewayAndRuntimeFailures(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		gateway  *fakeCapabilityGateway
		manager  *fakeManager
		planner  runtimeapi.LaunchPlanner
		wantCode host.FailureCode
		cause    error
	}{
		{
			name: "gateway", cause: errors.New("private gateway"),
			gateway: &fakeCapabilityGateway{registerErr: errors.New("private gateway")},
			manager: &fakeManager{}, planner: runtimeapi.LaunchPlannerFunc(noopPlan),
			wantCode: host.FailureCodeGatewayRegisterFailed,
		},
		{
			name: "planner", cause: errors.New("private planner"),
			gateway: &fakeCapabilityGateway{}, manager: &fakeManager{},
			planner: runtimeapi.LaunchPlannerFunc(func(runtimeapi.LaunchInput) (runtimeapi.LaunchPlan, error) {
				return runtimeapi.LaunchPlan{}, errors.New("private planner")
			}),
			wantCode: host.FailureCodeRuntimePlanFailed,
		},
		{
			name: "start", cause: errors.New("private start"),
			gateway: &fakeCapabilityGateway{}, manager: &fakeManager{startErr: errors.New("private start")},
			planner:  runtimeapi.LaunchPlannerFunc(noopPlan),
			wantCode: host.FailureCodeRuntimeStartFailed,
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			adapter := newTestAdapter(t, test.manager, test.gateway, test.planner)
			_, err := adapter.HandleIngressMessage(context.Background(), incomingMessage(t, "message-"+test.name, "不要泄漏"))
			if err == nil {
				t.Fatal("expected failure")
			}
			failure, ok := host.DescribeFailure(err)
			if !ok || failure.Code != test.wantCode || failure.Scope != host.FailureScopeMessage || !failure.Retryable {
				t.Fatalf("failure = %#v, %v", failure, ok)
			}
			if strings.Contains(err.Error(), "private") || strings.Contains(err.Error(), "不要泄漏") {
				t.Fatalf("unsafe error = %q", err.Error())
			}
		})
	}
}

func TestAdapterRejectsSessionIdentityOrRuntimeChange(t *testing.T) {
	t.Parallel()

	adapter := newTestAdapter(t, &fakeManager{}, nil, runtimeapi.LaunchPlannerFunc(noopPlan))
	changed := platform.RuntimeSession{Agent: platform.AgentIdentity{
		ID: "agent_1", ServerID: "server_1", UserID: "im_agent_1",
		ReplyPolicy: "mention_and_dm", RuntimeKind: "hermes",
	}}
	if err := adapter.UpdateSession(changed); !errors.Is(err, ErrSessionChanged) {
		t.Fatalf("UpdateSession changed runtime = %v", err)
	}
}

func TestShouldDispatchRoutesOnlyExplicitTargets(t *testing.T) {
	t.Parallel()

	agent := platform.AgentIdentity{UserID: "agent-im", ReplyPolicy: "mention_and_dm"}
	dm := incomingMessage(t, "dm", "hello")
	plainGroup := incomingGroupMessage(t, "plain", "hello", nil)
	mentioned := incomingGroupMessage(t, "mention", "hello", []string{"agent-im"})
	broadcast := incomingGroupMessage(t, "broadcast", "hello", []string{"@all"})
	if !shouldDispatch(agent, dm) || shouldDispatch(agent, plainGroup) ||
		!shouldDispatch(agent, mentioned) || shouldDispatch(agent, broadcast) {
		t.Fatal("reply policy routing mismatch")
	}
	mentioned.SenderUserID = agent.UserID
	if shouldDispatch(agent, mentioned) {
		t.Fatal("Agent consumed its own message")
	}
}

func newTestAdapter(
	t *testing.T,
	manager *fakeManager,
	gateway *fakeCapabilityGateway,
	planner runtimeapi.LaunchPlanner,
) *Adapter {
	t.Helper()
	config := Config{
		AgentID: "agent_1", StateDirectory: t.TempDir(),
		WorkingDirectory: filepath.Join(t.TempDir(), "workspace"),
		Actor:            manager,
		Runtimes: fakeResolver{runtime: runtimeapi.ResolvedRuntime{
			ID: "codex", InternalID: "codex", LaunchPlanner: planner,
		}},
		NewRuntimeEpoch: func() (string, error) { return "runtime-epoch-1", nil },
	}
	if gateway != nil {
		config.Gateway = gateway
	}
	adapter, err := New(config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = adapter.Close(context.Background()) })
	if err := adapter.UpdateSession(platform.RuntimeSession{Agent: platform.AgentIdentity{
		ID: "agent_1", ServerID: "server_1", UserID: "im_agent_1",
		ReplyPolicy: "mention_and_dm", RuntimeKind: "codex",
	}}); err != nil {
		t.Fatal(err)
	}
	return adapter
}

type fakeResolver struct{ runtime runtimeapi.ResolvedRuntime }

func (f fakeResolver) ResolveInternalRuntime(id string) (runtimeapi.ResolvedRuntime, bool) {
	return f.runtime, id == f.runtime.InternalID
}

type fakeManager struct {
	mu           sync.Mutex
	starts       []runtimeactor.StartCommand
	deliveries   []runtimeapi.Delivery
	stops        int
	events       chan runtimeactor.Event
	acked        int
	startErr     error
	deliverErr   error
	startEntered chan struct{}
	startBlock   <-chan struct{}
}

func (f *fakeManager) Start(_ context.Context, command runtimeactor.StartCommand) error {
	f.mu.Lock()
	f.starts = append(f.starts, command)
	err := f.startErr
	entered := f.startEntered
	block := f.startBlock
	f.mu.Unlock()
	if entered != nil {
		select {
		case entered <- struct{}{}:
		default:
		}
	}
	if block != nil {
		<-block
	}
	return err
}

func (f *fakeManager) Deliver(_ context.Context, _ string, delivery runtimeapi.Delivery) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.deliveries = append(f.deliveries, delivery)
	return f.deliverErr
}

func (f *fakeManager) DeliverDirect(ctx context.Context, launchID string, delivery runtimeapi.Delivery) error {
	return f.Deliver(ctx, launchID, delivery)
}

func (f *fakeManager) Stop(context.Context, string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.stops++
	return nil
}

func (f *fakeManager) Events() <-chan runtimeactor.Event { return f.events }

func (f *fakeManager) AckEvent(uint64) {
	f.mu.Lock()
	f.acked++
	f.mu.Unlock()
}

type fakeCapabilityGateway struct {
	registered           int
	authorizationUpdates int
	registerErr          error
}

func (f *fakeCapabilityGateway) UpdateSession(platform.RuntimeSession) error {
	f.authorizationUpdates++
	return nil
}

func (f *fakeCapabilityGateway) RegisterMessage(message im.IncomingMessage) (string, error) {
	f.registered++
	if f.registerErr != nil {
		return "", f.registerErr
	}
	return conversationKeyFor(message.Ref.Conversation())
}

func (*fakeCapabilityGateway) RuntimeEnvironment() map[string]string {
	return map[string]string{"VELA_AGENT_PROXY_URL": "http://127.0.0.1:12345"}
}

func incomingMessage(t *testing.T, messageID, text string) im.IncomingMessage {
	t.Helper()
	conversation, err := im.NewC2CConversation("human_1")
	if err != nil {
		t.Fatal(err)
	}
	reference, err := im.NewMessageRef(conversation, messageID, 1, time.Now().UnixMilli())
	if err != nil {
		t.Fatal(err)
	}
	return im.IncomingMessage{
		Ref: reference, SenderUserID: "human_1",
		Elements: []im.Element{{Type: im.ElementText, Text: text}},
	}
}

func noopPlan(runtimeapi.LaunchInput) (runtimeapi.LaunchPlan, error) {
	return runtimeapi.LaunchPlan{Prompt: "start"}, nil
}
