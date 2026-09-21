package workspaces

import (
	"context"
	"errors"
	"path/filepath"
	"sync"
	"testing"
)

type fakeDriver struct {
	mu          sync.Mutex
	name        string
	refs        map[string]Ref
	created     []string
	forkedFrom  []Ref
	deleted     []Ref
	attachments map[string]Attachment
}

func newFakeDriver(name string) *fakeDriver {
	return &fakeDriver{name: name, refs: map[string]Ref{}, attachments: map[string]Attachment{}}
}

func (d *fakeDriver) Name() string { return d.name }
func (d *fakeDriver) Capabilities() Capabilities {
	return Capabilities{Fork: true, PersistentSystem: true, PersistentWorkspace: true}
}
func (d *fakeDriver) Create(_ context.Context, spec CreateSpec) (Ref, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	ref := Ref{ID: spec.ID, Driver: d.name}
	d.refs[ref.Key()] = ref
	d.created = append(d.created, spec.ID)
	return ref, nil
}
func (d *fakeDriver) Fork(_ context.Context, source Ref, options ForkOptions) (Ref, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if _, found := d.refs[source.Key()]; !found {
		return Ref{}, errors.New("source missing")
	}
	ref := Ref{ID: options.ID, Driver: d.name}
	d.refs[ref.Key()] = ref
	d.forkedFrom = append(d.forkedFrom, source)
	return ref, nil
}
func (d *fakeDriver) Attach(_ context.Context, ref Ref, _ AttachSpec) (Attachment, error) {
	attachment := Attachment{ID: "attachment-" + ref.ID, Workspace: ref, Endpoint: Endpoint{Transport: "ssh"}}
	d.attachments[attachment.ID] = attachment
	return attachment, nil
}
func (d *fakeDriver) Detach(_ context.Context, attachment Attachment) error {
	delete(d.attachments, attachment.ID)
	return nil
}
func (d *fakeDriver) Delete(_ context.Context, ref Ref) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	delete(d.refs, ref.Key())
	d.deleted = append(d.deleted, ref)
	return nil
}
func (d *fakeDriver) Exists(_ context.Context, ref Ref) (bool, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	_, found := d.refs[ref.Key()]
	return found, nil
}

func TestRootThreadIsClaimedOnceAndCreateForksIt(t *testing.T) {
	catalog, err := OpenCatalog(filepath.Join(t.TempDir(), "catalog.json"))
	if err != nil {
		t.Fatal(err)
	}
	driver := newFakeDriver("fake")
	manager, err := NewManager(catalog, driver)
	if err != nil {
		t.Fatal(err)
	}
	root, claimed, err := manager.ClaimRoot(context.Background(), "019-root", "fake")
	if err != nil {
		t.Fatal(err)
	}
	if !claimed || root.ThreadID != "019-root" || root.Workspace.ID != "019-root" {
		t.Fatalf("unexpected root: %#v claimed=%v", root, claimed)
	}
	again, claimed, err := manager.ClaimRoot(context.Background(), "other", "fake")
	if err != nil {
		t.Fatal(err)
	}
	if claimed || again != root {
		t.Fatalf("root drifted: %#v", again)
	}
	child, err := manager.Create(context.Background(), CreateSpec{ID: "child"})
	if err != nil {
		t.Fatal(err)
	}
	if child.ID != "child" || len(driver.forkedFrom) != 1 || driver.forkedFrom[0] != root.Workspace {
		t.Fatalf("create did not fork root: child=%#v sources=%#v", child, driver.forkedFrom)
	}
}

func TestRootWorkspaceCannotBeDeleted(t *testing.T) {
	catalog, _ := OpenCatalog(filepath.Join(t.TempDir(), "catalog.json"))
	driver := newFakeDriver("fake")
	manager, _ := NewManager(catalog, driver)
	root, _, err := manager.ClaimRoot(context.Background(), "root", "fake")
	if err != nil {
		t.Fatal(err)
	}
	if err := manager.Delete(context.Background(), root.Workspace); !errors.Is(err, ErrRootWorkspaceDelete) {
		t.Fatalf("expected root deletion guard, got %v", err)
	}
}

func TestDeleteWorkspaceRemovesEveryThreadBinding(t *testing.T) {
	catalog, _ := OpenCatalog(filepath.Join(t.TempDir(), "catalog.json"))
	driver := newFakeDriver("fake")
	manager, _ := NewManager(catalog, driver)
	_, _, _ = manager.EnsureThread(context.Background(), "root", "fake")
	child, _, err := manager.EnsureThread(context.Background(), "child", "fake")
	if err != nil {
		t.Fatal(err)
	}
	if err := catalog.update(func(snapshot *CatalogSnapshot) error {
		snapshot.Threads["alias"] = child
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := manager.Delete(context.Background(), child); err != nil {
		t.Fatal(err)
	}
	for _, threadID := range []string{"child", "alias"} {
		if _, found := manager.WorkspaceForThread(threadID); found {
			t.Fatalf("deleted workspace is still bound to %s", threadID)
		}
	}
}

func TestCatalogSurvivesReopen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "catalog.json")
	catalog, _ := OpenCatalog(path)
	driver := newFakeDriver("fake")
	manager, _ := NewManager(catalog, driver)
	root, _, err := manager.ClaimRoot(context.Background(), "root-thread", "fake")
	if err != nil {
		t.Fatal(err)
	}
	reopened, err := OpenCatalog(path)
	if err != nil {
		t.Fatal(err)
	}
	if reopened.Snapshot().Root == nil || *reopened.Snapshot().Root != root {
		t.Fatalf("root was not durable: %#v", reopened.Snapshot().Root)
	}
}

func TestFirstOrdinaryThreadBecomesRootAndLaterThreadsForkIt(t *testing.T) {
	catalog, _ := OpenCatalog(filepath.Join(t.TempDir(), "catalog.json"))
	driver := newFakeDriver("fake")
	manager, _ := NewManager(catalog, driver)

	first, root, err := manager.EnsureThread(context.Background(), "thread-one", "fake")
	if err != nil || !root {
		t.Fatalf("first Thread did not become root: ref=%#v root=%v err=%v", first, root, err)
	}
	second, root, err := manager.EnsureThread(context.Background(), "thread-two", "fake")
	if err != nil || root || second.ID != "thread-two" {
		t.Fatalf("second Thread was not forked: ref=%#v root=%v err=%v", second, root, err)
	}
	if ref, found := manager.WorkspaceForThread("thread-two"); !found || ref != second {
		t.Fatalf("Thread binding is not durable: %#v found=%v", ref, found)
	}
	if err := manager.DeleteThread(context.Background(), "thread-one"); !errors.Is(err, ErrRootWorkspaceDelete) {
		t.Fatalf("root Thread archive guard missing: %v", err)
	}
	if err := manager.DeleteThread(context.Background(), "thread-two"); err != nil {
		t.Fatal(err)
	}
	if _, found := manager.WorkspaceForThread("thread-two"); found {
		t.Fatal("deleted Thread still owns a workspace")
	}
}

func TestForkThreadUsesTheSourceThreadWorkspace(t *testing.T) {
	catalog, _ := OpenCatalog(filepath.Join(t.TempDir(), "catalog.json"))
	driver := newFakeDriver("fake")
	manager, _ := NewManager(catalog, driver)
	root, _, _ := manager.EnsureThread(context.Background(), "root", "fake")
	child, _ := manager.ForkThread(context.Background(), "root", "child")
	grandchild, err := manager.ForkThread(context.Background(), "child", "grandchild")
	if err != nil {
		t.Fatal(err)
	}
	if root.ID != "root" || child.ID != "child" || grandchild.ID != "grandchild" {
		t.Fatalf("unexpected refs: %#v %#v %#v", root, child, grandchild)
	}
	if got := driver.forkedFrom[len(driver.forkedFrom)-1]; got != child {
		t.Fatalf("fork used root instead of selected source: %#v", got)
	}
}
