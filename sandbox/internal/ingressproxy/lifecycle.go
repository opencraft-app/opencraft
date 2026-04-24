package ingressproxy

import "sync"

type lifecycleTracker struct {
	mu sync.Mutex

	sandboxToConnectionKey map[string]string
}

func newLifecycleTracker() *lifecycleTracker {
	return &lifecycleTracker{
		sandboxToConnectionKey: make(map[string]string),
	}
}

func (t *lifecycleTracker) Update(sandboxID, connectionKey string, cleanup func(string) error) error {
	if sandboxID == "" || connectionKey == "" {
		return nil
	}

	t.mu.Lock()
	previous := t.sandboxToConnectionKey[sandboxID]
	t.sandboxToConnectionKey[sandboxID] = connectionKey
	t.mu.Unlock()

	if previous != "" && previous != connectionKey {
		return cleanup(previous)
	}
	return nil
}

func (t *lifecycleTracker) Clear(sandboxID string, cleanup func(string) error) error {
	if sandboxID == "" {
		return nil
	}

	t.mu.Lock()
	previous := t.sandboxToConnectionKey[sandboxID]
	delete(t.sandboxToConnectionKey, sandboxID)
	t.mu.Unlock()

	if previous != "" {
		return cleanup(previous)
	}
	return nil
}
