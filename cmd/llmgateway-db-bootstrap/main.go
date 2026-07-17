package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"syscall"

	"git.woa.com/wisp/mono2/llmgateway/internal/dbbootstrap"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	configPath := os.Getenv("LLMGATEWAY_DB_BOOTSTRAP_CONFIG")
	if configPath == "" {
		configPath = "/etc/llmgateway/db-bootstrap.yaml"
	}
	cfg, err := dbbootstrap.LoadConfig(configPath)
	if err != nil {
		log.Fatalf("load db bootstrap config: %v", err)
	}
	if err := dbbootstrap.Run(ctx, cfg); err != nil {
		log.Fatalf("run db bootstrap: %v", err)
	}
	log.Printf("llmgateway db bootstrap completed")
}
