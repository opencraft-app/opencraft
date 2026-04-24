package ingressproxy

import (
	"context"
	"net/http"
	"net/url"
	"testing"
	"time"
)

type recordingPoolObserver struct {
	lastSize int
}

func (o *recordingPoolObserver) SetPoolSize(size int) {
	o.lastSize = size
}

func (o *recordingPoolObserver) ObserveUpstreamError(string)     {}
func (o *recordingPoolObserver) ObserveRouteLookupFailure(string) {}
func (o *recordingPoolObserver) ObserveConnectionBlocked(string) {}
func (o *recordingPoolObserver) AddInFlight(string, int)         {}
func (o *recordingPoolObserver) SetCurrentConnections(int64)     {}
func (o *recordingPoolObserver) AddTotalConnections(uint64)      {}
func (o *recordingPoolObserver) ObserveCloseIdleConnections()    {}
func (o *recordingPoolObserver) ObserveResetConnections(uint64)  {}

func TestProxyPoolReusesProxyByConnectionKey(t *testing.T) {
	t.Parallel()

	pool := NewProxyPool(ProxyPoolOptions{})
	target, err := url.Parse("http://ingressproxy-g0.sandbox.svc.cluster.local")
	if err != nil {
		t.Fatalf("parse target: %v", err)
	}

	first := pool.Get(context.Background(), &ProxyDestination{
		ConnectionKey: "shard:g0",
		URL:           target,
		PreserveHost:  true,
	})
	second := pool.Get(context.Background(), &ProxyDestination{
		ConnectionKey: "shard:g0",
		URL:           target,
		PreserveHost:  true,
	})

	if first != second {
		t.Fatalf("expected same proxy instance for same connection key")
	}
}

func TestProxyPoolSeparatesProxiesByConnectionKey(t *testing.T) {
	t.Parallel()

	pool := NewProxyPool(ProxyPoolOptions{})
	target, err := url.Parse("http://10.0.0.7:49983")
	if err != nil {
		t.Fatalf("parse target: %v", err)
	}

	first := pool.Get(context.Background(), &ProxyDestination{
		ConnectionKey: "sandbox:a",
		URL:           target,
	})
	second := pool.Get(context.Background(), &ProxyDestination{
		ConnectionKey: "sandbox:b",
		URL:           target,
	})

	if first == second {
		t.Fatalf("expected different proxy instances for different connection keys")
	}
}

func TestProxyPoolUsesConfiguredTransportDefaults(t *testing.T) {
	t.Parallel()

	pool := NewProxyPool(ProxyPoolOptions{
		MaxIdleConns:        123,
		MaxIdleConnsPerHost: 17,
		MaxConnsPerHost:     29,
		IdleConnTimeout:     45 * time.Second,
	})
	target, err := url.Parse("http://10.0.0.7:49983")
	if err != nil {
		t.Fatalf("parse target: %v", err)
	}

	proxy := pool.Get(context.Background(), &ProxyDestination{
		ConnectionKey: "sandbox:a",
		URL:           target,
	})

	transport, ok := proxy.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("expected *http.Transport, got %T", proxy.Transport)
	}
	if transport.MaxIdleConns != 123 {
		t.Fatalf("MaxIdleConns mismatch: got %d want %d", transport.MaxIdleConns, 123)
	}
	if transport.MaxIdleConnsPerHost != 17 {
		t.Fatalf("MaxIdleConnsPerHost mismatch: got %d want %d", transport.MaxIdleConnsPerHost, 17)
	}
	if transport.MaxConnsPerHost != 29 {
		t.Fatalf("MaxConnsPerHost mismatch: got %d want %d", transport.MaxConnsPerHost, 29)
	}
	if transport.IdleConnTimeout != 45*time.Second {
		t.Fatalf("IdleConnTimeout mismatch: got %s want %s", transport.IdleConnTimeout, 45*time.Second)
	}
}

func TestProxyPoolDerivesPerHostBudgetsFromTotalBudget(t *testing.T) {
	t.Parallel()

	pool := NewProxyPool(ProxyPoolOptions{
		MaxIdleConns: 100,
	})
	target, err := url.Parse("http://10.0.0.7:49983")
	if err != nil {
		t.Fatalf("parse target: %v", err)
	}

	proxy := pool.Get(context.Background(), &ProxyDestination{
		ConnectionKey: "sandbox:a",
		URL:           target,
	})

	transport, ok := proxy.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("expected *http.Transport, got %T", proxy.Transport)
	}
	if transport.MaxIdleConns != 100 {
		t.Fatalf("MaxIdleConns mismatch: got %d want %d", transport.MaxIdleConns, 100)
	}
	if transport.MaxIdleConnsPerHost != 25 {
		t.Fatalf("MaxIdleConnsPerHost mismatch: got %d want %d", transport.MaxIdleConnsPerHost, 25)
	}
	if transport.MaxConnsPerHost != 25 {
		t.Fatalf("MaxConnsPerHost mismatch: got %d want %d", transport.MaxConnsPerHost, 25)
	}
}

func TestProxyPoolReportsPoolSizeOnNewProxy(t *testing.T) {
	t.Parallel()

	observer := &recordingPoolObserver{}
	pool := NewProxyPool(ProxyPoolOptions{Observer: observer})
	target, err := url.Parse("http://10.0.0.7:49983")
	if err != nil {
		t.Fatalf("parse target: %v", err)
	}

	_ = pool.Get(context.Background(), &ProxyDestination{
		ConnectionKey: "sandbox:a",
		URL:           target,
	})
	if observer.lastSize != 1 {
		t.Fatalf("expected pool size 1, got %d", observer.lastSize)
	}

	_ = pool.Get(context.Background(), &ProxyDestination{
		ConnectionKey: "sandbox:b",
		URL:           target,
	})
	if observer.lastSize != 2 {
		t.Fatalf("expected pool size 2, got %d", observer.lastSize)
	}
}

func TestProxyPoolForcesImmediateFlushForStreams(t *testing.T) {
	t.Parallel()

	pool := NewProxyPool(ProxyPoolOptions{})
	target, err := url.Parse("http://10.0.0.7:49983")
	if err != nil {
		t.Fatalf("parse target: %v", err)
	}

	proxy := pool.Get(context.Background(), &ProxyDestination{
		ConnectionKey: "sandbox:a",
		URL:           target,
	})
	if proxy.FlushInterval != -1 {
		t.Fatalf("expected FlushInterval=-1 for streaming proxy, got %v", proxy.FlushInterval)
	}
}
