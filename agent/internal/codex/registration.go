package codex

import (
	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/runtimeapi"
)

func Registration(options Options) runtimeapi.Registration {
	return runtimeapi.Registration{
		ID:          "codex",
		DisplayName: "Codex CLI",
		NewDriver: func() (runtimeapi.RuntimeDriver, error) {
			return New(options), nil
		},
		Policy:        runtimePolicy(),
		LaunchPlanner: NewLaunchPlanner(),
	}
}

func runtimePolicy() runtimeapi.RuntimePolicy {
	return runtimeapi.RuntimePolicy{
		SupportsStdin: true,
		BusyMode:      runtimeapi.BusyDeliveryDirect,
		Completion:    runtimeapi.CompletionEvent,
	}
}
