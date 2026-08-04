package hermes

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/filelock"
)

func TestNativeProfileProvisionerCreatesAndReusesManagedProfile(t *testing.T) {
	t.Parallel()

	trustedHome := t.TempDir()
	defaultHome := filepath.Join(trustedHome, ".hermes")
	if err := os.MkdirAll(defaultHome, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(
		filepath.Join(defaultHome, "config.yaml"),
		[]byte("model:\n  default: test\n"),
		0o600,
	); err != nil {
		t.Fatal(err)
	}

	var calls atomic.Int32
	var observed profileCommandRequest
	provisioner, err := newNativeProfileProvisioner(profileProvisionerOptions{
		TrustedHome: trustedHome,
		Candidate: executableCandidate{
			Path:       "/opt/hermes/bin/hermes",
			ArgsPrefix: []string{"--managed-test-prefix"},
		},
		Run: func(
			_ context.Context,
			request profileCommandRequest,
		) ([]byte, error) {
			calls.Add(1)
			observed = request
			selection, selectionErr := managedProfileSelection(
				trustedHome,
				"agent-1",
			)
			if selectionErr != nil {
				return nil, selectionErr
			}
			if mkdirErr := os.MkdirAll(selection.Home, 0o700); mkdirErr != nil {
				return nil, mkdirErr
			}
			if writeErr := os.MkdirAll(
				filepath.Join(selection.Home, "memories"),
				0o700,
			); writeErr != nil {
				return nil, writeErr
			}
			if writeErr := os.WriteFile(
				filepath.Join(selection.Home, "memories", "MEMORY.md"),
				[]byte("default identity"),
				0o600,
			); writeErr != nil {
				return nil, writeErr
			}
			return []byte("created"), nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	selection, err := provisioner.Ensure(context.Background(), "agent-1")
	if err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 1 {
		t.Fatalf("native create calls = %d", calls.Load())
	}
	wantArgs := []string{
		"--managed-test-prefix",
		"profile",
		"create",
		selection.Name,
		"--clone",
		"--clone-from",
		"default",
		"--no-alias",
	}
	if observed.Path != "/opt/hermes/bin/hermes" ||
		!reflect.DeepEqual(observed.Args, wantArgs) {
		t.Fatalf("native create request = %#v", observed)
	}
	if observed.Environment["HOME"] != trustedHome ||
		observed.Environment["HERMES_HOME"] != "" ||
		observed.Environment["HERMES_PROFILE"] != "" {
		t.Fatalf("native create environment = %#v", observed.Environment)
	}
	info, err := os.Stat(filepath.Join(selection.Home, managedProfileMarkerName))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("ownership marker mode = %o", info.Mode().Perm())
	}
	if _, err := os.Stat(
		filepath.Join(selection.Home, "memories", "MEMORY.md"),
	); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("legacy cloned identity was not scrubbed: %v", err)
	}

	reused, err := provisioner.Ensure(context.Background(), "agent-1")
	if err != nil {
		t.Fatal(err)
	}
	if reused.Name != selection.Name ||
		reused.Home != selection.Home ||
		reused.Explicit != selection.Explicit ||
		!reflect.DeepEqual(reused.Args, selection.Args) {
		t.Fatalf("reused selection = %#v, want %#v", reused, selection)
	}
	if calls.Load() != 1 {
		t.Fatalf("restart recloned managed Profile: calls = %d", calls.Load())
	}
}

func TestNativeProfileProvisionerRejectsUnmanagedCollision(t *testing.T) {
	t.Parallel()

	trustedHome := t.TempDir()
	if err := os.MkdirAll(
		filepath.Join(trustedHome, ".hermes"),
		0o700,
	); err != nil {
		t.Fatal(err)
	}
	selection, err := managedProfileSelection(trustedHome, "agent-1")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(selection.Home, 0o700); err != nil {
		t.Fatal(err)
	}

	var calls atomic.Int32
	provisioner, err := newNativeProfileProvisioner(profileProvisionerOptions{
		TrustedHome: trustedHome,
		Candidate:   executableCandidate{Path: "/opt/hermes/bin/hermes"},
		Run: func(
			context.Context,
			profileCommandRequest,
		) ([]byte, error) {
			calls.Add(1)
			return nil, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	if _, err := provisioner.Ensure(
		context.Background(),
		"agent-1",
	); err == nil || !strings.Contains(err.Error(), "unmanaged") {
		t.Fatalf("collision error = %v", err)
	}
	if calls.Load() != 0 {
		t.Fatalf("unmanaged collision invoked native create %d times", calls.Load())
	}
}

func TestNativeProfileProvisionerRecoversNativeCreatedTransaction(t *testing.T) {
	t.Parallel()

	trustedHome := t.TempDir()
	if err := os.MkdirAll(
		filepath.Join(trustedHome, ".hermes"),
		0o700,
	); err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int32
	provisioner, err := newNativeProfileProvisioner(profileProvisionerOptions{
		TrustedHome: trustedHome,
		Candidate:   executableCandidate{Path: "/opt/hermes/bin/hermes"},
		Run: func(
			context.Context,
			profileCommandRequest,
		) ([]byte, error) {
			calls.Add(1)
			return nil, errors.New("native create must not be repeated")
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	selection, err := managedProfileSelection(trustedHome, "agent-1")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(selection.Home, 0o700); err != nil {
		t.Fatal(err)
	}
	transaction, err := provisioner.newTransaction("agent-1", selection)
	if err != nil {
		t.Fatal(err)
	}
	transaction.Phase = profileTransactionNativeCreated
	if err := provisioner.writeTransaction(transaction); err != nil {
		t.Fatal(err)
	}

	recovered, err := provisioner.Ensure(context.Background(), "agent-1")
	if err != nil {
		t.Fatal(err)
	}
	if recovered.Home != selection.Home {
		t.Fatalf("recovered selection = %#v", recovered)
	}
	if calls.Load() != 0 {
		t.Fatalf("recovery repeated native create %d times", calls.Load())
	}
	if _, err := os.Stat(provisioner.transactionPath(selection.Name)); !errors.Is(
		err,
		os.ErrNotExist,
	) {
		t.Fatalf("committed transaction still exists: %v", err)
	}
	if err := validateManagedProfileMarker(selection, "agent-1"); err != nil {
		t.Fatalf("recovered marker: %v", err)
	}
}

func TestNativeProfileProvisionerRefusesAmbiguousPlannedTarget(t *testing.T) {
	t.Parallel()

	trustedHome := t.TempDir()
	if err := os.MkdirAll(
		filepath.Join(trustedHome, ".hermes"),
		0o700,
	); err != nil {
		t.Fatal(err)
	}
	provisioner, err := newNativeProfileProvisioner(profileProvisionerOptions{
		TrustedHome: trustedHome,
		Candidate:   executableCandidate{Path: "/opt/hermes/bin/hermes"},
		Run: func(
			context.Context,
			profileCommandRequest,
		) ([]byte, error) {
			return nil, errors.New("must not run")
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	selection, err := managedProfileSelection(trustedHome, "agent-1")
	if err != nil {
		t.Fatal(err)
	}
	transaction, err := provisioner.newTransaction("agent-1", selection)
	if err != nil {
		t.Fatal(err)
	}
	if err := provisioner.writeTransaction(transaction); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(selection.Home, 0o700); err != nil {
		t.Fatal(err)
	}
	sentinel := filepath.Join(selection.Home, "operator-data")
	if err := os.WriteFile(sentinel, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}

	if _, err := provisioner.Ensure(
		context.Background(),
		"agent-1",
	); err == nil || !strings.Contains(err.Error(), "ambiguous") {
		t.Fatalf("ambiguous recovery error = %v", err)
	}
	if data, err := os.ReadFile(sentinel); err != nil || string(data) != "keep" {
		t.Fatalf("ambiguous target was mutated: data=%q err=%v", data, err)
	}
	if _, err := os.Stat(
		filepath.Join(selection.Home, managedProfileMarkerName),
	); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("ambiguous target was adopted: %v", err)
	}
}

func TestNativeProfileProvisionerSerializesConcurrentEnsure(t *testing.T) {
	t.Parallel()

	trustedHome := t.TempDir()
	if err := os.MkdirAll(
		filepath.Join(trustedHome, ".hermes"),
		0o700,
	); err != nil {
		t.Fatal(err)
	}
	createStarted := make(chan struct{})
	allowCreate := make(chan struct{})
	var calls atomic.Int32
	provisioner, err := newNativeProfileProvisioner(profileProvisionerOptions{
		TrustedHome: trustedHome,
		Candidate:   executableCandidate{Path: "/opt/hermes/bin/hermes"},
		LockWait:    2 * time.Second,
		Run: func(
			_ context.Context,
			_ profileCommandRequest,
		) ([]byte, error) {
			if calls.Add(1) == 1 {
				close(createStarted)
			}
			<-allowCreate
			selection, selectionErr := managedProfileSelection(
				trustedHome,
				"agent-1",
			)
			if selectionErr != nil {
				return nil, selectionErr
			}
			return nil, os.MkdirAll(selection.Home, 0o700)
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	var wait sync.WaitGroup
	wait.Add(2)
	results := make(chan error, 2)
	go func() {
		defer wait.Done()
		_, ensureErr := provisioner.Ensure(context.Background(), "agent-1")
		results <- ensureErr
	}()
	<-createStarted
	go func() {
		defer wait.Done()
		_, ensureErr := provisioner.Ensure(context.Background(), "agent-1")
		results <- ensureErr
	}()
	close(allowCreate)
	wait.Wait()
	close(results)

	for result := range results {
		if result != nil {
			t.Fatalf("concurrent Ensure: %v", result)
		}
	}
	if calls.Load() != 1 {
		t.Fatalf("native create calls = %d, want 1", calls.Load())
	}
}

func TestNativeProfileProvisionerReturnsTypedBusyError(t *testing.T) {
	t.Parallel()

	trustedHome := t.TempDir()
	if err := os.MkdirAll(
		filepath.Join(trustedHome, ".hermes"),
		0o700,
	); err != nil {
		t.Fatal(err)
	}
	provisioner, err := newNativeProfileProvisioner(profileProvisionerOptions{
		TrustedHome: trustedHome,
		Candidate:   executableCandidate{Path: "/opt/hermes/bin/hermes"},
		LockWait:    40 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	selection, err := managedProfileSelection(trustedHome, "agent-1")
	if err != nil {
		t.Fatal(err)
	}
	held, err := filelock.Acquire(provisioner.lockPath(selection.Name))
	if err != nil {
		t.Fatal(err)
	}
	defer held.Release()

	started := time.Now()
	_, err = provisioner.Ensure(context.Background(), "agent-1")
	if !errors.Is(err, ErrProfileProvisioningBusy) {
		t.Fatalf("busy error = %v", err)
	}
	if elapsed := time.Since(started); elapsed < 20*time.Millisecond ||
		elapsed > time.Second {
		t.Fatalf("bounded lock wait = %v", elapsed)
	}
}

func TestNativeProfileProvisionerDoesNotOwnFailedPostcondition(t *testing.T) {
	t.Parallel()

	trustedHome := t.TempDir()
	defaultHome := filepath.Join(trustedHome, ".hermes")
	if err := os.MkdirAll(defaultHome, 0o700); err != nil {
		t.Fatal(err)
	}
	defaultCredential := filepath.Join(defaultHome, ".env")
	if err := os.WriteFile(
		defaultCredential,
		[]byte("TEST_ONLY=unchanged"),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	provisioner, err := newNativeProfileProvisioner(profileProvisionerOptions{
		TrustedHome: trustedHome,
		Candidate:   executableCandidate{Path: "/opt/hermes/bin/hermes"},
		Run: func(
			_ context.Context,
			_ profileCommandRequest,
		) ([]byte, error) {
			selection, selectionErr := managedProfileSelection(
				trustedHome,
				"agent-1",
			)
			if selectionErr != nil {
				return nil, selectionErr
			}
			if mkdirErr := os.MkdirAll(selection.Home, 0o700); mkdirErr != nil {
				return nil, mkdirErr
			}
			return nil, os.WriteFile(
				filepath.Join(selection.Home, "state.db"),
				[]byte("unexpected runtime state"),
				0o600,
			)
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	selection, err := managedProfileSelection(trustedHome, "agent-1")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := provisioner.Ensure(
		context.Background(),
		"agent-1",
	); err == nil || !strings.Contains(err.Error(), "state.db") {
		t.Fatalf("postcondition error = %v", err)
	}
	if _, err := os.Stat(
		filepath.Join(selection.Home, managedProfileMarkerName),
	); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("failed Profile was marked as owned: %v", err)
	}
	transaction, exists, err := provisioner.readTransaction(
		"agent-1",
		selection,
	)
	if err != nil {
		t.Fatal(err)
	}
	if !exists || transaction.Phase != profileTransactionNativeCreated {
		t.Fatalf("recoverable transaction = %#v exists=%v", transaction, exists)
	}
	data, err := os.ReadFile(defaultCredential)
	if err != nil || string(data) != "TEST_ONLY=unchanged" {
		t.Fatalf("default credentials changed: data=%q err=%v", data, err)
	}
}

func TestNativeProfileProvisionerRejectsSymlinkOwnershipMarker(t *testing.T) {
	t.Parallel()

	trustedHome := t.TempDir()
	if err := os.MkdirAll(
		filepath.Join(trustedHome, ".hermes"),
		0o700,
	); err != nil {
		t.Fatal(err)
	}
	provisioner, err := newNativeProfileProvisioner(profileProvisionerOptions{
		TrustedHome: trustedHome,
		Candidate:   executableCandidate{Path: "/opt/hermes/bin/hermes"},
		Run: func(
			context.Context,
			profileCommandRequest,
		) ([]byte, error) {
			return nil, errors.New("must not run")
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	selection, err := managedProfileSelection(trustedHome, "agent-1")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(selection.Home, 0o700); err != nil {
		t.Fatal(err)
	}
	marker := managedProfileMarker{
		Schema:      managedProfileMarkerSchema,
		AgentID:     "agent-1",
		ProfileName: selection.Name,
		ProfileHome: selection.Home,
		Template:    "default",
		CreatedAt:   time.Now().UTC(),
	}
	data, err := common.Marshal(marker)
	if err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "outside-marker.json")
	if err := os.WriteFile(outside, data, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(
		outside,
		filepath.Join(selection.Home, managedProfileMarkerName),
	); err != nil {
		t.Fatal(err)
	}

	if _, err := provisioner.Ensure(
		context.Background(),
		"agent-1",
	); err == nil || !strings.Contains(
		strings.ToLower(err.Error()),
		"link",
	) {
		t.Fatalf("symlink ownership error = %v", err)
	}
	if data, err := os.ReadFile(outside); err != nil ||
		string(data) == "" {
		t.Fatalf("outside marker changed: data=%q err=%v", data, err)
	}
}
