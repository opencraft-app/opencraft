package gatedsteering

import "testing"

func TestToolBoundaryFlushRequiresLastOutstandingTool(t *testing.T) {
	t.Parallel()

	state := Initial()
	first := Apply(state, Input{Signal: ToolCall})
	second := Apply(first.State, Input{Signal: ToolCall})
	if second.State.Phase != PhaseToolWait ||
		second.State.OutstandingTools != 2 ||
		second.FlushToolBatch {
		t.Fatalf("nested tool call decision = %#v", second)
	}

	oneLeft := Apply(second.State, Input{Signal: ToolOutput})
	if oneLeft.State.Phase != PhaseToolBoundary ||
		oneLeft.State.OutstandingTools != 1 ||
		oneLeft.FlushToolBatch {
		t.Fatalf("first tool output decision = %#v", oneLeft)
	}
	last := Apply(oneLeft.State, Input{Signal: ToolOutput})
	if last.State.OutstandingTools != 0 ||
		!last.HadOutstandingTool ||
		!last.FlushToolBatch {
		t.Fatalf("last tool output decision = %#v", last)
	}
	extra := Apply(last.State, Input{Signal: ToolOutput})
	if extra.State.OutstandingTools != 0 ||
		extra.HadOutstandingTool ||
		extra.FlushToolBatch {
		t.Fatalf("extra tool output decision = %#v", extra)
	}
}

func TestCompactionAndReviewBoundariesPlanOneBusyNotification(t *testing.T) {
	t.Parallel()

	compacting := Apply(Initial(), Input{Signal: CompactionStarted})
	if compacting.State.Phase != PhaseCompacting || !compacting.State.Compacting {
		t.Fatalf("compaction start = %#v", compacting)
	}
	compacted := Apply(compacting.State, Input{
		Signal:               CompactionFinished,
		HasSession:           true,
		SupportsStdin:        true,
		InboxLength:          2,
		PendingNotifications: 1,
	})
	if compacted.State.Phase != PhaseAssistantContinuation ||
		compacted.State.Compacting ||
		len(compacted.Effects) != 1 ||
		compacted.Effects[0] != (Effect{
			Kind:     EffectNotifyStdin,
			Reason:   "compaction_finished",
			Mode:     "busy",
			ClauseID: "SMR-002",
		}) {
		t.Fatalf("compaction finish = %#v", compacted)
	}

	reviewing := Apply(compacted.State, Input{Signal: ReviewStarted})
	if !reviewing.State.ReviewKnown ||
		!reviewing.State.Reviewing ||
		reviewing.State.Phase != PhaseReviewing {
		t.Fatalf("review start = %#v", reviewing)
	}
	reviewed := Apply(reviewing.State, Input{
		Signal:               ReviewFinished,
		HasSession:           true,
		SupportsStdin:        true,
		InboxLength:          1,
		PendingNotifications: 1,
	})
	if reviewed.State.Reviewing ||
		reviewed.State.Phase != PhaseAssistantContinuation ||
		len(reviewed.Effects) != 1 ||
		reviewed.Effects[0].Reason != "review_finished" {
		t.Fatalf("review finish = %#v", reviewed)
	}
}

func TestTurnEndResetsBoundariesAndChoosesIdleDelivery(t *testing.T) {
	t.Parallel()

	state := Initial()
	state.OutstandingTools = 2
	state.Compacting = true
	state.ReviewKnown = true
	state.Reviewing = true
	state.ToolBoundaryFlushDisabled = true
	state.LastFlushReason = "tool_batch"

	queued := Apply(state, Input{
		Signal:        TurnEnded,
		InboxLength:   3,
		SupportsStdin: true,
		HasSession:    true,
	})
	if queued.State.Idle ||
		queued.State.Phase != PhaseIdle ||
		queued.State.OutstandingTools != 0 ||
		queued.State.Compacting ||
		queued.State.Reviewing ||
		!queued.State.ToolBoundaryFlushDisabled ||
		queued.State.LastFlushReason != "tool_batch" ||
		len(queued.Effects) != 1 ||
		queued.Effects[0].Kind != EffectDeliverStdin ||
		queued.Effects[0].Mode != "idle" {
		t.Fatalf("queued turn end = %#v", queued)
	}

	idle := Apply(queued.State, Input{
		Signal:        TurnEnded,
		SupportsStdin: true,
		HasSession:    true,
	})
	if !idle.State.Idle || len(idle.Effects) != 0 {
		t.Fatalf("idle turn end = %#v", idle)
	}
}

func TestErrorPreservesToolCountAndPermanentlyDisablesToolFlush(t *testing.T) {
	t.Parallel()

	state := Initial()
	state.OutstandingTools = 2
	state.Compacting = true
	state.ReviewKnown = true
	state.Reviewing = true
	decision := Apply(state, Input{
		Signal:                   RuntimeError,
		TerminalWakeable:         true,
		DisableToolBoundaryFlush: true,
	})
	if !decision.State.Idle ||
		decision.State.Phase != PhaseError ||
		decision.State.OutstandingTools != 2 ||
		decision.State.Compacting ||
		decision.State.Reviewing ||
		!decision.State.ToolBoundaryFlushDisabled ||
		!decision.DisabledToolBoundaryFlush {
		t.Fatalf("error decision = %#v", decision)
	}
	if reset := Apply(decision.State, Input{Signal: AssistantContinued}); !reset.State.ToolBoundaryFlushDisabled {
		t.Fatalf("assistant continuation re-enabled the safety fence: %#v", reset)
	}
}

func TestBusyFlushReadinessReturnsStableBlockedReasons(t *testing.T) {
	t.Parallel()

	testCases := []struct {
		name  string
		state State
		input FlushInput
		want  string
	}{
		{"non gated", Initial(), FlushInput{}, "non_gated"},
		{"missing session", Initial(), FlushInput{Gated: true}, "missing_session"},
		{"empty inbox", Initial(), FlushInput{Gated: true, HasSession: true}, "empty_inbox"},
		{
			"disabled",
			State{ToolBoundaryFlushDisabled: true},
			FlushInput{Gated: true, HasSession: true, InboxLength: 1},
			"tool_boundary_flush_disabled",
		},
		{
			"compacting",
			State{Compacting: true},
			FlushInput{Gated: true, HasSession: true, InboxLength: 1},
			"compacting",
		},
		{
			"reviewing",
			State{ReviewKnown: true, Reviewing: true},
			FlushInput{Gated: true, HasSession: true, InboxLength: 1},
			"reviewing",
		},
		{
			"tools",
			State{OutstandingTools: 1},
			FlushInput{Gated: true, HasSession: true, InboxLength: 1},
			"outstanding_tool_uses",
		},
	}
	for _, testCase := range testCases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			got := BusyFlushReadiness(testCase.state, testCase.input)
			if got.ShouldNotify ||
				got.BlockedReason != testCase.want ||
				len(got.Effects) != 0 {
				t.Fatalf("BusyFlushReadiness() = %#v", got)
			}
		})
	}
	ready := BusyFlushReadiness(Initial(), FlushInput{
		Gated:       true,
		HasSession:  true,
		InboxLength: 1,
		Reason:      "tool_batch",
	})
	if !ready.ShouldNotify ||
		ready.BlockedReason != "" ||
		len(ready.Effects) != 1 ||
		ready.Effects[0] != (Effect{
			Kind:     EffectNotifyStdin,
			Reason:   "tool_batch",
			Mode:     "busy",
			ClauseID: "SMR-002",
		}) {
		t.Fatalf("ready flush = %#v", ready)
	}
}

func TestRecentEventHistoryIsBoundedAndIncludesReviewOnlyWhenKnown(t *testing.T) {
	t.Parallel()

	state := Initial()
	state = RecordEvent(state, "start")
	if len(state.RecentEvents) != 1 ||
		state.RecentEvents[0] != "start:idle:tools=0:compact=false" {
		t.Fatalf("initial history = %#v", state.RecentEvents)
	}
	state.ReviewKnown = true
	state.Reviewing = true
	for index := 0; index < 13; index++ {
		state = RecordEvent(state, "event")
	}
	if len(state.RecentEvents) != 12 ||
		state.RecentEvents[11] != "event:idle:tools=0:compact=false:review=true" {
		t.Fatalf("bounded history = %#v", state.RecentEvents)
	}
}
