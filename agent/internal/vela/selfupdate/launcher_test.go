package selfupdate

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

type recordingCommandRunner struct {
	name string
	args []string
}

func (runner *recordingCommandRunner) Run(_ context.Context, name string, args ...string) ([]byte, error) {
	runner.name = name
	runner.args = append([]string(nil), args...)
	return []byte("unit started"), nil
}

func TestSystemdHelperLauncherEscapesMainCgroupWithFixedTransientUnit(t *testing.T) {
	t.Parallel()
	runner := &recordingCommandRunner{}
	launcher, err := newSystemdHelperLauncher(runner, "/usr/bin/systemd-run")
	if err != nil {
		t.Fatal(err)
	}
	stateRoot := filepath.Join(t.TempDir(), "state")
	helper := filepath.Join(
		stateRoot, "update", "transactions",
		"0198d444-0000-7000-8000-000000000003", "helper-program",
	)
	if err := os.MkdirAll(filepath.Dir(helper), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(helper, []byte("helper"), 0o700); err != nil {
		t.Fatal(err)
	}
	command := HelperLaunch{
		HelperProgram: helper,
		StateRoot:     stateRoot, TransactionID: "0198d444-0000-7000-8000-000000000003",
		ParentPID: 123, Target: "linux-amd64",
	}
	if err := launcher.Launch(context.Background(), command); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"--unit", "vela-computer-upgrade-0198d444-0000-7000-8000-000000000003",
		"--collect", "--property=Type=exec", "--property=Restart=no", "--property=UMask=0077",
		"--", command.HelperProgram, "upgrade", "apply",
		"--state-dir", command.StateRoot, "--transaction-id", command.TransactionID,
		"--parent-pid", "123",
	}
	if runner.name != "/usr/bin/systemd-run" || !reflect.DeepEqual(runner.args, want) {
		t.Fatalf("systemd-run = %q %#v", runner.name, runner.args)
	}
}
