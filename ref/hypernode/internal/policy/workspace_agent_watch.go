package policy

import (
	"context"
	"errors"
	"fmt"
	"io"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
)

type remoteWorkspaceWatch struct {
	mu      sync.Mutex
	root    string
	pending []string
	seen    map[string]struct{}
	failure string
	ready   bool
	closed  bool
	session *ssh.Session
	notify  func()
	done    chan struct{}
	close   sync.Once
}

func newRemoteWorkspaceWatch(root string, notify func()) *remoteWorkspaceWatch {
	return &remoteWorkspaceWatch{
		root: root, seen: make(map[string]struct{}), notify: notify, done: make(chan struct{}),
	}
}

func (w *remoteWorkspaceWatch) setSession(session *ssh.Session) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return false
	}
	w.session = session
	return true
}

func (w *remoteWorkspaceWatch) fail(err error) {
	w.mu.Lock()
	if !w.closed {
		w.failure = err.Error()
		if _, exists := w.seen[w.root]; !exists {
			w.seen[w.root] = struct{}{}
			w.pending = append(w.pending, w.root)
		}
	}
	w.mu.Unlock()
	w.notify()
}

func (w *remoteWorkspaceWatch) markReady() {
	w.mu.Lock()
	if w.closed {
		w.mu.Unlock()
		return
	}
	w.ready = true
	w.failure = ""
	// Registration is intentionally asynchronous. A root invalidation closes
	// the gap between the caller receiving fs/watch and this agent installing
	// its inotify anchors, and does the same after every reconnect.
	if _, exists := w.seen[w.root]; !exists {
		w.seen[w.root] = struct{}{}
		w.pending = append(w.pending, w.root)
	}
	w.mu.Unlock()
	w.notify()
}

func (w *remoteWorkspaceWatch) enqueue(path string) {
	w.mu.Lock()
	if w.closed {
		w.mu.Unlock()
		return
	}
	if len(w.pending) >= workspaceWatchQueueLimit {
		w.pending = []string{w.root}
		w.seen = map[string]struct{}{w.root: {}}
	} else if _, exists := w.seen[path]; !exists {
		w.seen[path] = struct{}{}
		w.pending = append(w.pending, path)
	}
	w.mu.Unlock()
	w.notify()
}

func (w *remoteWorkspaceWatch) drain() []string {
	w.mu.Lock()
	defer w.mu.Unlock()
	result := append([]string(nil), w.pending...)
	w.pending = nil
	w.seen = make(map[string]struct{})
	return result
}

func (w *remoteWorkspaceWatch) Close() {
	w.close.Do(func() {
		w.mu.Lock()
		w.closed = true
		session := w.session
		w.mu.Unlock()
		close(w.done)
		if session != nil {
			_ = session.Close()
		}
	})
}

type workspaceWatchClientProvider func(context.Context) (*ssh.Client, error)
type workspaceWatchClientInvalidator func(*ssh.Client)

func (w *remoteWorkspaceWatch) run(
	clientFor workspaceWatchClientProvider, invalidate workspaceWatchClientInvalidator,
) {
	backoff := 100 * time.Millisecond
	for {
		attemptCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		err := w.runOnce(attemptCtx, clientFor, invalidate)
		cancel()
		if err == nil {
			return
		}
		w.fail(err)
		select {
		case <-w.done:
			return
		case <-time.After(backoff):
		}
		if backoff < 5*time.Second {
			backoff *= 2
			if backoff > 5*time.Second {
				backoff = 5 * time.Second
			}
		}
	}
}

func (w *remoteWorkspaceWatch) runOnce(
	ctx context.Context, clientFor workspaceWatchClientProvider, invalidate workspaceWatchClientInvalidator,
) error {
	client, err := clientFor(ctx)
	if err != nil {
		return err
	}
	session, err := client.NewSession()
	if err != nil {
		invalidate(client)
		return fmt.Errorf("open workspace watch channel: %w", err)
	}
	if !w.setSession(session) {
		_ = session.Close()
		return nil
	}
	defer session.Close()
	defer func() {
		w.mu.Lock()
		if w.session == session {
			w.session = nil
		}
		w.mu.Unlock()
	}()
	stdin, err := session.StdinPipe()
	if err != nil {
		_ = session.Close()
		return err
	}
	stdout, err := session.StdoutPipe()
	if err != nil {
		_ = session.Close()
		return err
	}
	stderr, err := session.StderrPipe()
	if err != nil {
		_ = session.Close()
		return err
	}
	if err := session.Start(workspaceStdioFastCommand); err != nil {
		_ = session.Close()
		return fmt.Errorf("start workspace watch fast path: %w", err)
	}
	if err := writeWorkspaceStdioFrame(stdin, workspaceStdioRequest{
		Operation: "watch", Path: w.root, Recursive: true,
	}); err != nil {
		_ = session.Close()
		return err
	}
	go func() { _, _ = io.Copy(io.Discard, io.LimitReader(stderr, 64*1024)) }()
	for {
		var message workspaceStdioMessage
		if err := readWorkspaceStdioFrame(stdout, &message); err != nil {
			w.mu.Lock()
			closed := w.closed
			w.mu.Unlock()
			if closed {
				return nil
			}
			return fmt.Errorf("read workspace watch event: %w", err)
		}
		switch message.Type {
		case "ready":
			w.markReady()
		case "event":
			if message.Path != "" {
				w.enqueue(message.Path)
			}
		case "error":
			return errors.New(message.Message)
		}
	}
}
