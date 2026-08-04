package runtimes

import (
	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/codex"
	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/hermes"
	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/hermesgateway"
	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/runtimeapi"
)

type Options struct {
	Version         string
	CodexExecutable string
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
	}
}
