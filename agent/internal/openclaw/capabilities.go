package openclaw

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"

	"velachat/agent/internal/runtimeapi"
)

func (driver *Driver) DiscoverProfileCapabilities(
	ctx context.Context,
	request runtimeapi.ProfileCapabilityRequest,
) (runtimeapi.ProfileCapabilityResult, error) {
	probe, err := driver.Probe(ctx)
	if err != nil {
		return runtimeapi.ProfileCapabilityResult{}, err
	}
	if !probe.Available {
		return runtimeapi.ProfileCapabilityResult{}, errors.New(probe.Diagnostic)
	}
	home := strings.TrimSpace(request.Environment["HOME"])
	if home == "" {
		home, err = os.UserHomeDir()
		if err != nil {
			return runtimeapi.ProfileCapabilityResult{}, err
		}
	}
	profile := managedProfileName(request.AgentID)
	return runtimeapi.ProfileCapabilityResult{
		Protocol:       "openclaw_gateway",
		RuntimeVersion: probe.Version,
		ProfileHome:    filepath.Join(home, ".openclaw-"+profile),
		ProfileKind:    "openclaw_managed",
		Models: runtimeapi.ModelResult{
			Models:      []runtimeapi.Model{},
			Unsupported: true,
		},
		Skills: []runtimeapi.Skill{},
	}, nil
}

var _ runtimeapi.ProfileCapabilityDiscoverer = (*Driver)(nil)
