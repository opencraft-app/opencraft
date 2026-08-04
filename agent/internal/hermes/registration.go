package hermes

import (
	"velachat/agent/internal/runtimeapi"
	"velachat/agent/internal/runtimeprompt"
)

func Registration(options Options) runtimeapi.Registration {
	return runtimeapi.Registration{
		ID:          "hermes-acp",
		WireID:      "opencode",
		DisplayName: "Hermes ACP",
		NewDriver: func() (runtimeapi.RuntimeDriver, error) {
			return New(options), nil
		},
		Policy:        runtimePolicy(),
		LaunchPlanner: runtimeprompt.NewPersistentPlanner("hermes-acp"),
	}
}

func runtimePolicy() runtimeapi.RuntimePolicy {
	return runtimeapi.RuntimePolicy{
		SupportsStdin: true,
		BusyMode:      runtimeapi.BusyDeliveryDirect,
		Completion:    runtimeapi.CompletionEvent,
	}
}
