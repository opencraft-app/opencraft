package proxycore

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync/atomic"
	"testing"
)

func TestServeStreamingHTTPDoesNotInvokeErrorHandlerAfterPartialBody(t *testing.T) {
	t.Parallel()

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()

	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		_, _ = io.WriteString(conn, "HTTP/1.1 200 OK\r\nContent-Length: 32\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\npartial-body")
	}()

	target, err := url.Parse("http://" + ln.Addr().String())
	if err != nil {
		t.Fatalf("parse target: %v", err)
	}

	var errorHandlerCalls atomic.Int32
	client := newProxyClient(PoolOptions{
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error, d *Destination) {
			errorHandlerCalls.Add(1)
			http.Error(w, "unexpected streaming error handler", http.StatusBadGateway)
		},
	}, &atomic.Uint64{}, &atomic.Int64{})

	req := httptest.NewRequest(http.MethodGet, "http://router.local/process.Process/open", nil)
	req = req.WithContext(WithDestination(context.Background(), &Destination{
		URL:           target,
		ConnectionKey: "instance-a",
	}))
	rr := httptest.NewRecorder()

	client.ServeHTTP(rr, req)

	if got := errorHandlerCalls.Load(); got != 0 {
		t.Fatalf("expected error handler not to run after partial body, got %d call(s)", got)
	}
	if rr.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", rr.Code)
	}
	if body := rr.Body.String(); body != "partial-body" {
		t.Fatalf("expected partial body only, got %q", body)
	}
}

func TestCopyResponseHeadersReplacesExistingValues(t *testing.T) {
	t.Parallel()

	dst := http.Header{"X-Test": []string{"old"}}
	src := http.Header{"X-Test": []string{"new1", "new2"}}

	copyResponseHeaders(dst, src)

	if got := dst.Values("X-Test"); len(got) != 2 || got[0] != "new1" || got[1] != "new2" {
		t.Fatalf("unexpected header values: %#v", got)
	}
}
