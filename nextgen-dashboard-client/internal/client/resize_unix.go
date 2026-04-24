//go:build unix

package client

import (
	"context"
	"os"
	"os/signal"
	"syscall"
)

func watchResize(ctx context.Context, _ *os.File, onResize func() error) {
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGWINCH)
	defer signal.Stop(signals)

	for {
		select {
		case <-ctx.Done():
			return
		case <-signals:
			_ = onResize()
		}
	}
}
