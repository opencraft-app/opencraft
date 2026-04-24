package main

import (
	"context"
	"fmt"
	"log"
	"net/http"

	"cvm-mock-e2b/internal/api"
	"cvm-mock-e2b/internal/logging"
	"cvm-mock-e2b/internal/provider"
	"cvm-mock-e2b/internal/runtimecfg"
	"cvm-mock-e2b/internal/service"
	"cvm-mock-e2b/internal/store"
	"os"
)

func main() {
	cleanup, err := logging.Init("server")
	if err != nil {
		log.Fatalf("init logging: %v", err)
	}
	defer cleanup()

	addr := ":8080"
	if v := os.Getenv("PORT"); v != "" {
		addr = ":" + v
	}
	if v := os.Getenv("API_ADDR"); v != "" {
		addr = v
	}

	var backend store.Store
	if dsn := mysqlDSNFromEnv(); dsn != "" {
		mysqlStore, err := store.NewMySQLStore(dsn)
		if err != nil {
			log.Fatalf("init mysql store: %v", err)
		}
		backend = mysqlStore
		log.Printf("using MySQL backend")
	} else {
		backend = store.NewMemoryStore()
		log.Printf("using in-memory backend")
	}

	svc := service.NewService(backend)
	verify := func(_ context.Context, _ string) error { return fmt.Errorf("verifier unavailable") }
	cp, err := provider.ResolveFromEnv()
	if err != nil {
		// Keep API server running; block inventory refills until verifier is configured.
		log.Printf("init provider failed; inventory refill will be rejected: %v", err)
		verify = func(_ context.Context, _ string) error { return fmt.Errorf("verifier unavailable: %w", err) }
	} else {
		verify = cp.VerifyInstance
	}
	router := api.New(svc, verify).Routes()

	log.Printf("starting API server on %s", addr)
	if err := http.ListenAndServe(addr, router); err != nil {
		log.Fatalf("server stopped: %v", err)
	}
}

func mysqlDSNFromEnv() string {
	return runtimecfg.MySQLDSNFromEnv()
}
