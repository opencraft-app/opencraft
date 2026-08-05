//go:build darwin

package install

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	launchdservice "velachat/agent/internal/launchd"
)

func TestComputerLaunchAgentMapsOnlyRuntimeDefinition(t *testing.T) {
	root := filepath.Join(t.TempDir(), "computer")
	manager := &recordingLaunchdManager{}
	launcher := &computerLaunchAgent{manager: manager}
	spec := LaunchSpec{
		Label: launchAgentLabel, ProgramPath: filepath.Join(root, "bin", ProgramName),
		ProgramSHA256: strings.Repeat("a", 64), InstallationRoot: root,
		StateDirectory: filepath.Join(root, "state"),
	}
	if err := launcher.Start(context.Background(), spec); err != nil {
		t.Fatal(err)
	}
	wantArguments := []string{"daemon", "run", "--state-dir", spec.StateDirectory}
	if manager.definition.Label != launchAgentLabel ||
		manager.definition.Program != spec.ProgramPath ||
		manager.definition.ProgramSHA256 != spec.ProgramSHA256 ||
		!equalStrings(manager.definition.Arguments, wantArguments) ||
		manager.definition.Environment["PATH"] != "/usr/local/bin:/usr/bin:/bin" ||
		manager.definition.KeepAlive != true || manager.definition.RunAtLoad != true ||
		manager.definition.ProcessType != launchdservice.ProcessTypeBackground ||
		manager.definition.Umask != 0o077 {
		t.Fatalf("definition = %#v", manager.definition)
	}
	for key, value := range manager.definition.Environment {
		if strings.Contains(strings.ToLower(key+value), "credential") ||
			strings.Contains(strings.ToLower(key+value), "token") {
			t.Fatalf("definition contains secret-shaped environment %q", key)
		}
	}
}

func TestComputerLaunchAgentUsesRegistrationLanguageForGenericFailure(t *testing.T) {
	root := filepath.Join(t.TempDir(), "computer")
	manager := &recordingLaunchdManager{err: &launchdservice.OperationError{
		Stage: launchdservice.StageObserve, Err: launchdservice.ErrIdentityMismatch,
	}}
	launcher := &computerLaunchAgent{manager: manager}
	err := launcher.Start(context.Background(), LaunchSpec{
		Label: launchAgentLabel, ProgramPath: filepath.Join(root, "bin", ProgramName),
		ProgramSHA256: strings.Repeat("a", 64), InstallationRoot: root,
		StateDirectory: filepath.Join(root, "state"),
	})
	if err == nil || err.Error() != "Unable to verify that Vela Computer was registered with macOS." {
		t.Fatalf("error = %v", err)
	}
}

type recordingLaunchdManager struct {
	definition launchdservice.Definition
	err        error
}

func (manager *recordingLaunchdManager) EnsureLoaded(_ context.Context, definition launchdservice.Definition) error {
	manager.definition = definition
	return manager.err
}

func equalStrings(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}
