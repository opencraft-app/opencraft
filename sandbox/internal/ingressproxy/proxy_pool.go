package ingressproxy

import (
	"context"
	"reflect"

	"cvm-mock-e2b/internal/proxycore"
)

type ProxyDestination = proxycore.Destination
type ProxyPoolOptions = proxycore.PoolOptions
type ProxyClient = proxycore.ProxyClient

type ProxyObserver interface {
	ObserveUpstreamError(class string)
	ObserveRouteLookupFailure(class string)
	ObserveConnectionBlocked(targetKind string)
	AddInFlight(targetKind string, delta int)
	SetPoolSize(size int)
	SetCurrentConnections(count int64)
	AddTotalConnections(delta uint64)
	ObserveCloseIdleConnections()
	ObserveResetConnections(delta uint64)
}

type ProxyProvider interface {
	Get(ctx context.Context, destination *ProxyDestination) *ProxyClient
	Close(connectionKey string) error
}

type ProxyPool struct {
	core *proxycore.ProxyPool
}

func NewProxyPool(opts ProxyPoolOptions) *ProxyPool {
	opts.Observer = normalizeObserver(opts.Observer)
	return &ProxyPool{core: proxycore.NewPool(opts)}
}

func (p *ProxyPool) Get(ctx context.Context, destination *ProxyDestination) *ProxyClient {
	return p.core.Get(ctx, destination)
}

func (p *ProxyPool) Close(connectionKey string) error {
	return p.core.Close(connectionKey)
}

func (p *ProxyPool) Has(connectionKey string) bool {
	return p.core.Has(connectionKey)
}

func (p *ProxyPool) Size() int {
	return p.core.Size()
}

func (p *ProxyPool) TotalConnections() uint64 {
	return p.core.TotalConnections()
}

func (p *ProxyPool) CurrentConnections() int64 {
	return p.core.CurrentConnections()
}

func normalizeObserver(observer any) any {
	if observer == nil {
		return nil
	}
	value := reflect.ValueOf(observer)
	switch value.Kind() {
	case reflect.Chan, reflect.Func, reflect.Interface, reflect.Map, reflect.Pointer, reflect.Slice:
		if value.IsNil() {
			return nil
		}
	}
	return observer
}
