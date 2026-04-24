package ingressproxy

import (
	"context"
	"net"
	"testing"
	"time"
)

type recordingDownstreamObserver struct {
	accepted uint64
	closed   uint64
	forced   uint64
	current  int64
}

func (o *recordingDownstreamObserver) AddDownstreamAccepted(delta uint64)      { o.accepted += delta }
func (o *recordingDownstreamObserver) AddDownstreamClosed(delta uint64)        { o.closed += delta }
func (o *recordingDownstreamObserver) ObserveDownstreamForceClosed(delta uint64) { o.forced += delta }
func (o *recordingDownstreamObserver) SetDownstreamCurrent(count int64)        { o.current = count }

func TestTrackedListenerTracksAcceptedAndClosedConnections(t *testing.T) {
	t.Parallel()

	base, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer base.Close()

	observer := &recordingDownstreamObserver{}
	listener := NewTrackedListener(base, observer)

	accepted := make(chan net.Conn, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		accepted <- conn
	}()

	clientConn, err := net.Dial("tcp", base.Addr().String())
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer clientConn.Close()

	serverConn := <-accepted
	if listener.Current() != 1 {
		t.Fatalf("expected 1 current connection, got %d", listener.Current())
	}
	if observer.accepted != 1 {
		t.Fatalf("expected accepted counter 1, got %d", observer.accepted)
	}

	if err := serverConn.Close(); err != nil {
		t.Fatalf("close server conn: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if !listener.WaitForZero(ctx) {
		t.Fatal("expected listener to reach zero connections")
	}
	if observer.closed != 1 {
		t.Fatalf("expected closed counter 1, got %d", observer.closed)
	}
	if observer.current != 0 {
		t.Fatalf("expected current gauge 0, got %d", observer.current)
	}
}

func TestTrackedListenerForceClosesRemainingConnections(t *testing.T) {
	t.Parallel()

	base, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer base.Close()

	observer := &recordingDownstreamObserver{}
	listener := NewTrackedListener(base, observer)

	accepted := make(chan net.Conn, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		accepted <- conn
	}()

	clientConn, err := net.Dial("tcp", base.Addr().String())
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer clientConn.Close()

	<-accepted
	if err := listener.CloseActive(); err != nil {
		t.Fatalf("force close active: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if !listener.WaitForZero(ctx) {
		t.Fatal("expected listener to reach zero after force close")
	}
	if observer.forced != 1 {
		t.Fatalf("expected forced counter 1, got %d", observer.forced)
	}
}
