package filelock

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestAcquirePreventsDuplicateOwnerAndReleases(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), "computer", "service.lock")
	first, err := Acquire(path)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Release()

	if _, err := Acquire(path); !errors.Is(err, ErrLocked) {
		t.Fatalf("second Acquire error = %v", err)
	}
	if err := first.Release(); err != nil {
		t.Fatal(err)
	}
	second, err := Acquire(path)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Release()

	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %o", info.Mode().Perm())
	}
}

func TestSharedLeasesCoexistAndExcludeExclusiveLease(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), "computer", "mode.lock")
	first, err := AcquireShared(path)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Release()
	second, err := AcquireShared(path)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Release()

	if _, err := AcquireExclusive(path); !errors.Is(err, ErrLocked) {
		t.Fatalf("exclusive with shared owners error = %v", err)
	}
	if err := first.Release(); err != nil {
		t.Fatal(err)
	}
	if _, err := AcquireExclusive(path); !errors.Is(err, ErrLocked) {
		t.Fatalf("exclusive with one shared owner error = %v", err)
	}
	if err := second.Release(); err != nil {
		t.Fatal(err)
	}

	exclusive, err := AcquireExclusive(path)
	if err != nil {
		t.Fatal(err)
	}
	defer exclusive.Release()
	if _, err := AcquireShared(path); !errors.Is(err, ErrLocked) {
		t.Fatalf("shared with exclusive owner error = %v", err)
	}
}

func TestBorrowedLeaseCloseDoesNotUnlockOwner(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), "computer", "mode.lock")
	owner, err := AcquireExclusive(path)
	if err != nil {
		t.Fatal(err)
	}
	defer owner.Release()

	inheritedFile, err := owner.DuplicateForInheritance()
	if err != nil {
		t.Fatal(err)
	}
	borrowed, err := NewBorrowedLease(inheritedFile)
	if err != nil {
		t.Fatal(err)
	}
	if err := borrowed.Close(); err != nil {
		t.Fatal(err)
	}

	if _, err := AcquireShared(path); !errors.Is(err, ErrLocked) {
		t.Fatalf("shared after borrowed close error = %v, want ErrLocked", err)
	}
	if err := owner.Release(); err != nil {
		t.Fatal(err)
	}
	shared, err := AcquireShared(path)
	if err != nil {
		t.Fatal(err)
	}
	defer shared.Release()
}
