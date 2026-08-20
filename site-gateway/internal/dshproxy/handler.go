package dshproxy

import (
	"context"
	"errors"
	"log"
	"net/http"
	"strings"
	"time"

	"git.woa.com/wisp/mono/site-gateway/internal/tatproxy"
)

const remoteAddress = "127.0.0.1:3080"

type HandlerOptions struct {
	Resolver   Resolver
	Dialer     TunnelDialer
	MaxTargets int
	IdleTTL    time.Duration
	Logger     *log.Logger
}

type Handler struct {
	resolver Resolver
	pool     *proxyPool
	logger   *log.Logger
}

func NewHandler(opts HandlerOptions) (*Handler, error) {
	if opts.Resolver == nil || opts.Dialer == nil {
		return nil, errors.New("DSH resolver and tunnel dialer are required")
	}
	if opts.MaxTargets <= 0 || opts.IdleTTL <= 0 {
		return nil, errors.New("DSH proxy limits must be positive")
	}
	logger := opts.Logger
	if logger == nil {
		logger = log.Default()
	}
	return &Handler{
		resolver: opts.Resolver,
		pool:     newProxyPool(opts.Dialer, opts.MaxTargets, opts.IdleTTL, logger),
		logger:   logger,
	}, nil
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	keyValues := r.Header.Values("Key")
	// Key only selects a target. It must not reach DSH or any proxy error path.
	r.Header.Del("Key")
	if len(keyValues) != 1 {
		writeProxyError(w, http.StatusBadRequest)
		return
	}
	key := strings.TrimSpace(keyValues[0])
	if key == "" {
		writeProxyError(w, http.StatusBadRequest)
		return
	}
	target, err := h.resolver.Resolve(r.Context(), key)
	if err != nil {
		switch {
		case errors.Is(err, ErrMissingKey):
			writeProxyError(w, http.StatusBadRequest)
		case errors.Is(err, ErrTargetNotFound):
			writeProxyError(w, http.StatusNotFound)
		case errors.Is(err, context.DeadlineExceeded), errors.Is(err, context.Canceled):
			writeProxyError(w, http.StatusGatewayTimeout)
		default:
			h.logger.Printf("DSH target resolution failed (error_type=%T)", err)
			writeProxyError(w, http.StatusBadGateway)
		}
		return
	}
	entry, release, err := h.pool.acquire(target)
	if err != nil {
		if errors.Is(err, ErrProxyTargetLimit) || errors.Is(err, tatproxy.ErrTargetLimit) {
			writeProxyError(w, http.StatusServiceUnavailable)
			return
		}
		writeProxyError(w, http.StatusServiceUnavailable)
		return
	}
	defer release()
	entry.proxy.ServeHTTP(w, r)
}

func (h *Handler) Close() {
	h.pool.close()
}

func writeProxyError(w http.ResponseWriter, status int) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(http.StatusText(status) + "\n"))
}
