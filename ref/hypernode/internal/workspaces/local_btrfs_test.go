package workspaces

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type recordingRunner struct {
	mu         sync.Mutex
	subvolumes map[string]bool
	commands   []string
}

func (r *recordingRunner) Run(_ context.Context, name string, args ...string) ([]byte, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.commands = append(r.commands, name+" "+strings.Join(args, " "))
	if name != "btrfs" || len(args) < 3 || args[0] != "subvolume" {
		return nil, nil
	}
	switch args[1] {
	case "show":
		if r.subvolumes[args[2]] {
			return nil, nil
		}
		return nil, fmt.Errorf("missing")
	case "create":
		r.subvolumes[args[2]] = true
		_ = os.MkdirAll(args[2], 0o700)
	case "snapshot":
		if !r.subvolumes[args[2]] {
			return nil, fmt.Errorf("source missing")
		}
		r.subvolumes[args[3]] = true
		_ = os.MkdirAll(args[3], 0o700)
	case "delete":
		delete(r.subvolumes, args[2])
	}
	return nil, nil
}

func TestLocalBtrfsForkCopiesSystemAndData(t *testing.T) {
	mount := t.TempDir()
	template := filepath.Join(mount, ".workspaces", "templates", "ubuntu-24.04")
	runner := &recordingRunner{subvolumes: map[string]bool{template: true}}
	driver, err := NewLocalBtrfsDriver(LocalBtrfsConfig{MountPath: mount, Runner: runner})
	if err != nil {
		t.Fatal(err)
	}
	root, err := driver.Create(context.Background(), CreateSpec{ID: "root", Driver: driver.Name()})
	if err != nil {
		t.Fatal(err)
	}
	child, err := driver.Fork(context.Background(), root, ForkOptions{ID: "child"})
	if err != nil {
		t.Fatal(err)
	}
	if child.ID != "child" {
		t.Fatalf("unexpected child %#v", child)
	}
	childPaths, _ := driver.paths("child")
	if !runner.subvolumes[childPaths.System] || !runner.subvolumes[childPaths.Data] {
		t.Fatalf("fork did not snapshot both views: %#v", runner.subvolumes)
	}
}

func TestLocalBtrfsRejectsPhysicalImplementationNamesInRef(t *testing.T) {
	driver, err := NewLocalBtrfsDriver(LocalBtrfsConfig{MountPath: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := driver.paths("../@main"); err == nil {
		t.Fatal("expected traversal-like workspace id to be rejected")
	}
}

type blockingLocalRuntime struct {
	attachStarted chan struct{}
	releaseAttach chan struct{}
}

func (r *blockingLocalRuntime) Attach(_ context.Context, ref Ref, _ LocalPaths, _ AttachSpec) (Attachment, error) {
	close(r.attachStarted)
	<-r.releaseAttach
	return Attachment{ID: "attachment", Workspace: ref}, nil
}

func (*blockingLocalRuntime) Detach(context.Context, Attachment) error { return nil }
func (*blockingLocalRuntime) Quiesce(context.Context, Ref) (func() error, error) {
	return func() error { return nil }, nil
}
func (*blockingLocalRuntime) StopWorkspace(context.Context, Ref) error { return nil }

func TestLocalBtrfsForkDoesNotWaitForUnrelatedAttach(t *testing.T) {
	mount := t.TempDir()
	sourcePaths := LocalPaths{
		System: filepath.Join(mount, ".workspaces", "systems", "source"),
		Data:   filepath.Join(mount, ".workspaces", "data", "source"),
	}
	unrelatedPaths := LocalPaths{
		System: filepath.Join(mount, ".workspaces", "systems", "unrelated"),
		Data:   filepath.Join(mount, ".workspaces", "data", "unrelated"),
	}
	runner := &recordingRunner{subvolumes: map[string]bool{
		sourcePaths.System: true, sourcePaths.Data: true,
		unrelatedPaths.System: true, unrelatedPaths.Data: true,
	}}
	runtime := &blockingLocalRuntime{attachStarted: make(chan struct{}), releaseAttach: make(chan struct{})}
	driver, err := NewLocalBtrfsDriver(LocalBtrfsConfig{
		MountPath: mount, Runner: runner, Runtime: runtime,
	})
	if err != nil {
		t.Fatal(err)
	}

	attachDone := make(chan error, 1)
	go func() {
		_, attachErr := driver.Attach(context.Background(), Ref{ID: "unrelated", Driver: driver.Name()}, AttachSpec{
			Principal: Principal{ID: "test"},
		})
		attachDone <- attachErr
	}()
	select {
	case <-runtime.attachStarted:
	case <-time.After(time.Second):
		t.Fatal("unrelated attach did not start")
	}

	forkDone := make(chan error, 1)
	go func() {
		_, forkErr := driver.Fork(context.Background(), Ref{ID: "source", Driver: driver.Name()}, ForkOptions{ID: "child"})
		forkDone <- forkErr
	}()
	select {
	case forkErr := <-forkDone:
		if forkErr != nil {
			t.Fatal(forkErr)
		}
	case <-time.After(time.Second):
		t.Fatal("fork waited for an unrelated workspace attach")
	}
	close(runtime.releaseAttach)
	if err := <-attachDone; err != nil {
		t.Fatal(err)
	}
}
