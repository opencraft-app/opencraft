package gatedsteering

import "fmt"

const maximumRecentEvents = 12

type Phase string

const (
	PhaseIdle                  Phase = "idle"
	PhaseToolWait              Phase = "tool_wait"
	PhaseToolBoundary          Phase = "tool_boundary"
	PhaseCompacting            Phase = "compacting"
	PhaseReviewing             Phase = "reviewing"
	PhaseAssistantContinuation Phase = "assistant_continuation"
	PhaseError                 Phase = "error"
)

type State struct {
	Idle                      bool
	ExpectedTerminationReason string
	Phase                     Phase
	OutstandingTools          int
	Compacting                bool
	ReviewKnown               bool
	Reviewing                 bool
	ToolBoundaryFlushDisabled bool
	LastFlushReason           string
	RecentEvents              []string
}

func Initial() State {
	return State{
		Phase:        PhaseIdle,
		RecentEvents: []string{},
	}
}

type Signal string

const (
	AssistantContinued    Signal = "assistant_continued"
	ToolCall              Signal = "tool_call"
	ToolOutput            Signal = "tool_output"
	CompactionStarted     Signal = "compaction_started"
	CompactionFinished    Signal = "compaction_finished"
	CompactionInterrupted Signal = "compaction_interrupted"
	ReviewStarted         Signal = "review_started"
	ReviewFinished        Signal = "review_finished"
	TurnEnded             Signal = "turn_ended"
	RuntimeError          Signal = "runtime_error"
)

type Input struct {
	Signal                   Signal
	InboxLength              int
	PendingNotifications     int
	SupportsStdin            bool
	HasSession               bool
	CanDeliverWithoutSession bool
	TerminateOnTurnEnd       bool
	TerminalWakeable         bool
	DisableToolBoundaryFlush bool
}

type EffectKind string

const (
	EffectNotifyStdin  EffectKind = "notify_stdin"
	EffectDeliverStdin EffectKind = "deliver_stdin"
)

type Effect struct {
	Kind     EffectKind
	Reason   string
	Mode     string
	ClauseID string
}

type Decision struct {
	State                     State
	Effects                   []Effect
	HadOutstandingTool        bool
	FlushToolBatch            bool
	DisabledToolBoundaryFlush bool
}

func Apply(state State, input Input) Decision {
	next := cloneState(state)
	decision := Decision{State: next}
	switch input.Signal {
	case ToolCall:
		decision.State.Idle = false
		decision.State.Phase = PhaseToolWait
		decision.HadOutstandingTool = decision.State.OutstandingTools > 0
		decision.State.OutstandingTools++
	case ToolOutput:
		decision.State.Idle = false
		decision.State.Phase = PhaseToolBoundary
		decision.HadOutstandingTool = decision.State.OutstandingTools > 0
		if decision.HadOutstandingTool {
			decision.State.OutstandingTools--
		}
		decision.FlushToolBatch = decision.HadOutstandingTool &&
			decision.State.OutstandingTools == 0
	case CompactionStarted:
		decision.State.Idle = false
		decision.State.Phase = PhaseCompacting
		decision.State.Compacting = true
	case CompactionInterrupted:
		decision.State.Idle = false
		decision.State.Compacting = false
	case CompactionFinished:
		decision.State.Idle = false
		decision.State.Phase = PhaseAssistantContinuation
		decision.State.Compacting = false
		decision.Effects = boundaryNotification(
			"compaction_finished",
			input,
		)
	case ReviewStarted:
		decision.State.Idle = false
		decision.State.Phase = PhaseReviewing
		decision.State.ReviewKnown = true
		decision.State.Reviewing = true
	case ReviewFinished:
		decision.State.Idle = false
		decision.State.Phase = PhaseAssistantContinuation
		decision.State.ReviewKnown = true
		decision.State.Reviewing = false
		decision.Effects = boundaryNotification("review_finished", input)
	case TurnEnded:
		deliverQueued := input.InboxLength > 0 &&
			input.SupportsStdin &&
			(input.HasSession || input.CanDeliverWithoutSession)
		decision.State.Idle = !deliverQueued
		decision.State.Phase = PhaseIdle
		decision.State.OutstandingTools = 0
		decision.State.Compacting = false
		if decision.State.ReviewKnown {
			decision.State.Reviewing = false
		}
		if input.TerminateOnTurnEnd {
			decision.State.ExpectedTerminationReason = "turn_end"
		}
		if deliverQueued {
			decision.Effects = []Effect{stdinEffect(
				EffectDeliverStdin,
				"turn_end",
				"idle",
			)}
		}
	case RuntimeError:
		decision.State.Idle = input.TerminalWakeable
		decision.State.Phase = PhaseError
		decision.State.Compacting = false
		if decision.State.ReviewKnown {
			decision.State.Reviewing = false
		}
		decision.DisabledToolBoundaryFlush = input.DisableToolBoundaryFlush
		decision.State.ToolBoundaryFlushDisabled =
			decision.State.ToolBoundaryFlushDisabled ||
				input.DisableToolBoundaryFlush
	case AssistantContinued:
		decision.State.Idle = false
		decision.State.Phase = PhaseAssistantContinuation
	}
	return decision
}

func boundaryNotification(reason string, input Input) []Effect {
	if !input.HasSession ||
		!input.SupportsStdin ||
		input.InboxLength == 0 ||
		input.PendingNotifications == 0 {
		return nil
	}
	return []Effect{stdinEffect(EffectNotifyStdin, reason, "busy")}
}

func stdinEffect(kind EffectKind, reason string, mode string) Effect {
	return Effect{
		Kind:     kind,
		Reason:   reason,
		Mode:     mode,
		ClauseID: "SMR-002",
	}
}

type FlushInput struct {
	Gated       bool
	HasSession  bool
	InboxLength int
	Reason      string
}

type FlushDecision struct {
	ShouldNotify  bool
	BlockedReason string
	Effects       []Effect
}

func BusyFlushReadiness(state State, input FlushInput) FlushDecision {
	blocked := ""
	switch {
	case !input.Gated:
		blocked = "non_gated"
	case !input.HasSession:
		blocked = "missing_session"
	case input.InboxLength == 0:
		blocked = "empty_inbox"
	case state.ToolBoundaryFlushDisabled:
		blocked = "tool_boundary_flush_disabled"
	case state.Compacting:
		blocked = "compacting"
	case state.ReviewKnown && state.Reviewing:
		blocked = "reviewing"
	case state.OutstandingTools > 0:
		blocked = "outstanding_tool_uses"
	}
	if blocked != "" {
		return FlushDecision{BlockedReason: blocked, Effects: []Effect{}}
	}
	return FlushDecision{
		ShouldNotify: true,
		Effects: []Effect{
			stdinEffect(EffectNotifyStdin, input.Reason, "busy"),
		},
	}
}

func RecordEvent(state State, event string) State {
	next := cloneState(state)
	review := ""
	if next.ReviewKnown {
		review = fmt.Sprintf(":review=%t", next.Reviewing)
	}
	summary := fmt.Sprintf(
		"%s:%s:tools=%d:compact=%t%s",
		event,
		next.Phase,
		next.OutstandingTools,
		next.Compacting,
		review,
	)
	next.RecentEvents = append(next.RecentEvents, summary)
	if len(next.RecentEvents) > maximumRecentEvents {
		next.RecentEvents = append(
			[]string(nil),
			next.RecentEvents[len(next.RecentEvents)-maximumRecentEvents:]...,
		)
	}
	return next
}

func MarkFlushed(state State, reason string) State {
	next := cloneState(state)
	next.LastFlushReason = reason
	return next
}

func ExpectTermination(state State, reason string) State {
	next := cloneState(state)
	next.ExpectedTerminationReason = reason
	return next
}

func cloneState(state State) State {
	state.RecentEvents = append([]string(nil), state.RecentEvents...)
	return state
}
