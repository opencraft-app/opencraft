package ingressproxy

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"strings"
	"sync/atomic"
	"time"

	"cvm-mock-e2b/internal/proxycore"
	"cvm-mock-e2b/internal/route"
)

const requestIDHeader = "X-Ingressproxy-Request-Id"

var ingressProxyReqSeq atomic.Uint64

func nextIngressProxyRequestID() string {
	seq := ingressProxyReqSeq.Add(1)
	return fmt.Sprintf("%x-%x", time.Now().UnixNano(), seq)
}

func ensureRequestID(r *http.Request) string {
	if r == nil {
		return nextIngressProxyRequestID()
	}
	reqID := strings.TrimSpace(r.Header.Get(requestIDHeader))
	if reqID == "" {
		reqID = nextIngressProxyRequestID()
		r.Header.Set(requestIDHeader, reqID)
	}
	return reqID
}

type RouterConfig struct {
	ShardCount        int
	EnableIPBackdoor  bool
	ShardServiceURLFn func(shard int) (*url.URL, error)
	Proxies           ProxyProvider
	Observer          ProxyObserver
}

func NewRouterHandler(cfg RouterConfig) (http.Handler, error) {
	if cfg.ShardCount <= 0 {
		return nil, fmt.Errorf("shard count must be positive")
	}
	if cfg.ShardServiceURLFn == nil {
		return nil, fmt.Errorf("shard service url resolver required")
	}
	proxies := cfg.Proxies
	if proxies == nil {
		proxies = NewProxyPool(ProxyPoolOptions{})
	}

	shardDestinations := make(map[int]*ProxyDestination, cfg.ShardCount)
	for shard := 0; shard < cfg.ShardCount; shard++ {
		target, err := cfg.ShardServiceURLFn(shard)
		if err != nil {
			return nil, fmt.Errorf("resolve shard %d target: %w", shard, err)
		}
		shardDestinations[shard] = &ProxyDestination{
			ConnectionKey: fmt.Sprintf("router:shard:%d", shard),
			URL:           target,
			PreserveHost:  true,
			Observer:      cfg.Observer,
		}
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reqID := ensureRequestID(r)
		w.Header().Set(requestIDHeader, reqID)
		if r.URL != nil && r.URL.Path == "/health" {
			HealthHandler().ServeHTTP(w, r)
			return
		}
		target, err := ParseTargetHost(r.Host, cfg.EnableIPBackdoor)
		if err != nil {
			log.Printf("[ingressproxy router] invalid host req_id=%s method=%s path=%s host=%s remote=%s err=%v",
				reqID, r.Method, r.URL.Path, r.Host, r.RemoteAddr, err)
			http.Error(w, "invalid host", http.StatusBadRequest)
			return
		}

		shard, err := ShardForKey(target.ShardKey(), cfg.ShardCount)
		if err != nil {
			log.Printf("[ingressproxy router] shard resolution failed req_id=%s method=%s path=%s host=%s sandbox=%s key=%s err=%v",
				reqID, r.Method, r.URL.Path, r.Host, target.SandboxID, target.ShardKey(), err)
			http.Error(w, "invalid shard", http.StatusInternalServerError)
			return
		}

		destination := shardDestinations[shard]
		log.Printf("[ingressproxy router] route req_id=%s method=%s path=%s host=%s sandbox=%s port=%s shard=%d key=%s target=%s remote=%s",
			reqID, r.Method, r.URL.Path, r.Host, target.SandboxID, target.Port, shard, destination.ConnectionKey, destination.URL, r.RemoteAddr)
		r = r.WithContext(proxycore.WithDestination(r.Context(), destination))
		proxies.Get(r.Context(), destination).ServeHTTP(w, r)
	}), nil
}

type routeStore interface {
	Get(ctx context.Context, sandboxID string) (Rule, error)
}

type Rule struct {
	InstanceID string
	Address    string
}

type ShardConfig struct {
	Routes               routeStore
	EnableIPBackdoor     bool
	Proxies              ProxyProvider
	ConnectionLimiter    *ConnectionLimiter
	MaxConnectionsPerKey int
	Observer             ProxyObserver
}

func NewShardHandler(cfg ShardConfig) (http.Handler, error) {
	if cfg.Routes == nil {
		return nil, fmt.Errorf("route store required")
	}
	proxies := cfg.Proxies
	if proxies == nil {
		proxies = NewProxyPool(ProxyPoolOptions{})
	}
	lifecycles := newLifecycleTracker()

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reqID := ensureRequestID(r)
		w.Header().Set(requestIDHeader, reqID)
		if r.URL != nil && r.URL.Path == "/health" {
			HealthHandler().ServeHTTP(w, r)
			return
		}
		target, err := ParseTargetHost(r.Host, cfg.EnableIPBackdoor)
		if err != nil {
			log.Printf("[ingressproxy shard] invalid host req_id=%s method=%s path=%s host=%s remote=%s err=%v",
				reqID, r.Method, r.URL.Path, r.Host, r.RemoteAddr, err)
			http.Error(w, "invalid host", http.StatusBadRequest)
			return
		}

		address := target.IP
		instanceID := ""
		targetKey := target.ShardKey()
		targetKind := "sandbox"
		if target.IsIPBackdoor() {
			targetKind = "ip"
		}
		if cfg.ConnectionLimiter != nil {
			_, acquired := cfg.ConnectionLimiter.TryAcquire(targetKey, cfg.MaxConnectionsPerKey)
			if !acquired {
				if cfg.Observer != nil {
					cfg.Observer.ObserveConnectionBlocked(targetKind)
				}
				log.Printf("[ingressproxy shard] too many connections req_id=%s method=%s path=%s host=%s sandbox=%s key=%s target_kind=%s remote=%s limit=%d",
					reqID, r.Method, r.URL.Path, r.Host, target.SandboxID, targetKey, targetKind, r.RemoteAddr, cfg.MaxConnectionsPerKey)
				http.Error(w, "too many concurrent requests", http.StatusTooManyRequests)
				return
			}
			if cfg.Observer != nil {
				cfg.Observer.AddInFlight(targetKind, 1)
			}
			defer func() {
				cfg.ConnectionLimiter.Release(targetKey)
				if cfg.Observer != nil {
					cfg.Observer.AddInFlight(targetKind, -1)
				}
			}()
		}
		if !target.IsIPBackdoor() {
			rule, err := cfg.Routes.Get(r.Context(), target.SandboxID)
			if err != nil {
				if errors.Is(err, route.ErrRouteNotFound) {
					if err := lifecycles.Clear(target.SandboxID, proxies.Close); err != nil {
						log.Printf("[ingressproxy shard] lifecycle clear error req_id=%s sandbox=%s err=%v",
							reqID, target.SandboxID, err)
				}
				log.Printf("[ingressproxy shard] route miss req_id=%s method=%s path=%s host=%s sandbox=%s key=%s remote=%s err=%v",
					reqID, r.Method, r.URL.Path, r.Host, target.SandboxID, targetKey, r.RemoteAddr, err)
				http.Error(w, "sandbox route not found", http.StatusNotFound)
				return
			}
			if cfg.Observer != nil {
				cfg.Observer.ObserveRouteLookupFailure(classifyRouteLookupErr(err))
			}
			log.Printf("[ingressproxy shard] route lookup failed req_id=%s method=%s path=%s host=%s sandbox=%s key=%s remote=%s err=%v",
				reqID, r.Method, r.URL.Path, r.Host, target.SandboxID, targetKey, r.RemoteAddr, err)
			http.Error(w, "sandbox route lookup failed", http.StatusBadGateway)
			return
		}
			address = rule.Address
			instanceID = rule.InstanceID
			connectionKey := routeConnectionKey(target.SandboxID, instanceID, address, target.Port)
			if err := lifecycles.Update(target.SandboxID, connectionKey, proxies.Close); err != nil {
				log.Printf("[ingressproxy shard] lifecycle cleanup error req_id=%s sandbox=%s err=%v",
					reqID, target.SandboxID, err)
			}
		}

		upstream, err := url.Parse("http://" + address + ":" + target.Port)
		if err != nil {
			log.Printf("[ingressproxy shard] invalid upstream req_id=%s method=%s path=%s host=%s sandbox=%s addr=%s port=%s err=%v",
				reqID, r.Method, r.URL.Path, r.Host, target.SandboxID, address, target.Port, err)
			http.Error(w, "invalid upstream", http.StatusBadGateway)
			return
		}

		destination := &ProxyDestination{
			ConnectionKey: routeConnectionKey(target.SandboxID, instanceID, address, target.Port),
			URL:           upstream,
			PreserveHost:  false,
			Observer:      cfg.Observer,
		}
		log.Printf("[ingressproxy shard] upstream req_id=%s method=%s path=%s host=%s sandbox=%s key=%s target_kind=%s target=%s remote=%s",
			reqID, r.Method, r.URL.Path, r.Host, target.SandboxID, destination.ConnectionKey, targetKind, destination.URL, r.RemoteAddr)
		r = r.WithContext(proxycore.WithDestination(r.Context(), destination))
		proxies.Get(r.Context(), destination).ServeHTTP(w, r)
	}), nil
}

func routeConnectionKey(sandboxID, instanceID, addr, port string) string {
	if instanceID != "" {
		return instanceID
	}
	if addr != "" && sandboxID == "" {
		return "ip-backdoor:" + addr + ":" + port
	}
	if sandboxID != "" {
		return "sandbox:" + sandboxID + ":" + addr + ":" + port
	}
	return "upstream:" + addr + ":" + port
}

func classifyRouteLookupErr(err error) string {
	switch {
	case err == nil:
		return "unknown"
	case errors.Is(err, context.DeadlineExceeded):
		return "timeout"
	case errors.Is(err, context.Canceled):
		return "canceled"
	}
	type timeoutErr interface {
		Timeout() bool
	}
	var te timeoutErr
	if errors.As(err, &te) && te.Timeout() {
		return "timeout"
	}
	return "lookup_failed"
}
