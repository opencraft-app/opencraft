package main

import (
	"context"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	cfg, err := loadConfig()
	if err != nil {
		log.Fatal(err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	listener, err := net.Listen("tcp", cfg.PacerListenAddress)
	if err != nil {
		log.Fatalf("listen for SSE pacer: %v", err)
	}
	pacer := &http.Server{
		Handler:           newPacerHandler(cfg.MockURL, cfg.SSEDuration),
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		if err := pacer.Serve(listener); err != nil && err != http.ErrServerClosed {
			log.Printf("SSE pacer stopped: %v", err)
			stop()
		}
	}()

	kube, err := newInClusterKubeClient()
	if err != nil {
		log.Fatalf("create Kubernetes client: %v", err)
	}
	coord := newCoordinator(cfg, kube)
	report, runErr := coord.run(ctx)
	raw := marshalReport(report)
	fmt.Println(string(raw))
	if cfg.ReportPath != "" {
		_ = os.WriteFile(cfg.ReportPath, raw, 0o600)
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = pacer.Shutdown(shutdownCtx)
	if runErr != nil {
		log.Printf("set upgrade soak failed: %v", runErr)
		os.Exit(1)
	}
}
