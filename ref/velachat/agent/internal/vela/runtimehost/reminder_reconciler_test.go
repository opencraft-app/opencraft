package runtimehost

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"velachat/agent/internal/runtimeactor"
	"velachat/agent/internal/runtimeapi"
	"velachat/agent/internal/vela/im"
	"velachat/agent/internal/vela/ingress"
	"velachat/agent/internal/vela/platform"
	velastate "velachat/agent/internal/vela/state"
)

const (
	reminderAgentID      = "01900000-0000-7000-8000-000000000002"
	reminderServerID     = "01900000-0000-7000-8000-000000000001"
	reminderOccurrenceID = "01900000-0000-7000-8000-000000000011"
	reminderID           = "01900000-0000-7000-8000-000000000012"
)

func TestAdapterReconcilesReminderThroughRuntimeAcceptanceAndAck(t *testing.T) {
	t.Parallel()

	manager := &fakeManager{events: make(chan runtimeactor.Event, 2)}
	occurrences, err := velastate.OpenOccurrenceStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	planned := make(chan runtimeapi.LaunchInput, 1)
	client := &fakeReminderClient{values: []platform.ReminderOccurrence{{
		ID:              reminderOccurrenceID,
		ServerID:        reminderServerID,
		ReminderID:      reminderID,
		AgentID:         reminderAgentID,
		ScheduledFireAt: time.Now().Add(-time.Minute).UTC(),
		State:           platform.ReminderOccurrenceDue,
		Text:            "检查构建状态",
	}}}
	adapter, err := New(Config{
		AgentID:          reminderAgentID,
		StateDirectory:   t.TempDir(),
		WorkingDirectory: t.TempDir(),
		Actor:            manager,
		Runtimes: fakeResolver{runtime: runtimeapi.ResolvedRuntime{
			ID:         "codex",
			InternalID: "codex",
			LaunchPlanner: runtimeapi.LaunchPlannerFunc(func(input runtimeapi.LaunchInput) (
				runtimeapi.LaunchPlan, error,
			) {
				planned <- input
				return runtimeapi.LaunchPlan{Prompt: string(input.WakeMessage)}, nil
			}),
		}},
		Occurrences:      occurrences,
		ReminderClient:   client,
		ReminderInterval: time.Hour,
		NewRuntimeEpoch: func() (string, error) {
			return "runtime-epoch-reminder", nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = adapter.Close(context.Background()) })
	if err := adapter.UpdateSession(platform.RuntimeSession{
		Agent: platform.AgentIdentity{
			ID:          reminderAgentID,
			ServerID:    reminderServerID,
			UserID:      "im_agent_reminder",
			ReplyPolicy: "dm_only",
			RuntimeKind: "codex",
		},
	}); err != nil {
		t.Fatal(err)
	}

	select {
	case input := <-planned:
		if !input.WakeMessageTransient {
			t.Fatal("Reminder wake was modeled as durable chat inbox content")
		}
	case <-time.After(time.Second):
		t.Fatal("Reminder launch planning was not observed")
	}
	deadline := time.Now().Add(time.Second)
	for {
		manager.mu.Lock()
		started := len(manager.starts) == 1
		containsOccurrence := started &&
			strings.Contains(manager.starts[0].Prompt, reminderOccurrenceID)
		manager.mu.Unlock()
		if started && containsOccurrence {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("reminder Runtime start was not observed")
		}
		time.Sleep(time.Millisecond)
	}

	deadline = time.Now().Add(time.Second)
	for {
		if _, ok := occurrences.Get(reminderOccurrenceID); !ok {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("acknowledged reminder occurrence was not removed")
		}
		time.Sleep(time.Millisecond)
	}
	client.mu.Lock()
	defer client.mu.Unlock()
	if client.acks != 1 || client.lastAckID != reminderOccurrenceID {
		t.Fatalf("acks=%d last=%q", client.acks, client.lastAckID)
	}
}

func TestAdapterTreatsReminderCustomElementOnlyAsWakeHint(t *testing.T) {
	t.Parallel()

	manager := &fakeManager{}
	adapter, err := New(Config{
		AgentID:          reminderAgentID,
		StateDirectory:   t.TempDir(),
		WorkingDirectory: t.TempDir(),
		Actor:            manager,
		Runtimes: fakeResolver{runtime: runtimeapi.ResolvedRuntime{
			ID:            "codex",
			InternalID:    "codex",
			LaunchPlanner: runtimeapi.LaunchPlannerFunc(noopPlan),
		}},
		NewRuntimeEpoch: func() (string, error) {
			return "runtime-epoch-reminder-hint", nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = adapter.Close(context.Background()) })
	if err := adapter.UpdateSession(platform.RuntimeSession{Agent: platform.AgentIdentity{
		ID: reminderAgentID, ServerID: reminderServerID, UserID: "im_agent_reminder",
		ReplyPolicy: "dm_only", RuntimeKind: "codex",
	}}); err != nil {
		t.Fatal(err)
	}
	message := incomingMessage(t, "reminder-wake-hint", "")
	message.SenderUserID = "administrator"
	message.Elements = []im.Element{{
		Type:       im.ElementCustom,
		CustomType: ReminderWakeCustomType,
	}}
	result, err := adapter.HandleIngressMessage(context.Background(), message)
	if err != nil || result.Disposition != ingress.Consumed {
		t.Fatalf("HandleIngressMessage() = %#v, %v", result, err)
	}

	manager.mu.Lock()
	starts := len(manager.starts)
	deliveries := len(manager.deliveries)
	manager.mu.Unlock()
	if starts != 0 || deliveries != 0 {
		t.Fatalf(
			"wake hint entered message runtime: starts=%d deliveries=%d",
			starts,
			deliveries,
		)
	}
}

func TestAdapterReminderWakeIsSingleFlightAndAckFailureIsDurable(t *testing.T) {
	t.Parallel()

	manager := &fakeManager{events: make(chan runtimeactor.Event, 1)}
	occurrences, err := velastate.OpenOccurrenceStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	reference, _, err := occurrences.Observe(velastate.OccurrenceInput{
		AgentID:      reminderAgentID,
		OccurrenceID: reminderOccurrenceID,
		ReminderID:   reminderID,
		ScheduledAt:  now.Add(-time.Minute),
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := occurrences.Start(reference.OccurrenceID, "runtime-epoch-old", now); err != nil {
		t.Fatal(err)
	}
	if _, err := occurrences.Complete(reference.OccurrenceID, "runtime-epoch-old"); err != nil {
		t.Fatal(err)
	}
	client := &fakeReminderClient{
		ackErrors:   []error{errors.New("temporary ack failure")},
		blockList:   make(chan struct{}),
		listEntered: make(chan struct{}, 1),
	}
	adapter, err := New(Config{
		AgentID:          reminderAgentID,
		StateDirectory:   t.TempDir(),
		WorkingDirectory: t.TempDir(),
		Actor:            manager,
		Runtimes: fakeResolver{runtime: runtimeapi.ResolvedRuntime{
			ID:            "codex",
			InternalID:    "codex",
			LaunchPlanner: runtimeapi.LaunchPlannerFunc(noopPlan),
		}},
		Occurrences:      occurrences,
		ReminderClient:   client,
		ReminderInterval: time.Hour,
		NewRuntimeEpoch: func() (string, error) {
			return "runtime-epoch-new", nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = adapter.Close(context.Background()) })
	if err := adapter.UpdateSession(platform.RuntimeSession{Agent: platform.AgentIdentity{
		ID: reminderAgentID, ServerID: reminderServerID, UserID: "im_agent_reminder",
		ReplyPolicy: "dm_only", RuntimeKind: "codex",
	}}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-client.listEntered:
	case <-time.After(time.Second):
		t.Fatal("reminder sweep did not enter list")
	}
	for index := range 2 {
		message := incomingMessage(t, fmt.Sprintf("reminder-hint-%d", index), "")
		message.Elements = []im.Element{{Type: im.ElementCustom, CustomType: ReminderWakeCustomType}}
		result, err := adapter.HandleIngressMessage(context.Background(), message)
		if err != nil || result.Disposition != ingress.Consumed {
			t.Fatalf("reminder hint result = %#v, %v", result, err)
		}
	}
	close(client.blockList)
	deadline := time.Now().Add(time.Second)
	for {
		if _, ok := occurrences.Get(reminderOccurrenceID); !ok {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("reminder occurrence did not converge after ACK retry")
		}
		time.Sleep(time.Millisecond)
	}
	client.mu.Lock()
	defer client.mu.Unlock()
	if client.maxConcurrentLists > 1 || client.acks != 2 {
		t.Fatalf("max concurrent lists=%d acks=%d", client.maxConcurrentLists, client.acks)
	}
}

type fakeReminderClient struct {
	mu                 sync.Mutex
	values             []platform.ReminderOccurrence
	acks               int
	lastAckID          string
	ackErrors          []error
	blockList          chan struct{}
	listEntered        chan struct{}
	concurrentLists    int
	maxConcurrentLists int
}

func (f *fakeReminderClient) ListAllReminderOccurrences(
	ctx context.Context,
	_ platform.AccessToken,
) ([]platform.ReminderOccurrence, error) {
	f.mu.Lock()
	f.concurrentLists++
	if f.concurrentLists > f.maxConcurrentLists {
		f.maxConcurrentLists = f.concurrentLists
	}
	values := append([]platform.ReminderOccurrence(nil), f.values...)
	block := f.blockList
	entered := f.listEntered
	f.mu.Unlock()
	if entered != nil {
		select {
		case entered <- struct{}{}:
		default:
		}
	}
	if block != nil {
		select {
		case <-block:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	f.mu.Lock()
	f.concurrentLists--
	f.mu.Unlock()
	return values, nil
}

func (f *fakeReminderClient) AcknowledgeReminderOccurrence(
	_ context.Context,
	_ platform.AccessToken,
	occurrenceID string,
) (platform.ReminderOccurrence, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.acks++
	f.lastAckID = occurrenceID
	if len(f.ackErrors) > 0 {
		err := f.ackErrors[0]
		f.ackErrors = f.ackErrors[1:]
		return platform.ReminderOccurrence{}, err
	}
	for index, occurrence := range f.values {
		if occurrence.ID != occurrenceID {
			continue
		}
		f.values = append(f.values[:index], f.values[index+1:]...)
		break
	}
	return platform.ReminderOccurrence{
		ID: occurrenceID, State: platform.ReminderOccurrenceAcknowledged,
		ResultCode: "completed",
	}, nil
}
