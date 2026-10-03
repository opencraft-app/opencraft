package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"time"
)

type httpEndpoint struct {
	server   *http.Server
	listener net.Listener
}

// Bind every endpoint before serving so a bind failure cannot leave a partial API.
func bindHTTPServers(servers []*http.Server) ([]httpEndpoint, error) {
	endpoints := make([]httpEndpoint, 0, len(servers))
	for _, server := range servers {
		listener, err := net.Listen("tcp", server.Addr)
		if err != nil {
			for _, endpoint := range endpoints {
				_ = endpoint.listener.Close()
			}
			return nil, fmt.Errorf("bind Workers API listener %s: %w", server.Addr, err)
		}
		endpoints = append(endpoints, httpEndpoint{server: server, listener: listener})
	}
	return endpoints, nil
}

func runHTTPServers(ctx context.Context, logger *slog.Logger, engineCount int, endpoints []httpEndpoint, drainTimeout time.Duration) error {
	if len(endpoints) == 0 {
		return errors.New("Workers API requires at least one HTTP listener")
	}
	listenerErrors := make(chan error, len(endpoints))
	for _, endpoint := range endpoints {
		go func() {
			logger.Info("starting Workers API listener", "listenAddress", endpoint.server.Addr, "engineCount", engineCount)
			err := endpoint.server.Serve(endpoint.listener)
			if errors.Is(err, http.ErrServerClosed) {
				err = nil
			}
			listenerErrors <- err
		}()
	}

	// Serve returns as soon as its listener closes, before admitted requests finish. A signal
	// or any listener termination starts one drain cycle; neither is permission to return yet.
	var failures []error
	remainingListeners := len(endpoints)
	select {
	case <-ctx.Done():
	case err := <-listenerErrors:
		remainingListeners--
		if err != nil {
			failures = append(failures, err)
		}
	}
	shutdownContext, cancel := context.WithTimeout(context.Background(), drainTimeout)
	defer cancel()
	shutdownErrors := make(chan error, len(endpoints))
	for _, endpoint := range endpoints {
		go func() {
			// Public and private listeners stop admission together and share one total budget.
			// A held public stream must not keep the private listener accepting new work.
			err := endpoint.server.Shutdown(shutdownContext)
			if err != nil {
				logger.Error("shut down Workers API listener", "address", endpoint.server.Addr, "error", err)
				// Long streams can exceed the bounded drain. Close their connections without
				// replaying requests whose downstream side effects may already have committed.
				err = errors.Join(err, endpoint.server.Close())
			}
			shutdownErrors <- err
		}()
	}
	for range endpoints {
		if err := <-shutdownErrors; err != nil {
			failures = append(failures, err)
		}
	}
	for range remainingListeners {
		if err := <-listenerErrors; err != nil {
			failures = append(failures, err)
		}
	}
	return errors.Join(failures...)
}
