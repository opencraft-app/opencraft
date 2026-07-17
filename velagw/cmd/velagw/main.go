package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"git.woa.com/wisp/mono2/llmgateway/internal/clientcli"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	command := clientcli.NewRoot(clientcli.Dependencies{Out: os.Stdout, Err: os.Stderr})
	command.SetContext(ctx)
	if err := command.Execute(); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, "错误：", err)
		os.Exit(1)
	}
}
