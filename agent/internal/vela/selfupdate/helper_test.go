package selfupdate

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	rootstate "velachat/agent/internal/state"
)

type fakeServiceManager struct {
	starts int
	stops  int
	resets int
}

func (manager *fakeServiceManager) StopMain(context.Context) error {
	manager.stops++
	return nil
}
func (manager *fakeServiceManager) StartMain(context.Context) error {
	manager.starts++
	return nil
}
func (manager *fakeServiceManager) ResetFailed(context.Context) error {
	manager.resets++
	return nil
}

type immediateParentWaiter struct{ pid int }

func (waiter *immediateParentWaiter) Wait(_ context.Context, pid int, _ time.Duration) error {
	waiter.pid = pid
	return nil
}

type fixedHealthWaiter struct{ err error }

func (waiter fixedHealthWaiter) Wait(
	context.Context, string, string, string, string, time.Duration,
) error {
	return waiter.err
}

func TestApplyHelperSwapsAndMarksHealthy(t *testing.T) {
	t.Parallel()
	fixture := newHelperFixture(t)
	manager := &fakeServiceManager{}
	parent := &immediateParentWaiter{}
	helper, err := NewApplyHelper(ApplyHelperConfig{
		StateRoot: fixture.stateRoot, InstallationRoot: fixture.installationRoot,
		TransactionID: fixture.transactionID, ParentPID: 321, Target: "linux-amd64",
		Now: time.Now, Parent: parent, Services: manager, Health: fixedHealthWaiter{},
		ParentTimeout: time.Minute, HealthTimeout: time.Minute,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := helper.Apply(context.Background()); err != nil {
		t.Fatal(err)
	}
	program, _ := os.ReadFile(filepath.Join(fixture.installationRoot, "bin", "vela-computer"))
	if string(program) != "new" || parent.pid != 321 || manager.starts != 1 || manager.stops != 1 {
		t.Fatalf("program=%q parent=%d service=%#v", program, parent.pid, manager)
	}
	journal, err := LoadJournal(fixture.stateRoot, fixture.transactionID)
	if err != nil || journal.Phase != PhaseHealthy {
		t.Fatalf("journal=%#v err=%v", journal, err)
	}
	if _, ok, err := fixture.stager.Pending(); err != nil || ok {
		t.Fatalf("pending after healthy = (%t, %v)", ok, err)
	}
}

func TestApplyHelperRollsBackBinaryAndInstallJournalWhenHealthFails(t *testing.T) {
	t.Parallel()
	fixture := newHelperFixture(t)
	manager := &fakeServiceManager{}
	helper, err := NewApplyHelper(ApplyHelperConfig{
		StateRoot: fixture.stateRoot, InstallationRoot: fixture.installationRoot,
		TransactionID: fixture.transactionID, ParentPID: 654, Target: "linux-amd64",
		Now: time.Now, Parent: &immediateParentWaiter{}, Services: manager,
		Health:        fixedHealthWaiter{err: errors.New("health timeout")},
		ParentTimeout: time.Minute, HealthTimeout: time.Minute,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := helper.Apply(context.Background()); !errors.Is(err, ErrUpdateRolledBack) {
		t.Fatalf("Apply error = %v", err)
	}
	program, _ := os.ReadFile(filepath.Join(fixture.installationRoot, "bin", "vela-computer"))
	if string(program) != "old" || manager.starts != 2 || manager.stops != 2 || manager.resets != 1 {
		t.Fatalf("rollback program=%q service=%#v", program, manager)
	}
	var installJournal map[string]any
	if err := rootstate.New(fixture.stateRoot).Read("install.journal.json", &installJournal); err != nil {
		t.Fatal(err)
	}
	if installJournal["version"] != "v0.1.51" {
		t.Fatalf("install journal after rollback = %#v", installJournal)
	}
	journal, err := LoadJournal(fixture.stateRoot, fixture.transactionID)
	if err != nil || journal.Phase != PhaseRolledBack {
		t.Fatalf("journal=%#v err=%v", journal, err)
	}
}

type helperFixture struct {
	installationRoot string
	stateRoot        string
	transactionID    string
	stager           *Stager
}

func newHelperFixture(t *testing.T) helperFixture {
	t.Helper()
	installationRoot := filepath.Join(t.TempDir(), "computer")
	stateRoot := filepath.Join(installationRoot, "state")
	binRoot := filepath.Join(installationRoot, "bin")
	candidateRoot := filepath.Join(stateRoot, "update", "candidates", "candidate")
	for _, directory := range []string{stateRoot, binRoot, candidateRoot} {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	oldDigest := sha256.Sum256([]byte("old"))
	newDigest := sha256.Sum256([]byte("new"))
	current := filepath.Join(binRoot, "vela-computer")
	_ = os.WriteFile(current, []byte("old"), 0o700)
	_ = os.WriteFile(filepath.Join(candidateRoot, "vela-computer"), []byte("new"), 0o700)
	installJournal := map[string]any{
		"schema": 1, "stage": "complete", "transactionId": "0198d444-0000-7000-8000-000000000000",
		"platformUrl": "https://platform.example", "allowInsecureHttp": false,
		"version": "v0.1.51", "target": "linux-amd64",
		"programSha256": hex.EncodeToString(oldDigest[:]),
	}
	if err := rootstate.New(stateRoot).Write("install.journal.json", installJournal); err != nil {
		t.Fatal(err)
	}
	const transactionID = "0198d444-0000-7000-8000-000000000004"
	stager, err := NewStager(StagerConfig{
		StateRoot: stateRoot, InstallationRoot: installationRoot,
		CurrentVersion: "v0.1.51", Target: "linux-amd64", CurrentProgram: current,
		Now: time.Now, NewID: func() (string, error) { return transactionID, nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := stager.Stage(context.Background(), Candidate{
		Version: "v0.1.52", Sequence: 9, Directory: candidateRoot,
		Release: VerifiedRelease{Version: "v0.1.52", Target: "linux-amd64", ProgramSHA256: newDigest, ProgramSize: 3},
	}); err != nil {
		t.Fatal(err)
	}
	journal, _, _ := stager.Pending()
	journal, err = transitionJournal(stager, journal, PhaseStaged, PhaseWaitingForIdle, "", time.Now())
	if err == nil {
		_, err = transitionJournal(stager, journal, PhaseWaitingForIdle, PhaseHelperStarted, "", time.Now())
	}
	if err != nil {
		t.Fatal(err)
	}
	return helperFixture{
		installationRoot: installationRoot, stateRoot: stateRoot,
		transactionID: transactionID, stager: stager,
	}
}
