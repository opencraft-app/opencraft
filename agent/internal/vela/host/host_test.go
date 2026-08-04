package host

import (
	"context"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"velachat/agent/internal/vela/im"
	"velachat/agent/internal/vela/ingress"
	"velachat/agent/internal/vela/platform"
	velastate "velachat/agent/internal/vela/state"
)

func TestHostRenewsIMWithoutClosingRuntime(t *testing.T) {
	t.Parallel()

	sessions := &fakeSessions{
		session: runtimeSession(t),
	}
	first := newFakeTransport()
	second := newFakeTransport()
	transports := &fakeTransportFactory{
		values: []im.Transport{first, second},
	}
	runtime := &fakeRuntime{
		messages: make(chan im.IncomingMessage, 1),
	}
	ready := make(chan struct{}, 1)
	host, err := New(Config{
		Sessions:          sessions,
		Transports:        transports,
		Cursors:           testCursorStore(t),
		Runtime:           runtime,
		NewLaunchID:       launchIDs("im-launch-1", "im-launch-2"),
		RefreshBefore:     time.Minute,
		BackoffBase:       time.Millisecond,
		BackoffMax:        10 * time.Millisecond,
		MaxFailures:       3,
		ShutdownTimeout:   time.Second,
		MaxInFlightEvents: 1,
		ReportReady: func() {
			select {
			case ready <- struct{}{}:
			default:
			}
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- host.Run(ctx) }()

	waitStarted(t, first)
	select {
	case <-ready:
	case <-time.After(time.Second):
		t.Fatal("Host did not report ready after IM start and recovery")
	}
	first.events <- im.Event{
		ID:       "renew-1",
		LaunchID: "im-launch-1",
		Type:     im.EventUserSigExpiring,
	}
	waitStarted(t, second)
	if runtime.closed.Load() != 0 {
		t.Fatal("UserSig 续期不应重启 Runtime")
	}

	conversation, err := im.NewC2CConversation("human_1")
	if err != nil {
		t.Fatal(err)
	}
	reference, err := im.NewMessageRef(
		conversation,
		"message_1",
		1,
		time.Now().UnixMilli(),
	)
	if err != nil {
		t.Fatal(err)
	}
	second.events <- im.Event{
		ID:       "message-event-1",
		LaunchID: "im-launch-2",
		Type:     im.EventMessage,
		Message: &im.IncomingMessage{
			Ref:          reference,
			SenderUserID: "human_1",
			Elements: []im.Element{{
				Type: im.ElementText,
				Text: "你好",
			}},
		},
	}
	select {
	case message := <-runtime.messages:
		if message.Ref.MessageID() != "message_1" {
			t.Fatalf("message = %#v", message)
		}
	case <-time.After(time.Second):
		t.Fatal("Runtime 未收到实时消息")
	}

	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("Host 未在期限内停止")
	}
	if runtime.closed.Load() != 1 {
		t.Fatalf("Runtime Close count = %d", runtime.closed.Load())
	}
	if sessions.calls.Load() < 2 {
		t.Fatalf("session calls = %d", sessions.calls.Load())
	}
	if runtime.sessionUpdates.Load() < 2 {
		t.Fatalf(
			"Runtime session updates = %d",
			runtime.sessionUpdates.Load(),
		)
	}
}

func TestHostRefreshesUserSigWhileRuntimeHandlerIsBlocked(t *testing.T) {
	t.Parallel()
	first := newFakeTransport()
	second := newFakeTransport()
	entered := make(chan struct{})
	release := make(chan struct{})
	runtime := &fakeRuntime{handleMessage: func(
		_ context.Context,
		_ im.IncomingMessage,
	) error {
		close(entered)
		<-release
		return nil
	}}
	host, err := New(Config{
		Sessions:   &fakeSessions{session: runtimeSession(t)},
		Transports: &fakeTransportFactory{values: []im.Transport{first, second}},
		Cursors:    testCursorStore(t), Runtime: runtime,
		NewLaunchID:   launchIDs("im-launch-blocked-1", "im-launch-blocked-2"),
		RefreshBefore: time.Minute, BackoffBase: time.Millisecond,
		BackoffMax: 10 * time.Millisecond, MaxFailures: 3,
		ShutdownTimeout: time.Second, MaxInFlightEvents: 1,
		RecoveryMessageTimeout: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- host.Run(ctx) }()
	waitStarted(t, first)
	message := historyMessage(t, mustC2CConversation(t, "human-blocked"), "blocked", "hello", 1)
	first.events <- im.Event{LaunchID: "im-launch-blocked-1", Type: im.EventMessage, Message: &message}
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("Runtime handler did not start")
	}
	first.events <- im.Event{LaunchID: "im-launch-blocked-1", Type: im.EventUserSigExpiring}
	waitStarted(t, second)
	close(release)
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestHostQueuesRealtimeBehindHistoryDuringDiscovery(t *testing.T) {
	t.Parallel()
	conversation := mustC2CConversation(t, "human-discovery")
	historyMessageValue := historyMessage(t, conversation, "history-1", "old", 1)
	liveMessage := historyMessage(t, conversation, "live-2", "new", 2)
	base := newFakeTransport()
	releaseHistory := make(chan struct{})
	historyEntered := make(chan struct{}, 1)
	transport := &fakeHistoryTransport{
		fakeTransport: base,
		unread:        []im.UnreadConversation{{Conversation: conversation, UnreadCount: 1}},
		pages:         []im.HistoryPage{{Messages: []im.IncomingMessage{historyMessageValue}, Completed: true}},
		marked:        make(chan im.Conversation, 1), historyBlock: releaseHistory,
		historyEntered: historyEntered,
	}
	delivered := make(chan string, 2)
	host, err := New(Config{
		Sessions:   &fakeSessions{session: runtimeSession(t)},
		Transports: &fakeTransportFactory{values: []im.Transport{transport}},
		Cursors:    testCursorStore(t), Runtime: &fakeRuntime{messages: make(chan im.IncomingMessage, 2),
			handleMessage: func(_ context.Context, message im.IncomingMessage) error {
				delivered <- message.Ref.MessageID()
				return nil
			}},
		NewLaunchID: launchIDs("im-launch-discovery"), RefreshBefore: time.Minute,
		BackoffBase: time.Millisecond, BackoffMax: 10 * time.Millisecond,
		MaxFailures: 3, ShutdownTimeout: time.Second, MaxInFlightEvents: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- host.Run(ctx) }()
	waitStarted(t, base)
	select {
	case <-historyEntered:
	case <-time.After(time.Second):
		t.Fatal("history recovery did not start")
	}
	base.events <- im.Event{LaunchID: "im-launch-discovery", Type: im.EventMessage, Message: &liveMessage}
	select {
	case got := <-delivered:
		t.Fatalf("realtime overtook history: %s", got)
	case <-time.After(20 * time.Millisecond):
	}
	close(releaseHistory)
	for _, want := range []string{"history-1", "live-2"} {
		select {
		case got := <-delivered:
			if got != want {
				t.Fatalf("delivered = %q, want %q", got, want)
			}
		case <-time.After(time.Second):
			t.Fatalf("missing delivery %s", want)
		}
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestHostC2CCursorRecoveryUsesTwoPassAnchorsAndSDKOrder(t *testing.T) {
	t.Parallel()
	conversation := mustC2CConversation(t, "human-anchor")
	store := testCursorStore(t)
	boundaryMessage := historyMessage(t, conversation, "cursor", "seen", 1)
	boundary := velastate.NewMessageCursor(boundaryMessage.Ref, time.Now().UTC())
	if err := store.Advance(nil, boundary); err != nil {
		t.Fatal(err)
	}
	newest := historyMessage(t, conversation, "aaa-newest", "newest", 2)
	middle := historyMessage(t, conversation, "zzz-middle", "middle", 2)
	requests := make(chan string, 3)
	transport := &functionalHistoryTransport{history: func(request im.HistoryRequest) (im.HistoryPage, error) {
		requests <- request.Cursor
		switch request.Cursor {
		case "":
			return im.HistoryPage{Messages: []im.IncomingMessage{newest, middle}, NextCursor: "page-2"}, nil
		case "page-2":
			return im.HistoryPage{Messages: []im.IncomingMessage{middle, boundaryMessage}, Completed: true}, nil
		default:
			return im.HistoryPage{}, errors.New("unexpected cursor")
		}
	}}
	delivered := make(chan string, 2)
	runtime := &fakeRuntime{handleMessage: func(_ context.Context, message im.IncomingMessage) error {
		delivered <- message.Ref.MessageID()
		return nil
	}}
	host, err := New(Config{
		Sessions:   &fakeSessions{session: runtimeSession(t)},
		Transports: &fakeTransportFactory{values: []im.Transport{newFakeTransport()}},
		Cursors:    store, Runtime: runtime, NewLaunchID: launchIDs("unused"),
		RefreshBefore: time.Minute, BackoffBase: time.Millisecond,
		BackoffMax: 10 * time.Millisecond, MaxFailures: 1,
		ShutdownTimeout: time.Second, MaxInFlightEvents: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { host.closeCoordinator() })
	count, found, err := host.recoverC2CFromCursor(
		context.Background(), transport, boundary,
	)
	if err != nil || !found || count != 2 {
		t.Fatalf("recoverC2CFromCursor() = %d, %v, %v", count, found, err)
	}
	for _, want := range []string{"zzz-middle", "aaa-newest"} {
		select {
		case got := <-delivered:
			if got != want {
				t.Fatalf("delivery = %q, want %q", got, want)
			}
		case <-time.After(time.Second):
			t.Fatalf("missing delivery %s", want)
		}
	}
	for _, want := range []string{"", "page-2", "page-2"} {
		if got := <-requests; got != want {
			t.Fatalf("history cursor = %q, want %q", got, want)
		}
	}
}

func TestHostRecoversPersistedFirstMessageGapWithoutUnreadSnapshot(t *testing.T) {
	t.Parallel()

	conversation := mustC2CConversation(t, "human-gap-anchor")
	failed := historyMessage(t, conversation, "failed-first", "retry me", 1)
	store := testCursorStore(t)
	failedCursor := velastate.NewMessageCursor(failed.Ref, time.Now().UTC())
	if _, err := store.MarkGap(conversation, nil, &failedCursor, velastate.GapDiagnostic{
		Code: velastate.GapRuntimeFailed, DetectedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatal(err)
	}
	transport := &fakeHistoryTransport{
		fakeTransport: newFakeTransport(),
		pages:         []im.HistoryPage{{Messages: []im.IncomingMessage{failed}, Completed: true}},
		marked:        make(chan im.Conversation, 1),
	}
	delivered := make(chan string, 1)
	host, err := New(Config{
		Sessions:   &fakeSessions{session: runtimeSession(t)},
		Transports: &fakeTransportFactory{values: []im.Transport{transport}},
		Cursors:    store,
		Runtime: &fakeRuntime{handleMessage: func(_ context.Context, message im.IncomingMessage) error {
			delivered <- message.Ref.MessageID()
			return nil
		}},
		NewLaunchID: launchIDs("unused"), RefreshBefore: time.Minute,
		BackoffBase: time.Millisecond, BackoffMax: 10 * time.Millisecond,
		MaxFailures: 1, ShutdownTimeout: time.Second, MaxInFlightEvents: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { host.closeCoordinator() })
	if err := host.recoverUnread(context.Background(), transport, runtimeSession(t)); err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-delivered:
		if got != failed.Ref.MessageID() {
			t.Fatalf("delivered = %q", got)
		}
	default:
		t.Fatal("persisted first-message gap was not recovered")
	}
	if _, ok := store.Gap(conversation); ok {
		t.Fatal("successful anchored recovery retained gap")
	}
	cursor, ok := store.Get(conversation)
	if !ok || cursor.MessageID != failed.Ref.MessageID() {
		t.Fatalf("cursor = %#v, %v", cursor, ok)
	}
}

func TestHostRecoversPersistedFirstMessageGapForGroupAndTopic(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name         string
		conversation im.Conversation
	}{
		{name: "group", conversation: mustGroupConversation(t, "group-gap-anchor")},
		{name: "topic", conversation: mustTopicConversation(t, "group-gap-anchor", "topic-gap-anchor")},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			failed := historyMessage(t, test.conversation, test.name+"-failed", "retry", 10)
			newer := historyMessage(t, test.conversation, test.name+"-newer", "newer", 11)
			store := testCursorStore(t)
			failedCursor := velastate.NewMessageCursor(failed.Ref, time.Now().UTC())
			if _, err := store.MarkGap(test.conversation, nil, &failedCursor, velastate.GapDiagnostic{
				Code: velastate.GapRuntimeFailed, DetectedAt: time.Now().UTC(),
			}); err != nil {
				t.Fatal(err)
			}
			transport := &fakeHistoryTransport{
				fakeTransport: newFakeTransport(),
				pages: []im.HistoryPage{{
					Messages: []im.IncomingMessage{newer, failed}, Completed: true,
				}},
				marked: make(chan im.Conversation, 1),
			}
			delivered := make(chan string, 2)
			host, err := New(Config{
				Sessions:   &fakeSessions{session: runtimeSession(t)},
				Transports: &fakeTransportFactory{values: []im.Transport{transport}},
				Cursors:    store,
				Runtime: &fakeRuntime{handleMessage: func(_ context.Context, message im.IncomingMessage) error {
					delivered <- message.Ref.MessageID()
					return nil
				}},
				NewLaunchID: launchIDs("unused"), RefreshBefore: time.Minute,
				BackoffBase: time.Millisecond, BackoffMax: 10 * time.Millisecond,
				MaxFailures: 1, ShutdownTimeout: time.Second, MaxInFlightEvents: 1,
			})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { host.closeCoordinator() })
			if err := host.recoverUnread(context.Background(), transport, runtimeSession(t)); err != nil {
				t.Fatal(err)
			}
			for _, want := range []string{failed.Ref.MessageID(), newer.Ref.MessageID()} {
				select {
				case got := <-delivered:
					if got != want {
						t.Fatalf("delivered = %q, want %q", got, want)
					}
				default:
					t.Fatalf("missing delivery %q", want)
				}
			}
			if _, ok := store.Gap(test.conversation); ok {
				t.Fatal("successful ordered recovery retained gap")
			}
			cursor, ok := store.Get(test.conversation)
			if !ok || cursor.MessageID != newer.Ref.MessageID() {
				t.Fatalf("cursor = %#v, %v", cursor, ok)
			}
		})
	}
}

func TestHostDoesNotMarkReadWhenCheckpointHistoryLagsUnreadSnapshot(t *testing.T) {
	t.Parallel()

	conversation := mustC2CConversation(t, "human-history-lag")
	boundaryMessage := historyMessage(t, conversation, "cursor-before-crash", "seen", 1)
	store := testCursorStore(t)
	boundary := velastate.NewMessageCursor(boundaryMessage.Ref, time.Now().UTC())
	if err := store.Advance(nil, boundary); err != nil {
		t.Fatal(err)
	}
	selfMessage := historyMessage(t, conversation, "self-reply", "already sent", 2)
	selfMessage.SenderUserID = runtimeSession(t).IM.UserID
	transport := &fakeHistoryTransport{
		fakeTransport: newFakeTransport(),
		unread:        []im.UnreadConversation{{Conversation: conversation, UnreadCount: 1}},
		pages: []im.HistoryPage{{
			Messages: []im.IncomingMessage{selfMessage, boundaryMessage}, Completed: true,
		}},
		marked: make(chan im.Conversation, 1),
	}
	host, err := New(Config{
		Sessions:   &fakeSessions{session: runtimeSession(t)},
		Transports: &fakeTransportFactory{values: []im.Transport{transport}},
		Cursors:    store, Runtime: &fakeRuntime{}, NewLaunchID: launchIDs("unused"),
		RefreshBefore: time.Minute, BackoffBase: time.Millisecond,
		BackoffMax: 10 * time.Millisecond, MaxFailures: 1,
		ShutdownTimeout: time.Second, MaxInFlightEvents: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { host.closeCoordinator() })
	err = host.recoverUnread(context.Background(), transport, runtimeSession(t))
	if !errors.Is(err, ErrRecoverySnapshotIncomplete) {
		t.Fatalf("recoverUnread() error = %v", err)
	}
	if len(transport.marked) != 0 {
		t.Fatal("history lag incorrectly marked unread conversation as read")
	}
}

func TestHostReportsUnreadyAndReadyAcrossIMReconnect(t *testing.T) {
	t.Parallel()

	first := newFakeTransport()
	second := newFakeTransport()
	health := make(chan bool, 3)
	host, err := New(Config{
		Sessions: &fakeSessions{
			session: runtimeSession(t),
		},
		Transports: &fakeTransportFactory{
			values: []im.Transport{first, second},
		},
		Cursors:           testCursorStore(t),
		Runtime:           &fakeRuntime{},
		NewLaunchID:       launchIDs("im-launch-1", "im-launch-2"),
		RefreshBefore:     time.Minute,
		BackoffBase:       time.Millisecond,
		BackoffMax:        10 * time.Millisecond,
		MaxFailures:       3,
		ShutdownTimeout:   time.Second,
		MaxInFlightEvents: 1,
		ReportReady: func() {
			health <- true
		},
		ReportUnready: func() {
			health <- false
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- host.Run(ctx) }()

	waitStarted(t, first)
	waitHostHealth(t, health, true)
	first.events <- im.Event{
		ID:       "stopped-1",
		LaunchID: "im-launch-1",
		Type:     im.EventStopped,
	}
	waitHostHealth(t, health, false)
	waitStarted(t, second)
	waitHostHealth(t, health, true)

	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("Host did not stop")
	}
}

func waitHostHealth(t *testing.T, health <-chan bool, want bool) {
	t.Helper()
	select {
	case got := <-health:
		if got != want {
			t.Fatalf("Host health = %t, want %t", got, want)
		}
	case <-time.After(time.Second):
		t.Fatalf("Host did not report health %t", want)
	}
}

func TestHostAcceptsComputerManagedDirectSessionsWithoutAgentCredential(
	t *testing.T,
) {
	t.Parallel()

	sessions := &fakeSessions{
		session: runtimeSession(t),
	}
	transport := newFakeTransport()
	host, err := New(Config{
		Sessions: sessions,
		Transports: &fakeTransportFactory{
			values: []im.Transport{transport},
		},
		Cursors:           testCursorStore(t),
		Runtime:           &fakeRuntime{},
		NewLaunchID:       launchIDs("computer-managed-launch"),
		RefreshBefore:     time.Minute,
		BackoffBase:       time.Millisecond,
		BackoffMax:        10 * time.Millisecond,
		MaxFailures:       3,
		ShutdownTimeout:   time.Second,
		MaxInFlightEvents: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- host.Run(ctx) }()
	waitStarted(t, transport)
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("Computer-managed Host 未停止")
	}
	if sessions.calls.Load() != 1 {
		t.Fatalf("direct session calls = %d", sessions.calls.Load())
	}
}

func TestHostRefreshesExpiredUserSigAfterKickedOut(t *testing.T) {
	t.Parallel()

	sessions := &fakeSessions{
		session: runtimeSession(t),
	}
	first := newFakeTransport()
	second := newFakeTransport()
	host, err := New(Config{
		Sessions: sessions,
		Transports: &fakeTransportFactory{
			values: []im.Transport{first, second},
		},
		Cursors:           testCursorStore(t),
		Runtime:           &fakeRuntime{},
		NewLaunchID:       launchIDs("im-launch-1", "im-launch-2"),
		RefreshBefore:     time.Minute,
		BackoffBase:       time.Millisecond,
		BackoffMax:        10 * time.Millisecond,
		MaxFailures:       1,
		ShutdownTimeout:   time.Second,
		MaxInFlightEvents: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- host.Run(ctx) }()

	waitStarted(t, first)
	first.events <- im.Event{
		ID:       "expired-1",
		LaunchID: "im-launch-1",
		Type:     im.EventKickedOut,
		Code:     "usersig_expired",
	}
	waitStarted(t, second)

	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("Host 未在期限内停止")
	}
	if calls := sessions.calls.Load(); calls < 2 {
		t.Fatalf("session calls = %d, want at least 2", calls)
	}
}

func TestHostReportsSafeKickedOutReasonWithoutChangingReconnectOutcome(
	t *testing.T,
) {
	t.Parallel()

	transport := newFakeTransport()
	reports := make(chan FailureReport, 1)
	host, err := New(Config{
		Sessions:          &fakeSessions{session: runtimeSession(t)},
		Transports:        &fakeTransportFactory{values: []im.Transport{transport}},
		Cursors:           testCursorStore(t),
		Runtime:           &fakeRuntime{},
		NewLaunchID:       launchIDs("im-launch-1"),
		RefreshBefore:     time.Minute,
		BackoffBase:       time.Millisecond,
		BackoffMax:        10 * time.Millisecond,
		MaxFailures:       1,
		ShutdownTimeout:   time.Second,
		MaxInFlightEvents: 1,
		ReportFailure: func(report FailureReport) {
			reports <- report
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- host.Run(context.Background()) }()
	waitStarted(t, transport)
	transport.events <- im.Event{
		ID:       "kicked-1",
		LaunchID: "im-launch-1",
		Type:     im.EventKickedOut,
		Reason:   "kicked_out_mult_account",
	}
	if err := <-done; !errors.Is(err, ErrFailureLimit) {
		t.Fatalf("Run error = %v", err)
	}
	report := <-reports
	if report.Scope != FailureScopeIdentity ||
		report.Stage != FailureStageServing ||
		report.Code != FailureCodeKickedOutMultAccount ||
		!report.Retryable ||
		report.Attempt != 1 ||
		report.MessageID != "" ||
		report.ConversationKind != "" {
		t.Fatalf("report = %#v", report)
	}
}

func TestHostReportsSafeMessageHandlerFailure(t *testing.T) {
	t.Parallel()

	conversation, err := im.NewC2CConversation("human_1")
	if err != nil {
		t.Fatal(err)
	}
	message := historyMessage(
		t,
		conversation,
		"message_1",
		"不要记录消息正文",
		1,
	)
	transport := newFakeTransport()
	reports := make(chan FailureReport, 1)
	host, err := New(Config{
		Sessions:          &fakeSessions{session: runtimeSession(t)},
		Transports:        &fakeTransportFactory{values: []im.Transport{transport}},
		Cursors:           testCursorStore(t),
		Runtime:           &fakeRuntime{handleErr: errors.New("Bearer secret\nhttps://private.example")},
		NewLaunchID:       launchIDs("im-launch-1"),
		RefreshBefore:     time.Minute,
		BackoffBase:       time.Millisecond,
		BackoffMax:        10 * time.Millisecond,
		MaxFailures:       1,
		ShutdownTimeout:   time.Second,
		MaxInFlightEvents: 1,
		ReportFailure: func(report FailureReport) {
			reports <- report
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- host.Run(ctx) }()
	waitStarted(t, transport)
	transport.events <- im.Event{
		ID:       "message-event-1",
		LaunchID: "im-launch-1",
		Type:     im.EventMessage,
		Message:  &message,
	}
	report := <-reports
	if report.Scope != FailureScopeMessage ||
		report.Stage != FailureStageServing ||
		report.Code != FailureCodeMessageHandlerFailed ||
		report.Retryable != true ||
		report.Attempt != 1 ||
		report.MessageID != "message_1" ||
		report.ConversationKind != im.ConversationC2C {
		t.Fatalf("report = %#v", report)
	}
	if rendered := report.String(); strings.Contains(rendered, "secret") ||
		strings.Contains(rendered, "private.example") ||
		strings.Contains(rendered, "不要记录消息正文") {
		t.Fatalf("failure report leaked private data: %q", rendered)
	}
	if transport.closed.Load() != 0 {
		t.Fatal("消息级失败不应重置 IM transport")
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestHostPreservesTrustedMessageFailureCode(t *testing.T) {
	t.Parallel()

	conversation, err := im.NewC2CConversation("human_1")
	if err != nil {
		t.Fatal(err)
	}
	message := historyMessage(t, conversation, "message_2", "private", 2)
	transport := newFakeTransport()
	reports := make(chan FailureReport, 1)
	host, err := New(Config{
		Sessions:   &fakeSessions{session: runtimeSession(t)},
		Transports: &fakeTransportFactory{values: []im.Transport{transport}},
		Cursors:    testCursorStore(t),
		Runtime: &fakeRuntime{handleErr: NewFailureError(
			FailureScopeMessage,
			FailureCodeRuntimeDeliverFailed,
			true,
			errors.New("Authorization: secret"),
		)},
		NewLaunchID:       launchIDs("im-launch-1"),
		RefreshBefore:     time.Minute,
		BackoffBase:       time.Millisecond,
		BackoffMax:        10 * time.Millisecond,
		MaxFailures:       1,
		ShutdownTimeout:   time.Second,
		MaxInFlightEvents: 1,
		ReportFailure: func(report FailureReport) {
			reports <- report
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- host.Run(ctx) }()
	waitStarted(t, transport)
	transport.events <- im.Event{
		ID:       "message-event-2",
		LaunchID: "im-launch-1",
		Type:     im.EventMessage,
		Message:  &message,
	}
	report := <-reports
	if report.Code != FailureCodeRuntimeDeliverFailed ||
		report.MessageID != "message_2" {
		t.Fatalf("report = %#v", report)
	}
	if transport.closed.Load() != 0 {
		t.Fatal("受信任的消息级失败不应重置 IM transport")
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestHostReportsClosedTransportEventStream(t *testing.T) {
	t.Parallel()

	transport := newFakeTransport()
	reports := make(chan FailureReport, 1)
	host, err := New(Config{
		Sessions:          &fakeSessions{session: runtimeSession(t)},
		Transports:        &fakeTransportFactory{values: []im.Transport{transport}},
		Cursors:           testCursorStore(t),
		Runtime:           &fakeRuntime{},
		NewLaunchID:       launchIDs("im-launch-1"),
		RefreshBefore:     time.Minute,
		BackoffBase:       time.Millisecond,
		BackoffMax:        10 * time.Millisecond,
		MaxFailures:       1,
		ShutdownTimeout:   time.Second,
		MaxInFlightEvents: 1,
		ReportFailure: func(report FailureReport) {
			reports <- report
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- host.Run(context.Background()) }()
	waitStarted(t, transport)
	close(transport.events)
	if err := <-done; !errors.Is(err, ErrFailureLimit) {
		t.Fatalf("Run error = %v", err)
	}
	report := <-reports
	if report.Scope != FailureScopeSession ||
		report.Stage != FailureStageServing ||
		report.Code != FailureCodeTransportEventsClosed ||
		!report.Retryable ||
		report.Attempt != 1 {
		t.Fatalf("report = %#v", report)
	}
}

func TestHostLegacyUserSigCodeTakesPrecedenceOverDiagnosticReason(
	t *testing.T,
) {
	t.Parallel()

	first := newFakeTransport()
	second := newFakeTransport()
	reports := make(chan FailureReport, 1)
	host, err := New(Config{
		Sessions: &fakeSessions{session: runtimeSession(t)},
		Transports: &fakeTransportFactory{
			values: []im.Transport{first, second},
		},
		Cursors:           testCursorStore(t),
		Runtime:           &fakeRuntime{},
		NewLaunchID:       launchIDs("im-launch-1", "im-launch-2"),
		RefreshBefore:     time.Minute,
		BackoffBase:       time.Millisecond,
		BackoffMax:        10 * time.Millisecond,
		MaxFailures:       1,
		ShutdownTimeout:   time.Second,
		MaxInFlightEvents: 1,
		ReportFailure: func(report FailureReport) {
			reports <- report
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- host.Run(ctx) }()
	waitStarted(t, first)
	first.events <- im.Event{
		ID:       "expired-1",
		LaunchID: "im-launch-1",
		Type:     im.EventKickedOut,
		Code:     "usersig_expired",
		Reason:   "kicked_out_mult_account",
	}
	waitStarted(t, second)
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	select {
	case report := <-reports:
		t.Fatalf("legacy refresh should not report a failure: %#v", report)
	default:
	}
}

func TestHostStopsOnRejectedCredential(t *testing.T) {
	t.Parallel()

	host, err := New(Config{
		Sessions: &fakeSessions{
			err: platform.ErrCredentialRejected,
		},
		Transports:        &fakeTransportFactory{},
		Cursors:           testCursorStore(t),
		Runtime:           &fakeRuntime{},
		NewLaunchID:       launchIDs("unused"),
		RefreshBefore:     time.Minute,
		BackoffBase:       time.Millisecond,
		BackoffMax:        10 * time.Millisecond,
		MaxFailures:       3,
		ShutdownTimeout:   time.Second,
		MaxInFlightEvents: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := host.Run(context.Background()); !errors.Is(
		err,
		platform.ErrCredentialRejected,
	) {
		t.Fatalf("Run error = %v", err)
	}
}

func TestHostReportsTransportStartFailureStage(t *testing.T) {
	t.Parallel()

	reports := make(chan FailureReport, 1)
	transport := newFakeTransport()
	transport.startErr = errors.New("private bridge detail")
	host, err := New(Config{
		Sessions: &fakeSessions{
			session: runtimeSession(t),
		},
		Transports: &fakeTransportFactory{
			values: []im.Transport{transport},
		},
		Cursors:           testCursorStore(t),
		Runtime:           &fakeRuntime{},
		NewLaunchID:       launchIDs("im-launch-1"),
		RefreshBefore:     time.Minute,
		BackoffBase:       time.Millisecond,
		BackoffMax:        10 * time.Millisecond,
		MaxFailures:       1,
		ShutdownTimeout:   time.Second,
		MaxInFlightEvents: 1,
		ReportFailure: func(report FailureReport) {
			reports <- report
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := host.Run(context.Background()); !errors.Is(
		err,
		ErrFailureLimit,
	) {
		t.Fatalf("Run error = %v", err)
	}
	select {
	case report := <-reports:
		if report.Stage != FailureStageTransportStart ||
			report.Attempt != 1 {
			t.Fatalf("report = %#v", report)
		}
	default:
		t.Fatal("Host 未报告 Transport Start 失败阶段")
	}
}

func TestHostRecoversUnreadMessagesInOrderBeforeServingLiveEvents(
	t *testing.T,
) {
	t.Parallel()

	conversation, err := im.NewC2CConversation("human_1")
	if err != nil {
		t.Fatal(err)
	}
	older := historyMessage(t, conversation, "message_1", "先到", 1)
	newer := historyMessage(t, conversation, "message_2", "后到", 2)
	own := historyMessage(t, conversation, "message_own", "自己的", 3)
	own.SenderUserID = "agent_1"
	base := newFakeTransport()
	transport := &fakeHistoryTransport{
		fakeTransport: base,
		unread: []im.UnreadConversation{{
			Conversation: conversation,
			UnreadCount:  2,
		}},
		pages: []im.HistoryPage{
			{
				Messages:   []im.IncomingMessage{own, newer},
				NextCursor: "page-2",
			},
			{
				Messages:  []im.IncomingMessage{older},
				Completed: true,
			},
		},
		marked: make(chan im.Conversation, 1),
	}
	runtime := &fakeRuntime{
		messages: make(chan im.IncomingMessage, 3),
	}
	host, err := New(Config{
		Sessions:          &fakeSessions{session: runtimeSession(t)},
		Transports:        &fakeTransportFactory{values: []im.Transport{transport}},
		Cursors:           testCursorStore(t),
		Runtime:           runtime,
		NewLaunchID:       launchIDs("im-launch-1"),
		RefreshBefore:     time.Minute,
		BackoffBase:       time.Millisecond,
		BackoffMax:        10 * time.Millisecond,
		MaxFailures:       3,
		ShutdownTimeout:   time.Second,
		MaxInFlightEvents: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- host.Run(ctx) }()
	waitStarted(t, base)

	for _, want := range []string{"message_1", "message_2", "message_own"} {
		select {
		case message := <-runtime.messages:
			if message.Ref.MessageID() != want {
				t.Fatalf(
					"recovered message = %q, want %q",
					message.Ref.MessageID(),
					want,
				)
			}
		case <-time.After(time.Second):
			t.Fatalf("未恢复历史消息 %s", want)
		}
	}
	select {
	case marked := <-transport.marked:
		if marked != conversation {
			t.Fatalf("marked conversation = %#v", marked)
		}
	case <-time.After(time.Second):
		t.Fatal("成功恢复后未标记会话已读")
	}

	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("Host 未在期限内停止")
	}
}

func TestHostRecoversUnreadTopicAndMarksItRead(t *testing.T) {
	t.Parallel()

	conversation, err := im.NewTopicConversation(
		"group_1",
		"group_1@TOPIC#_topic_1",
	)
	if err != nil {
		t.Fatal(err)
	}
	recovered := historyMessage(
		t,
		conversation,
		"topic_message_1",
		"离线期间明确提及 Agent",
		1,
	)
	base := newFakeTransport()
	transport := &fakeHistoryTransport{
		fakeTransport: base,
		unread: []im.UnreadConversation{{
			Conversation: conversation,
			UnreadCount:  1,
		}},
		pages: []im.HistoryPage{{
			Messages:  []im.IncomingMessage{recovered},
			Completed: true,
		}},
		marked: make(chan im.Conversation, 1),
	}
	runtime := &fakeRuntime{
		messages: make(chan im.IncomingMessage, 1),
	}
	host, err := New(Config{
		Sessions:          &fakeSessions{session: runtimeSession(t)},
		Transports:        &fakeTransportFactory{values: []im.Transport{transport}},
		Cursors:           testCursorStore(t),
		Runtime:           runtime,
		NewLaunchID:       launchIDs("im-launch-topic"),
		RefreshBefore:     time.Minute,
		BackoffBase:       time.Millisecond,
		BackoffMax:        10 * time.Millisecond,
		MaxFailures:       3,
		ShutdownTimeout:   time.Second,
		MaxInFlightEvents: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- host.Run(ctx) }()
	waitStarted(t, base)
	select {
	case message := <-runtime.messages:
		actual := message.Ref.Conversation()
		if message.Ref.MessageID() != "topic_message_1" ||
			actual.Kind() != im.ConversationTopic ||
			actual.GroupID() != "group_1" ||
			actual.TopicID() != "group_1@TOPIC#_topic_1" {
			t.Fatalf("recovered Topic message = %#v", message)
		}
	case <-time.After(time.Second):
		t.Fatal("未恢复 Topic 历史消息")
	}
	select {
	case marked := <-transport.marked:
		if marked != conversation {
			t.Fatalf("marked Topic = %#v", marked)
		}
	case <-time.After(time.Second):
		t.Fatal("成功恢复后未标记 Topic 已读")
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("Host 未在期限内停止")
	}
}

func TestHostIsolatesNonAdvancingHistoryGapWithoutRestartingSession(
	t *testing.T,
) {
	t.Parallel()

	conversation, err := im.NewC2CConversation("human_1")
	if err != nil {
		t.Fatal(err)
	}
	base := newFakeTransport()
	transport := &fakeHistoryTransport{
		fakeTransport: base,
		unread: []im.UnreadConversation{{
			Conversation: conversation,
			UnreadCount:  1,
		}},
		pages:  []im.HistoryPage{{}},
		marked: make(chan im.Conversation, 1),
	}
	reports := make(chan FailureReport, 1)
	ready := make(chan struct{}, 1)
	cursors := testCursorStore(t)
	host, err := New(Config{
		Sessions:          &fakeSessions{session: runtimeSession(t)},
		Transports:        &fakeTransportFactory{values: []im.Transport{transport}},
		Cursors:           cursors,
		Runtime:           &fakeRuntime{},
		NewLaunchID:       launchIDs("im-launch-1"),
		RefreshBefore:     time.Minute,
		BackoffBase:       time.Millisecond,
		BackoffMax:        10 * time.Millisecond,
		MaxFailures:       1,
		ShutdownTimeout:   time.Second,
		MaxInFlightEvents: 1,
		ReportFailure: func(report FailureReport) {
			reports <- report
		},
		ReportReady: func() { ready <- struct{}{} },
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- host.Run(ctx) }()
	select {
	case <-ready:
	case <-time.After(time.Second):
		t.Fatal("history gap incorrectly prevented Host readiness")
	}
	if calls := transport.historyCalls.Load(); calls != 1 {
		t.Fatalf("history calls = %d, want 1", calls)
	}
	if len(transport.marked) != 0 {
		t.Fatal("失败的历史恢复不得标记会话已读")
	}
	select {
	case report := <-reports:
		if report.Stage != FailureStageHistoryRecovery ||
			report.Code != FailureCodeRecoveryStalled {
			t.Fatalf("report = %#v", report)
		}
	default:
		t.Fatal("Host 未报告安全的 history recovery 错误码")
	}
	if gap, ok := cursors.Gap(conversation); !ok || gap.Diagnostic.Code != velastate.GapRecoveryStalled {
		t.Fatalf("persisted gap = %#v, %v", gap, ok)
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestHostReportsStartupStages(t *testing.T) {
	t.Parallel()

	transport := newFakeTransport()
	stages := make(chan StartupStage, 8)
	ready := make(chan struct{}, 1)
	host, err := New(Config{
		Sessions:          &fakeSessions{session: runtimeSession(t)},
		Transports:        &fakeTransportFactory{values: []im.Transport{transport}},
		Cursors:           testCursorStore(t),
		Runtime:           &fakeRuntime{},
		NewLaunchID:       launchIDs("im-launch-stages"),
		RefreshBefore:     time.Minute,
		BackoffBase:       time.Millisecond,
		BackoffMax:        10 * time.Millisecond,
		MaxFailures:       1,
		ShutdownTimeout:   time.Second,
		MaxInFlightEvents: 1,
		ReportStartup: func(stage StartupStage) {
			stages <- stage
		},
		ReportReady: func() {
			ready <- struct{}{}
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- host.Run(ctx) }()
	waitStarted(t, transport)
	select {
	case <-ready:
	case <-time.After(time.Second):
		t.Fatal("Host 未进入 serving")
	}

	want := []StartupStage{
		StartupStageRuntimeSession,
		StartupStageRuntimeBind,
		StartupStageTransportCreate,
		StartupStageTransportStart,
		StartupStageHistoryRecovery,
		StartupStageServing,
	}
	for index, expected := range want {
		select {
		case actual := <-stages:
			if actual != expected {
				t.Fatalf("startup stage[%d] = %q, want %q", index, actual, expected)
			}
		case <-time.After(time.Second):
			t.Fatalf("缺少 startup stage[%d] = %q", index, expected)
		}
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestHostReportsRuntimeBindFailureInsteadOfReturningOpaqueError(
	t *testing.T,
) {
	t.Parallel()

	reports := make(chan FailureReport, 1)
	host, err := New(Config{
		Sessions:          &fakeSessions{session: runtimeSession(t)},
		Transports:        &fakeTransportFactory{},
		Cursors:           testCursorStore(t),
		Runtime:           &fakeRuntime{updateErr: errors.New("private bind detail")},
		NewLaunchID:       launchIDs("unused"),
		RefreshBefore:     time.Minute,
		BackoffBase:       time.Millisecond,
		BackoffMax:        10 * time.Millisecond,
		MaxFailures:       1,
		ShutdownTimeout:   time.Second,
		MaxInFlightEvents: 1,
		ReportFailure: func(report FailureReport) {
			reports <- report
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := host.Run(context.Background()); !errors.Is(err, ErrFailureLimit) {
		t.Fatalf("Run error = %v, want ErrFailureLimit", err)
	}
	select {
	case report := <-reports:
		if report.Stage != FailureStageRuntimeBind ||
			report.Code != FailureCodeRuntimeBindFailed ||
			!report.Retryable || report.Attempt != 1 {
			t.Fatalf("report = %#v", report)
		}
	case <-time.After(time.Second):
		t.Fatal("Runtime bind 失败没有结构化报告")
	}
}

func TestHostIsolatesFailedConversationAndKeepsOtherConversationServing(t *testing.T) {
	t.Parallel()

	transport := newFakeTransport()
	delivered := make(chan string, 1)
	var calls atomic.Int64
	runtime := &fakeRuntime{
		handleMessage: func(
			_ context.Context,
			message im.IncomingMessage,
		) error {
			if calls.Add(1) == 1 {
				return NewFailureError(
					FailureScopeMessage,
					FailureCodeRuntimeDeliverFailed,
					true,
					errors.New("private runtime detail"),
				)
			}
			delivered <- message.Ref.MessageID()
			return nil
		},
	}
	reports := make(chan FailureReport, 1)
	host, err := New(Config{
		Sessions:          &fakeSessions{session: runtimeSession(t)},
		Transports:        &fakeTransportFactory{values: []im.Transport{transport}},
		Cursors:           testCursorStore(t),
		Runtime:           runtime,
		NewLaunchID:       launchIDs("im-launch-isolation"),
		RefreshBefore:     time.Minute,
		BackoffBase:       time.Millisecond,
		BackoffMax:        10 * time.Millisecond,
		MaxFailures:       1,
		ShutdownTimeout:   time.Second,
		MaxInFlightEvents: 1,
		ReportFailure: func(report FailureReport) {
			reports <- report
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- host.Run(ctx) }()
	waitStarted(t, transport)
	for _, input := range []struct {
		messageID string
		userID    string
	}{
		{messageID: "message-failed", userID: "human_1"},
		{messageID: "message-blocked", userID: "human_1"},
		{messageID: "message-ok", userID: "human_2"},
	} {
		message := historyMessage(
			t,
			mustC2CConversation(t, input.userID),
			input.messageID,
			"消息",
			calls.Load()+1,
		)
		transport.events <- im.Event{
			ID:       "event-" + input.messageID,
			LaunchID: "im-launch-isolation",
			Type:     im.EventMessage,
			Message:  &message,
		}
		if input.messageID == "message-failed" {
			select {
			case report := <-reports:
				if report.Scope != FailureScopeMessage ||
					report.Stage != FailureStageServing ||
					report.Code != FailureCodeRuntimeDeliverFailed ||
					report.MessageID != input.messageID {
					t.Fatalf("report = %#v", report)
				}
			case <-time.After(time.Second):
				t.Fatal("消息处理失败没有结构化报告")
			}
		}
	}
	select {
	case messageID := <-delivered:
		if messageID != "message-ok" {
			t.Fatalf("delivered = %q", messageID)
		}
	case <-time.After(time.Second):
		t.Fatal("另一个会话被失败会话阻塞")
	}
	if transport.closed.Load() != 0 {
		t.Fatal("消息级失败不应重置 IM transport")
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestHostRepairsFailedConversationFromTencentHistoryWithoutReconnect(t *testing.T) {
	t.Parallel()
	conversation := mustC2CConversation(t, "human-resync")
	message := historyMessage(t, conversation, "message-retry", "retry", 1)
	base := newFakeTransport()
	transport := &fakeHistoryTransport{
		fakeTransport: base, marked: make(chan im.Conversation, 1),
	}
	delivered := make(chan string, 1)
	var calls atomic.Int64
	runtime := &fakeRuntime{handleMessage: func(_ context.Context, value im.IncomingMessage) error {
		if calls.Add(1) == 1 {
			transport.unread = []im.UnreadConversation{{Conversation: conversation, UnreadCount: 1}}
			transport.pages = []im.HistoryPage{{Messages: []im.IncomingMessage{message}, Completed: true}}
			return NewFailureError(
				FailureScopeMessage, FailureCodeRuntimeDeliverFailed, true,
				errors.New("runtime rejected once"),
			)
		}
		delivered <- value.Ref.MessageID()
		return nil
	}}
	host, err := New(Config{
		Sessions:   &fakeSessions{session: runtimeSession(t)},
		Transports: &fakeTransportFactory{values: []im.Transport{transport}},
		Cursors:    testCursorStore(t), Runtime: runtime,
		NewLaunchID:   launchIDs("im-launch-targeted-resync"),
		RefreshBefore: time.Minute, BackoffBase: time.Millisecond,
		BackoffMax: 10 * time.Millisecond, MaxFailures: 3,
		ShutdownTimeout: time.Second, MaxInFlightEvents: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- host.Run(ctx) }()
	waitStarted(t, base)
	base.events <- im.Event{
		LaunchID: "im-launch-targeted-resync", Type: im.EventMessage, Message: &message,
	}
	select {
	case got := <-delivered:
		if got != message.Ref.MessageID() {
			t.Fatalf("targeted recovery delivered %q", got)
		}
	case <-time.After(time.Second):
		t.Fatal("failed conversation was not repaired from Tencent history")
	}
	if base.closed.Load() != 0 {
		t.Fatal("targeted recovery unnecessarily reconnected IM")
	}
	select {
	case marked := <-transport.marked:
		if marked != conversation {
			t.Fatalf("marked = %#v", marked)
		}
	case <-time.After(time.Second):
		t.Fatal("repaired conversation was not marked read")
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestHostDoesNotLetFailedRecoveredMessageBlockReadiness(
	t *testing.T,
) {
	t.Parallel()

	conversation := mustC2CConversation(t, "human_1")
	base := newFakeTransport()
	transport := &fakeHistoryTransport{
		fakeTransport: base,
		unread: []im.UnreadConversation{{
			Conversation: conversation,
			UnreadCount:  1,
		}},
		pages: []im.HistoryPage{{
			Messages: []im.IncomingMessage{historyMessage(
				t, conversation, "message-failed", "消息", 1,
			)},
			Completed: true,
		}},
		marked: make(chan im.Conversation, 1),
	}
	reports := make(chan FailureReport, 1)
	ready := make(chan struct{}, 1)
	host, err := New(Config{
		Sessions:   &fakeSessions{session: runtimeSession(t)},
		Transports: &fakeTransportFactory{values: []im.Transport{transport}},
		Cursors:    testCursorStore(t),
		Runtime: &fakeRuntime{handleMessage: func(
			context.Context,
			im.IncomingMessage,
		) error {
			return NewFailureError(
				FailureScopeMessage,
				FailureCodeRuntimeStartFailed,
				true,
				errors.New("private start detail"),
			)
		}},
		NewLaunchID:            launchIDs("im-launch-recovery-isolation"),
		RefreshBefore:          time.Minute,
		BackoffBase:            time.Millisecond,
		BackoffMax:             10 * time.Millisecond,
		MaxFailures:            1,
		ShutdownTimeout:        time.Second,
		MaxInFlightEvents:      1,
		RecoveryMessageTimeout: time.Second,
		ReportFailure: func(report FailureReport) {
			reports <- report
		},
		ReportReady: func() { ready <- struct{}{} },
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- host.Run(ctx) }()
	waitStarted(t, base)
	select {
	case <-ready:
	case <-time.After(time.Second):
		t.Fatal("失败的历史消息阻塞了 Host readiness")
	}
	select {
	case report := <-reports:
		if report.Stage != FailureStageHistoryRecovery ||
			report.Code != FailureCodeRuntimeStartFailed ||
			report.MessageID != "message-failed" {
			t.Fatalf("report = %#v", report)
		}
	case <-time.After(time.Second):
		t.Fatal("历史消息失败没有保留叶子错误")
	}
	if len(transport.marked) != 0 {
		t.Fatal("处理失败的历史会话不得标记已读")
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestHostBoundsRecoveredMessageHandling(t *testing.T) {
	t.Parallel()

	conversation := mustC2CConversation(t, "human_1")
	base := newFakeTransport()
	transport := &fakeHistoryTransport{
		fakeTransport: base,
		unread: []im.UnreadConversation{{
			Conversation: conversation,
			UnreadCount:  1,
		}},
		pages: []im.HistoryPage{{
			Messages: []im.IncomingMessage{historyMessage(
				t, conversation, "message-timeout", "消息", 1,
			)},
			Completed: true,
		}},
		marked: make(chan im.Conversation, 1),
	}
	reports := make(chan FailureReport, 1)
	ready := make(chan struct{}, 1)
	host, err := New(Config{
		Sessions:   &fakeSessions{session: runtimeSession(t)},
		Transports: &fakeTransportFactory{values: []im.Transport{transport}},
		Cursors:    testCursorStore(t),
		Runtime: &fakeRuntime{handleMessage: func(
			ctx context.Context,
			_ im.IncomingMessage,
		) error {
			<-ctx.Done()
			return ctx.Err()
		}},
		NewLaunchID:            launchIDs("im-launch-recovery-timeout"),
		RefreshBefore:          time.Minute,
		BackoffBase:            time.Millisecond,
		BackoffMax:             10 * time.Millisecond,
		MaxFailures:            1,
		ShutdownTimeout:        time.Second,
		MaxInFlightEvents:      1,
		RecoveryMessageTimeout: 20 * time.Millisecond,
		ReportFailure: func(report FailureReport) {
			reports <- report
		},
		ReportReady: func() { ready <- struct{}{} },
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- host.Run(ctx) }()
	waitStarted(t, base)
	select {
	case <-ready:
	case <-time.After(time.Second):
		t.Fatal("超时的历史消息阻塞了 Host readiness")
	}
	select {
	case report := <-reports:
		if report.Stage != FailureStageHistoryRecovery ||
			report.Code != FailureCodeMessageHandlerTimeout ||
			report.MessageID != "message-timeout" {
			t.Fatalf("report = %#v", report)
		}
	case <-time.After(time.Second):
		t.Fatal("历史消息超时没有结构化报告")
	}
	if len(transport.marked) != 0 {
		t.Fatal("处理超时的历史会话不得标记已读")
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

type fakeSessions struct {
	session platform.RuntimeSession
	err     error
	calls   atomic.Int64
}

func (f *fakeSessions) CreateRuntimeSession(
	context.Context,
) (platform.RuntimeSession, error) {
	f.calls.Add(1)
	return f.session, f.err
}

type fakeTransportFactory struct {
	mu     sync.Mutex
	values []im.Transport
}

func (f *fakeTransportFactory) New() (im.Transport, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.values) == 0 {
		return nil, errors.New("no transport")
	}
	value := f.values[0]
	f.values = f.values[1:]
	return value, nil
}

type fakeTransport struct {
	events   chan im.Event
	started  chan im.Session
	closed   atomic.Int64
	startErr error
}

func newFakeTransport() *fakeTransport {
	return &fakeTransport{
		events:  make(chan im.Event, 8),
		started: make(chan im.Session, 1),
	}
}

func (f *fakeTransport) Start(
	_ context.Context,
	session im.Session,
) error {
	if f.startErr != nil {
		return f.startErr
	}
	f.started <- session
	return nil
}

func (*fakeTransport) SendText(
	context.Context,
	im.SendTextRequest,
) (im.SendReceipt, error) {
	return im.SendReceipt{}, nil
}

func (*fakeTransport) SendCustom(
	context.Context,
	im.SendCustomRequest,
) (im.SendReceipt, error) {
	return im.SendReceipt{}, nil
}

func (f *fakeTransport) Events() <-chan im.Event {
	return f.events
}

func (f *fakeTransport) Close(context.Context) error {
	f.closed.Add(1)
	return nil
}

type fakeHistoryTransport struct {
	*fakeTransport
	unread []im.UnreadConversation
	pages  []im.HistoryPage
	marked chan im.Conversation

	historyCalls    atomic.Int64
	historyRequests chan im.HistoryRequest
	historyBlock    <-chan struct{}
	historyEntered  chan struct{}
	historyMu       sync.Mutex
	historyCache    map[string]im.HistoryPage
}

type functionalHistoryTransport struct {
	history func(im.HistoryRequest) (im.HistoryPage, error)
}

func (*functionalHistoryTransport) UnreadConversations(context.Context) ([]im.UnreadConversation, error) {
	return nil, nil
}

func (f *functionalHistoryTransport) History(_ context.Context, request im.HistoryRequest) (im.HistoryPage, error) {
	return f.history(request)
}

func (*functionalHistoryTransport) MarkRead(context.Context, im.Conversation) error { return nil }

func (f *fakeHistoryTransport) UnreadConversations(
	context.Context,
) ([]im.UnreadConversation, error) {
	return append([]im.UnreadConversation(nil), f.unread...), nil
}

func (f *fakeHistoryTransport) History(
	ctx context.Context,
	request im.HistoryRequest,
) (im.HistoryPage, error) {
	f.historyCalls.Add(1)
	if f.historyRequests != nil {
		f.historyRequests <- request
	}
	if f.historyEntered != nil {
		select {
		case f.historyEntered <- struct{}{}:
		default:
		}
	}
	if f.historyBlock != nil {
		select {
		case <-f.historyBlock:
		case <-ctx.Done():
			return im.HistoryPage{}, ctx.Err()
		}
	}
	key := string(request.Conversation.Kind()) + "\x00" +
		request.Conversation.PeerUserID() + "\x00" + request.Conversation.GroupID() +
		"\x00" + request.Conversation.TopicID() + "\x00" + request.Cursor
	f.historyMu.Lock()
	defer f.historyMu.Unlock()
	if page, ok := f.historyCache[key]; ok {
		return page, nil
	}
	if len(f.pages) == 0 {
		return im.HistoryPage{}, errors.New("no history page")
	}
	page := f.pages[0]
	f.pages = f.pages[1:]
	if f.historyCache == nil {
		f.historyCache = make(map[string]im.HistoryPage)
	}
	f.historyCache[key] = page
	return page, nil
}

func (f *fakeHistoryTransport) MarkRead(
	_ context.Context,
	conversation im.Conversation,
) error {
	f.marked <- conversation
	return nil
}

type fakeRuntime struct {
	messages       chan im.IncomingMessage
	handleErr      error
	handleMessage  func(context.Context, im.IncomingMessage) error
	updateErr      error
	closed         atomic.Int64
	sessionUpdates atomic.Int64
}

func (f *fakeRuntime) UpdateSession(platform.RuntimeSession) error {
	f.sessionUpdates.Add(1)
	return f.updateErr
}

func (f *fakeRuntime) HandleMessage(
	ctx context.Context,
	message im.IncomingMessage,
) error {
	if f.handleMessage != nil {
		return f.handleMessage(ctx, message)
	}
	if f.messages != nil {
		f.messages <- message
	}
	return f.handleErr
}

func (f *fakeRuntime) HandleIngressMessage(
	ctx context.Context,
	message im.IncomingMessage,
) (ingress.MessageResult, error) {
	if err := f.HandleMessage(ctx, message); err != nil {
		return ingress.MessageResult{}, err
	}
	return ingress.MessageResult{Disposition: ingress.RuntimeAccepted}, nil
}

func testCursorStore(t *testing.T) *velastate.FileCursorStore {
	t.Helper()
	store, err := velastate.OpenFileCursorStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return store
}

func mustC2CConversation(t *testing.T, userID string) im.Conversation {
	t.Helper()
	conversation, err := im.NewC2CConversation(userID)
	if err != nil {
		t.Fatal(err)
	}
	return conversation
}

func mustGroupConversation(t *testing.T, groupID string) im.Conversation {
	t.Helper()
	conversation, err := im.NewGroupConversation(groupID)
	if err != nil {
		t.Fatal(err)
	}
	return conversation
}

func mustTopicConversation(t *testing.T, groupID, topicID string) im.Conversation {
	t.Helper()
	conversation, err := im.NewTopicConversation(groupID, topicID)
	if err != nil {
		t.Fatal(err)
	}
	return conversation
}

func (f *fakeRuntime) Close(context.Context) error {
	f.closed.Add(1)
	return nil
}

func waitStarted(t *testing.T, transport *fakeTransport) im.Session {
	t.Helper()
	select {
	case session := <-transport.started:
		return session
	case <-time.After(time.Second):
		t.Fatal("Transport 未启动")
		return im.Session{}
	}
}

func launchIDs(values ...string) func() (string, error) {
	var index atomic.Int64
	return func() (string, error) {
		position := int(index.Add(1) - 1)
		if position >= len(values) {
			return "", errors.New("no launch ID")
		}
		return values[position], nil
	}
}

func runtimeSession(t *testing.T) platform.RuntimeSession {
	t.Helper()
	userSig, err := platform.NewUserSig("short-usersig")
	if err != nil {
		t.Fatal(err)
	}
	expiresAt := time.Now().Add(30 * time.Minute).UTC()
	return platform.RuntimeSession{
		ExpiresAt: expiresAt,
		Agent: platform.AgentIdentity{
			ID:          "01900000-0000-7000-8000-000000000002",
			ServerID:    "01900000-0000-7000-8000-000000000001",
			UserID:      "agent_1",
			ReplyPolicy: "mention_and_dm",
			RuntimeKind: "codex",
		},
		IM: platform.IMSession{
			SDKAppID:  1000000000,
			UserID:    "agent_1",
			UserSig:   userSig,
			ExpiresAt: expiresAt,
		},
	}
}

func historyMessage(
	t *testing.T,
	conversation im.Conversation,
	messageID string,
	text string,
	sequence int64,
) im.IncomingMessage {
	t.Helper()
	reference, err := im.NewMessageRef(
		conversation,
		messageID,
		sequence,
		time.UnixMilli(1785398400000+sequence).UnixMilli(),
	)
	if err != nil {
		t.Fatal(err)
	}
	return im.IncomingMessage{
		Ref:          reference,
		SenderUserID: "human_1",
		Elements: []im.Element{{
			Type: im.ElementText,
			Text: text,
		}},
	}
}
