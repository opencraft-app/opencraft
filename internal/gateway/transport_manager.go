package gateway

import (
	"errors"
	"fmt"
	"net/http"
	"sync"
	"time"
)

var ErrRetiredRouteRevision = errors.New("route revision has been retired")

type transportPoolKey struct {
	setID         string
	routeRevision int64
}

type TransportManager struct {
	mu           sync.Mutex
	factory      func() http.RoundTripper
	drainTimeout time.Duration
	current      map[string]int64
	transports   map[transportPoolKey]http.RoundTripper
	timers       map[transportPoolKey]*time.Timer
	closed       bool
}

func NewTransportManager(factory func() http.RoundTripper, drainTimeout time.Duration) *TransportManager {
	if drainTimeout <= 0 {
		drainTimeout = 330 * time.Second
	}
	return &TransportManager{
		factory: factory, drainTimeout: drainTimeout,
		current: map[string]int64{}, transports: map[transportPoolKey]http.RoundTripper{}, timers: map[transportPoolKey]*time.Timer{},
	}
}

func (m *TransportManager) DrainTimeout() time.Duration {
	if m == nil {
		return 0
	}
	return m.drainTimeout
}

func (m *TransportManager) Get(setID string, routeRevision int64) (http.RoundTripper, error) {
	if m == nil || m.factory == nil {
		return nil, fmt.Errorf("traffic transport factory is unavailable")
	}
	if setID == "" || routeRevision <= 0 {
		return nil, fmt.Errorf("set_id and positive route_revision are required")
	}
	key := transportPoolKey{setID: setID, routeRevision: routeRevision}

	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return nil, fmt.Errorf("transport manager is closed")
	}
	current := m.current[setID]
	if routeRevision < current {
		transport, ok := m.transports[key]
		m.mu.Unlock()
		if !ok {
			return nil, ErrRetiredRouteRevision
		}
		return transport, nil
	}
	transport, ok := m.transports[key]
	if !ok {
		transport = m.factory()
		if transport == nil {
			m.mu.Unlock()
			return nil, fmt.Errorf("traffic transport factory returned nil")
		}
		m.transports[key] = transport
	}
	var draining []http.RoundTripper
	if routeRevision > current {
		m.current[setID] = routeRevision
		for oldKey, oldTransport := range m.transports {
			if oldKey.setID != setID || oldKey.routeRevision >= routeRevision {
				continue
			}
			if _, scheduled := m.timers[oldKey]; scheduled {
				continue
			}
			draining = append(draining, oldTransport)
			oldKey := oldKey
			m.timers[oldKey] = time.AfterFunc(m.drainTimeout, func() { m.retire(oldKey) })
		}
	}
	m.mu.Unlock()
	for _, oldTransport := range draining {
		closeIdleConnections(oldTransport)
	}
	return transport, nil
}

func (m *TransportManager) retire(key transportPoolKey) {
	m.mu.Lock()
	transport, ok := m.transports[key]
	delete(m.transports, key)
	delete(m.timers, key)
	m.mu.Unlock()
	if ok {
		closeIdleConnections(transport)
	}
}

func (m *TransportManager) Close() {
	if m == nil {
		return
	}
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return
	}
	m.closed = true
	for _, timer := range m.timers {
		timer.Stop()
	}
	transports := make([]http.RoundTripper, 0, len(m.transports))
	for _, transport := range m.transports {
		transports = append(transports, transport)
	}
	m.transports = map[transportPoolKey]http.RoundTripper{}
	m.timers = map[transportPoolKey]*time.Timer{}
	m.mu.Unlock()
	for _, transport := range transports {
		closeIdleConnections(transport)
	}
}

func closeIdleConnections(transport http.RoundTripper) {
	if closer, ok := transport.(interface{ CloseIdleConnections() }); ok {
		closer.CloseIdleConnections()
	}
}
