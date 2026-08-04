package runtimehost

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"velachat/agent/internal/runtimeapi"
	"velachat/agent/internal/vela/im"
	"velachat/agent/internal/vela/ingress"
	"velachat/agent/internal/vela/platform"
)

func TestAdapterReturnsStrongIngressDispositionWithoutChatJournal(t *testing.T) {
	t.Parallel()

	manager := &fakeManager{}
	adapter, err := New(Config{
		AgentID: "agent_1", StateDirectory: t.TempDir(),
		WorkingDirectory: filepath.Join(t.TempDir(), "workspace"),
		Actor:            manager,
		Runtimes: fakeResolver{runtime: runtimeapi.ResolvedRuntime{
			ID: "codex", InternalID: "codex",
			LaunchPlanner: runtimeapi.LaunchPlannerFunc(noopPlan),
		}},
		NewRuntimeEpoch: func() (string, error) { return "runtime-epoch-1", nil },
	})
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

	ordinary := incomingGroupMessage(t, "group-message", "普通消息", nil)
	result, err := adapter.HandleIngressMessage(context.Background(), ordinary)
	if err != nil || result.Disposition != ingress.Consumed {
		t.Fatalf("ordinary result = (%#v, %v)", result, err)
	}
	result, err = adapter.HandleIngressMessage(context.Background(), incomingMessage(t, "dm-message", "唤醒"))
	if err != nil || result.Disposition != ingress.RuntimeAccepted {
		t.Fatalf("DM result = (%#v, %v)", result, err)
	}
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if len(manager.starts) != 1 || len(manager.deliveries) != 0 {
		t.Fatalf("runtime calls = starts:%d deliveries:%d", len(manager.starts), len(manager.deliveries))
	}
}

func TestAdapterSessionRefreshDoesNotWaitForBlockedRuntimeDelivery(t *testing.T) {
	t.Parallel()
	entered := make(chan struct{}, 1)
	release := make(chan struct{})
	manager := &fakeManager{startEntered: entered, startBlock: release}
	adapter := newTestAdapter(t, manager, nil, runtimeapi.LaunchPlannerFunc(noopPlan))
	deliveryDone := make(chan error, 1)
	go func() {
		_, err := adapter.HandleIngressMessage(
			context.Background(), incomingMessage(t, "message-blocked-refresh", "hello"),
		)
		deliveryDone <- err
	}()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("Runtime delivery did not start")
	}
	refreshDone := make(chan error, 1)
	go func() {
		refreshDone <- adapter.UpdateSession(platform.RuntimeSession{Agent: platform.AgentIdentity{
			ID: "agent_1", ServerID: "server_1", UserID: "im_agent_1",
			ReplyPolicy: "mention_and_dm", RuntimeKind: "codex",
		}})
	}()
	select {
	case err := <-refreshDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(50 * time.Millisecond):
		t.Fatal("session refresh waited for blocked Runtime delivery")
	}
	close(release)
	if err := <-deliveryDone; err != nil {
		t.Fatal(err)
	}
}

func incomingGroupMessage(t *testing.T, messageID, text string, mentions []string) im.IncomingMessage {
	t.Helper()
	conversation, err := im.NewGroupConversation("group_1")
	if err != nil {
		t.Fatal(err)
	}
	reference, err := im.NewMessageRef(conversation, messageID, 1, 1785715200000)
	if err != nil {
		t.Fatal(err)
	}
	elements := []im.Element{{Type: im.ElementText, Text: text}}
	if len(mentions) > 0 {
		elements = append(elements, im.Element{Type: im.ElementMention, UserIDs: mentions})
	}
	return im.IncomingMessage{Ref: reference, SenderUserID: "human_1", Elements: elements}
}
