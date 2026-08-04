package ingress

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"velachat/agent/internal/vela/im"
	velastate "velachat/agent/internal/vela/state"
)

func TestCoordinatorDoesNotLetOneConversationBlockAnother(t *testing.T) {
	t.Parallel()

	blocked := make(chan struct{})
	processed := make(chan string, 2)
	handler := HandlerFunc(func(_ context.Context, message im.IncomingMessage) (MessageResult, error) {
		if message.Ref.Conversation().PeerUserID() == "human-blocked" {
			<-blocked
		}
		processed <- message.Ref.MessageID()
		return MessageResult{Disposition: RuntimeAccepted}, nil
	})
	coordinator, cursors := newTestCoordinator(t, handler, Config{MaxConcurrent: 2, QueueSize: 2, DeliveryTimeout: time.Second})

	start := time.Now()
	if got := coordinator.Submit(message(t, c2c(t, "human-blocked"), "blocked-1", 0, 1)); got != SubmitAccepted {
		t.Fatalf("first Submit = %v", got)
	}
	if got := coordinator.Submit(message(t, c2c(t, "human-free"), "free-1", 0, 2)); got != SubmitAccepted {
		t.Fatalf("second Submit = %v", got)
	}
	if time.Since(start) > 50*time.Millisecond {
		t.Fatal("Submit blocked the IM control loop")
	}
	select {
	case got := <-processed:
		if got != "free-1" {
			t.Fatalf("first processed = %q", got)
		}
	case <-time.After(time.Second):
		t.Fatal("independent conversation did not progress")
	}
	freeConversation := c2c(t, "human-free")
	deadline := time.Now().Add(time.Second)
	for {
		if _, ok := cursors.Get(freeConversation); ok {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("independent conversation cursor was not advanced")
		}
		time.Sleep(time.Millisecond)
	}
	close(blocked)
}

func TestCoordinatorKeepsConversationFIFOAndStopsAtHandlerFailure(t *testing.T) {
	t.Parallel()

	firstStarted := make(chan struct{})
	releaseFirst := make(chan struct{})
	var callsMu sync.Mutex
	var calls []string
	handler := HandlerFunc(func(_ context.Context, message im.IncomingMessage) (MessageResult, error) {
		callsMu.Lock()
		calls = append(calls, message.Ref.MessageID())
		callsMu.Unlock()
		if message.Ref.MessageID() == "message-1" {
			close(firstStarted)
			<-releaseFirst
			return MessageResult{}, errors.New("runtime failed")
		}
		return MessageResult{Disposition: RuntimeAccepted}, nil
	})
	coordinator, cursors := newTestCoordinator(t, handler, Config{MaxConcurrent: 2, QueueSize: 4, DeliveryTimeout: time.Second})
	conversation := group(t, "group-a")
	coordinator.Submit(message(t, conversation, "message-1", 1, 1))
	<-firstStarted
	coordinator.Submit(message(t, conversation, "message-2", 2, 2))
	close(releaseFirst)
	waitGap(t, cursors, conversation)
	time.Sleep(30 * time.Millisecond)
	callsMu.Lock()
	defer callsMu.Unlock()
	if len(calls) != 1 || calls[0] != "message-1" {
		t.Fatalf("handler calls = %#v", calls)
	}
	if _, ok := cursors.Get(conversation); ok {
		t.Fatal("failed message advanced cursor")
	}
	gap, ok := cursors.Gap(conversation)
	if !ok || gap.FirstUnconsumed == nil || gap.FirstUnconsumed.MessageID != "message-1" {
		t.Fatalf("failure boundary = %#v, %v", gap.FirstUnconsumed, ok)
	}
}

func TestCoordinatorQueueOverflowCreatesGapBeforeQueuedSuccessor(t *testing.T) {
	t.Parallel()

	started := make(chan struct{})
	release := make(chan struct{})
	var calls atomic.Int32
	handler := HandlerFunc(func(_ context.Context, _ im.IncomingMessage) (MessageResult, error) {
		if calls.Add(1) == 1 {
			close(started)
			<-release
		}
		return MessageResult{Disposition: RuntimeAccepted}, nil
	})
	coordinator, cursors := newTestCoordinator(t, handler, Config{MaxConcurrent: 1, QueueSize: 1, DeliveryTimeout: time.Second})
	conversation := group(t, "group-overflow")
	coordinator.Submit(message(t, conversation, "message-1", 1, 1))
	<-started
	coordinator.Submit(message(t, conversation, "message-2", 2, 2))
	if got := coordinator.Submit(message(t, conversation, "message-3", 3, 3)); got != SubmitNeedsResync {
		t.Fatalf("overflow Submit = %v", got)
	}
	close(release)
	waitGap(t, cursors, conversation)
	time.Sleep(30 * time.Millisecond)
	if calls.Load() != 1 {
		t.Fatalf("handler calls after overflow = %d", calls.Load())
	}
	cursor, ok := cursors.Get(conversation)
	if !ok || cursor.MessageID != "message-1" {
		t.Fatalf("cursor after overflow = %#v, %v", cursor, ok)
	}
}

func TestCoordinatorTimeoutFencesLateSuccessAndDoesNotSpawnAgain(t *testing.T) {
	t.Parallel()

	release := make(chan struct{})
	var calls atomic.Int32
	handler := HandlerFunc(func(_ context.Context, _ im.IncomingMessage) (MessageResult, error) {
		calls.Add(1)
		<-release // deliberately ignores context
		return MessageResult{Disposition: RuntimeAccepted}, nil
	})
	coordinator, cursors := newTestCoordinator(t, handler, Config{MaxConcurrent: 1, QueueSize: 1, DeliveryTimeout: 20 * time.Millisecond})
	conversation := c2c(t, "human-timeout")
	coordinator.Submit(message(t, conversation, "message-1", 0, 1))
	waitGap(t, cursors, conversation)
	if got := coordinator.Submit(message(t, conversation, "message-2", 0, 2)); got != SubmitNeedsResync {
		t.Fatalf("Submit after timeout = %v", got)
	}
	time.Sleep(30 * time.Millisecond)
	if calls.Load() != 1 {
		t.Fatalf("ignored-context handler calls = %d", calls.Load())
	}
	close(release)
	time.Sleep(30 * time.Millisecond)
	if _, ok := cursors.Get(conversation); ok {
		t.Fatal("late accepted result advanced cursor")
	}
}

func TestCoordinatorRecoveryCrossesPersistedGapAndResumesRealtimeLane(t *testing.T) {
	t.Parallel()
	handler := HandlerFunc(func(_ context.Context, _ im.IncomingMessage) (MessageResult, error) {
		return MessageResult{Disposition: RuntimeAccepted}, nil
	})
	coordinator, cursors := newTestCoordinator(t, handler, Config{
		MaxConcurrent: 1, QueueSize: 2, DeliveryTimeout: time.Second,
	})
	conversation := group(t, "group-recover")
	first := velastate.NewMessageCursor(
		message(t, conversation, "message-1", 1, 1).Ref,
		time.Now().UTC(),
	)
	if err := cursors.Advance(nil, first); err != nil {
		t.Fatal(err)
	}
	if _, err := cursors.MarkGap(conversation, &first, nil, velastate.GapDiagnostic{
		Code: velastate.GapRuntimeFailed, DetectedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatal(err)
	}
	if err := coordinator.Recover(
		context.Background(),
		message(t, conversation, "message-2", 2, 2),
	); err != nil {
		t.Fatal(err)
	}
	if _, ok := cursors.Gap(conversation); ok {
		t.Fatal("recovery did not clear persisted gap")
	}
	if got := coordinator.Submit(message(t, conversation, "message-3", 3, 3)); got != SubmitAccepted {
		t.Fatalf("realtime Submit after recovery = %v", got)
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if cursor, ok := cursors.Get(conversation); ok && cursor.MessageID == "message-3" {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("realtime lane did not resume after recovery")
}

func TestCoordinatorReportsLeafHandlerFailureWithoutStoppingOtherConversation(t *testing.T) {
	t.Parallel()
	reports := make(chan Failure, 1)
	handlerErr := errors.New("runtime leaf failure")
	handler := HandlerFunc(func(_ context.Context, message im.IncomingMessage) (MessageResult, error) {
		if message.Ref.Conversation().PeerUserID() == "human-failed" {
			return MessageResult{}, handlerErr
		}
		return MessageResult{Disposition: RuntimeAccepted}, nil
	})
	coordinator, _ := newTestCoordinator(t, handler, Config{
		MaxConcurrent: 2, QueueSize: 2, DeliveryTimeout: time.Second,
		ReportFailure: func(failure Failure) { reports <- failure },
	})
	coordinator.Submit(message(t, c2c(t, "human-failed"), "failed", 0, 1))
	coordinator.Submit(message(t, c2c(t, "human-free"), "free", 0, 1))
	select {
	case failure := <-reports:
		if !errors.Is(failure.Err, handlerErr) || failure.Message.Ref.MessageID() != "failed" ||
			failure.Code != velastate.GapRuntimeFailed {
			t.Fatalf("failure = %#v", failure)
		}
	case <-time.After(time.Second):
		t.Fatal("leaf handler failure was not reported")
	}
}

func TestCoordinatorDiscoveryQueuesRealtimeBehindRecoveredHistory(t *testing.T) {
	t.Parallel()
	calls := make(chan string, 2)
	handler := HandlerFunc(func(_ context.Context, message im.IncomingMessage) (MessageResult, error) {
		calls <- message.Ref.MessageID()
		return MessageResult{Disposition: RuntimeAccepted}, nil
	})
	coordinator, _ := newTestCoordinator(t, handler, Config{
		MaxConcurrent: 1, QueueSize: 4, DeliveryTimeout: time.Second,
	})
	if err := coordinator.BeginDiscovery(); err != nil {
		t.Fatal(err)
	}
	conversation := group(t, "group-discovery")
	if got := coordinator.Submit(message(t, conversation, "live-2", 2, 2)); got != SubmitAccepted {
		t.Fatalf("Submit during discovery = %v", got)
	}
	select {
	case got := <-calls:
		t.Fatalf("realtime message ran before history: %s", got)
	case <-time.After(20 * time.Millisecond):
	}
	if err := coordinator.Recover(context.Background(), message(t, conversation, "history-1", 1, 1)); err != nil {
		t.Fatal(err)
	}
	if err := coordinator.EndDiscovery(); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"history-1", "live-2"} {
		select {
		case got := <-calls:
			if got != want {
				t.Fatalf("call = %q, want %q", got, want)
			}
		case <-time.After(time.Second):
			t.Fatalf("missing call %s", want)
		}
	}
}

func newTestCoordinator(t *testing.T, handler Handler, overrides Config) (*Coordinator, *velastate.FileCursorStore) {
	t.Helper()
	cursors, err := velastate.OpenFileCursorStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	overrides.Handler = handler
	overrides.Cursors = cursors
	coordinator, err := New(overrides)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = coordinator.Close(ctx)
	})
	return coordinator, cursors
}

func waitGap(t *testing.T, cursors *velastate.FileCursorStore, conversation im.Conversation) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if _, ok := cursors.Gap(conversation); ok {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("conversation gap was not persisted")
}

func message(t *testing.T, conversation im.Conversation, id string, sequence, second int64) im.IncomingMessage {
	t.Helper()
	ref, err := im.NewMessageRef(conversation, id, sequence, time.Date(2026, 8, 3, 0, 0, int(second), 0, time.UTC).UnixMilli())
	if err != nil {
		t.Fatal(err)
	}
	return im.IncomingMessage{Ref: ref, SenderUserID: "human"}
}

func c2c(t *testing.T, userID string) im.Conversation {
	t.Helper()
	conversation, err := im.NewC2CConversation(userID)
	if err != nil {
		t.Fatal(err)
	}
	return conversation
}

func group(t *testing.T, groupID string) im.Conversation {
	t.Helper()
	conversation, err := im.NewGroupConversation(groupID)
	if err != nil {
		t.Fatal(err)
	}
	return conversation
}
