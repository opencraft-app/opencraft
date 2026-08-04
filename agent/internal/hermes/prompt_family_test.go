package hermes

import (
	"encoding/json"
	"errors"
	"testing"
	"time"

	"velachat/agent/internal/runtimeapi"
)

func TestPromptFamilyResolvesResponseOrders(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		order []int64
		want  []promptResolution
	}{
		{
			name:  "child before root",
			order: []int64{2, 1},
			want: []promptResolution{
				{RequestID: 2, Generation: 1, Ordinal: 2, EarlyChild: true},
				{RequestID: 1, Generation: 1, Ordinal: 1, Complete: true},
			},
		},
		{
			name:  "root before child",
			order: []int64{1, 2},
			want: []promptResolution{
				{RequestID: 1, Generation: 1, Ordinal: 1, PromotedRequestID: 2},
				{RequestID: 2, Generation: 1, Ordinal: 2, Complete: true},
			},
		},
		{
			name:  "later child before root",
			order: []int64{3, 1, 2},
			want: []promptResolution{
				{RequestID: 3, Generation: 1, Ordinal: 3, EarlyChild: true},
				{RequestID: 1, Generation: 1, Ordinal: 1, PromotedRequestID: 2},
				{RequestID: 2, Generation: 1, Ordinal: 2, Complete: true},
			},
		},
		{
			name:  "fifo promotion",
			order: []int64{1, 2, 3},
			want: []promptResolution{
				{RequestID: 1, Generation: 1, Ordinal: 1, PromotedRequestID: 2},
				{RequestID: 2, Generation: 1, Ordinal: 2, PromotedRequestID: 3},
				{RequestID: 3, Generation: 1, Ordinal: 3, Complete: true},
			},
		},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			var family promptFamily
			if _, err := family.Start(1); err != nil {
				t.Fatal(err)
			}
			if _, err := family.Append(2); err != nil {
				t.Fatal(err)
			}
			if _, err := family.Append(3); err != nil && len(test.order) > 2 {
				t.Fatal(err)
			}
			if len(test.order) == 2 {
				family.Rollback(3)
			}

			for index, requestID := range test.order {
				got, ok := family.Resolve(requestID)
				if !ok {
					t.Fatalf("Resolve(%d) was not tracked", requestID)
				}
				if got != test.want[index] {
					t.Fatalf(
						"Resolve(%d) = %#v, want %#v",
						requestID,
						got,
						test.want[index],
					)
				}
			}
			if family.Active() {
				t.Fatal("prompt family remained active after terminal resolution")
			}
		})
	}
}

func TestPromptFamilyGenerationRollbackAndBounds(t *testing.T) {
	t.Parallel()

	var family promptFamily
	first, err := family.Start(11)
	if err != nil {
		t.Fatal(err)
	}
	if first.Generation != 1 || first.Ordinal != 1 {
		t.Fatalf("first member = %#v", first)
	}
	if _, err := family.Start(12); !errors.Is(err, ErrPrimaryTurnActive) {
		t.Fatalf("second Start error = %v", err)
	}
	child, err := family.Append(12)
	if err != nil {
		t.Fatal(err)
	}
	if child.Generation != 1 || child.Ordinal != 2 {
		t.Fatalf("child member = %#v", child)
	}
	if !family.Rollback(12) || !family.Active() {
		t.Fatal("child rollback cleared the active root")
	}
	if !family.Rollback(11) || family.Active() {
		t.Fatal("root rollback did not clear the family")
	}
	second, err := family.Start(21)
	if err != nil {
		t.Fatal(err)
	}
	if second.Generation != 2 || second.Ordinal != 1 {
		t.Fatalf("second generation root = %#v", second)
	}

	for index := 1; index < maxPromptFamilyMembers; index++ {
		if _, err := family.Append(int64(21 + index)); err != nil {
			t.Fatalf("Append at %d: %v", index, err)
		}
	}
	if _, err := family.Append(9999); !errors.Is(err, ErrPromptFamilyFull) {
		t.Fatalf("overflow error = %v", err)
	}
}

func TestPromptResponseWaitsForLocalWriteCommit(t *testing.T) {
	t.Parallel()

	session := &session{
		events:   make(chan runtimeapi.Event, 4),
		pending:  make(map[int64]pendingCall),
		launchID: "launch-response-before-commit",
	}
	session.initActionDispatcher()
	defer session.closeEvents()
	if _, err := session.promptFamily.Start(1); err != nil {
		t.Fatal(err)
	}
	session.nextID = 1
	session.pending[1] = pendingCall{
		method:     "session/prompt",
		prompt:     true,
		promptRoot: true,
	}
	session.dispatch(rpcMessage{
		ID:        json.RawMessage("1"),
		Result:    json.RawMessage(`{"stopReason":"end_turn"}`),
		hasID:     true,
		hasResult: true,
	})
	select {
	case event := <-session.events:
		t.Fatalf("response overtook local write commit: %#v", event)
	case <-time.After(50 * time.Millisecond):
	}
	if !session.promptFamily.Active() {
		t.Fatal("uncommitted response resolved the active family")
	}

	session.commitPrompt(1)
	first := <-session.events
	second := <-session.events
	if first.Kind != runtimeapi.EventActivity ||
		second.Kind != runtimeapi.EventTurnCompletion {
		t.Fatalf("committed prompt events = %#v then %#v", first, second)
	}
}
