package cli

import (
	"bytes"
	"context"
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestRootExposesOnlyStableVelaDaemonCommands(t *testing.T) {
	t.Parallel()

	var output bytes.Buffer
	root := newTestRoot(t, &fakeActions{}, &output)
	root.SetArgs([]string{"--help"})
	if err := root.Execute(); err != nil {
		t.Fatal(err)
	}
	help := output.String()
	for _, want := range []string{
		"Vela Computer",
		"setup",
		"daemon",
		"status",
		"doctor",
		"logs",
		"tui",
		"version",
	} {
		if !strings.Contains(help, want) {
			t.Fatalf("help missing %q:\n%s", want, help)
		}
	}
	for _, forbidden := range []string{"canary", "\n  run "} {
		if strings.Contains(help, forbidden) {
			t.Fatalf("help unexpectedly exposes %q:\n%s", forbidden, help)
		}
	}
}

func TestHiddenInstallDispatchesVerifiedFirstInstallInputs(t *testing.T) {
	t.Parallel()

	rootDirectory := t.TempDir()
	actions := &fakeActions{}
	var output bytes.Buffer
	root := newTestRoot(t, actions, &output)
	root.SetArgs([]string{
		"install",
		"--platform-url", "http://192.0.2.10",
		"--allow-insecure-platform-http",
		"--token-file", filepath.Join(rootDirectory, "token"),
		"--manifest-file", filepath.Join(rootDirectory, "manifest.json"),
		"--signature-file", filepath.Join(rootDirectory, "manifest.sig"),
		"--signing-public-key", "test-public-key",
		"--release-version", "0.2.0",
		"--target", "darwin-arm64",
		"--program-file", filepath.Join(rootDirectory, "vela-computer"),
		"--installation-root", filepath.Join(rootDirectory, ".vela"),
	})
	if err := root.Execute(); err != nil {
		t.Fatal(err)
	}
	if actions.LastCall() != "install" {
		t.Fatalf("last call = %q", actions.LastCall())
	}
	options := actions.install
	if options.ProgramFile != filepath.Join(rootDirectory, "vela-computer") ||
		options.InstallationRoot != filepath.Join(rootDirectory, ".vela") ||
		options.StateDirectory != filepath.Join(rootDirectory, ".vela", "state") ||
		!options.AllowInsecurePlatformHTTP {
		t.Fatalf("install options = %#v", options)
	}
}

func TestDaemonContainsOnlyRun(t *testing.T) {
	t.Parallel()

	var output bytes.Buffer
	root := newTestRoot(t, &fakeActions{}, &output)
	root.SetArgs([]string{"daemon", "--help"})
	if err := root.Execute(); err != nil {
		t.Fatal(err)
	}
	help := output.String()
	if !strings.Contains(help, "run") {
		t.Fatalf("daemon help missing run:\n%s", help)
	}
	for _, forbidden := range []string{"start", "stop", "restart", "agent"} {
		if strings.Contains(help, forbidden) {
			t.Fatalf("daemon help unexpectedly exposes %q:\n%s", forbidden, help)
		}
	}
}

func TestVersionDoesNotCallDaemon(t *testing.T) {
	t.Parallel()

	actions := &fakeActions{}
	var output bytes.Buffer
	root := newTestRoot(t, actions, &output)
	root.SetArgs([]string{"version"})
	if err := root.Execute(); err != nil {
		t.Fatal(err)
	}
	if got := strings.TrimSpace(output.String()); got !=
		"vela-computer vela test-version" {
		t.Fatalf("version output = %q", got)
	}
	if actions.TotalCalls() != 0 {
		t.Fatalf("version called daemon actions %d times", actions.TotalCalls())
	}
}

func TestVersionJSON(t *testing.T) {
	t.Parallel()

	var output bytes.Buffer
	root := newTestRoot(t, &fakeActions{}, &output)
	root.SetArgs([]string{"version", "--json"})
	if err := root.Execute(); err != nil {
		t.Fatal(err)
	}
	if got := strings.TrimSpace(output.String()); got !=
		`{"mode":"vela","name":"vela-computer","version":"test-version"}` {
		t.Fatalf("version JSON = %q", got)
	}
}

func TestSetupForwardsFrozenOptions(t *testing.T) {
	t.Parallel()

	actions := &fakeActions{}
	root := newTestRoot(t, actions, &bytes.Buffer{})
	root.SetArgs([]string{
		"setup",
		"--platform-url", "https://platform.example.test",
		"--access-token-file", "/secure/human.token",
		"--server-id", "01989d5e-0000-7000-8000-000000000001",
		"--name", "开发机",
		"--state-dir", "./state",
		"--repair",
	})
	if err := root.Execute(); err != nil {
		t.Fatal(err)
	}
	options := actions.SetupOptions()
	if options.PlatformURL != "https://platform.example.test" ||
		options.AccessTokenFile != "/secure/human.token" ||
		options.ServerID != "01989d5e-0000-7000-8000-000000000001" ||
		options.Name != "开发机" ||
		options.StateDir != "./state" ||
		!options.Repair {
		t.Fatalf("setup options = %#v", options)
	}
}

func TestSetupRejectsMissingOrRelativeSecurityInput(t *testing.T) {
	t.Parallel()

	for _, args := range [][]string{
		{
			"setup",
			"--platform-url", "https://platform.example.test",
			"--access-token-file", "./human.token",
			"--server-id", "01989d5e-0000-7000-8000-000000000001",
			"--name", "开发机",
		},
		{
			"setup",
			"--platform-url", "https://platform.example.test",
			"--access-token-file", "/secure/human.token",
			"--server-id", "01989d5e-0000-7000-8000-000000000001",
			"--name", "",
		},
	} {
		actions := &fakeActions{}
		root := newTestRoot(t, actions, &bytes.Buffer{})
		root.SetArgs(args)
		if err := root.Execute(); !errors.Is(err, ErrInvalidArguments) {
			t.Fatalf("args %v error = %v, want ErrInvalidArguments", args, err)
		}
		if actions.TotalCalls() != 0 {
			t.Fatal("setup action called with invalid arguments")
		}
	}
}

func TestSetupAllowsHTTPOnlyForExplicitLoopbackCanary(t *testing.T) {
	t.Parallel()

	args := []string{
		"setup",
		"--platform-url", "http://127.0.0.1:18080",
		"--access-token-file", "/secure/human.token",
		"--server-id", "01989d5e-0000-7000-8000-000000000001",
		"--name", "本地 Canary",
	}

	denied := &fakeActions{}
	deniedRoot := newTestRoot(t, denied, &bytes.Buffer{})
	deniedRoot.SetArgs(args)
	if err := deniedRoot.Execute(); !errors.Is(err, ErrInvalidArguments) {
		t.Fatalf("default HTTP setup error = %v, want ErrInvalidArguments", err)
	}

	allowed := &fakeActions{}
	root, err := NewRoot(RootConfig{
		Version:               "test-version",
		Stdout:                &bytes.Buffer{},
		Stderr:                &bytes.Buffer{},
		Actions:               allowed,
		AllowInsecureLoopback: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	root.SetArgs(args)
	if err := root.Execute(); err != nil {
		t.Fatalf("explicit loopback HTTP setup: %v", err)
	}
	if allowed.TotalCalls() != 1 {
		t.Fatalf("setup calls = %d, want 1", allowed.TotalCalls())
	}
}

func TestTUIAllowsRemoteHTTPOnlyForExplicitDevelopmentOverride(t *testing.T) {
	t.Parallel()

	args := []string{"tui", "--platform-url", "http://9.135.236.23"}
	denied := &fakeActions{}
	deniedRoot := newTestRoot(t, denied, &bytes.Buffer{})
	deniedRoot.SetArgs(args)
	if err := deniedRoot.Execute(); !errors.Is(err, ErrInvalidArguments) {
		t.Fatalf("default remote HTTP TUI error = %v, want ErrInvalidArguments", err)
	} else if !strings.Contains(err.Error(), "VELA_ALLOW_INSECURE_HTTP=1") {
		t.Fatalf("default remote HTTP TUI error = %q, want development override hint", err)
	}

	allowed := &fakeActions{}
	root, err := NewRoot(RootConfig{
		Version:           "test-version",
		Stdout:            &bytes.Buffer{},
		Stderr:            &bytes.Buffer{},
		Actions:           allowed,
		AllowInsecureHTTP: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	root.SetArgs(args)
	if err := root.Execute(); err != nil {
		t.Fatalf("explicit remote HTTP TUI: %v", err)
	}
	if allowed.TotalCalls() != 1 {
		t.Fatalf("TUI calls = %d, want 1", allowed.TotalCalls())
	}
}

func TestTUIRejectsRemovedSharedClientPreviewFlag(t *testing.T) {
	t.Parallel()

	actions := &fakeActions{}
	root := newTestRoot(t, actions, &bytes.Buffer{})
	root.SetArgs([]string{
		"tui",
		"--platform-url", "https://platform.example.test",
		"--shared-client",
	})
	if err := root.Execute(); err == nil {
		t.Fatal("removed --shared-client preview flag was still accepted")
	}
	if actions.TotalCalls() != 0 {
		t.Fatalf("removed preview flag invoked TUI %d times", actions.TotalCalls())
	}
}

func TestDaemonAndManagementCommandsForwardOptions(t *testing.T) {
	t.Parallel()

	actions := &fakeActions{}
	tests := []struct {
		args []string
		want string
	}{
		{[]string{"daemon", "run", "--state-dir", "./state"}, "daemon"},
		{[]string{"status", "--json", "--state-dir", "./state"}, "status"},
		{[]string{"doctor", "--json", "--state-dir", "./state"}, "doctor"},
		{[]string{"logs", "--follow", "--lines", "321", "--state-dir", "./state"}, "logs"},
	}
	for _, test := range tests {
		root := newTestRoot(t, actions, &bytes.Buffer{})
		root.SetArgs(test.args)
		if err := root.Execute(); err != nil {
			t.Fatalf("%v: %v", test.args, err)
		}
		if got := actions.LastCall(); got != test.want {
			t.Fatalf("%v called %q, want %q", test.args, got, test.want)
		}
	}
	if got := actions.daemon.StateDir; got != "./state" {
		t.Fatalf("daemon state dir = %q", got)
	}
	if !actions.status.JSON || actions.status.StateDir != "./state" {
		t.Fatalf("status options = %#v", actions.status)
	}
	if !actions.doctor.JSON || actions.doctor.StateDir != "./state" {
		t.Fatalf("doctor options = %#v", actions.doctor)
	}
	if !actions.logs.Follow ||
		actions.logs.Lines != 321 ||
		actions.logs.StateDir != "./state" {
		t.Fatalf("logs options = %#v", actions.logs)
	}
}

func TestRootRunAliasDoesNotExist(t *testing.T) {
	t.Parallel()
	actions := &fakeActions{}
	root := newTestRoot(t, actions, &bytes.Buffer{})
	root.SetArgs([]string{"run", "--state-dir", "./state"})
	if err := root.Execute(); err == nil {
		t.Fatal("removed root run alias was accepted")
	}
	if actions.TotalCalls() != 0 {
		t.Fatal("removed root run alias dispatched an action")
	}
}

func TestLogsRejectsOutOfRangeLines(t *testing.T) {
	t.Parallel()

	for _, value := range []string{"0", "10001"} {
		actions := &fakeActions{}
		root := newTestRoot(t, actions, &bytes.Buffer{})
		root.SetArgs([]string{"logs", "--lines", value})
		if err := root.Execute(); !errors.Is(err, ErrInvalidArguments) {
			t.Fatalf("lines %s error = %v", value, err)
		}
		if actions.TotalCalls() != 0 {
			t.Fatal("logs action called with invalid line count")
		}
	}
}

func newTestRoot(
	t *testing.T,
	actions Actions,
	output *bytes.Buffer,
) *Command {
	t.Helper()
	root, err := NewRoot(RootConfig{
		Version: "test-version",
		Stdout:  output,
		Stderr:  output,
		Actions: actions,
	})
	if err != nil {
		t.Fatal(err)
	}
	return root
}

type fakeActions struct {
	mu      sync.Mutex
	calls   []string
	setup   SetupOptions
	daemon  DaemonRunOptions
	status  StatusOptions
	doctor  DoctorOptions
	logs    LogsOptions
	tui     TUIOptions
	install InstallOptions
}

func (a *fakeActions) Install(_ context.Context, options InstallOptions) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.calls = append(a.calls, "install")
	a.install = options
	return nil
}

func (a *fakeActions) Setup(_ context.Context, options SetupOptions) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.calls = append(a.calls, "setup")
	a.setup = options
	return nil
}

func (a *fakeActions) DaemonRun(
	_ context.Context,
	options DaemonRunOptions,
) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.calls = append(a.calls, "daemon")
	a.daemon = options
	return nil
}

func (a *fakeActions) Status(_ context.Context, options StatusOptions) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.calls = append(a.calls, "status")
	a.status = options
	return nil
}

func (a *fakeActions) Doctor(_ context.Context, options DoctorOptions) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.calls = append(a.calls, "doctor")
	a.doctor = options
	return nil
}

func (a *fakeActions) Logs(_ context.Context, options LogsOptions) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.calls = append(a.calls, "logs")
	a.logs = options
	return nil
}

func (a *fakeActions) TUI(_ context.Context, options TUIOptions) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.calls = append(a.calls, "tui")
	a.tui = options
	return nil
}

func (a *fakeActions) SetupOptions() SetupOptions {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.setup
}

func (a *fakeActions) LastCall() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	if len(a.calls) == 0 {
		return ""
	}
	return a.calls[len(a.calls)-1]
}

func (a *fakeActions) TotalCalls() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return len(a.calls)
}
