package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"git.woa.com/wisp/mono2/llmgateway/test/regression/pacer"
)

func main() {
	upstream := strings.TrimRight(env("LLMGATEWAY_REGRESSION_PACER_UPSTREAM", "http://cloud-mockllm:8080"), "/")
	duration, err := time.ParseDuration(env("LLMGATEWAY_REGRESSION_SSE_DURATION", "3m"))
	if err != nil || duration <= 0 {
		log.Fatal("invalid LLMGATEWAY_REGRESSION_SSE_DURATION")
	}
	handler, err := pacer.NewHandlerWithFaultControl(
		upstream, duration, env("LLMGATEWAY_REGRESSION_LONG_MODEL", "llmgw-regression-long"),
		strings.TrimSpace(os.Getenv("LLMGATEWAY_REGRESSION_FAULT_TOKEN")), nil,
	)
	if err != nil {
		log.Fatal(err)
	}
	server := &http.Server{
		Addr:              env("LLMGATEWAY_REGRESSION_PACER_LISTEN", ":18082"),
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdownCtx)
	}()
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

func env(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}
