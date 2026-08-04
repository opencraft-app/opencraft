package hermesgateway

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/hermes"
	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/runtimeapi"
	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/runtimeprompt"
)

type Options struct {
	PythonExecutable string
	PythonArgsPrefix []string
	HermesExecutable string
	HermesArgsPrefix []string
	Version          string
	TrustedHome      string
	RuntimeLeaseWait time.Duration
}

type Driver struct {
	pythonExecutable string
	pythonArgsPrefix []string
	hermesExecutable string
	version          string
	trustedHome      string
	homeErr          error
	runtimeLeaseWait time.Duration
	hostDriver       *hermes.Driver
}

var _ runtimeapi.RuntimeDriver = (*Driver)(nil)

func New(options Options) *Driver {
	version := strings.TrimSpace(options.Version)
	if version == "" {
		version = "0.1.0-dev"
	}
	trustedHome := strings.TrimSpace(options.TrustedHome)
	var homeErr error
	if trustedHome == "" {
		trustedHome, homeErr = os.UserHomeDir()
	}
	if homeErr == nil {
		if !filepath.IsAbs(trustedHome) {
			homeErr = errors.New(
				"Hermes Gateway trusted OS-user home is not absolute",
			)
		} else {
			trustedHome = filepath.Clean(trustedHome)
		}
	}
	return &Driver{
		pythonExecutable: strings.TrimSpace(options.PythonExecutable),
		pythonArgsPrefix: append([]string(nil), options.PythonArgsPrefix...),
		hermesExecutable: strings.TrimSpace(options.HermesExecutable),
		version:          version,
		trustedHome:      trustedHome,
		homeErr:          homeErr,
		runtimeLeaseWait: options.RuntimeLeaseWait,
		hostDriver: hermes.New(hermes.Options{
			Executable:       strings.TrimSpace(options.HermesExecutable),
			ArgsPrefix:       append([]string(nil), options.HermesArgsPrefix...),
			Version:          version,
			TrustedHome:      strings.TrimSpace(options.TrustedHome),
			RuntimeLeaseWait: options.RuntimeLeaseWait,
		}),
	}
}

func Registration(options Options) runtimeapi.Registration {
	return runtimeapi.Registration{
		ID:          "hermes-gateway",
		WireID:      "pi",
		DisplayName: "Hermes Gateway",
		NewDriver: func() (runtimeapi.RuntimeDriver, error) {
			return New(options), nil
		},
		Policy: runtimeapi.RuntimePolicy{
			SupportsStdin: true,
			BusyMode:      runtimeapi.BusyDeliveryDirect,
			Completion:    runtimeapi.CompletionEvent,
		},
		LaunchPlanner: runtimeprompt.NewPersistentPlanner("hermes-gateway"),
	}
}
