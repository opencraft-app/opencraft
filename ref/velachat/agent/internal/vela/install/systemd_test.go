package install

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type recordingSystemdRunner struct{ calls []string }

func (runner *recordingSystemdRunner) Run(_ context.Context, name string, args ...string) ([]byte, error) {
	call := name + " " + strings.Join(args, " ")
	runner.calls = append(runner.calls, call)
	switch {
	case strings.Contains(call, "is-enabled"):
		return []byte("enabled\n"), nil
	case strings.Contains(call, "is-active"):
		return []byte("active\n"), nil
	case strings.Contains(call, "MainPID"):
		return []byte("1234\n"), nil
	default:
		return nil, nil
	}
}

func TestSystemdLauncherWritesExactUnitAndReloadsOnlyWhenDefinitionChanges(t *testing.T) {
	root := filepath.Join(t.TempDir(), "var", "lib", "vela", "computer")
	state := filepath.Join(root, "state")
	program := filepath.Join(root, "bin", ProgramName)
	for _, directory := range []string{state, filepath.Dir(program)} {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(program, []byte("program"), 0o700); err != nil {
		t.Fatal(err)
	}
	unitPath := filepath.Join(t.TempDir(), "vela-computer.service")
	runner := &recordingSystemdRunner{}
	launcher, err := newComputerSystemdLauncher(systemdLauncherConfig{
		Runner: runner, Systemctl: "/usr/bin/systemctl", UnitPath: unitPath,
		EffectiveUID: func() int { return 0 },
	})
	if err != nil {
		t.Fatal(err)
	}
	spec := LaunchSpec{
		Label: linuxSystemdUnit, ProgramPath: program,
		ProgramSHA256: strings.Repeat("a", 64), RuntimeConfigDigest: strings.Repeat("b", 64),
		InstallationRoot: root, StateDirectory: state,
	}
	if err := launcher.Start(context.Background(), spec); err != nil {
		t.Fatal(err)
	}
	unit, err := os.ReadFile(unitPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, required := range []string{
		"[Service]", "ExecStart=" + program + " daemon run --state-dir " + state,
		"Environment=HOME=/root", "Restart=always", "RestartSec=3", "UMask=0077",
	} {
		if !strings.Contains(string(unit), required) {
			t.Errorf("unit missing %q:\n%s", required, unit)
		}
	}
	firstCalls := strings.Join(runner.calls, "\n")
	for _, required := range []string{
		"daemon-reload", "enable --now " + linuxSystemdUnit,
		"is-enabled " + linuxSystemdUnit, "is-active " + linuxSystemdUnit,
		"show " + linuxSystemdUnit + " --property MainPID --value",
	} {
		if !strings.Contains(firstCalls, required) {
			t.Errorf("systemctl calls missing %q:\n%s", required, firstCalls)
		}
	}
	runner.calls = nil
	if err := launcher.Start(context.Background(), spec); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(strings.Join(runner.calls, "\n"), "daemon-reload") {
		t.Fatalf("unchanged unit reloaded systemd: %#v", runner.calls)
	}
}
