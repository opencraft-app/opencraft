package main

import (
	"context"
	"os"
	"os/signal"
	"syscall"

	"git.woa.com/wisp/mono2/collaboration/internal/cli"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	os.Exit(cli.Run(ctx, os.Args[1:], os.Stdout, os.Stderr))
}
