package main

import (
	"context"
	"database/sql"
	"net/http"
	"os"

	"cvm-mock-e2b/internal/faultinject"
	"cvm-mock-e2b/internal/logging"
	"cvm-mock-e2b/internal/observability"
	"cvm-mock-e2b/internal/provider"
	"cvm-mock-e2b/internal/runtimecfg"
	"cvm-mock-e2b/internal/service"
	"cvm-mock-e2b/internal/store"
)

func main() {
	cleanup, err := logging.Init("faultinjector")
	if err != nil {
		panic(err)
	}
	defer cleanup()
	shutdownTracing, err := observability.InitStdoutTracing("sandbox-faultinjector")
	if err != nil {
		panic(err)
	}
	defer func() {
		_ = shutdownTracing(context.Background())
	}()

	dsn := runtimecfg.MySQLDSNFromEnv()
	if dsn == "" {
		panic("faultinjector requires MySQL runtime config")
	}
	mysqlStore, err := store.NewMySQLStore(dsn)
	if err != nil {
		panic(err)
	}
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		panic(err)
	}
	defer db.Close()

	cp, err := provider.ResolveFromEnv()
	if err != nil {
		panic(err)
	}
	injector := faultinject.NewInjector(service.NewService(mysqlStore), cp, db)
	handler := faultinject.NewHandler(injector, os.Getenv("FAULTINJECTOR_TOKEN"))

	addr := os.Getenv("FAULTINJECTOR_ADDR")
	if addr == "" {
		addr = ":8090"
	}

	if err := http.ListenAndServe(addr, handler.Routes()); err != nil && err != http.ErrServerClosed {
		panic(err)
	}
}
