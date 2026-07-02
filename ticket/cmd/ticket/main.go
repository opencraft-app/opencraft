package main

import (
	"log"
	"net/http"
	"time"

	"git.woa.com/wisp/mono/ticket/internal/config"
	"git.woa.com/wisp/mono/ticket/internal/httpapi"
	"git.woa.com/wisp/mono/ticket/internal/service"
	"git.woa.com/wisp/mono/ticket/internal/store"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("load config: %v", err)
	}

	st, err := store.NewMySQLStore(cfg.MySQLDSN)
	if err != nil {
		log.Fatalf("init mysql store: %v", err)
	}
	defer st.Close()

	svc := service.New(st)

	router := httpapi.NewRouter(svc, httpapi.ServerConfig{
		AllowedOrigins: cfg.AllowedOrigins,
		AdminToken:     cfg.AdminToken,
	})

	server := &http.Server{
		Addr:              cfg.Addr,
		Handler:           router,
		ReadHeaderTimeout: 10 * time.Second,
	}
	log.Printf("ticket listening on %s", cfg.Addr)
	log.Fatal(server.ListenAndServe())
}
