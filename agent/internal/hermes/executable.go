package hermes

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/runtimeapi"
)

const executableProbeTimeout = 10 * time.Second

type executableCandidate struct {
	Path       string
	ArgsPrefix []string
}

func (driver *Driver) Probe(
	ctx context.Context,
) (runtimeapi.ProbeResult, error) {
	candidate, err := driver.selectExecutable(ctx)
	if err != nil {
		if ctx.Err() != nil {
			return runtimeapi.ProbeResult{}, ctx.Err()
		}
		return runtimeapi.ProbeResult{
			Diagnostic: err.Error(),
		}, nil
	}
	probeCtx, cancel := context.WithTimeout(ctx, executableProbeTimeout)
	defer cancel()
	output, err := exec.CommandContext(
		probeCtx,
		candidate.Path,
		appendCandidateArgs(candidate, "acp", "--version")...,
	).CombinedOutput()
	if ctx.Err() != nil {
		return runtimeapi.ProbeResult{}, ctx.Err()
	}
	version := firstOutputLine(output)
	diagnostic := ""
	if err != nil {
		diagnostic = "Hermes version probe failed: " + err.Error()
	}
	return runtimeapi.ProbeResult{
		Available:  true,
		Path:       candidate.Path,
		Version:    version,
		Diagnostic: diagnostic,
	}, nil
}

func (driver *Driver) DetectModels(
	ctx context.Context,
) (runtimeapi.ModelResult, error) {
	if _, err := driver.selectExecutable(ctx); err != nil {
		if ctx.Err() != nil {
			return runtimeapi.ModelResult{}, ctx.Err()
		}
		return runtimeapi.ModelResult{Unsupported: true}, nil
	}
	return runtimeapi.ModelResult{
		Models: []runtimeapi.Model{{
			ID:       "default",
			Label:    "Configured Hermes profile default",
			Verified: "suggestion_only",
		}},
		Default: "default",
	}, nil
}

func (driver *Driver) selectExecutable(
	ctx context.Context,
) (executableCandidate, error) {
	if driver.containerEvidence != nil {
		if evidence := driver.containerEvidence(); evidence != "" {
			return executableCandidate{}, fmt.Errorf(
				"Hermes managed Profiles do not support container installs: %s",
				evidence,
			)
		}
	}
	candidates := driver.executableCandidates()
	if len(candidates) == 0 {
		return executableCandidate{}, errors.New(
			"Hermes executable was not found in PATH",
		)
	}
	diagnostics := make([]string, 0, len(candidates))
	seen := make(map[string]struct{}, len(candidates))
	for _, candidate := range candidates {
		candidate.Path = strings.TrimSpace(candidate.Path)
		if candidate.Path == "" {
			continue
		}
		key := filepath.Clean(candidate.Path)
		if _, duplicate := seen[key]; duplicate {
			continue
		}
		seen[key] = struct{}{}
		probeCtx, cancel := context.WithTimeout(ctx, executableProbeTimeout)
		command := exec.CommandContext(
			probeCtx,
			candidate.Path,
			appendCandidateArgs(candidate, "acp", "--check")...,
		)
		command.Stdin = nil
		output, err := command.CombinedOutput()
		cancel()
		if err == nil {
			if compatibilityErr := validateProfileCreateCapabilities(
				ctx,
				candidate,
			); compatibilityErr != nil {
				if ctx.Err() != nil {
					return executableCandidate{}, ctx.Err()
				}
				diagnostics = append(
					diagnostics,
					fmt.Sprintf(
						"%q rejected: %s",
						candidate.Path,
						compatibilityErr,
					),
				)
				continue
			}
			return executableCandidate{
				Path:       candidate.Path,
				ArgsPrefix: append([]string(nil), candidate.ArgsPrefix...),
			}, nil
		}
		if ctx.Err() != nil {
			return executableCandidate{}, ctx.Err()
		}
		detail := strings.TrimSpace(string(output))
		if detail == "" {
			detail = err.Error()
		}
		diagnostics = append(
			diagnostics,
			fmt.Sprintf("%q rejected: %s", candidate.Path, detail),
		)
	}
	return executableCandidate{}, fmt.Errorf(
		"no compatible Hermes ACP executable: %s",
		strings.Join(diagnostics, "; "),
	)
}

func validateProfileCreateCapabilities(
	ctx context.Context,
	candidate executableCandidate,
) error {
	probeCtx, cancel := context.WithTimeout(ctx, executableProbeTimeout)
	defer cancel()
	output, err := exec.CommandContext(
		probeCtx,
		candidate.Path,
		appendCandidateArgs(candidate, "profile", "create", "--help")...,
	).CombinedOutput()
	if err != nil {
		return fmt.Errorf("Hermes Profile create probe failed: %w", err)
	}
	help := string(output)
	for _, flag := range []string{"--clone", "--clone-from", "--no-alias"} {
		if !strings.Contains(help, flag) {
			return fmt.Errorf(
				"Hermes Profile create does not support required %s",
				flag,
			)
		}
	}
	return nil
}

func (driver *Driver) executableCandidates() []executableCandidate {
	if strings.TrimSpace(driver.executable) != "" {
		return []executableCandidate{{
			Path:       driver.executable,
			ArgsPrefix: append([]string(nil), driver.argsPrefix...),
		}}
	}
	paths := make([]string, 0, 3)
	if path, err := exec.LookPath("hermes"); err == nil {
		paths = append(paths, path)
	}
	if driver.homeErr == nil {
		for _, relative := range []string{
			filepath.Join(".local", "bin", "hermes"),
			filepath.Join("bin", "hermes"),
		} {
			path := filepath.Join(driver.trustedHome, relative)
			info, err := os.Stat(path)
			if err == nil &&
				!info.IsDir() &&
				info.Mode().Perm()&0o111 != 0 {
				paths = append(paths, path)
			}
		}
	}
	seen := make(map[string]struct{}, len(paths))
	candidates := make([]executableCandidate, 0, len(paths))
	for _, path := range paths {
		path = filepath.Clean(path)
		if _, duplicate := seen[path]; duplicate {
			continue
		}
		seen[path] = struct{}{}
		candidates = append(candidates, executableCandidate{Path: path})
	}
	return candidates
}

func appendCandidateArgs(
	candidate executableCandidate,
	args ...string,
) []string {
	result := append([]string(nil), candidate.ArgsPrefix...)
	return append(result, args...)
}

func firstOutputLine(output []byte) string {
	for _, line := range strings.Split(string(output), "\n") {
		if line = strings.TrimSpace(line); line != "" {
			return line
		}
	}
	return ""
}
