package workersapi

import (
	"log/slog"
	"net/http"
	"net/http/httptrace"
	"sync"
	"time"
)

// fetchTransportTrace observes client-side milestones, not execution or commit
// at the target. Even a successful local write does not prove target delivery.
// It owns no retries, deadlines, bodies, headers, or persistent state.
type fetchTransportTrace struct {
	mu        sync.Mutex
	started   time.Time
	connected time.Time
	written   time.Time
	firstByte time.Time
	writeFail bool
	reused    bool
	localAddr string
	peerAddr  string
}

func traceFetchRequest(request *http.Request) (*http.Request, *fetchTransportTrace) {
	trace := &fetchTransportTrace{started: time.Now()}
	hooks := &httptrace.ClientTrace{
		GotConn: func(info httptrace.GotConnInfo) {
			trace.mu.Lock()
			defer trace.mu.Unlock()
			trace.connected = time.Now()
			trace.written, trace.firstByte = time.Time{}, time.Time{}
			trace.writeFail, trace.reused = false, info.Reused
			trace.localAddr = info.Conn.LocalAddr().String()
			trace.peerAddr = info.Conn.RemoteAddr().String()
		},
		WroteRequest: func(info httptrace.WroteRequestInfo) {
			trace.mu.Lock()
			defer trace.mu.Unlock()
			trace.writeFail = info.Err != nil
			if info.Err == nil {
				trace.written = time.Now()
			}
		},
		GotFirstResponseByte: func() {
			trace.mu.Lock()
			defer trace.mu.Unlock()
			trace.firstByte = time.Now()
		},
	}
	return request.WithContext(httptrace.WithClientTrace(request.Context(), hooks)), trace
}

func (trace *fetchTransportTrace) attributes() []slog.Attr {
	trace.mu.Lock()
	defer trace.mu.Unlock()
	phase := "acquiring_connection"
	switch {
	case !trace.firstByte.IsZero():
		phase = "reading_response_headers"
	case !trace.written.IsZero():
		phase = "awaiting_response_headers"
	case trace.writeFail:
		phase = "writing_request_failed"
	case !trace.connected.IsZero():
		phase = "writing_request"
	}
	attrs := []slog.Attr{
		slog.String("transport_phase", phase),
		slog.Int64("transport_elapsed_ms", time.Since(trace.started).Milliseconds()),
	}
	if !trace.connected.IsZero() {
		attrs = append(attrs,
			slog.Int64("transport_connected_ms", trace.connected.Sub(trace.started).Milliseconds()),
			slog.Bool("transport_connection_reused", trace.reused),
			slog.String("transport_local_addr", trace.localAddr),
			slog.String("transport_peer_addr", trace.peerAddr),
		)
	}
	if !trace.written.IsZero() {
		attrs = append(attrs, slog.Int64("transport_written_ms", trace.written.Sub(trace.started).Milliseconds()))
	}
	if !trace.firstByte.IsZero() {
		attrs = append(attrs, slog.Int64("transport_first_byte_ms", trace.firstByte.Sub(trace.started).Milliseconds()))
	}
	return attrs
}
