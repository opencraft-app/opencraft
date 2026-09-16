package selfupdate

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestHealthReporterWritesEvidenceOnlyForRunningExpectedProgram(t *testing.T) {
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
		journal, err = transitionJournal(fixture.stager, journal, PhaseProgramSwapped, PhaseServiceStarted, "", time.Now())
	}
	if err != nil {
		t.Fatal(err)
	}
	program := filepath.Join(fixture.installationRoot, "bin", "vela-computer")
	if err := os.WriteFile(program, []byte("new"), 0o700); err != nil {
		t.Fatal(err)
	}
	reporter, err := NewHealthReporter(HealthReporterConfig{
		StateRoot: fixture.stateRoot, Version: "v0.1.52", Program: program, Now: time.Now,
	})
	if err != nil {
		t.Fatal(err)
	}
	written, err := reporter.Report()
	if err != nil || !written {
		t.Fatalf("Report = (%t, %v)", written, err)
	}
	waiter := NewFileHealthWaiter(5 * time.Millisecond)
	if err := waiter.Wait(
		context.Background(), fixture.stateRoot, fixture.transactionID,
		"v0.1.52", journal.ToProgramSHA256, time.Second,
	); err != nil {
		t.Fatal(err)
	}
}
