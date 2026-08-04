package state

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/vela/im"
)

func TestFileCursorStorePersistsEveryConversationWithoutMessageBody(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	store, err := OpenFileCursorStore(root)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 8, 3, 1, 2, 3, 0, time.UTC)
	conversations := []im.Conversation{
		mustC2C(t, "human-a"),
		mustGroup(t, "group-a"),
		mustTopic(t, "community-a", "topic-a"),
	}
	for index, conversation := range conversations {
		cursor := cursorFor(t, conversation, "message-"+string(rune('a'+index)), int64(index+1), now.Add(time.Duration(index)*time.Millisecond))
		if err := store.Advance(nil, cursor); err != nil {
			t.Fatalf("Advance(%s): %v", conversation.Kind(), err)
		}
	}
	if err := store.MarkInitialized(); err != nil {
		t.Fatal(err)
	}

	data, err := os.ReadFile(filepath.Join(root, CursorStoreFilename))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "secret body") {
		t.Fatal("cursor snapshot persisted message body")
	}
	info, err := os.Stat(filepath.Join(root, CursorStoreFilename))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("cursor mode = %o", info.Mode().Perm())
	}

	reopened, err := OpenFileCursorStore(root)
	if err != nil {
		t.Fatal(err)
	}
	if !reopened.Initialized() {
		t.Fatal("cursor store did not persist initialized marker")
	}
	for _, conversation := range conversations {
		cursor, ok := reopened.Get(conversation)
		if !ok || !sameConversation(cursor.Conversation, conversation) {
			t.Fatalf("Get(%s) = %#v, %v", conversation.Kind(), cursor, ok)
		}
	}
	if got := reopened.List(); len(got) != len(conversations) {
		t.Fatalf("List() len = %d", len(got))
	}
}

func TestFileCursorStoreUsesCASForSameTimestampC2C(t *testing.T) {
	t.Parallel()

	store, err := OpenFileCursorStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	conversation := mustC2C(t, "human-a")
	boundary := time.Date(2026, 8, 3, 2, 0, 0, 123000000, time.UTC)
	first := cursorFor(t, conversation, "z-id", 0, boundary)
	second := cursorFor(t, conversation, "a-id", 0, boundary)
	if err := store.Advance(nil, first); err != nil {
		t.Fatal(err)
	}
	if err := store.Advance(&first, second); err != nil {
		t.Fatalf("same-timestamp C2C advance: %v", err)
	}
	if err := store.Advance(&first, cursorFor(t, conversation, "late-old-generation", 0, boundary)); !errors.Is(err, ErrCursorConflict) {
		t.Fatalf("stale expected error = %v", err)
	}
	if err := store.Advance(&first, second); err != nil {
		t.Fatalf("idempotent retry = %v", err)
	}
	got, ok := store.Get(conversation)
	if !ok || got.MessageID != second.MessageID {
		t.Fatalf("cursor = %#v, %v", got, ok)
	}
}

func TestFileCursorStoreRejectsSequenceAndTimeRegression(t *testing.T) {
	t.Parallel()

	store, err := OpenFileCursorStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 8, 3, 3, 0, 0, 0, time.UTC)
	group := mustGroup(t, "group-a")
	current := cursorFor(t, group, "message-10", 10, now)
	if err := store.Advance(nil, current); err != nil {
		t.Fatal(err)
	}
	for _, next := range []MessageCursor{
		cursorFor(t, group, "message-9", 9, now.Add(time.Second)),
		cursorFor(t, group, "message-other-10", 10, now.Add(time.Second)),
		cursorFor(t, group, "message-11", 11, now.Add(-time.Second)),
	} {
		if err := store.Advance(&current, next); !errors.Is(err, ErrCursorRegression) {
			t.Fatalf("Advance(%#v) error = %v", next, err)
		}
	}
}

func TestFileCursorStoreRejectsCorruptSnapshot(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, CursorStoreFilename), []byte(`{"schemaVersion":1,"cursors":[`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := OpenFileCursorStore(root); !errors.Is(err, ErrCursorCorrupt) {
		t.Fatalf("OpenFileCursorStore() error = %v", err)
	}
}

func TestFileCursorStoreSeparatesBaselineGapAndOperatorRebase(t *testing.T) {
	t.Parallel()

	store, err := OpenFileCursorStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	conversation := mustC2C(t, "human-gap")
	now := time.Date(2026, 8, 3, 4, 0, 0, 0, time.UTC)
	baseline := cursorFor(t, conversation, "baseline", 0, now)
	if err := store.InitializeBaseline(baseline, BaselineNewInstall); err != nil {
		t.Fatal(err)
	}
	if err := store.InitializeBaseline(cursorFor(t, conversation, "other", 0, now), BaselineNewInstall); !errors.Is(err, ErrCursorConflict) {
		t.Fatalf("second baseline error = %v", err)
	}
	gap, err := store.MarkGap(conversation, &baseline, nil, GapDiagnostic{
		Code:       GapHistoryExpired,
		DetectedAt: now.Add(time.Minute),
	})
	if err != nil {
		t.Fatal(err)
	}
	latest := cursorFor(t, conversation, "latest", 0, now.Add(time.Hour))
	if err := store.RebaseGap(&baseline, gap.Version, latest, RebaseOperatorLatest); err != nil {
		t.Fatal(err)
	}
	got, ok := store.Get(conversation)
	if !ok || got.MessageID != latest.MessageID ||
		got.LastRebase == nil || got.LastRebase.Reason != RebaseOperatorLatest ||
		got.Baseline == nil || got.Baseline.Reason != BaselineNewInstall {
		t.Fatalf("rebased cursor = %#v, %v", got, ok)
	}
	if err := store.RebaseGap(&latest, gap.Version, cursorFor(t, conversation, "latest-2", 0, now.Add(2*time.Hour)), RebaseOperatorLatest); !errors.Is(err, ErrCursorNotInGap) {
		t.Fatalf("rebase outside gap error = %v", err)
	}
}

func TestFileCursorStorePersistsGapBeforeFirstCursor(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	store, err := OpenFileCursorStore(root)
	if err != nil {
		t.Fatal(err)
	}
	conversation := mustC2C(t, "human-no-cursor-gap")
	now := time.Date(2026, 8, 3, 5, 0, 0, 0, time.UTC)
	gap, err := store.MarkGap(conversation, nil, nil, GapDiagnostic{
		Code: GapHistoryExpired, DetectedAt: now,
	})
	if err != nil || gap.Version != 1 {
		t.Fatalf("MarkGap() = (%#v, %v)", gap, err)
	}
	reopened, err := OpenFileCursorStore(root)
	if err != nil {
		t.Fatal(err)
	}
	if loaded, ok := reopened.Gap(conversation); !ok || loaded.Version != gap.Version {
		t.Fatalf("Gap() = (%#v, %v)", loaded, ok)
	}
	latest := cursorFor(t, conversation, "latest", 0, now.Add(time.Hour))
	if err := reopened.InitializeBaseline(latest, BaselineNewInstall); !errors.Is(err, ErrCursorInGap) {
		t.Fatalf("baseline over gap error = %v", err)
	}
	if err := reopened.RebaseGap(nil, gap.Version, latest, RebaseOperatorLatest); err != nil {
		t.Fatal(err)
	}
	if _, ok := reopened.Gap(conversation); ok {
		t.Fatal("gap retained after explicit rebase")
	}
}

func TestFileCursorStorePersistsAndListsFirstUnconsumedBoundary(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	store, err := OpenFileCursorStore(root)
	if err != nil {
		t.Fatal(err)
	}
	conversation := mustC2C(t, "human-first-unconsumed")
	now := time.Date(2026, 8, 3, 5, 30, 0, 0, time.UTC)
	failed := cursorFor(t, conversation, "failed-first-message", 0, now)
	gap, err := store.MarkGap(conversation, nil, &failed, GapDiagnostic{
		Code: GapRuntimeFailed, DetectedAt: now.Add(time.Second),
	})
	if err != nil {
		t.Fatal(err)
	}
	if gap.FirstUnconsumed == nil || gap.FirstUnconsumed.MessageID != failed.MessageID {
		t.Fatalf("first unconsumed = %#v", gap.FirstUnconsumed)
	}

	reopened, err := OpenFileCursorStore(root)
	if err != nil {
		t.Fatal(err)
	}
	gaps := reopened.ListGaps()
	if len(gaps) != 1 || gaps[0].FirstUnconsumed == nil ||
		gaps[0].FirstUnconsumed.MessageID != failed.MessageID {
		t.Fatalf("ListGaps() = %#v", gaps)
	}
	gaps[0].FirstUnconsumed.MessageID = "mutated-by-caller"
	loaded, ok := reopened.Gap(conversation)
	if !ok || loaded.FirstUnconsumed == nil || loaded.FirstUnconsumed.MessageID != failed.MessageID {
		t.Fatalf("caller mutated persisted gap = %#v, %v", loaded, ok)
	}
	updated, err := reopened.MarkGap(conversation, nil, nil, GapDiagnostic{
		Code: GapRecoveryStalled, DetectedAt: now.Add(2 * time.Second),
	})
	if err != nil || updated.FirstUnconsumed == nil || updated.FirstUnconsumed.MessageID != failed.MessageID {
		t.Fatalf("updated gap lost first boundary = %#v, %v", updated, err)
	}
}

func TestFileCursorStoreOpensLegacySchemaWithoutGapBoundary(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	path := filepath.Join(root, CursorStoreFilename)
	legacy := `{"schemaVersion":1,"initialized":true,"cursors":[],"gaps":[{"kind":"c2c","peerUserId":"human-legacy","version":1,"code":"runtime_failed","detectedAt":"2026-08-03T05:30:00Z"}]}`
	if err := os.WriteFile(path, []byte(legacy), 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := OpenFileCursorStore(root)
	if err != nil {
		t.Fatal(err)
	}
	gaps := store.ListGaps()
	if len(gaps) != 1 || gaps[0].FirstUnconsumed != nil {
		t.Fatalf("legacy gaps = %#v", gaps)
	}
}

func TestFileCursorStoreRecoveryAdvancesAndClearsGapWithoutOperatorRebase(t *testing.T) {
	t.Parallel()
	store, err := OpenFileCursorStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	conversation := mustGroup(t, "group-recovery")
	now := time.Now().UTC()
	first := cursorFor(t, conversation, "message-1", 1, now)
	if err := store.Advance(nil, first); err != nil {
		t.Fatal(err)
	}
	gap, err := store.MarkGap(conversation, &first, nil, GapDiagnostic{
		Code: GapRuntimeFailed, DetectedAt: now.Add(time.Second),
	})
	if err != nil {
		t.Fatal(err)
	}
	second := cursorFor(t, conversation, "message-2", 2, now.Add(2*time.Second))
	if err := store.RecoverAdvance(&first, gap.Version, second); err != nil {
		t.Fatal(err)
	}
	if _, ok := store.Gap(conversation); ok {
		t.Fatal("successful history recovery left the conversation in gap")
	}
	current, ok := store.Get(conversation)
	if !ok || current.MessageID != second.MessageID || current.LastRebase != nil {
		t.Fatalf("recovered cursor = %#v, %v", current, ok)
	}
}

func cursorFor(t *testing.T, conversation im.Conversation, messageID string, sequence int64, timestamp time.Time) MessageCursor {
	t.Helper()
	reference, err := im.NewMessageRef(conversation, messageID, sequence, timestamp.UnixMilli())
	if err != nil {
		t.Fatal(err)
	}
	return NewMessageCursor(reference, timestamp.Add(time.Second))
}

func mustC2C(t *testing.T, userID string) im.Conversation {
	t.Helper()
	conversation, err := im.NewC2CConversation(userID)
	if err != nil {
		t.Fatal(err)
	}
	return conversation
}

func mustGroup(t *testing.T, groupID string) im.Conversation {
	t.Helper()
	conversation, err := im.NewGroupConversation(groupID)
	if err != nil {
		t.Fatal(err)
	}
	return conversation
}

func mustTopic(t *testing.T, groupID, topicID string) im.Conversation {
	t.Helper()
	conversation, err := im.NewTopicConversation(groupID, topicID)
	if err != nil {
		t.Fatal(err)
	}
	return conversation
}

func sameConversation(left, right im.Conversation) bool {
	return left.Kind() == right.Kind() &&
		left.PeerUserID() == right.PeerUserID() &&
		left.GroupID() == right.GroupID() &&
		left.TopicID() == right.TopicID()
}
