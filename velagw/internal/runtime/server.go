package runtime

import (
	"context"
	"errors"
	"log"
	"net"
	"net/http"
	"time"

	"git.woa.com/wisp/mono2/llmgateway/internal/lifecycle"
)

type Options struct {
	DrainWait       time.Duration
	ShutdownTimeout time.Duration
	Close           func() error
}

func Serve(ctx context.Context, srv *http.Server, listener net.Listener, state *lifecycle.State, options Options) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if options.ShutdownTimeout <= 0 {
		options.ShutdownTimeout = time.Minute
	}

	errCh := make(chan error, 1)
	go func() {
		err := srv.Serve(listener)
		if errors.Is(err, http.ErrServerClosed) {
			err = nil
		}
		errCh <- err
	}()

	select {
	case err := <-errCh:
		return errors.Join(err, closeResource(options.Close))
	case <-ctx.Done():
	}

	state.BeginDraining()
	log.Printf("llmgateway shutdown signal received; readiness draining for %s", options.DrainWait)
	if options.DrainWait > 0 {
		time.Sleep(options.DrainWait)
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), options.ShutdownTimeout)
	defer cancel()
	shutdownErr := srv.Shutdown(shutdownCtx)

	var serveErr error
	select {
	case serveErr = <-errCh:
	case <-shutdownCtx.Done():
		serveErr = shutdownCtx.Err()
	}

	closeErr := closeResource(options.Close)
	if err := errors.Join(shutdownErr, serveErr, closeErr); err != nil {
		return err
	}
	log.Printf("llmgateway shutdown completed")
	return nil
}

func closeResource(closeFn func() error) error {
	if closeFn == nil {
		return nil
	}
	return closeFn()
}
