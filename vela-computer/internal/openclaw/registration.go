package openclaw

import (
	"git.woa.com/wisp/mono2/vela-computer/internal/runtimeapi"
	"git.woa.com/wisp/mono2/vela-computer/internal/runtimeprompt"
)

func Registration(options Options) runtimeapi.Registration {
	return runtimeapi.Registration{
		ID:          "openclaw",
		DisplayName: "OpenClaw",
		NewDriver: func() (runtimeapi.RuntimeDriver, error) {
			return New(options), nil
		},
		Policy: runtimeapi.RuntimePolicy{
			SupportsStdin: true,
			BusyMode:      runtimeapi.BusyDeliveryNone,
			Completion:    runtimeapi.CompletionEvent,
		},
		LaunchPlanner: runtimeprompt.NewPersistentPlanner("openclaw"),
	}
}
