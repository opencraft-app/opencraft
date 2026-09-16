package hermes

import (
	"git.woa.com/wisp/mono2/vela-computer/internal/runtimeapi"
	"git.woa.com/wisp/mono2/vela-computer/internal/runtimeprompt"
)

func Registration(options Options) runtimeapi.Registration {
	return runtimeapi.Registration{
		ID:          "hermes-acp",
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
