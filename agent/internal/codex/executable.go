package codex

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"velachat/agent/internal/runtimeapi"
)

const executableProbeTimeout = 5 * time.Second

// executableCandidate keeps a command and its fixed arguments together across
// compatibility validation and the operation that consumes the selection.
type executableCandidate struct {
	Path       string
	ArgsPrefix []string
	Source     string
}

type executableSelection struct {
	Candidate   executableCandidate
	Diagnostics []string
}

func (d *Driver) Probe(ctx context.Context) (runtimeapi.ProbeResult, error) {
	selection, err := d.selectExecutable(ctx)
	if err != nil {
		if ctx.Err() != nil {
			return runtimeapi.ProbeResult{}, ctx.Err()
		}
		return runtimeapi.ProbeResult{
			Available:  false,
			Diagnostic: err.Error(),
		}, nil
	}
	version, versionDiagnostic, err := probeExecutableVersion(
		ctx,
		selection.Candidate,
	)
	if err != nil {
		return runtimeapi.ProbeResult{}, err
	}
	diagnostics := append([]string(nil), selection.Diagnostics...)
	if versionDiagnostic != "" {
		diagnostics = append(diagnostics, versionDiagnostic)
	}
	return runtimeapi.ProbeResult{
		Available:  true,
		Path:       selection.Candidate.Path,
		Version:    version,
		Diagnostic: strings.Join(diagnostics, "; "),
	}, nil
}

func (d *Driver) selectExecutable(ctx context.Context) (executableSelection, error) {
	candidates := d.executableCandidates()
	if len(candidates) == 0 {
		return executableSelection{},
			errors.New("Codex executable was not found in PATH or the macOS application")
	}
	seen := make(map[string]struct{}, len(candidates))
	diagnostics := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		candidate.Path = strings.TrimSpace(candidate.Path)
		if candidate.Path == "" {
			continue
		}
		key := filepath.Clean(candidate.Path)
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		candidate.ArgsPrefix = append([]string(nil), candidate.ArgsPrefix...)
		validator := validateExecutableCandidate
		if d.candidateValidator != nil {
			validator = d.candidateValidator
		}
		diagnostic, err := validator(ctx, candidate)
		if err == nil {
			return executableSelection{
				Candidate:   candidate,
				Diagnostics: diagnostics,
			}, nil
		}
		if ctx.Err() != nil {
			return executableSelection{}, ctx.Err()
		}
		diagnostics = append(diagnostics, diagnostic)
	}
	if len(diagnostics) == 0 {
		return executableSelection{},
			errors.New("Codex executable candidates were empty")
	}
	return executableSelection{}, fmt.Errorf(
		"no compatible Codex executable: %s",
		strings.Join(diagnostics, "; "),
	)
}

func (d *Driver) executableCandidates() []executableCandidate {
	if d.candidateSource != nil {
		return cloneExecutableCandidates(d.candidateSource())
	}
	if strings.TrimSpace(d.executable) != "" {
		return []executableCandidate{{
			Path:       d.executable,
			ArgsPrefix: append([]string(nil), d.argsPrefix...),
			Source:     "configured",
		}}
	}
	candidates := make([]executableCandidate, 0, 2)
	if path, err := exec.LookPath("codex"); err == nil {
		candidates = append(candidates, executableCandidate{
			Path:   path,
			Source: "PATH",
		})
	}
	if info, err := os.Stat(desktopExecutable); err == nil && !info.IsDir() {
		candidates = append(candidates, executableCandidate{
			Path:   desktopExecutable,
			Source: "macOS application",
		})
	}
	return candidates
}

func cloneExecutableCandidates(
	candidates []executableCandidate,
) []executableCandidate {
	cloned := make([]executableCandidate, 0, len(candidates))
	for _, candidate := range candidates {
		candidate.ArgsPrefix = append([]string(nil), candidate.ArgsPrefix...)
		cloned = append(cloned, candidate)
	}
	return cloned
}

func validateExecutableCandidate(
	ctx context.Context,
	candidate executableCandidate,
) (string, error) {
	probeCtx, cancel := context.WithTimeout(ctx, executableProbeTimeout)
	defer cancel()
	args := append(
		append([]string(nil), candidate.ArgsPrefix...),
		"app-server",
		"--help",
	)
	output, err := exec.CommandContext(probeCtx, candidate.Path, args...).CombinedOutput()
	if err == nil {
		return "", nil
	}
	detail := strings.TrimSpace(string(output))
	if detail == "" {
		detail = err.Error()
	} else {
		detail += ": " + err.Error()
	}
	source := strings.TrimSpace(candidate.Source)
	if source == "" {
		source = "candidate"
	}
	return fmt.Sprintf(
		"%s %q rejected: %s",
		source,
		candidate.Path,
		detail,
	), err
}

func probeExecutableVersion(
	ctx context.Context,
	candidate executableCandidate,
) (string, string, error) {
	probeCtx, cancel := context.WithTimeout(ctx, executableProbeTimeout)
	defer cancel()
	args := append(
		append([]string(nil), candidate.ArgsPrefix...),
		"--version",
	)
	output, err := exec.CommandContext(probeCtx, candidate.Path, args...).CombinedOutput()
	if ctx.Err() != nil {
		return "", "", ctx.Err()
	}
	if err != nil {
		return "", fmt.Sprintf(
			"%s %q version probe failed: %v",
			candidate.Source,
			candidate.Path,
			err,
		), nil
	}
	for _, line := range strings.Split(string(output), "\n") {
		if line = strings.TrimSpace(line); line != "" {
			return line, "", nil
		}
	}
	return "", "", nil
}
