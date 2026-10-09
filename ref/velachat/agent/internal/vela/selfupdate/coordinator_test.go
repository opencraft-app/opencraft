package selfupdate

import (
	"context"
	"crypto/sha256"
	"os"
	"path/filepath"
	"testing"
	"time"

	"velachat/agent/internal/vela/activitygate"
)

type recordingHelperLauncher struct {
	stager   *Stager
	launched chan HelperLaunch
}

func (launcher *recordingHelperLauncher) Launch(_ context.Context, command HelperLaunch) error {
	journal, ok, err := launcher.stager.Pending()
	if err != nil || !ok || journal.Phase != PhaseHelperStarted {
		return ErrTransactionInvalid
	}
	launcher.launched <- command
	return nil
}

func TestCoordinatorDrainsBeforeLaunchingExternalHelper(t *testing.T) {
	t.Parallel()
	installationRoot := filepath.Join(t.TempDir(), "computer")
	stateRoot := filepath.Join(installationRoot, "state")
	binRoot := filepath.Join(installationRoot, "bin")
	candidateRoot := filepath.Join(stateRoot, "update", "candidates", "candidate")
	for _, directory := range []string{stateRoot, binRoot, candidateRoot} {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	currentProgram := filepath.Join(binRoot, "vela-computer")
	newProgram := filepath.Join(candidateRoot, "vela-computer")
	_ = os.WriteFile(currentProgram, []byte("old"), 0o700)
	_ = os.WriteFile(newProgram, []byte("new"), 0o700)
	now := time.Date(2026, 8, 18, 2, 0, 0, 0, time.UTC)
	stager, err := NewStager(StagerConfig{
		StateRoot: stateRoot, InstallationRoot: installationRoot,
		CurrentVersion: "v0.1.51", Target: "linux-amd64", CurrentProgram: currentProgram,
		Now:   func() time.Time { return now },
		NewID: func() (string, error) { return "0198d444-0000-7000-8000-000000000002", nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte("new"))
	if err := stager.Stage(context.Background(), Candidate{
		Version: "v0.1.52", Sequence: 8, Directory: candidateRoot,
		Release: VerifiedRelease{Version: "v0.1.52", Target: "linux-amd64", ProgramSHA256: digest, ProgramSize: 3},
	}); err != nil {
		t.Fatal(err)
	}
	gate := activitygate.New()
	lease, err := gate.Acquire(context.Background(), activitygate.AgentTurn)
	if err != nil {
		t.Fatal(err)
	}
	launcher := &recordingHelperLauncher{stager: stager, launched: make(chan HelperLaunch, 1)}
	shutdown := make(chan struct{}, 1)
	coordinator, err := NewCoordinator(CoordinatorConfig{
		Stager: stager, Gate: gate, Launcher: launcher, ParentPID: 123,
		Now: func() time.Time { return now }, Shutdown: func() { shutdown <- struct{}{} },
	})
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- coordinator.Run(context.Background()) }()
	deadline := time.Now().Add(time.Second)
	for !gate.Snapshot().Draining {
		if time.Now().After(deadline) {
			t.Fatal("coordinator did not start drain")
		}
		time.Sleep(time.Millisecond)
	}
	select {
	case command := <-launcher.launched:
		t.Fatalf("helper launched before active turn ended: %#v", command)
	default:
	}
	lease.Release()
	select {
	case command := <-launcher.launched:
		if command.ParentPID != 123 || command.TransactionID != "0198d444-0000-7000-8000-000000000002" ||
			!filepath.IsAbs(command.HelperProgram) {
			t.Fatalf("helper command = %#v", command)
		}
	case <-time.After(time.Second):
		t.Fatal("helper was not launched after drain")
	}
	select {
	case <-shutdown:
	case <-time.After(time.Second):
		t.Fatal("daemon shutdown was not requested")
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestCoordinatorLeavesHelperOwnedRestartPhaseRunning(t *testing.T) {
	t.Parallel()
	fixture := newHelperFixture(t)
	journal, _, err := fixture.stager.Pending()
	if err != nil {
		t.Fatal(err)
	}
	journal, err = transitionJournal(fixture.stager, journal, PhaseHelperStarted, PhaseDaemonStopped, "", time.Now())
	if err == nil {
		journal, err = transitionJournal(fixture.stager, journal, PhaseDaemonStopped, PhaseProgramSwapped, "", time.Now())
	}
	if err == nil {
		_, err = transitionJournal(fixture.stager, journal, PhaseProgramSwapped, PhaseServiceStarted, "", time.Now())
	}
	if err != nil {
		t.Fatal(err)
	}
	launcher := &recordingHelperLauncher{stager: fixture.stager, launched: make(chan HelperLaunch, 1)}
	shutdown := make(chan struct{}, 1)
	coordinator, err := NewCoordinator(CoordinatorConfig{
		Stager: fixture.stager, Gate: activitygate.New(), Launcher: launcher,
		ParentPID: 123, Now: time.Now, Shutdown: func() { shutdown <- struct{}{} },
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- coordinator.Run(ctx) }()
	select {
	case <-done:
		t.Fatal("coordinator exited before the helper health handshake completed")
	case <-launcher.launched:
		t.Fatal("coordinator relaunched helper during service_started")
	case <-shutdown:
		t.Fatal("coordinator stopped the newly started daemon")
	case <-time.After(50 * time.Millisecond):
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestCoordinatorRecoversTerminalPointerWithoutRestartLoop(t *testing.T) {
	t.Parallel()
	fixture := newHelperFixture(t)
	journal, _, _ := fixture.stager.Pending()
	var err error
	for _, transition := range []struct{ from, to Phase }{
		{PhaseHelperStarted, PhaseDaemonStopped},
		{PhaseDaemonStopped, PhaseProgramSwapped},
		{PhaseProgramSwapped, PhaseServiceStarted},
		{PhaseServiceStarted, PhaseHealthy},
	} {
		journal, err = transitionJournal(
			fixture.stager, journal, transition.from, transition.to, "", time.Now(),
		)
		if err != nil {
			t.Fatal(err)
		}
	}
	launcher := &recordingHelperLauncher{stager: fixture.stager, launched: make(chan HelperLaunch, 1)}
	coordinator, err := NewCoordinator(CoordinatorConfig{
		Stager: fixture.stager, Gate: activitygate.New(), Launcher: launcher,
		ParentPID: 123, Now: time.Now, Shutdown: func() { t.Error("terminal recovery requested shutdown") },
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- coordinator.Run(ctx) }()
	time.Sleep(50 * time.Millisecond)
	if _, ok, err := fixture.stager.Pending(); err != nil || ok {
		t.Fatalf("terminal pending pointer was not cleared: ok=%t err=%v", ok, err)
	}
	select {
	case <-done:
		t.Fatal("terminal recovery exited daemon coordinator")
	default:
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}
