package runtimes

import (
	"git.woa.com/wisp/mono2/vela-computer/internal/codex"
	"git.woa.com/wisp/mono2/vela-computer/internal/hermes"
	"git.woa.com/wisp/mono2/vela-computer/internal/hermesgateway"
	"git.woa.com/wisp/mono2/vela-computer/internal/openclaw"
	"git.woa.com/wisp/mono2/vela-computer/internal/runtimeapi"
)

type Options struct {
	Version            string
	CodexExecutable    string
	OpenClawExecutable string
}

func Builtins(options Options) []runtimeapi.Registration {
	return []runtimeapi.Registration{
		codex.Registration(codex.Options{
			Version:    options.Version,
			Executable: options.CodexExecutable,
		}),
		hermes.Registration(hermes.Options{Version: options.Version}),
		hermesgateway.Registration(hermesgateway.Options{
			Version: options.Version,
		}),
		openclaw.Registration(openclaw.Options{
			Version:    options.Version,
			Executable: options.OpenClawExecutable,
		}),
	}
}
