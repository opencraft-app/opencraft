package wrapper

import (
	"encoding/json"
	"testing"
)

func TestACPReplayUpdateFiltersLegacyPrivateLifecycleMarkers(t *testing.T) {
	for _, kind := range []string{"error", "lifecycle", "replay_done", "replay_gap", "turn_complete"} {
		t.Run(kind, func(t *testing.T) {
			payload, err := json.Marshal(map[string]any{"sessionUpdate": kind})
			if err != nil {
				t.Fatal(err)
			}
			if update, ok := acpReplayUpdate(acpSessionEvent{
				SessionID: "session_1",
				Payload:   payload,
			}); ok {
				t.Fatalf("legacy private lifecycle marker should not replay as session/update: %#v", update)
			}
		})
	}
}

func TestACPReplayUpdateKeepsStandardMessageReplay(t *testing.T) {
	payload, err := json.Marshal(map[string]any{
		"sessionUpdate": "agent_message_chunk",
		"content":       map[string]any{"text": "hello"},
	})
	if err != nil {
		t.Fatal(err)
	}
	replay, ok := acpReplayUpdate(acpSessionEvent{
		SessionID: "session_1",
		TurnID:    "turn_1",
		MessageID: "message_1",
		BlockID:   "block_1",
		Seq:       7,
		Payload:   payload,
	})
	if !ok {
		t.Fatal("standard message update should remain replayable")
	}
	params := replay["update"].(map[string]any)
	if params["replay"] != true {
		t.Fatalf("expected replay marker on historical update: %#v", params)
	}
	if params["sessionUpdate"] != "agent_message_chunk" || params["turnId"] != "turn_1" || params["messageId"] != "message_1" || params["blockId"] != "block_1" {
		t.Fatalf("unexpected replay payload: %#v", params)
	}
}
