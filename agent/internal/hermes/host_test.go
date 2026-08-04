package hermes

import (
	"context"
	"errors"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/runtimeapi"
)

func TestPrepareManagedHostReturnsProtocolNeutralProfileMetadata(t *testing.T) {
	driver, selection, trustedHome := newManagedHermesTestDriver(
		t,
		"agent-host-contract",
	)

	host, err := driver.PrepareManagedHost(
		context.Background(),
		"agent-host-contract",
	)
	if err != nil {
		t.Fatal(err)
	}
	if host.Executable == "" ||
		host.TrustedHome != trustedHome ||
		host.ProfileName != selection.Name ||
		host.ProfileHome != selection.Home ||
		!reflect.DeepEqual(host.ProfileArgs, selection.Args) {
		t.Fatalf("PrepareManagedHost() = %#v", host)
	}
	if len(host.ArgsPrefix) == 0 {
		t.Fatalf("test executable prefix was lost: %#v", host)
	}
}

func TestManagedProfileRuntimeLeaseIsPerProfileAndReleasable(t *testing.T) {
	t.Parallel()

	trustedHome := t.TempDir()
	firstHost := ManagedHost{
		TrustedHome: trustedHome,
		ProfileName: "raft-profile-a",
	}
	secondHost := ManagedHost{
		TrustedHome: trustedHome,
		ProfileName: "raft-profile-b",
	}
	first, err := AcquireManagedProfileRuntimeLease(
		context.Background(),
		firstHost,
		100*time.Millisecond,
	)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Release()

	other, err := AcquireManagedProfileRuntimeLease(
		context.Background(),
		secondHost,
		100*time.Millisecond,
	)
	if err != nil {
		t.Fatalf("different Profile lease = %v", err)
	}
	defer other.Release()

	waitCtx, cancel := context.WithTimeout(
		context.Background(),
		50*time.Millisecond,
	)
	defer cancel()
	if _, err := AcquireManagedProfileRuntimeLease(
		waitCtx,
		firstHost,
		time.Second,
	); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("duplicate Profile lease error = %v", err)
	}

	if err := first.Release(); err != nil {
		t.Fatal(err)
	}
	reacquired, err := AcquireManagedProfileRuntimeLease(
		context.Background(),
		firstHost,
		100*time.Millisecond,
	)
	if err != nil {
		t.Fatalf("released Profile was not reacquired: %v", err)
	}
	defer reacquired.Release()

	wantLockDir := filepath.Join(
		trustedHome,
		".hermes",
		".raft-computer-go",
		"runtime-locks",
	)
	if filepath.Dir(reacquired.path) != wantLockDir {
		t.Fatalf("runtime lease path = %q, want directory %q", reacquired.path, wantLockDir)
	}
}

func TestACPDriverHoldsManagedProfileLeaseForProcessLifetime(t *testing.T) {
	driver, _, trustedHome := newManagedHermesTestDriver(
		t,
		"agent-runtime-lease",
	)
	driver.runtimeLeaseWait = 50 * time.Millisecond
	request := runtimeapi.StartRequest{
		AgentID:          "agent-runtime-lease",
		LaunchID:         "launch-runtime-lease-a",
		WorkingDirectory: t.TempDir(),
		Environment: map[string]string{
			"GO_WANT_HERMES_ACP_HELPER": "1",
			"HOME":                      trustedHome,
		},
	}
	first, err := driver.Start(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Stop(context.Background())

	request.LaunchID = "launch-runtime-lease-b"
	if _, err := driver.Start(
		context.Background(),
		request,
	); !errors.Is(err, ErrManagedProfileRuntimeBusy) {
		t.Fatalf("second Start() error = %v", err)
	}

	if err := first.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}
	request.LaunchID = "launch-runtime-lease-c"
	restarted, err := driver.Start(context.Background(), request)
	if err != nil {
		t.Fatalf("Start() after release = %v", err)
	}
	defer restarted.Stop(context.Background())
}
