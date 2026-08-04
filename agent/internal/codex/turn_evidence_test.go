package codex

import "testing"

func TestTurnEvidenceDetectsAcceptedNonEmptyTurnWithoutRuntimeEvidence(t *testing.T) {
	t.Parallel()

	var evidence turnEvidenceState
	evidence.markAcceptedInput("turn-1", true)
	evidence.markStarted("turn-1")

	completion := evidence.markCompleted()
	if !completion.ZeroEvidence || completion.InputEvidence != "nonempty" {
		t.Fatalf("completion = %#v", completion)
	}
}

func TestTurnEvidenceHandlesStartedBeforeAcceptedResponse(t *testing.T) {
	t.Parallel()

	var evidence turnEvidenceState
	evidence.markStarted("turn-1")
	evidence.markAcceptedInput("turn-1", true)

	completion := evidence.markCompleted()
	if !completion.ZeroEvidence || completion.InputEvidence != "nonempty" {
		t.Fatalf("completion = %#v", completion)
	}
}

func TestTurnEvidenceRequiresTurnStarted(t *testing.T) {
	t.Parallel()

	var evidence turnEvidenceState
	evidence.markAcceptedInput("turn-1", true)

	if completion := evidence.markCompleted(); completion.ZeroEvidence {
		t.Fatalf("completion without turn/started = %#v", completion)
	}
}

func TestTurnEvidenceAcceptsRuntimeActivityOrTokenUsage(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		mark func(*turnEvidenceState)
	}{
		{
			name: "runtime activity",
			mark: func(evidence *turnEvidenceState) {
				evidence.markRuntimeActivity()
			},
		},
		{
			name: "valid token usage",
			mark: func(evidence *turnEvidenceState) {
				evidence.markTokenUsage()
			},
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			var evidence turnEvidenceState
			evidence.markAcceptedInput("turn-1", true)
			evidence.markStarted("turn-1")
			test.mark(&evidence)
			if completion := evidence.markCompleted(); completion.ZeroEvidence {
				t.Fatalf("completion with %s = %#v", test.name, completion)
			}
		})
	}
}

func TestTurnEvidenceDoesNotReviveCompletedTurnInput(t *testing.T) {
	t.Parallel()

	var evidence turnEvidenceState
	evidence.markStarted("turn-old")
	evidence.markRuntimeActivity()
	evidence.markCompleted()
	evidence.markAcceptedInput("turn-old", true)

	evidence.markStarted("turn-new")
	completion := evidence.markCompleted()
	if !completion.ZeroEvidence || completion.InputEvidence != "unknown" {
		t.Fatalf("new completion inherited old input = %#v", completion)
	}
}

func TestTurnEvidencePreservesActiveIDAcrossFalsyRepeatedStart(t *testing.T) {
	t.Parallel()

	var state turnEvidenceState
	state.markStarted("turn-primary")
	state.markRuntimeActivity()
	state.markStarted("")

	completion := state.markCompleted()
	if !completion.ZeroEvidence {
		t.Fatal("repeated start did not reset per-turn Runtime evidence")
	}
	if !state.wasCompleted("turn-primary") {
		t.Fatal("falsy repeated start lost the completed active turn identity")
	}
}
