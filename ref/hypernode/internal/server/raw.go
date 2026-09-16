package server

import (
	"context"
	"fmt"
	"io"
	"log"
	"net"
	"sync"
	"time"

	"hypernode/internal/policy"
	"hypernode/internal/store"
)

// RawServer deliberately knows nothing about SSH. It moves TCP byte chunks
// between the kernel and policy-owned protocol state machines.
type RawServer struct {
	listen string
	store  *store.Store
	policy *policy.Engine
	active sync.Map
}

func NewRaw(listen string, st *store.Store, engine *policy.Engine) (*RawServer, error) {
	if st == nil || engine == nil {
		return nil, fmt.Errorf("store and policy are required")
	}
	return &RawServer{listen: listen, store: st, policy: engine}, nil
}

func (s *RawServer) Serve(ctx context.Context) error {
	listener, err := net.Listen("tcp", s.listen)
	if err != nil {
		return err
	}
	defer listener.Close()
	go func() {
		<-ctx.Done()
		_ = listener.Close()
		s.active.Range(func(key, _ any) bool {
			_ = key.(net.Conn).Close()
			return true
		})
	}()
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	tickWake, cancelTickWake := s.policy.SubscribeTickWake()
	defer cancelTickWake()
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case <-tickWake:
				_ = s.policy.Tick()
			case <-ticker.C:
				_ = s.policy.Tick()
			}
		}
	}()
	var workers sync.WaitGroup
	defer workers.Wait()
	for {
		connection, acceptErr := listener.Accept()
		if acceptErr != nil {
			if ctx.Err() != nil {
				return nil
			}
			continue
		}
		workers.Add(1)
		s.active.Store(connection, struct{}{})
		go func() {
			defer workers.Done()
			defer s.active.Delete(connection)
			s.serveConnection(connection)
		}()
	}
}

func (s *RawServer) serveConnection(connection net.Conn) {
	defer connection.Close()
	id := connectionID(connection.RemoteAddr().String(), nil)
	openedAt := time.Now()
	closeReason := "unknown"
	defer func() {
		log.Printf(
			"honeypot connection.end connection=%s reason=%s duration_ms=%d",
			id,
			closeReason,
			time.Since(openedAt).Milliseconds(),
		)
	}()
	_ = s.store.OpenConnection(id, connection.RemoteAddr().String(), "raw-tcp")
	defer s.store.CloseConnection(id)
	context := map[string]any{"connectionId": id, "remoteAddr": connection.RemoteAddr().String()}
	wake, cancelWake := s.policy.SubscribeWake()
	defer cancelWake()
	decision, err := s.policy.TCPOpen(context)
	if err != nil {
		closeReason = "policy_open_error"
		return
	}
	if !decision.Allow {
		closeReason = "policy_open_denied"
		return
	}
	if s.writeRawDecision(id, connection, decision) != nil {
		closeReason = "open_write_error"
		return
	}
	defer func() {
		decision, _ := s.policy.TCPClose(context)
		_ = s.writeRawDecision(id, connection, decision)
	}()
	type rawRead struct {
		data    []byte
		err     error
		release chan struct{}
	}
	reads := make(chan rawRead, 1)
	stopReads := make(chan struct{})
	defer close(stopReads)
	go func() {
		defer close(reads)
		buffer := make([]byte, 64*1024)
		for {
			count, readErr := connection.Read(buffer)
			release := make(chan struct{})
			select {
			case reads <- rawRead{data: buffer[:count], err: readErr, release: release}:
			case <-stopReads:
				return
			}
			select {
			case <-release:
			case <-stopReads:
				return
			}
			if readErr != nil {
				return
			}
		}
	}()
	for {
		select {
		case read, open := <-reads:
			if !open {
				closeReason = "read_loop_closed"
				return
			}
			if len(read.data) > 0 {
				decision, err = s.policy.TCPData(map[string]any{
					"connectionId": id, "remoteAddr": connection.RemoteAddr().String(),
					"dataBytes": read.data,
				})
				if err != nil {
					closeReason = "policy_data_error"
					close(read.release)
					return
				}
				if !decision.Allow {
					closeReason = "policy_data_denied"
					close(read.release)
					return
				}
				if s.writeRawDecision(id, connection, decision) != nil {
					closeReason = "data_write_error"
					close(read.release)
					return
				}
				if decision.CloseAfterWrite {
					closeReason = "policy_data_close_after_write"
					close(read.release)
					return
				}
			}
			close(read.release)
			if read.err != nil {
				if read.err != io.EOF {
					context["error"] = read.err.Error()
					closeReason = "peer_read_error"
				} else {
					closeReason = "peer_eof"
				}
				return
			}
		case <-wake:
			decision, err = s.policy.TCPPoll(context)
			if err != nil {
				closeReason = "policy_poll_error"
				return
			}
			if !decision.Allow {
				closeReason = "policy_poll_denied"
				return
			}
			if s.writeRawDecision(id, connection, decision) != nil {
				closeReason = "poll_write_error"
				return
			}
			if decision.CloseAfterWrite {
				closeReason = "policy_poll_close_after_write"
				return
			}
		}
	}
}

func (s *RawServer) writeRawDecision(connectionID string, connection net.Conn, decision policy.Decision) error {
	if len(decision.StdoutBytes) == 0 {
		return nil
	}
	if decision.Sensitive {
		_ = s.store.Record(connectionID, "", "stream.stdout.binary", map[string]any{
			"redacted": true, "bytes": len(decision.StdoutBytes),
		})
	}
	_, err := connection.Write(decision.StdoutBytes)
	return err
}
