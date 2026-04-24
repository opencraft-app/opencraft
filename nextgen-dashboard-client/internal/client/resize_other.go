//go:build !unix

package client

import (
	"context"
	"os"
)

func watchResize(ctx context.Context, _ *os.File, onResize func() error) {
	<-ctx.Done()
}
