package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"path/filepath"

	"cloudagent/gateway/internal/telemetry"
	"cloudagent/gateway/internal/wrapper"
	"go.opentelemetry.io/otel/attribute"
	otellog "go.opentelemetry.io/otel/log"
)

func main() {
	shutdownTelemetry, err := telemetry.Init(telemetry.Options{
		ServiceName: envDefault("OTEL_SERVICE_NAME", "cloudagent-gateway"),
		Attributes: []attribute.KeyValue{
			attribute.String("cloudagent.component", "gateway"),
		},
	})
	if err != nil {
		log.Fatalf("init telemetry: %v", err)
	}
	defer func() {
		if err := shutdownTelemetry(); err != nil {
			log.Printf("shutdown telemetry: %v", err)
		}
	}()

	dataDir := os.Getenv("GATEWAY_DATA_DIR")
	if dataDir == "" {
		dataDir = filepath.Join(os.TempDir(), "gateway-data")
	}
	addr := os.Getenv("GATEWAY_ADDR")
	if addr == "" {
		addr = ":8080"
	}
	store, err := wrapper.NewStore(dataDir)
	if err != nil {
		log.Fatalf("init store: %v", err)
	}
	var worker wrapper.Worker
	switch os.Getenv("GATEWAY_WORKER_MODE") {
	case "fake":
		worker = wrapper.FakeWorker{}
	case "agent_injected":
		agentSidecarWorker, err := wrapper.NewAgentSidecarWorkerFromEnvWithWorkspaceService(store)
		if err != nil {
			log.Fatalf("init agent sidecar worker: %v", err)
		}
		worker = agentSidecarWorker
	default:
		log.Fatalf("GATEWAY_WORKER_MODE must be set to fake or agent_injected")
	}
	server := wrapper.NewServer(store, worker)
	telemetry.Info(context.Background(), telemetry.Logger("cloudagent/gateway/cmd/server"), "gateway.listening",
		otellog.String("addr", addr),
		otellog.String("data_dir", dataDir),
		otellog.String("worker_mode", os.Getenv("GATEWAY_WORKER_MODE")),
	)
	if err := http.ListenAndServe(addr, server.Handler()); err != nil {
		log.Fatal(err)
	}
}

func envDefault(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
