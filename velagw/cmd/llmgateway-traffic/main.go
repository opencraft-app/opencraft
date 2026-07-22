package main

import (
	"context"
	"log"
	"os/signal"
	"syscall"

	"git.woa.com/wisp/mono2/llmgateway/internal/app"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	if err := app.Run(ctx, app.ModeTraffic); err != nil {
		log.Fatal(err)
	}
}
