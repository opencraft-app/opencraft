package main

import (
	"log"
	"net/http"
	"os"
	"path/filepath"

	"cloudagent/gateway/internal/wrapper"
)

func main() {
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
		agentSidecarWorker, err := wrapper.NewAgentSidecarWorkerFromEnv()
		if err != nil {
			log.Fatalf("init agent sidecar worker: %v", err)
		}
		worker = agentSidecarWorker
	default:
		log.Fatalf("GATEWAY_WORKER_MODE must be set to fake or agent_injected")
	}
	server := wrapper.NewServer(store, worker)
	log.Printf("listening on %s data_dir=%s", addr, dataDir)
	if err := http.ListenAndServe(addr, server.Handler()); err != nil {
		log.Fatal(err)
	}
}
