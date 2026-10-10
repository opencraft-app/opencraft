package runtimes

import (
	"velachat/agent/internal/codex"
	"velachat/agent/internal/hermes"
	"velachat/agent/internal/hermesgateway"
	"velachat/agent/internal/openclaw"
	"velachat/agent/internal/runtimeapi"
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
