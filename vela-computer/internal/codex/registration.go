package codex

import (
	"git.woa.com/wisp/mono2/vela-computer/internal/runtimeapi"
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
