package codex

import (
	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/runtimeapi"
	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/runtimeprompt"
)

// Kept in the Codex package for compatibility with the existing fixture tests.
const responseTargetHint = "Reply in the channel or create/reply in a thread as appropriate; " +
	"use each message's `target` and `msg` fields to choose the exact target."

const codexMessageDeliveryText = "New inbox updates may be delivered to you automatically " +
	"while your process stays alive."

const codexBusyDeliveryNote = "\n\nNote: While you are busy, the daemon may write batched " +
	"content-free inbox updates into your active turn. Finish your current step, then check " +
	"the inbox or read messages at a natural breakpoint."

type LaunchPlanner struct {
	inner runtimeprompt.PersistentPlanner
}

func NewLaunchPlanner() LaunchPlanner {
	return LaunchPlanner{
		inner: runtimeprompt.NewPersistentPlanner("codex"),
	}
}

func (planner LaunchPlanner) PlanLaunch(
	input runtimeapi.LaunchInput,
) (runtimeapi.LaunchPlan, error) {
	return planner.inner.PlanLaunch(input)
}
