package wrapper

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestStoreImportCloudAgentRunEventRejectsConflictingSeq(t *testing.T) {
	store, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	run := cloudAgentRunRecord{
		RunID:     "job_event_conflict",
		SessionID: "session_event_conflict",
		Status:    "running",
	}
	if err := store.CreateCloudAgentRun(run); err != nil {
		t.Fatal(err)
	}
	event := cloudAgentRunEvent{
		Seq:       1,
		RunID:     run.RunID,
		SessionID: run.SessionID,
		Kind:      "assistant_text",
		Event:     json.RawMessage(`{"sessionUpdate":"agent_message_chunk","content":{"text":"hello"}}`),
		CreatedAt: time.Now().UTC(),
	}
	if err := store.ImportCloudAgentRunEvent(event); err != nil {
		t.Fatalf("first import failed: %v", err)
	}
	if err := store.ImportCloudAgentRunEvent(event); err != nil {
		t.Fatalf("same event import should be idempotent: %v", err)
	}
	event.Event = json.RawMessage(`{"sessionUpdate":"agent_message_chunk","content":{"text":"different"}}`)
	err = store.ImportCloudAgentRunEvent(event)
	if err == nil {
		t.Fatal("conflicting event import should fail")
	}
	if !strings.Contains(err.Error(), "event conflict") {
		t.Fatalf("conflicting import should explain ledger conflict, got %v", err)
	}
}

func TestStoreSeedCloudAgentRunEventsSkipsExistingLedgerSeq(t *testing.T) {
	store, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	session := &acpSession{
		SessionID:         "session_seed_existing",
		Scope:             Scope{TenantID: "tenant-a", ProjectID: "project-a"},
		Model:             "agent-sidecar-chat",
		CWD:               "/workspace",
		State:             acpRuntimeStateReady,
		RuntimeGeneration: 1,
		CreatedAt:         time.Now().UTC(),
		UpdatedAt:         time.Now().UTC(),
	}
	if err := store.SaveACPSession(session); err != nil {
		t.Fatalf("save session: %v", err)
	}
	turn, err := store.BeginACPPromptTurn(session.SessionID, "resp_seed_existing", "hello", nil)
	if err != nil {
		t.Fatalf("begin turn: %v", err)
	}
	run := cloudAgentRunRecord{
		RunID:     "job_seed_existing",
		SessionID: session.SessionID,
		TurnID:    turn.TurnID,
		Status:    "running",
	}
	if err := store.CreateCloudAgentRun(run); err != nil {
		t.Fatalf("create run: %v", err)
	}
	if err := store.SeedCloudAgentRunEventsFromTurn(run.RunID); err != nil {
		t.Fatalf("initial seed: %v", err)
	}
	rawAssistantEvent := json.RawMessage(`{"sessionUpdate":"agent_message_chunk","content":{"text":"ledger"}}`)
	if err := store.AppendCloudAgentRunEvent(run.RunID, "assistant_text", rawAssistantEvent); err != nil {
		t.Fatalf("append durable assistant event: %v", err)
	}
	if _, _, err := store.UpsertACPAssistantBlock(session.SessionID, turn.TurnID, turn.AssistantMessageID, "resp_seed_existing", "text", "", map[string]any{
		"sessionUpdate": "agent_message_chunk",
		"messageId":     turn.AssistantMessageID,
		"blockId":       "block_seed_existing",
		"content":       map[string]any{"text": "transcript"},
	}); err != nil {
		t.Fatalf("upsert assistant block: %v", err)
	}
	if err := store.SeedCloudAgentRunEventsFromTurn(run.RunID); err != nil {
		t.Fatalf("seed should skip existing ledger seq instead of reporting transcript conflict: %v", err)
	}
	_, events, err := store.CloudAgentRunEventsSince(session.Scope, run.RunID, 0)
	if err != nil {
		t.Fatalf("load events: %v", err)
	}
	if len(events) != 2 {
		t.Fatalf("seed should not duplicate existing ledger events, got %#v", events)
	}
	if string(events[1].Event) != string(rawAssistantEvent) {
		t.Fatalf("durable ledger event should remain authoritative over transcript fallback: %s", events[1].Event)
	}
}

func TestStoreCloudAgentRunTerminalStatusIsNotOverwritten(t *testing.T) {
	store, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	run := cloudAgentRunRecord{
		RunID:     "job_terminal_once",
		SessionID: "session_terminal_once",
		Status:    "running",
	}
	if err := store.CreateCloudAgentRun(run); err != nil {
		t.Fatal(err)
	}
	if err := store.UpdateCloudAgentRun(run.RunID, "completed", "end_turn", "", ""); err != nil {
		t.Fatal(err)
	}
	if err := store.UpdateCloudAgentRun(run.RunID, "cancelled", "cancelled", "", ""); err != nil {
		t.Fatal(err)
	}
	if err := store.UpdateCloudAgentRun(run.RunID, "completed", "end_turn", "", "final output"); err != nil {
		t.Fatal(err)
	}

	loaded := loadCloudAgentRunForTest(t, store, run.RunID)
	if loaded.Status != "completed" || loaded.StopReason != "end_turn" || loaded.OutputText != "final output" {
		t.Fatalf("terminal run should keep first terminal status while allowing same-status output fill, got %#v", loaded)
	}
}

func loadCloudAgentRunForTest(t *testing.T, store *Store, runID string) cloudAgentRunRecord {
	t.Helper()
	store.mu.Lock()
	defer store.mu.Unlock()
	run, err := store.loadCloudAgentRunLocked(runID)
	if err != nil {
		t.Fatal(err)
	}
	return run
}
