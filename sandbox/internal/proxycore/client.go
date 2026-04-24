package proxycore

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
)

const (
	defaultMaxIdleConns    = 512
	defaultIdleConnTimeout = 90 * time.Second
	defaultDialTimeout     = 30 * time.Second
	defaultDialKeepAlive   = 20 * time.Second
	defaultMaxDialAttempts = 1
	hostConnectionSplit    = 4
)

type UpstreamErrorObserver interface {
	ObserveUpstreamError(class string)
}

type PoolSizeObserver interface {
	SetPoolSize(size int)
}

type ConnectionStatsObserver interface {
	SetCurrentConnections(count int64)
	AddTotalConnections(delta uint64)
}

type ConnectionLifecycleObserver interface {
	ObserveCloseIdleConnections()
	ObserveResetConnections(delta uint64)
}

type ErrorHandlerFunc func(http.ResponseWriter, *http.Request, error, *Destination)

type ModifyResponseFunc func(*http.Response, *Destination) error

type PoolOptions struct {
	MaxIdleConns        int
	MaxIdleConnsPerHost int
	MaxConnsPerHost     int
	IdleConnTimeout     time.Duration
	MaxDialAttempts     int
	DisableKeepAlives   bool
	Observer            any
	ErrorHandler        ErrorHandlerFunc
	ModifyResponse      ModifyResponseFunc
}

type ProxyPool struct {
	mu sync.RWMutex

	clients map[string]*ProxyClient
	opts    PoolOptions

	totalConnections   atomic.Uint64
	currentConnections atomic.Int64
}

func NewPool(opts PoolOptions) *ProxyPool {
	return &ProxyPool{
		clients: make(map[string]*ProxyClient),
		opts:    opts,
	}
}

func (p *ProxyPool) Get(ctx context.Context, d *Destination) *ProxyClient {
	_ = ctx

	p.mu.RLock()
	client := p.clients[d.ConnectionKey]
	p.mu.RUnlock()
	if client != nil {
		return client
	}

	p.mu.Lock()
	defer p.mu.Unlock()

	if client = p.clients[d.ConnectionKey]; client != nil {
		return client
	}

	client = newProxyClient(
		p.opts,
		&p.totalConnections,
		&p.currentConnections,
	)
	p.clients[d.ConnectionKey] = client
	if observer, ok := p.opts.Observer.(PoolSizeObserver); ok {
		observer.SetPoolSize(len(p.clients))
	}
	return client
}

func (p *ProxyPool) Close(connectionKey string) error {
	p.mu.Lock()
	client := p.clients[connectionKey]
	delete(p.clients, connectionKey)
	size := len(p.clients)
	p.mu.Unlock()

	if observer, ok := p.opts.Observer.(PoolSizeObserver); ok {
		observer.SetPoolSize(size)
	}

	if client == nil {
		return nil
	}

	client.closeIdleConnections()
	return client.resetAllConnections()
}

func (p *ProxyPool) Remove(connectionKey string) error {
	return p.Close(connectionKey)
}

func (p *ProxyPool) Has(connectionKey string) bool {
	p.mu.RLock()
	defer p.mu.RUnlock()
	_, ok := p.clients[connectionKey]
	return ok
}

func (p *ProxyPool) Size() int {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return len(p.clients)
}

func (p *ProxyPool) TotalConnections() uint64 {
	return p.totalConnections.Load()
}

func (p *ProxyPool) CurrentConnections() int64 {
	return p.currentConnections.Load()
}

type ProxyClient struct {
	httputil.ReverseProxy

	transport         *http.Transport
	activeConnections *trackedConnectionSet
	observer          any
}

func newProxyClient(opts PoolOptions, totalConnections *atomic.Uint64, currentConnections *atomic.Int64) *ProxyClient {
	activeConnections := newTrackedConnectionSet()
	maxIdleConns := withDefaultInt(opts.MaxIdleConns, defaultMaxIdleConns)
	maxIdleConnsPerHost := splitHostConnections(maxIdleConns, opts.MaxIdleConnsPerHost)
	maxConnsPerHost := splitHostConnections(maxIdleConns, opts.MaxConnsPerHost)
	transport := &http.Transport{
		Proxy:               http.ProxyFromEnvironment,
		MaxIdleConns:        maxIdleConns,
		MaxIdleConnsPerHost: maxIdleConnsPerHost,
		MaxConnsPerHost:     maxConnsPerHost,
		IdleConnTimeout:     withDefaultDuration(opts.IdleConnTimeout, defaultIdleConnTimeout),
		TLSHandshakeTimeout: 0,
		DisableKeepAlives:   opts.DisableKeepAlives,
		ForceAttemptHTTP2:   false,
		DisableCompression:  true,
	}

	maxAttempts := withDefaultInt(opts.MaxDialAttempts, defaultMaxDialAttempts)
	transport.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		var conn net.Conn
		var err error

		for attempt := 0; attempt < maxAttempts; attempt++ {
			conn, err = (&net.Dialer{
				Timeout:   defaultDialTimeout,
				KeepAlive: defaultDialKeepAlive,
			}).DialContext(ctx, network, addr)
			if err == nil {
				totalConnections.Add(1)
				if observer, ok := opts.Observer.(ConnectionStatsObserver); ok {
					observer.AddTotalConnections(1)
				}
				return newTrackedConnection(conn, currentConnections, activeConnections, opts.Observer), nil
			}
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			if attempt < maxAttempts-1 {
				backoff := time.Duration(100*(attempt+1)) * time.Millisecond
				select {
				case <-time.After(backoff):
				case <-ctx.Done():
					return nil, ctx.Err()
				}
			}
		}

		return nil, err
	}

	pc := &ProxyClient{
		transport:         transport,
		activeConnections: activeConnections,
		observer:          opts.Observer,
	}

	pc.ReverseProxy = httputil.ReverseProxy{
		Transport:     transport,
		FlushInterval: -1,
		Rewrite: func(r *httputil.ProxyRequest) {
			d, ok := GetDestination(r.In.Context())
			if !ok || d == nil || d.URL == nil {
				r.SetURL(r.In.URL)
				return
			}
			originalHost := r.In.Host
			r.SetURL(d.URL)
			if d.PreserveHost {
				r.Out.Host = originalHost
			}
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			d, _ := GetDestination(r.Context())
			if d != nil {
				if observer, ok := d.Observer.(UpstreamErrorObserver); ok {
					observer.ObserveUpstreamError(ClassifyProxyErr(err))
				}
			}
			if opts.ErrorHandler != nil {
				opts.ErrorHandler(w, r, err, d)
				return
			}
			http.Error(w, "upstream transport error", http.StatusBadGateway)
		},
		ModifyResponse: func(resp *http.Response) error {
			d, _ := GetDestination(resp.Request.Context())
			if opts.ModifyResponse != nil {
				return opts.ModifyResponse(resp, d)
			}
			return nil
		},
	}

	return pc
}

func (p *ProxyClient) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if shouldManuallyStream(r.URL.Path) {
		p.serveStreamingHTTP(w, r)
		return
	}
	p.ReverseProxy.ServeHTTP(w, r)
}

func shouldManuallyStream(path string) bool {
	return strings.HasPrefix(path, "/process.Process/")
}

func (p *ProxyClient) serveStreamingHTTP(w http.ResponseWriter, r *http.Request) {
	d, ok := GetDestination(r.Context())
	if !ok || d == nil || d.URL == nil {
		http.Error(w, "missing proxy destination", http.StatusBadGateway)
		return
	}

	outReq := r.Clone(r.Context())
	targetURL := *r.URL
	targetURL.Scheme = d.URL.Scheme
	targetURL.Host = d.URL.Host
	outReq.URL = &targetURL
	outReq.RequestURI = ""
	if d.PreserveHost {
		outReq.Host = r.Host
	}

	resp, err := p.transport.RoundTrip(outReq)
	if err != nil {
		if p.ErrorHandler != nil {
			p.ErrorHandler(w, r, err)
			return
		}
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	copyResponseHeaders(w.Header(), resp.Header)
	w.WriteHeader(resp.StatusCode)

	flusher, _ := w.(http.Flusher)
	if flusher != nil {
		flusher.Flush()
	}

	buf := make([]byte, 32*1024)
	for {
		n, readErr := resp.Body.Read(buf)
		if n > 0 {
			if _, writeErr := w.Write(buf[:n]); writeErr != nil {
				return
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				return
			}
			return
		}
	}
}

func copyResponseHeaders(dst, src http.Header) {
	for key, values := range src {
		dst.Del(key)
		for _, value := range values {
			dst.Add(key, value)
		}
	}
}

func (p *ProxyClient) closeIdleConnections() {
	if observer, ok := p.observer.(ConnectionLifecycleObserver); ok {
		observer.ObserveCloseIdleConnections()
	}
	p.transport.CloseIdleConnections()
}

func (p *ProxyClient) resetAllConnections() error {
	items := p.activeConnections.Items()
	if observer, ok := p.observer.(ConnectionLifecycleObserver); ok && len(items) > 0 {
		observer.ObserveResetConnections(uint64(len(items)))
	}
	var errs []error
	for _, conn := range items {
		if err := conn.Reset(); err != nil && !errors.Is(err, net.ErrClosed) {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

func withDefaultInt(v, def int) int {
	if v > 0 {
		return v
	}
	return def
}

func splitHostConnections(total, explicit int) int {
	if explicit > 0 {
		return explicit
	}
	if total <= hostConnectionSplit {
		return total
	}
	return total / hostConnectionSplit
}

func withDefaultDuration(v, def time.Duration) time.Duration {
	if v > 0 {
		return v
	}
	return def
}

type trackedConnectionSet struct {
	mu    sync.Mutex
	conns map[string]*trackedConnection
}

func newTrackedConnectionSet() *trackedConnectionSet {
	return &trackedConnectionSet{conns: make(map[string]*trackedConnection)}
}

func (s *trackedConnectionSet) Insert(conn *trackedConnection) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.conns[conn.id] = conn
}

func (s *trackedConnectionSet) Remove(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.conns, id)
}

func (s *trackedConnectionSet) Items() []*trackedConnection {
	s.mu.Lock()
	defer s.mu.Unlock()
	items := make([]*trackedConnection, 0, len(s.conns))
	for _, conn := range s.conns {
		items = append(items, conn)
	}
	return items
}

type trackedConnection struct {
	net.Conn

	id       string
	closed   atomic.Bool
	counter  *atomic.Int64
	set      *trackedConnectionSet
	observer any
}

func newTrackedConnection(conn net.Conn, counter *atomic.Int64, set *trackedConnectionSet, observer any) *trackedConnection {
	current := counter.Add(1)

	tracked := &trackedConnection{
		Conn:     conn,
		id:       uuid.NewString(),
		counter:  counter,
		set:      set,
		observer: observer,
	}
	if set != nil {
		set.Insert(tracked)
	}
	if stats, ok := observer.(ConnectionStatsObserver); ok {
		stats.SetCurrentConnections(current)
	}
	return tracked
}

func (c *trackedConnection) Reset() error {
	var errs []error
	if tcpConn, ok := c.Conn.(*net.TCPConn); ok {
		if err := tcpConn.SetLinger(0); err != nil {
			errs = append(errs, err)
		}
	}
	if err := c.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
		errs = append(errs, err)
	}
	return errors.Join(errs...)
}

func (c *trackedConnection) Close() error {
	err := c.Conn.Close()
	if err != nil {
		return err
	}
	c.release()
	return nil
}

func (c *trackedConnection) release() {
	if !c.closed.CompareAndSwap(false, true) {
		return
	}
	current := c.counter.Add(-1)
	if c.set != nil {
		c.set.Remove(c.id)
	}
	if stats, ok := c.observer.(ConnectionStatsObserver); ok {
		stats.SetCurrentConnections(current)
	}
}
