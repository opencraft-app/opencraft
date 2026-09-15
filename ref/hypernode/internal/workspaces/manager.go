package workspaces

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"sync"
	"time"
)

type Manager struct {
	catalog *Catalog
	mu      sync.RWMutex
	opMu    sync.Mutex
	drivers map[string]Driver
}

func NewManager(catalog *Catalog, drivers ...Driver) (*Manager, error) {
	if catalog == nil {
		return nil, errors.New("workspace catalog is required")
	}
	m := &Manager{catalog: catalog, drivers: map[string]Driver{}}
	for _, driver := range drivers {
		if err := m.Register(driver); err != nil {
			return nil, err
		}
	}
	return m, nil
}

func (m *Manager) Register(driver Driver) error {
	if driver == nil || driver.Name() == "" {
		return errors.New("workspace driver name is required")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, found := m.drivers[driver.Name()]; found {
		return fmt.Errorf("workspace driver already registered: %s", driver.Name())
	}
	m.drivers[driver.Name()] = driver
	return nil
}

func (m *Manager) driver(name string) (Driver, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	driver := m.drivers[name]
	if driver == nil {
		return nil, unknownDriver(name)
	}
	return driver, nil
}

func (m *Manager) Root() *RootBinding {
	return m.catalog.Snapshot().Root
}

func (m *Manager) WorkspaceForThread(threadID string) (Ref, bool) {
	ref, found := m.catalog.Snapshot().Threads[threadID]
	return ref, found
}

func (m *Manager) Snapshot() CatalogSnapshot { return m.catalog.Snapshot() }

func (m *Manager) Capabilities(driverName string) (Capabilities, error) {
	driver, err := m.driver(driverName)
	if err != nil {
		return Capabilities{}, err
	}
	return driver.Capabilities(), nil
}

// ClaimRoot atomically binds the first ordinary Thread to a newly-created root
// workspace. Losing concurrent claimers receive the already durable binding.
func (m *Manager) ClaimRoot(ctx context.Context, threadID, driverName string) (RootBinding, bool, error) {
	m.opMu.Lock()
	defer m.opMu.Unlock()
	return m.claimRoot(ctx, threadID, driverName)
}

func (m *Manager) claimRoot(ctx context.Context, threadID, driverName string) (RootBinding, bool, error) {
	if threadID == "" {
		return RootBinding{}, false, errors.New("root thread id is required")
	}
	if root := m.Root(); root != nil {
		return *root, root.ThreadID == threadID, nil
	}
	driver, err := m.driver(driverName)
	if err != nil {
		return RootBinding{}, false, err
	}
	ref, err := driver.Create(ctx, CreateSpec{ID: threadID, Driver: driverName})
	if err != nil {
		return RootBinding{}, false, err
	}
	claimed := false
	err = m.catalog.update(func(snapshot *CatalogSnapshot) error {
		if snapshot.Root != nil {
			return nil
		}
		snapshot.Workspaces[ref.Key()] = ref
		snapshot.Threads[threadID] = ref
		snapshot.Root = &RootBinding{ThreadID: threadID, Workspace: ref}
		claimed = true
		return nil
	})
	if err != nil {
		_ = driver.Delete(ctx, ref)
		return RootBinding{}, false, err
	}
	root := m.Root()
	if !claimed {
		// Another process won between Create and catalog commit. The unpublished
		// resource is not reachable and must not be retained.
		_ = driver.Delete(ctx, ref)
	}
	return *root, claimed, nil
}

// EnsureThread returns an existing binding or creates an O(1) fork of the
// established root. Claiming the caller as root is retained only as an atomic
// bootstrap fallback; production policy establishes the node management
// Thread as root before any ordinary Thread can attach.
func (m *Manager) EnsureThread(ctx context.Context, threadID, driverName string) (Ref, bool, error) {
	if threadID == "" {
		return Ref{}, false, errors.New("thread id is required")
	}
	m.opMu.Lock()
	defer m.opMu.Unlock()
	if ref, found := m.catalog.Snapshot().Threads[threadID]; found {
		return ref, false, nil
	}
	if m.Root() == nil {
		root, claimed, err := m.claimRoot(ctx, threadID, driverName)
		return root.Workspace, claimed, err
	}
	root := m.Root()
	driver, err := m.driver(root.Workspace.Driver)
	if err != nil {
		return Ref{}, false, err
	}
	ref, err := driver.Fork(ctx, root.Workspace, ForkOptions{ID: threadID})
	if err != nil {
		return Ref{}, false, err
	}
	if err := m.catalog.update(func(snapshot *CatalogSnapshot) error {
		snapshot.Workspaces[ref.Key()] = ref
		snapshot.Threads[threadID] = ref
		return nil
	}); err != nil {
		_ = driver.Delete(ctx, ref)
		return Ref{}, false, err
	}
	return ref, false, nil
}

func (m *Manager) DeleteThread(ctx context.Context, threadID string) error {
	m.opMu.Lock()
	defer m.opMu.Unlock()
	snapshot := m.catalog.Snapshot()
	if snapshot.Root != nil && snapshot.Root.ThreadID == threadID {
		return ErrRootWorkspaceDelete
	}
	ref, found := snapshot.Threads[threadID]
	if !found {
		return nil
	}
	driver, err := m.driver(ref.Driver)
	if err != nil {
		return err
	}
	if err := driver.Delete(ctx, ref); err != nil {
		return err
	}
	return m.catalog.update(func(next *CatalogSnapshot) error {
		delete(next.Threads, threadID)
		delete(next.Workspaces, ref.Key())
		return nil
	})
}

func (m *Manager) ForkThread(ctx context.Context, sourceThreadID, destinationThreadID string) (Ref, error) {
	if sourceThreadID == "" || destinationThreadID == "" {
		return Ref{}, errors.New("source and destination thread ids are required")
	}
	started := time.Now()
	m.opMu.Lock()
	defer m.opMu.Unlock()
	lockWait := time.Since(started)
	snapshot := m.catalog.Snapshot()
	if existing, found := snapshot.Threads[destinationThreadID]; found {
		return existing, nil
	}
	source, found := snapshot.Threads[sourceThreadID]
	if !found {
		return Ref{}, fmt.Errorf("source thread has no workspace: %s", sourceThreadID)
	}
	driver, err := m.driver(source.Driver)
	if err != nil {
		return Ref{}, err
	}
	driverStarted := time.Now()
	ref, err := driver.Fork(ctx, source, ForkOptions{ID: destinationThreadID})
	if err != nil {
		return Ref{}, err
	}
	driverDuration := time.Since(driverStarted)
	catalogStarted := time.Now()
	if err := m.catalog.update(func(next *CatalogSnapshot) error {
		next.Workspaces[ref.Key()] = ref
		next.Threads[destinationThreadID] = ref
		return nil
	}); err != nil {
		_ = driver.Delete(ctx, ref)
		return Ref{}, err
	}
	log.Printf(
		"workspace fork timing source=%s destination=%s lock_wait_ms=%d driver_ms=%d catalog_ms=%d total_ms=%d",
		sourceThreadID, destinationThreadID, lockWait.Milliseconds(), driverDuration.Milliseconds(),
		time.Since(catalogStarted).Milliseconds(), time.Since(started).Milliseconds(),
	)
	return ref, nil
}

func (m *Manager) Create(ctx context.Context, spec CreateSpec) (Ref, error) {
	root := m.Root()
	if root == nil {
		return Ref{}, errors.New("root workspace is not initialized")
	}
	driver, err := m.driver(root.Workspace.Driver)
	if err != nil {
		return Ref{}, err
	}
	if spec.Driver != "" && spec.Driver != root.Workspace.Driver {
		return Ref{}, fmt.Errorf("creating from root across drivers requires explicit migration")
	}
	if spec.ID == "" {
		spec.ID, err = randomID()
		if err != nil {
			return Ref{}, err
		}
	}
	ref, err := driver.Fork(ctx, root.Workspace, ForkOptions{ID: spec.ID})
	if err != nil {
		return Ref{}, err
	}
	if err := m.record(ref); err != nil {
		_ = driver.Delete(ctx, ref)
		return Ref{}, err
	}
	return ref, nil
}

func (m *Manager) Fork(ctx context.Context, source Ref, options ForkOptions) (Ref, error) {
	if err := source.Validate(); err != nil {
		return Ref{}, err
	}
	driver, err := m.driver(source.Driver)
	if err != nil {
		return Ref{}, err
	}
	if options.ID == "" {
		options.ID, err = randomID()
		if err != nil {
			return Ref{}, err
		}
	}
	ref, err := driver.Fork(ctx, source, options)
	if err != nil {
		return Ref{}, err
	}
	if err := m.record(ref); err != nil {
		_ = driver.Delete(ctx, ref)
		return Ref{}, err
	}
	return ref, nil
}

func (m *Manager) Attach(ctx context.Context, ref Ref, spec AttachSpec) (Attachment, error) {
	if err := ref.Validate(); err != nil {
		return Attachment{}, err
	}
	driver, err := m.driver(ref.Driver)
	if err != nil {
		return Attachment{}, err
	}
	return driver.Attach(ctx, ref, spec)
}

func (m *Manager) Detach(ctx context.Context, attachment Attachment) error {
	driver, err := m.driver(attachment.Workspace.Driver)
	if err != nil {
		return err
	}
	return driver.Detach(ctx, attachment)
}

func (m *Manager) Delete(ctx context.Context, ref Ref) error {
	if root := m.Root(); root != nil && root.Workspace == ref {
		return ErrRootWorkspaceDelete
	}
	driver, err := m.driver(ref.Driver)
	if err != nil {
		return err
	}
	if err := driver.Delete(ctx, ref); err != nil {
		return err
	}
	return m.catalog.update(func(snapshot *CatalogSnapshot) error {
		for threadID, bound := range snapshot.Threads {
			if bound == ref {
				delete(snapshot.Threads, threadID)
			}
		}
		delete(snapshot.Workspaces, ref.Key())
		return nil
	})
}

func (m *Manager) record(ref Ref) error {
	if err := ref.Validate(); err != nil {
		return err
	}
	return m.catalog.update(func(snapshot *CatalogSnapshot) error {
		snapshot.Workspaces[ref.Key()] = ref
		return nil
	})
}

func randomID() (string, error) {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return "", fmt.Errorf("generate workspace id: %w", err)
	}
	return hex.EncodeToString(bytes[:]), nil
}
