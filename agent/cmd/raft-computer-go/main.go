package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/agentcli"
	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/state"
	velaapp "github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/vela/app"
	velacli "github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/vela/cli"
)

var version = "0.1.0-dev"

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	exitCode := 0
	if len(os.Args) > 1 && os.Args[1] == "__agent-cli" {
		exitCode = runAgentCLI(ctx, os.Args[2:])
	} else {
		exitCode = runVela(ctx, os.Args[1:])
	}
	os.Exit(exitCode)
}

func runVela(ctx context.Context, args []string) int {
	allowInsecureLoopback := os.Getenv(
		"RAFT_COMPUTER_GO_ALLOW_INSECURE_LOOPBACK",
	) == "1"
	allowInsecureHTTP := os.Getenv(
		"RAFT_COMPUTER_GO_ALLOW_INSECURE_HTTP",
	) == "1"
	root, err := stateRoot()
	if err != nil {
		return printError(err)
	}
	actions, err := velaapp.NewActions(velaapp.Config{
		Root:                  root,
		Version:               version,
		BuildID:               executableBuildID(),
		Stdout:                os.Stdout,
		Stderr:                os.Stderr,
		AllowInsecureLoopback: allowInsecureLoopback,
		AllowInsecureHTTP:     allowInsecureHTTP,
	})
	if err != nil {
		return printError(err)
	}
	command, err := velacli.NewRoot(velacli.RootConfig{
		Version:               version,
		Stdout:                os.Stdout,
		Stderr:                os.Stderr,
		Actions:               actions,
		AllowInsecureLoopback: allowInsecureLoopback,
		AllowInsecureHTTP:     allowInsecureHTTP,
	})
	if err != nil {
		return printError(err)
	}
	command.SetArgs(args)
	if err := command.ExecuteContext(ctx); err != nil {
		return printError(err)
	}
	return 0
}

func executableBuildID() string {
	executable, err := os.Executable()
	if err != nil {
		return version
	}
	file, err := os.Open(executable)
	if err != nil {
		return version
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return version
	}
	return "sha256:" + hex.EncodeToString(hash.Sum(nil))
}

func runAgentCLI(ctx context.Context, args []string) int {
	app := agentcli.NewFromEnvironmentWithVersion(os.Stdout, os.Stderr, version)
	return app.Run(ctx, args)
}

func stateRoot() (string, error) {
	if configured := strings.TrimSpace(os.Getenv("RAFT_COMPUTER_GO_HOME")); configured != "" {
		absolute, err := filepath.Abs(configured)
		if err != nil {
			return "", err
		}
		return filepath.Clean(absolute), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return state.DefaultRoot(home), nil
}

func printError(err error) int {
	if err != nil {
		_, _ = io.WriteString(os.Stderr, redactedError(err)+"\n")
	}
	return 1
}

func redactedError(err error) string {
	if err == nil {
		return ""
	}
	text := err.Error()
	lower := strings.ToLower(text)
	for _, marker := range []string{"sk_", "sap_", "Bearer "} {
		if strings.Contains(text, marker) {
			return "operation failed; sensitive detail redacted"
		}
	}
	if strings.Contains(text, "eyJ") ||
		(strings.Contains(text, "://") && strings.Contains(text, "?")) ||
		strings.Contains(lower, "bearertoken") ||
		strings.Contains(lower, "refresh token") ||
		strings.Contains(lower, "access token") ||
		strings.Contains(lower, "signature=") {
		return "operation failed; sensitive detail redacted"
	}
	return text
}
