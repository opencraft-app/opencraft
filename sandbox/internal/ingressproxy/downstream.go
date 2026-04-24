package ingressproxy

import (
	"context"
	"errors"
	"net"
	"sync"
	"sync/atomic"
	"time"
)

const downstreamWaitPollInterval = 200 * time.Millisecond

type downstreamAcceptedObserver interface {
	AddDownstreamAccepted(delta uint64)
}

type downstreamClosedObserver interface {
	AddDownstreamClosed(delta uint64)
}

type downstreamCurrentObserver interface {
	SetDownstreamCurrent(count int64)
}

type downstreamForcedObserver interface {
	ObserveDownstreamForceClosed(delta uint64)
}

type TrackedListener struct {
	net.Listener

	mu    sync.Mutex
	conns map[*trackedDownstreamConn]struct{}

	current  atomic.Int64
	observer any
}

func NewTrackedListener(listener net.Listener, observer any) *TrackedListener {
	return &TrackedListener{
		Listener: listener,
		conns:    make(map[*trackedDownstreamConn]struct{}),
		observer: observer,
	}
}

func (l *TrackedListener) Accept() (net.Conn, error) {
	conn, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}

	tracked := &trackedDownstreamConn{
		Conn:     conn,
		listener: l,
	}

	l.mu.Lock()
	l.conns[tracked] = struct{}{}
	l.mu.Unlock()

	current := l.current.Add(1)
	if observer, ok := l.observer.(downstreamAcceptedObserver); ok {
		observer.AddDownstreamAccepted(1)
	}
	if observer, ok := l.observer.(downstreamCurrentObserver); ok {
		observer.SetDownstreamCurrent(current)
	}

	return tracked, nil
}

func (l *TrackedListener) Current() int64 {
	return l.current.Load()
}

func (l *TrackedListener) WaitForZero(ctx context.Context) bool {
	ticker := time.NewTicker(downstreamWaitPollInterval)
	defer ticker.Stop()

	for {
		if l.Current() == 0 {
			return true
		}
		select {
		case <-ctx.Done():
			return l.Current() == 0
		case <-ticker.C:
		}
	}
}

func (l *TrackedListener) CloseActive() error {
	l.mu.Lock()
	items := make([]*trackedDownstreamConn, 0, len(l.conns))
	for conn := range l.conns {
		items = append(items, conn)
	}
	l.mu.Unlock()

	if observer, ok := l.observer.(downstreamForcedObserver); ok && len(items) > 0 {
		observer.ObserveDownstreamForceClosed(uint64(len(items)))
	}

	var errs []error
	for _, conn := range items {
		if err := conn.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

func (l *TrackedListener) release(conn *trackedDownstreamConn) {
	l.mu.Lock()
	if _, ok := l.conns[conn]; !ok {
		l.mu.Unlock()
		return
	}
	delete(l.conns, conn)
	l.mu.Unlock()

	current := l.current.Add(-1)
	if observer, ok := l.observer.(downstreamClosedObserver); ok {
		observer.AddDownstreamClosed(1)
	}
	if observer, ok := l.observer.(downstreamCurrentObserver); ok {
		observer.SetDownstreamCurrent(current)
	}
}

type trackedDownstreamConn struct {
	net.Conn

	closed   atomic.Bool
	listener *TrackedListener
}

func (c *trackedDownstreamConn) Close() error {
	err := c.Conn.Close()
	if c.closed.CompareAndSwap(false, true) {
		c.listener.release(c)
	}
	return err
}
