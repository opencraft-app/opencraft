package dshproxy

import (
	"context"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"git.woa.com/wisp/mono/site-gateway/internal/tatproxy"
)

var ErrProxyTargetLimit = errors.New("DSH proxy target limit reached")

type TunnelDialer interface {
	DialContext(context.Context, tatproxy.Target) (net.Conn, error)
}

type proxyPool struct {
	dialer     TunnelDialer
	maxTargets int
	idleTTL    time.Duration
	logger     *log.Logger

	mu      sync.Mutex
	entries map[string]*proxyEntry
	closed  bool
	done    chan struct{}
}

type proxyEntry struct {
	proxy     *httputil.ReverseProxy
	transport *http.Transport
	active    int
	lastUsed  time.Time
}

func newProxyPool(dialer TunnelDialer, maxTargets int, idleTTL time.Duration, logger *log.Logger) *proxyPool {
	p := &proxyPool{
		dialer:     dialer,
		maxTargets: maxTargets,
		idleTTL:    idleTTL,
		logger:     logger,
		entries:    make(map[string]*proxyEntry),
		done:       make(chan struct{}),
	}
	go p.reapIdle()
	return p
}

func (p *proxyPool) acquire(target Target) (*proxyEntry, func(), error) {
	now := time.Now()
	key := target.Key()
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return nil, nil, net.ErrClosed
	}
	if entry := p.entries[key]; entry != nil {
		entry.active++
		entry.lastUsed = now
		return entry, p.releaseFunc(entry), nil
	}
	p.evictLocked(now)
	if len(p.entries) >= p.maxTargets {
		return nil, nil, ErrProxyTargetLimit
	}
	entry := p.newEntry(target)
	entry.active = 1
	entry.lastUsed = now
	p.entries[key] = entry
	return entry, p.releaseFunc(entry), nil
}

func (p *proxyPool) releaseFunc(entry *proxyEntry) func() {
	return func() {
		p.mu.Lock()
		if entry.active > 0 {
			entry.active--
		}
		entry.lastUsed = time.Now()
		p.mu.Unlock()
	}
}

func (p *proxyPool) newEntry(target Target) *proxyEntry {
	upstream := &url.URL{Scheme: "http", Host: remoteAddress}
	transport := &http.Transport{
		DialContext:           func(ctx context.Context, _, _ string) (net.Conn, error) { return p.dialer.DialContext(ctx, target) },
		ForceAttemptHTTP2:     false,
		MaxIdleConns:          64,
		MaxIdleConnsPerHost:   32,
		IdleConnTimeout:       90 * time.Second,
		ExpectContinueTimeout: time.Second,
	}
	proxy := &httputil.ReverseProxy{
		Rewrite: func(request *httputil.ProxyRequest) {
			request.SetURL(upstream)
			request.SetXForwarded()
			if proto := forwardedProto(request.In.Header.Get("X-Forwarded-Proto")); proto != "" {
				request.Out.Header.Set("X-Forwarded-Proto", proto)
			}
			request.Out.Host = upstream.Host
			request.Out.Header.Del("Key")
			if request.Out.Header.Get("Origin") != "" {
				request.Out.Header.Set("Origin", upstream.String())
			}
		},
		Transport:     transport,
		FlushInterval: -1,
		ErrorLog:      log.New(io.Discard, "", 0),
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, err error) {
			status := http.StatusServiceUnavailable
			if errors.Is(err, tatproxy.ErrConnectionLimit) {
				status = http.StatusTooManyRequests
			} else if isTimeout(err) {
				status = http.StatusGatewayTimeout
			}
			p.logger.Printf("DSH upstream unavailable (status=%d, error_type=%T)", status, err)
			writeProxyError(w, status)
		},
	}
	return &proxyEntry{proxy: proxy, transport: transport}
}

func forwardedProto(raw string) string {
	proto := strings.ToLower(strings.TrimSpace(strings.Split(raw, ",")[0]))
	if proto == "http" || proto == "https" {
		return proto
	}
	return ""
}

func isTimeout(err error) bool {
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, os.ErrDeadlineExceeded) {
		return true
	}
	var netErr net.Error
	return errors.As(err, &netErr) && netErr.Timeout()
}

func (p *proxyPool) evictLocked(now time.Time) {
	for key, entry := range p.entries {
		if entry.active == 0 && now.Sub(entry.lastUsed) >= p.idleTTL {
			entry.transport.CloseIdleConnections()
			delete(p.entries, key)
		}
	}
	if len(p.entries) < p.maxTargets {
		return
	}
	var (
		oldestKey string
		oldest    *proxyEntry
	)
	for key, entry := range p.entries {
		if entry.active == 0 && (oldest == nil || entry.lastUsed.Before(oldest.lastUsed)) {
			oldestKey = key
			oldest = entry
		}
	}
	if oldest != nil {
		oldest.transport.CloseIdleConnections()
		delete(p.entries, oldestKey)
	}
}

func (p *proxyPool) reapIdle() {
	interval := p.idleTTL / 2
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
			p.mu.Lock()
			p.evictLocked(now)
			p.mu.Unlock()
		case <-p.done:
			return
		}
	}
}

func (p *proxyPool) close() {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return
	}
	p.closed = true
	close(p.done)
	entries := make([]*proxyEntry, 0, len(p.entries))
	for _, entry := range p.entries {
		entries = append(entries, entry)
	}
	p.entries = make(map[string]*proxyEntry)
	p.mu.Unlock()
	for _, entry := range entries {
		entry.transport.CloseIdleConnections()
	}
}
