package openclaw

import (
	"context"
	"errors"
	"os/exec"
	"strings"
	"time"

	"velachat/agent/internal/runtimeapi"
)

const executableProbeTimeout = 5 * time.Second

func (driver *Driver) Probe(ctx context.Context) (runtimeapi.ProbeResult, error) {
	executable := strings.TrimSpace(driver.executable)
	if executable == "" {
		var err error
		executable, err = exec.LookPath("openclaw")
		if err != nil {
			return runtimeapi.ProbeResult{
				Available:  false,
				Diagnostic: "OpenClaw executable was not found in PATH",
			}, nil
		}
	}

	version, err := runProbe(ctx, executable, "--version")
	if err != nil {
		if ctx.Err() != nil {
			return runtimeapi.ProbeResult{}, ctx.Err()
		}
		return runtimeapi.ProbeResult{
			Available:  false,
			Diagnostic: "OpenClaw version probe failed",
		}, nil
	}
	help, err := runProbe(ctx, executable, "gateway", "--help")
	if err != nil || !strings.Contains(help, "--allow-unconfigured") ||
		!strings.Contains(help, "--port") {
		return runtimeapi.ProbeResult{
			Available: false,
			Path:      executable,
			Version:   firstLine(version),
			Diagnostic: "OpenClaw Gateway does not expose the required " +
				"embedding flags",
		}, nil
	}
	return runtimeapi.ProbeResult{
		Available: true,
		Path:      executable,
		Version:   firstLine(version),
	}, nil
}

func runProbe(ctx context.Context, executable string, args ...string) (string, error) {
	probeCtx, cancel := context.WithTimeout(ctx, executableProbeTimeout)
	defer cancel()
	output, err := exec.CommandContext(probeCtx, executable, args...).CombinedOutput()
	if err != nil {
		return "", err
	}
	if probeCtx.Err() != nil {
		return "", probeCtx.Err()
	}
	return string(output), nil
}

func firstLine(value string) string {
	for _, line := range strings.Split(value, "\n") {
		if line = strings.TrimSpace(line); line != "" {
			return line
		}
	}
	return ""
}

var errRuntimeNotImplemented = errors.New("OpenClaw Runtime is not implemented")
