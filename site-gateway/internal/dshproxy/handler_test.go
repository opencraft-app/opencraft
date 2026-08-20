package dshproxy

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"git.woa.com/wisp/mono/site-gateway/internal/tatproxy"
	"github.com/gorilla/websocket"
)

type resolverFunc func(context.Context, string) (Target, error)

func (f resolverFunc) Resolve(ctx context.Context, key string) (Target, error) { return f(ctx, key) }

type directDialer struct{ address string }

func (d directDialer) DialContext(ctx context.Context, _ tatproxy.Target) (net.Conn, error) {
	var dialer net.Dialer
	return dialer.DialContext(ctx, "tcp", d.address)
}

func TestHandlerProxiesHTTPAndStripsKey(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if r.Host != remoteAddress || r.Header.Get("Origin") != "http://"+remoteAddress || r.Header.Get("Key") != "" || r.Header.Get("X-Forwarded-Proto") != "https" {
			t.Errorf("upstream host/origin/key/proto = %q/%q/%q/%q", r.Host, r.Header.Get("Origin"), r.Header.Get("Key"), r.Header.Get("X-Forwarded-Proto"))
		}
		w.Header().Set("X-Upstream", "yes")
		_, _ = w.Write(append([]byte(r.Method+" "+r.URL.RequestURI()+" "), body...))
	}))
	defer upstream.Close()
	address := strings.TrimPrefix(upstream.URL, "http://")
	handler, err := NewHandler(HandlerOptions{
		Resolver: resolverFunc(func(_ context.Context, key string) (Target, error) {
			if key != "opaque-secret" {
				t.Fatalf("resolver key = %q", key)
			}
			return Target{Region: "ap-beijing", InstanceID: "ins-test123"}, nil
		}),
		Dialer: directDialer{address: address}, MaxTargets: 2, IdleTTL: time.Minute,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer handler.Close()
	req := httptest.NewRequest(http.MethodPost, "http://bot.dsh.lightvela.site/api/chat?q=1", strings.NewReader("payload"))
	req.Header.Set("Key", "opaque-secret")
	req.Header.Set("Origin", "https://bot.dsh.lightvela.site")
	req.Header.Set("X-Forwarded-Proto", "https")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || rec.Header().Get("X-Upstream") != "yes" || rec.Body.String() != "POST /api/chat?q=1 payload" {
		t.Fatalf("response = %d %q headers=%v", rec.Code, rec.Body.String(), rec.Header())
	}
}

func TestHandlerProxiesWebSocket(t *testing.T) {
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	observed := make(chan http.Header, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		observed <- r.Header.Clone()
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		messageType, data, err := conn.ReadMessage()
		if err == nil {
			_ = conn.WriteMessage(messageType, data)
		}
	}))
	defer upstream.Close()
	handler, _ := NewHandler(HandlerOptions{
		Resolver: resolverFunc(func(context.Context, string) (Target, error) {
			return Target{Region: "ap-beijing", InstanceID: "ins-test123"}, nil
		}),
		Dialer: directDialer{address: strings.TrimPrefix(upstream.URL, "http://")}, MaxTargets: 2, IdleTTL: time.Minute,
	})
	defer handler.Close()
	proxy := httptest.NewServer(handler)
	defer proxy.Close()
	header := http.Header{"Key": []string{"opaque-secret"}, "Origin": []string{"https://bot.dsh.lightvela.site"}}
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(proxy.URL, "http")+"/api/events.mux", header)
	if err != nil {
		t.Fatalf("dial websocket: %v", err)
	}
	defer conn.Close()
	if err := conn.WriteMessage(websocket.TextMessage, []byte("hello")); err != nil {
		t.Fatal(err)
	}
	_, data, err := conn.ReadMessage()
	if err != nil || string(data) != "hello" {
		t.Fatalf("websocket echo = %q, err=%v", data, err)
	}
	upstreamHeader := <-observed
	if upstreamHeader.Get("Key") != "" || upstreamHeader.Get("Origin") != "http://"+remoteAddress {
		t.Fatalf("upstream key/origin = %q/%q", upstreamHeader.Get("Key"), upstreamHeader.Get("Origin"))
	}
}

func TestHandlerRejectsMultipleKeyValuesAndDeletesThem(t *testing.T) {
	resolverCalled := false
	handler, err := NewHandler(HandlerOptions{
		Resolver: resolverFunc(func(context.Context, string) (Target, error) {
			resolverCalled = true
			return Target{}, nil
		}),
		Dialer: directDialer{address: "127.0.0.1:1"}, MaxTargets: 1, IdleTTL: time.Minute,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer handler.Close()
	req := httptest.NewRequest(http.MethodGet, "http://dsh.lightvela.site/", nil)
	req.Header.Add("Key", "first")
	req.Header.Add("Key", "second")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest || resolverCalled {
		t.Fatalf("response/resolver = %d/%v, want 400/false", rec.Code, resolverCalled)
	}
	if values := req.Header.Values("Key"); len(values) != 0 {
		t.Fatalf("Key headers remained after rejection: %v", values)
	}
}
