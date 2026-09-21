package workspaces

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

const catalogVersion = 1

type RootBinding struct {
	ThreadID  string `json:"threadId"`
	Workspace Ref    `json:"workspace"`
}

type CatalogSnapshot struct {
	Version    int            `json:"version"`
	Root       *RootBinding   `json:"root,omitempty"`
	Workspaces map[string]Ref `json:"workspaces"`
	// Threads is the durable Thread -> WorkspaceRef ownership relation. UI and
	// AppServer projections may be rebuilt, but this binding is resource truth.
	Threads map[string]Ref `json:"threads"`
}

// Catalog is independent from Thread projection storage. It records resources
// that really exist, not AppServer/UI projections of those resources.
type Catalog struct {
	path string
	mu   sync.Mutex
	data CatalogSnapshot
}

func OpenCatalog(path string) (*Catalog, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return nil, fmt.Errorf("workspace catalog path must be absolute and clean: %q", path)
	}
	c := &Catalog{path: path, data: CatalogSnapshot{
		Version: catalogVersion, Workspaces: map[string]Ref{}, Threads: map[string]Ref{},
	}}
	bytes, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return c, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read workspace catalog: %w", err)
	}
	if err := json.Unmarshal(bytes, &c.data); err != nil {
		return nil, fmt.Errorf("decode workspace catalog: %w", err)
	}
	if c.data.Version != catalogVersion {
		return nil, fmt.Errorf("unsupported workspace catalog version %d", c.data.Version)
	}
	if c.data.Workspaces == nil {
		c.data.Workspaces = map[string]Ref{}
	}
	if c.data.Threads == nil {
		c.data.Threads = map[string]Ref{}
	}
	if c.data.Root != nil {
		// Catalog v1 drafts did not yet persist the general Thread binding.
		c.data.Threads[c.data.Root.ThreadID] = c.data.Root.Workspace
	}
	return c, nil
}

func (c *Catalog) Snapshot() CatalogSnapshot {
	c.mu.Lock()
	defer c.mu.Unlock()
	return cloneSnapshot(c.data)
}

func (c *Catalog) update(change func(*CatalogSnapshot) error) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	next := cloneSnapshot(c.data)
	if err := change(&next); err != nil {
		return err
	}
	if err := c.persist(next); err != nil {
		return err
	}
	c.data = next
	return nil
}

func (c *Catalog) persist(snapshot CatalogSnapshot) error {
	if err := os.MkdirAll(filepath.Dir(c.path), 0o700); err != nil {
		return fmt.Errorf("create workspace catalog directory: %w", err)
	}
	bytes, err := json.MarshalIndent(snapshot, "", "  ")
	if err != nil {
		return fmt.Errorf("encode workspace catalog: %w", err)
	}
	temporary, err := os.CreateTemp(filepath.Dir(c.path), ".workspace-catalog-*")
	if err != nil {
		return fmt.Errorf("create workspace catalog temporary file: %w", err)
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return err
	}
	if _, err := temporary.Write(append(bytes, '\n')); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Rename(temporaryPath, c.path); err != nil {
		return fmt.Errorf("replace workspace catalog: %w", err)
	}
	directory, err := os.Open(filepath.Dir(c.path))
	if err == nil {
		_ = directory.Sync()
		_ = directory.Close()
	}
	return nil
}

func cloneSnapshot(source CatalogSnapshot) CatalogSnapshot {
	result := CatalogSnapshot{
		Version:    source.Version,
		Workspaces: make(map[string]Ref, len(source.Workspaces)),
		Threads:    make(map[string]Ref, len(source.Threads)),
	}
	if source.Root != nil {
		root := *source.Root
		result.Root = &root
	}
	for key, ref := range source.Workspaces {
		result.Workspaces[key] = ref
	}
	for threadID, ref := range source.Threads {
		result.Threads[threadID] = ref
	}
	return result
}
