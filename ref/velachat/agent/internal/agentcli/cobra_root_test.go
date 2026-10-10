package agentcli

import (
	"bytes"
	"context"
	"errors"
	"path/filepath"
	"slices"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
	"velachat/agent/internal/agentapi"
)

func TestAgentCLIExposesOnlyVelaCommands(t *testing.T) {
	t.Parallel()
	root := NewRootCommand(Dependencies{
		ClientProvider: func(context.Context) (*agentapi.Client, error) {
			return nil, errors.New("must not acquire client while inspecting tree")
		},
	})
	want := []string{
		"auth whoami",
		"channel info", "channel members",
		"server info",
		"user info",
		"inbox check",
		"message send", "message check", "message read", "message search", "message resolve", "message react",
		"attachment upload", "attachment view",
		"task list", "task claim", "task update",
		"reminder schedule", "reminder list", "reminder cancel", "reminder snooze", "reminder update", "reminder log",
	}
	slices.Sort(want)
	if got := cobraLeafPaths(root); !slices.Equal(got, want) {
		t.Fatalf("Agent command tree = %v, want %v", got, want)
	}
	if command, _, err := root.Find([]string{"workspace"}); err == nil && command != root {
		t.Fatalf("Vela unexpectedly exposes workspace command: %s", command.CommandPath())
	}
	if command, _, err := root.Find([]string{"thread"}); err == nil && command != root {
		t.Fatalf("Vela unexpectedly exposes legacy thread command: %s", command.CommandPath())
	}
	for _, path := range [][]string{{"task", "list"}, {"task", "claim"}, {"task", "update"}} {
		command, _, err := root.Find(path)
		if err != nil || command.Flags().Lookup("target") != nil {
			t.Fatalf("Vela %s retains fake channel target: command=%v err=%v", strings.Join(path, " "), command, err)
		}
	}
	serverInfo, _, err := root.Find([]string{"server", "info"})
	if err != nil {
		t.Fatalf("resolve Vela server info: %v", err)
	}
	if serverInfo.LocalNonPersistentFlags().HasAvailableFlags() {
		var flags []string
		serverInfo.LocalNonPersistentFlags().VisitAll(func(flag *pflag.Flag) {
			flags = append(flags, flag.Name)
		})
		t.Fatalf("Vela server info retains unsupported filters: %v", flags)
	}
	wantMessageFlags := map[string][]string{
		"send":    {"attachment-id", "json", "target", "text"},
		"check":   {},
		"read":    {"after", "around", "limit", "target"},
		"search":  {"limit", "offset", "query", "target"},
		"resolve": {},
		"react":   {"emoji", "message-id", "remove"},
	}
	for name, wantFlags := range wantMessageFlags {
		command, _, err := root.Find([]string{"message", name})
		if err != nil {
			t.Fatalf("resolve Vela message %s: %v", name, err)
		}
		gotFlags := make([]string, 0)
		command.LocalNonPersistentFlags().VisitAll(func(flag *pflag.Flag) {
			gotFlags = append(gotFlags, flag.Name)
		})
		slices.Sort(gotFlags)
		slices.Sort(wantFlags)
		if !slices.Equal(gotFlags, wantFlags) {
			t.Errorf("Vela message %s flags = %v, want %v", name, gotFlags, wantFlags)
		}
	}
}

func TestCobraHelpAndVersionDoNotAcquireLazyDependencies(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		args []string
	}{
		{name: "root", args: nil},
		{name: "root help", args: []string{"--help"}},
		{name: "help command", args: []string{"help", "reminder"}},
		{name: "family", args: []string{"reminder"}},
		{name: "family help", args: []string{"reminder", "--help"}},
		{name: "leaf help", args: []string{"reminder", "schedule", "--help"}},
		{name: "version", args: []string{"--version"}},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			var clientCalls atomic.Int32
			var stdout bytes.Buffer
			var stderr bytes.Buffer
			app := NewWithDependencies(Dependencies{
				ClientProvider: func(context.Context) (*agentapi.Client, error) {
					clientCalls.Add(1)
					return nil, errors.New("unexpected client acquisition")
				},
				Stdout:  &stdout,
				Stderr:  &stderr,
				Version: "test-version",
			})
			if exitCode := app.Run(context.Background(), test.args); exitCode != 0 {
				t.Fatalf("exit code = %d, stderr=%q", exitCode, stderr.String())
			}
			if clientCalls.Load() != 0 {
				t.Fatalf(
					"provider calls: client=%d",
					clientCalls.Load(),
				)
			}
			if stderr.Len() != 0 {
				t.Fatalf("stderr = %q", stderr.String())
			}
			if stdout.Len() == 0 {
				t.Fatal("stdout is empty")
			}
		})
	}
}

func TestCobraUsageErrorIsRenderedOnceAndDoesNotAcquireClient(t *testing.T) {
	t.Parallel()

	var clientCalls atomic.Int32
	var stderr bytes.Buffer
	app := NewWithDependencies(Dependencies{
		ClientProvider: func(context.Context) (*agentapi.Client, error) {
			clientCalls.Add(1)
			return nil, errors.New("unexpected client acquisition")
		},
		Stderr: &stderr,
	})
	exitCode := app.Run(context.Background(), []string{
		"message", "send", "--target", "#general", "positional content",
	})
	if exitCode != 2 {
		t.Fatalf("exit code = %d, stderr=%q", exitCode, stderr.String())
	}
	if clientCalls.Load() != 0 {
		t.Fatalf("client provider calls = %d", clientCalls.Load())
	}
	if got := strings.Count(stderr.String(), "Error:"); got != 1 {
		t.Fatalf("Error prefix count = %d, stderr=%q", got, stderr.String())
	}
	if !strings.Contains(stderr.String(), `Run "vela message send --help" for usage.`) {
		t.Fatalf("stderr = %q", stderr.String())
	}
}

func TestCobraExecutionErrorIsRenderedOnce(t *testing.T) {
	t.Parallel()

	var clientCalls atomic.Int32
	var stderr bytes.Buffer
	app := NewWithDependencies(Dependencies{
		ClientProvider: func(context.Context) (*agentapi.Client, error) {
			clientCalls.Add(1)
			return nil, errors.New("provider exploded")
		},
		Stderr: &stderr,
	})
	exitCode := app.Run(context.Background(), []string{"inbox", "check"})
	if exitCode != 1 {
		t.Fatalf("exit code = %d, stderr=%q", exitCode, stderr.String())
	}
	if clientCalls.Load() != 1 {
		t.Fatalf("client provider calls = %d", clientCalls.Load())
	}
	if got := strings.Count(stderr.String(), "Error:"); got != 1 {
		t.Fatalf("Error prefix count = %d, stderr=%q", got, stderr.String())
	}
}

func TestCobraSemanticAndFilePreflightPrecedesLazyProviders(t *testing.T) {
	t.Parallel()

	missingFile := filepath.Join(t.TempDir(), "missing.png")
	tests := []struct {
		name string
		args []string
	}{
		{
			name: "message content validation",
			args: []string{
				"message", "send",
				"--target", "#general",
			},
		},
		{
			name: "server list modifier validation",
			args: []string{"server", "info", "--limit", "10"},
		},
		{
			name: "Reminder timing validation",
			args: []string{
				"reminder", "schedule",
				"--title", "Follow up",
				"--message-id", "message-1",
			},
		},
		{
			name: "attachment file preflight",
			args: []string{
				"attachment", "upload",
				"--path", missingFile,
				"--target", "#general",
			},
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			var clientCalls atomic.Int32
			var stderr bytes.Buffer
			app := NewWithDependencies(Dependencies{
				ClientProvider: func(context.Context) (*agentapi.Client, error) {
					clientCalls.Add(1)
					return nil, errors.New("client provider must not run")
				},
				Stderr: &stderr,
			})
			if exitCode := app.Run(context.Background(), test.args); exitCode != 2 {
				t.Fatalf("exit code = %d, stderr=%q", exitCode, stderr.String())
			}
			if clientCalls.Load() != 0 {
				t.Fatalf(
					"provider calls: client=%d",
					clientCalls.Load(),
				)
			}
		})
	}
}

func cobraLeafPaths(root *cobra.Command) []string {
	var paths []string
	var visit func(*cobra.Command)
	visit = func(command *cobra.Command) {
		children := command.Commands()
		if len(children) == 0 {
			if command != root && command.Name() != "help" {
				paths = append(
					paths,
					strings.TrimPrefix(command.CommandPath(), root.Name()+" "),
				)
			}
			return
		}
		for _, child := range children {
			if child.Name() != "help" {
				visit(child)
			}
		}
	}
	visit(root)
	return paths
}
