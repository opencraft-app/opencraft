package tatproxy

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"go.mongodb.org/mongo-driver/v2/bson"
)

var (
	ErrConnectionLimit = errors.New("TAT per-target connection limit reached")
	ErrTargetLimit     = errors.New("TAT target limit reached")
	ErrBackpressure    = errors.New("TAT receive buffer limit reached")
	ErrOpenTimeout     = fmt.Errorf("TAT proxy open timeout: %w", context.DeadlineExceeded)
)

type ManagerOptions struct {
	Starter                   Starter
	Dialer                    *websocket.Dialer
	StartTimeout              time.Duration
	OpenTimeout               time.Duration
	IdleTimeout               time.Duration
	MaxTargets                int
	MaxConnectionsPerTarget   int
	QueueDepth                int
	MaxFrameBytes             int64
	MaxBufferedBytesPerConn   int64
	MaxBufferedBytesPerTarget int64
	MaxBufferedBytesTotal     int64
}

type Manager struct {
	opts ManagerOptions

	mu            sync.Mutex
	sessions      map[string]*sessionEntry
	closed        bool
	done          chan struct{}
	closeOnce     sync.Once
	bufferedBytes atomic.Int64
}

type sessionEntry struct {
	ready   chan struct{}
	session *session
	err     error
}

func NewManager(opts ManagerOptions) (*Manager, error) {
	if opts.Starter == nil {
		return nil, errors.New("TAT starter is required")
	}
	if opts.StartTimeout <= 0 || opts.OpenTimeout <= 0 || opts.IdleTimeout <= 0 {
		return nil, errors.New("TAT timeouts must be positive")
	}
	if opts.MaxTargets <= 0 || opts.MaxConnectionsPerTarget <= 0 || opts.QueueDepth <= 0 ||
		opts.MaxFrameBytes <= 0 || opts.MaxBufferedBytesPerConn <= 0 ||
		opts.MaxBufferedBytesPerTarget <= 0 || opts.MaxBufferedBytesTotal <= 0 {
		return nil, errors.New("TAT limits must be positive")
	}
	if opts.MaxFrameBytes > opts.MaxBufferedBytesPerConn ||
		opts.MaxBufferedBytesPerConn > opts.MaxBufferedBytesPerTarget ||
		opts.MaxBufferedBytesPerTarget > opts.MaxBufferedBytesTotal {
		return nil, errors.New("TAT byte limits must satisfy frame <= connection <= target <= total")
	}
	// ReadMessage and BSON decoding temporarily retain multiple copies of a frame.
	// Keep their worst-case aggregate below one quarter of the buffer budget.
	if int64(opts.MaxTargets) > (opts.MaxBufferedBytesTotal/4)/opts.MaxFrameBytes {
		return nil, errors.New("TAT target and frame limits exceed the transient memory budget")
	}
	if opts.Dialer == nil {
		dialer := *websocket.DefaultDialer
		dialer.HandshakeTimeout = opts.OpenTimeout
		opts.Dialer = &dialer
	}
	m := &Manager{
		opts:     opts,
		sessions: make(map[string]*sessionEntry),
		done:     make(chan struct{}),
	}
	go m.reapIdle()
	return m, nil
}

func (m *Manager) DialContext(ctx context.Context, target Target) (net.Conn, error) {
	if err := target.Validate(); err != nil {
		return nil, err
	}
	s, err := m.getSession(ctx, target)
	if err != nil {
		return nil, err
	}
	return s.openConn(ctx)
}

func (m *Manager) getSession(ctx context.Context, target Target) (*session, error) {
	key := target.Key()
	for {
		m.mu.Lock()
		if m.closed {
			m.mu.Unlock()
			return nil, net.ErrClosed
		}
		if existing := m.sessions[key]; existing != nil {
			ready := existing.ready
			m.mu.Unlock()
			select {
			case <-ready:
				if existing.err != nil {
					return nil, existing.err
				}
				if existing.session != nil && !existing.session.isClosed() {
					existing.session.touch()
					return existing.session, nil
				}
				m.mu.Lock()
				if m.sessions[key] == existing {
					delete(m.sessions, key)
				}
				m.mu.Unlock()
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-m.done:
				return nil, net.ErrClosed
			}
			continue
		}
		if len(m.sessions) >= m.opts.MaxTargets {
			m.mu.Unlock()
			return nil, ErrTargetLimit
		}
		entry := &sessionEntry{ready: make(chan struct{})}
		m.sessions[key] = entry
		m.mu.Unlock()

		s, err := m.openSession(ctx, target)
		m.mu.Lock()
		if current := m.sessions[key]; current == entry {
			entry.session = s
			entry.err = err
			if err != nil || m.closed {
				delete(m.sessions, key)
			}
			close(entry.ready)
		}
		closed := m.closed
		m.mu.Unlock()
		if closed {
			if s != nil {
				s.close(net.ErrClosed)
			}
			return nil, net.ErrClosed
		}
		if err == nil {
			// Publish the session before starting its reader. Otherwise an immediate
			// peer close can call drop before entry.session points at this session.
			go s.readLoop()
		}
		return s, err
	}
}

func (m *Manager) openSession(ctx context.Context, target Target) (*session, error) {
	startCtx, cancel := context.WithTimeout(ctx, m.opts.StartTimeout)
	bootstrap, err := m.opts.Starter.Start(startCtx, target)
	cancel()
	if err != nil {
		return nil, err
	}
	if bootstrap.SessionID == "" || bootstrap.OwnerUIN == "" || bootstrap.AppID == 0 || bootstrap.WSURL == "" {
		return nil, errors.New("incomplete TAT bootstrap")
	}
	openCtx, cancel := context.WithTimeout(ctx, m.opts.OpenTimeout)
	ws, response, err := m.opts.Dialer.DialContext(openCtx, bootstrap.WSURL, http.Header{})
	cancel()
	if response != nil && response.Body != nil {
		_ = response.Body.Close()
	}
	if err != nil {
		return nil, fmt.Errorf("connect TAT websocket: %w", err)
	}
	ws.SetReadLimit(m.opts.MaxFrameBytes)
	s := &session{
		manager:    m,
		target:     target,
		ws:         ws,
		sessionID:  bootstrap.SessionID,
		conns:      make(map[string]*TatConn),
		slots:      make(chan struct{}, m.opts.MaxConnectionsPerTarget),
		queueDepth: m.opts.QueueDepth,
		done:       make(chan struct{}),
		writeGate:  make(chan struct{}, 1),
	}
	s.writeGate <- struct{}{}
	s.touch()
	if err := s.writeJSON(map[string]any{
		"Type": "SessionAuth",
		"Data": map[string]any{
			"Uin":         bootstrap.OwnerUIN,
			"AppId":       bootstrap.AppID,
			"InstanceId":  target.InstanceID,
			"SessionId":   bootstrap.SessionID,
			"MaxIdleTime": int(m.opts.IdleTimeout.Seconds()),
		},
	}); err != nil {
		_ = ws.Close()
		return nil, fmt.Errorf("authenticate TAT websocket: %w", err)
	}
	return s, nil
}

func (m *Manager) drop(key string, candidate *session) {
	m.mu.Lock()
	if entry := m.sessions[key]; entry != nil && entry.session == candidate {
		delete(m.sessions, key)
	}
	m.mu.Unlock()
}

func (m *Manager) reapIdle() {
	interval := m.opts.IdleTimeout / 2
	if interval > time.Minute {
		interval = time.Minute
	}
	if interval < time.Second {
		interval = time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case now := <-ticker.C:
			m.mu.Lock()
			var stale []*session
			for _, entry := range m.sessions {
				if entry.session != nil && entry.session.idleFor(now) >= m.opts.IdleTimeout {
					stale = append(stale, entry.session)
				}
			}
			m.mu.Unlock()
			for _, s := range stale {
				s.close(io.EOF)
			}
		case <-m.done:
			return
		}
	}
}

func (m *Manager) Close() error {
	m.closeOnce.Do(func() {
		m.mu.Lock()
		m.closed = true
		close(m.done)
		var sessions []*session
		for _, entry := range m.sessions {
			if entry.session != nil {
				sessions = append(sessions, entry.session)
			}
		}
		m.sessions = make(map[string]*sessionEntry)
		m.mu.Unlock()
		for _, s := range sessions {
			s.close(net.ErrClosed)
		}
	})
	return nil
}

type session struct {
	manager    *Manager
	target     Target
	ws         *websocket.Conn
	sessionID  string
	queueDepth int

	writeGate     chan struct{}
	mu            sync.Mutex
	conns         map[string]*TatConn
	slots         chan struct{}
	lastUsed      time.Time
	bufferedBytes atomic.Int64

	done      chan struct{}
	closeOnce sync.Once
}

func (s *session) writeJSON(value any) error {
	deadline := time.Now().Add(10 * time.Second)
	if err := s.acquireWriter(deadline); err != nil {
		return err
	}
	defer s.releaseWriter()
	_ = s.ws.SetWriteDeadline(deadline)
	return s.ws.WriteJSON(value)
}

func (s *session) writeBSON(typ, channelID string, data payload, deadline time.Time) error {
	raw, err := marshalFrame(typ, s.sessionID, channelID, data)
	if err != nil {
		return err
	}
	if deadline.IsZero() || deadline.After(time.Now().Add(10*time.Second)) {
		deadline = time.Now().Add(10 * time.Second)
	}
	if err := s.acquireWriter(deadline); err != nil {
		return err
	}
	defer s.releaseWriter()
	_ = s.ws.SetWriteDeadline(deadline)
	if err := s.ws.WriteMessage(websocket.BinaryMessage, raw); err != nil {
		go s.close(err)
		return err
	}
	return nil
}

func marshalFrame(typ, sessionID, channelID string, data payload) ([]byte, error) {
	return bson.Marshal(frame{Type: typ, Data: envelope{
		SessionID: sessionID,
		ChannelID: channelID,
		Data:      data,
	}})
}

func (s *session) writeBSONForConn(c *TatConn, typ string, data payload, operationDeadline time.Time) error {
	raw, err := marshalFrame(typ, s.sessionID, c.id, data)
	if err != nil {
		return err
	}
	capDeadline := time.Now().Add(10 * time.Second)
	if !operationDeadline.IsZero() && operationDeadline.Before(capDeadline) {
		capDeadline = operationDeadline
	}
	if err := s.acquireWriterForConn(c, capDeadline); err != nil {
		return err
	}
	defer s.releaseWriter()

	deadline, changed, err := c.currentWriteState(capDeadline)
	if err != nil {
		return err
	}
	// Gorilla applies Conn.writeDeadline to the underlying socket at the start
	// of every WriteMessage. Refresh it for each frame so an older SessionAuth or
	// best-effort close deadline cannot poison a long-lived shared session.
	if err := s.ws.SetWriteDeadline(deadline); err != nil {
		return err
	}
	underlying := s.ws.UnderlyingConn()
	_ = underlying.SetWriteDeadline(deadline)
	writeDone := make(chan struct{})
	watcherDone := make(chan struct{})
	go func() {
		defer close(watcherDone)
		for {
			select {
			case <-c.done:
				_ = underlying.SetWriteDeadline(time.Now())
				return
			case <-s.done:
				_ = underlying.SetWriteDeadline(time.Now())
				return
			case <-changed:
				var stateErr error
				deadline, changed, stateErr = c.currentWriteState(capDeadline)
				if stateErr != nil {
					_ = underlying.SetWriteDeadline(time.Now())
					return
				}
				_ = underlying.SetWriteDeadline(deadline)
			case <-writeDone:
				return
			}
		}
	}()
	err = s.ws.WriteMessage(websocket.BinaryMessage, raw)
	close(writeDone)
	<-watcherDone
	if err != nil {
		go s.close(err)
	}
	return err
}

func (s *session) acquireWriter(deadline time.Time) error {
	timer := time.NewTimer(time.Until(deadline))
	defer timer.Stop()
	select {
	case <-s.writeGate:
		return nil
	case <-s.done:
		return net.ErrClosed
	case <-timer.C:
		return os.ErrDeadlineExceeded
	}
}

func (s *session) acquireWriterForConn(c *TatConn, capDeadline time.Time) error {
	for {
		deadline, changed, err := c.currentWriteState(capDeadline)
		if err != nil {
			return err
		}
		timer := time.NewTimer(time.Until(deadline))
		select {
		case <-s.writeGate:
			timer.Stop()
			if _, _, err := c.currentWriteState(capDeadline); err != nil {
				s.releaseWriter()
				return err
			}
			return nil
		case <-c.done:
			timer.Stop()
			return net.ErrClosed
		case <-s.done:
			timer.Stop()
			return net.ErrClosed
		case <-changed:
			timer.Stop()
			continue
		case <-timer.C:
			return os.ErrDeadlineExceeded
		}
	}
}

func (s *session) releaseWriter() {
	select {
	case s.writeGate <- struct{}{}:
	case <-s.done:
	}
}

func reserveBytes(counter *atomic.Int64, amount, limit int64) bool {
	for {
		current := counter.Load()
		if amount > limit-current {
			return false
		}
		if counter.CompareAndSwap(current, current+amount) {
			return true
		}
	}
}

func (s *session) reserveBufferedBytes(c *TatConn, amount int64) bool {
	if !reserveBytes(&s.manager.bufferedBytes, amount, s.manager.opts.MaxBufferedBytesTotal) {
		return false
	}
	if !reserveBytes(&s.bufferedBytes, amount, s.manager.opts.MaxBufferedBytesPerTarget) {
		s.manager.bufferedBytes.Add(-amount)
		return false
	}
	if !reserveBytes(&c.bufferedBytes, amount, s.manager.opts.MaxBufferedBytesPerConn) {
		s.bufferedBytes.Add(-amount)
		s.manager.bufferedBytes.Add(-amount)
		return false
	}
	return true
}

func (s *session) releaseBufferedBytes(c *TatConn, amount int64) {
	if amount <= 0 {
		return
	}
	c.bufferedBytes.Add(-amount)
	s.releaseTargetBufferedBytes(amount)
}

func (s *session) releaseTargetBufferedBytes(amount int64) {
	if amount <= 0 {
		return
	}
	s.bufferedBytes.Add(-amount)
	s.manager.bufferedBytes.Add(-amount)
}

func (s *session) openConn(ctx context.Context) (*TatConn, error) {
	select {
	case s.slots <- struct{}{}:
	case <-ctx.Done():
		return nil, ctx.Err()
	default:
		return nil, ErrConnectionLimit
	}
	c := newTatConn(s, "dsh-"+uuid.NewString(), s.queueDepth)
	s.mu.Lock()
	select {
	case <-s.done:
		s.mu.Unlock()
		<-s.slots
		return nil, net.ErrClosed
	default:
	}
	s.conns[c.id] = c
	s.lastUsed = time.Now()
	s.mu.Unlock()
	openDeadline := time.Now().Add(s.manager.opts.OpenTimeout)
	if deadline, ok := ctx.Deadline(); ok && deadline.Before(openDeadline) {
		openDeadline = deadline
	}
	if err := s.writeBSONForConn(c, "PtyProxyNew", payload{
		ProxyID: c.id,
		IP:      remoteIP,
		Port:    remotePort,
	}, openDeadline); err != nil {
		c.finish(err, false)
		return nil, err
	}
	timer := time.NewTimer(s.manager.opts.OpenTimeout)
	defer timer.Stop()
	select {
	case err := <-c.ready:
		if err != nil {
			c.finish(err, false)
			return nil, err
		}
		return c, nil
	case <-ctx.Done():
		c.finish(ctx.Err(), true)
		return nil, ctx.Err()
	case <-timer.C:
		c.finish(ErrOpenTimeout, true)
		return nil, ErrOpenTimeout
	case <-s.done:
		c.finish(net.ErrClosed, false)
		return nil, net.ErrClosed
	}
}

func (s *session) readLoop() {
	for {
		messageType, raw, err := s.ws.ReadMessage()
		if err != nil {
			s.close(err)
			return
		}
		var f frame
		switch messageType {
		case websocket.BinaryMessage:
			err = bson.Unmarshal(raw, &f)
		case websocket.TextMessage:
			err = json.Unmarshal(raw, &f)
		default:
			continue
		}
		if err != nil {
			s.close(fmt.Errorf("decode TAT frame: %w", err))
			return
		}
		if f.Type == "PtyError" || f.Type == "Error" {
			s.close(errors.New("TAT session rejected request"))
			return
		}
		proxyID := f.Data.Data.ProxyID
		if proxyID == "" {
			if frameError(f) != "" {
				s.close(errors.New("TAT session returned an error"))
				return
			}
			continue
		}
		s.mu.Lock()
		c := s.conns[proxyID]
		s.mu.Unlock()
		if c == nil {
			continue
		}
		if frameError(f) != "" {
			err := errors.New("TAT proxy rejected stream")
			c.signalReady(err)
			c.finish(err, false)
			continue
		}
		switch f.Type {
		case "PtyProxyReady":
			c.signalReady(nil)
		case "PtyProxyData":
			c.deliver(f.Data.Data.Data)
		case "PtyProxyClose":
			c.signalReady(io.EOF)
			c.finish(io.EOF, false)
		}
	}
}

func (s *session) unregister(c *TatConn) {
	s.mu.Lock()
	if s.conns[c.id] == c {
		delete(s.conns, c.id)
		<-s.slots
	}
	s.lastUsed = time.Now()
	s.mu.Unlock()
}

func (s *session) close(err error) {
	s.closeOnce.Do(func() {
		close(s.done)
		_ = s.ws.Close()
		s.mu.Lock()
		conns := make([]*TatConn, 0, len(s.conns))
		for _, c := range s.conns {
			conns = append(conns, c)
		}
		s.mu.Unlock()
		for _, c := range conns {
			c.signalReady(err)
			c.finish(err, false)
		}
		s.manager.drop(s.target.Key(), s)
	})
}

func (s *session) isClosed() bool {
	select {
	case <-s.done:
		return true
	default:
		return false
	}
}

func (s *session) touch() {
	s.mu.Lock()
	s.lastUsed = time.Now()
	s.mu.Unlock()
}

func (s *session) idleFor(now time.Time) time.Duration {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.conns) > 0 {
		return 0
	}
	return now.Sub(s.lastUsed)
}
