package tatproxy

import (
	"io"
	"net"
	"os"
	"sync"
	"sync/atomic"
	"time"
)

type TatConn struct {
	session *session
	id      string
	ready   chan error
	data    chan []byte
	done    chan struct{}

	readMu          sync.Mutex
	mu              sync.Mutex
	buffer          []byte
	readDeadline    time.Time
	writeDeadline   time.Time
	deadlineChanged chan struct{}
	terminalErr     error
	bufferedBytes   atomic.Int64

	readyOnce sync.Once
	closeOnce sync.Once
}

func newTatConn(s *session, id string, queueDepth int) *TatConn {
	return &TatConn{
		session:         s,
		id:              id,
		ready:           make(chan error, 1),
		data:            make(chan []byte, queueDepth),
		done:            make(chan struct{}),
		deadlineChanged: make(chan struct{}),
	}
}

func (c *TatConn) signalReady(err error) {
	c.readyOnce.Do(func() { c.ready <- err })
}

func (c *TatConn) deliver(data []byte) {
	if len(data) == 0 {
		return
	}
	amount := int64(len(data))
	c.mu.Lock()
	select {
	case <-c.done:
		c.mu.Unlock()
		return
	default:
	}
	if !c.session.reserveBufferedBytes(c, amount) {
		c.mu.Unlock()
		c.finish(ErrBackpressure, true)
		return
	}
	copyOfData := append([]byte(nil), data...)
	select {
	case c.data <- copyOfData:
		c.mu.Unlock()
	default:
		c.session.releaseBufferedBytes(c, amount)
		c.mu.Unlock()
		c.finish(ErrBackpressure, true)
	}
}

func (c *TatConn) Read(p []byte) (int, error) {
	c.readMu.Lock()
	defer c.readMu.Unlock()
	if len(p) == 0 {
		return 0, nil
	}
	for {
		c.mu.Lock()
		if len(c.buffer) > 0 {
			n := copy(p, c.buffer)
			if n == len(c.buffer) {
				c.buffer = nil
			} else {
				c.buffer = c.buffer[n:]
			}
			c.mu.Unlock()
			c.session.releaseBufferedBytes(c, int64(n))
			return n, nil
		}
		deadline := c.readDeadline
		changed := c.deadlineChanged
		terminalErr := c.terminalErr
		c.mu.Unlock()

		select {
		case data := <-c.data:
			c.mu.Lock()
			c.buffer = data
			c.mu.Unlock()
			continue
		default:
		}
		select {
		case <-c.done:
			select {
			case data := <-c.data:
				c.mu.Lock()
				c.buffer = data
				c.mu.Unlock()
				continue
			default:
			}
			c.mu.Lock()
			terminalErr = c.terminalErr
			c.mu.Unlock()
			if terminalErr == nil {
				terminalErr = io.EOF
			}
			return 0, terminalErr
		default:
		}

		timer, timerC := deadlineTimer(deadline)
		select {
		case data := <-c.data:
			stopTimer(timer)
			c.mu.Lock()
			c.buffer = data
			c.mu.Unlock()
		case <-c.done:
			stopTimer(timer)
		case <-changed:
			stopTimer(timer)
		case <-timerC:
			return 0, os.ErrDeadlineExceeded
		}
	}
}

func (c *TatConn) Write(p []byte) (int, error) {
	if err := c.session.writeBSONForConn(c, "PtyProxyData", payload{
		ProxyID: c.id,
		Data:    append([]byte(nil), p...),
	}, time.Time{}); err != nil {
		return 0, err
	}
	return len(p), nil
}

func (c *TatConn) currentWriteState(capDeadline time.Time) (time.Time, <-chan struct{}, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	select {
	case <-c.done:
		return time.Time{}, nil, net.ErrClosed
	default:
	}
	deadline := capDeadline
	if !c.writeDeadline.IsZero() && c.writeDeadline.Before(deadline) {
		deadline = c.writeDeadline
	}
	if !time.Now().Before(deadline) {
		return time.Time{}, nil, os.ErrDeadlineExceeded
	}
	return deadline, c.deadlineChanged, nil
}

func (c *TatConn) Close() error {
	c.finish(net.ErrClosed, true)
	return nil
}

func (c *TatConn) finish(err error, notifyRemote bool) {
	c.closeOnce.Do(func() {
		c.mu.Lock()
		c.terminalErr = err
		close(c.deadlineChanged)
		close(c.done)
		c.mu.Unlock()

		// A closed transport may never call Read again. Drop any unread payload and
		// return its byte budget immediately instead of pinning process capacity.
		c.readMu.Lock()
		c.mu.Lock()
		c.buffer = nil
		for {
			select {
			case <-c.data:
			default:
				remaining := c.bufferedBytes.Swap(0)
				c.mu.Unlock()
				c.readMu.Unlock()
				c.session.releaseTargetBufferedBytes(remaining)
				goto drained
			}
		}
	drained:
		c.session.unregister(c)
		if notifyRemote {
			// Close is local and prompt. The remote close frame is best effort so a
			// congested shared WebSocket cannot stall every HTTP connection cleanup.
			go func() {
				_ = c.session.writeBSON(
					"PtyProxyClose",
					c.id,
					payload{ProxyID: c.id},
					time.Now().Add(250*time.Millisecond),
				)
			}()
		}
	})
}

func (c *TatConn) LocalAddr() net.Addr  { return tatAddr("tat-local") }
func (c *TatConn) RemoteAddr() net.Addr { return tatAddr(remoteIP + ":" + remotePort) }

func (c *TatConn) SetDeadline(deadline time.Time) error {
	c.mu.Lock()
	c.readDeadline = deadline
	c.writeDeadline = deadline
	c.signalDeadlineChangeLocked()
	c.mu.Unlock()
	return nil
}

func (c *TatConn) SetReadDeadline(deadline time.Time) error {
	c.mu.Lock()
	c.readDeadline = deadline
	c.signalDeadlineChangeLocked()
	c.mu.Unlock()
	return nil
}

func (c *TatConn) SetWriteDeadline(deadline time.Time) error {
	c.mu.Lock()
	c.writeDeadline = deadline
	c.signalDeadlineChangeLocked()
	c.mu.Unlock()
	return nil
}

func (c *TatConn) signalDeadlineChangeLocked() {
	select {
	case <-c.done:
		return
	default:
	}
	close(c.deadlineChanged)
	c.deadlineChanged = make(chan struct{})
}

func deadlineTimer(deadline time.Time) (*time.Timer, <-chan time.Time) {
	if deadline.IsZero() {
		return nil, nil
	}
	duration := time.Until(deadline)
	if duration < 0 {
		duration = 0
	}
	timer := time.NewTimer(duration)
	return timer, timer.C
}

func stopTimer(timer *time.Timer) {
	if timer != nil {
		timer.Stop()
	}
}

type tatAddr string

func (a tatAddr) Network() string { return "tat" }
func (a tatAddr) String() string  { return string(a) }
