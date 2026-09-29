package gateway

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

// observedTrafficRequestBody measures the incoming body without buffering or
// changing it. In particular, no body bytes or untrusted error text are logged.
type observedTrafficRequestBody struct {
	io.ReadCloser
	bytesRead     atomic.Int64
	readWaitNanos atomic.Int64
	mu            sync.Mutex
	firstError    string
}

func (b *observedTrafficRequestBody) Read(buffer []byte) (int, error) {
	start := time.Now()
	n, err := b.ReadCloser.Read(buffer)
	b.readWaitNanos.Add(time.Since(start).Nanoseconds())
	b.bytesRead.Add(int64(n))
	if err != nil && !errors.Is(err, io.EOF) {
		b.mu.Lock()
		if b.firstError == "" {
			b.firstError = trafficErrorKind(err)
		}
		b.mu.Unlock()
	}
	return n, err
}

func (b *observedTrafficRequestBody) errorKind() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.firstError
}

func recordTrafficRequestFailure(entry *AccessLog, request *http.Request, body *observedTrafficRequestBody, contentLength int64) {
	if request != nil && request.Context().Err() != nil {
		entry.RequestContextError = trafficErrorKind(request.Context().Err())
	}
	if body == nil {
		return
	}
	declared := contentLength
	read := body.bytesRead.Load()
	waitMS := body.readWaitNanos.Load() / int64(time.Millisecond)
	entry.RequestContentLength = &declared
	entry.RequestBodyBytesRead = &read
	entry.RequestBodyReadWaitMS = &waitMS
	entry.RequestBodyErrorKind = body.errorKind()
}

func trafficErrorKind(err error) string {
	if err == nil {
		return ""
	}
	switch {
	case errors.Is(err, context.Canceled):
		return "context_canceled"
	case errors.Is(err, context.DeadlineExceeded):
		return "deadline_exceeded"
	case errors.Is(err, io.ErrUnexpectedEOF):
		return "unexpected_eof"
	case errors.Is(err, io.EOF):
		return "eof"
	case errors.Is(err, io.ErrClosedPipe):
		return "closed_pipe"
	case errors.Is(err, net.ErrClosed):
		return "network_closed"
	case errors.Is(err, syscall.ECONNRESET):
		return "connection_reset"
	case errors.Is(err, syscall.ECONNABORTED):
		return "connection_aborted"
	case errors.Is(err, syscall.EPIPE):
		return "broken_pipe"
	case errors.Is(err, syscall.ETIMEDOUT):
		return "network_timeout"
	}
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		return "dns_error"
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return "network_timeout"
	}
	if message := err.Error(); strings.Contains(message, "ContentLength=") && strings.Contains(message, "Body length") {
		return "content_length_mismatch"
	}
	return "other"
}

func trafficErrorOp(err error) string {
	var opErr *net.OpError
	if errors.As(err, &opErr) {
		switch opErr.Op {
		case "dial", "read", "write":
			return opErr.Op
		}
	}
	return ""
}
