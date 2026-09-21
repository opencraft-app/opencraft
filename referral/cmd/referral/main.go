package main

import (
	"log"
	"net/http"
	"time"

	"git.woa.com/wisp/mono/referral/internal/config"
	"git.woa.com/wisp/mono/referral/internal/httpapi"
	"git.woa.com/wisp/mono/referral/internal/service"
	"git.woa.com/wisp/mono/referral/internal/store"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("load config: %v", err)
	}
	if !cfg.Enabled {
		server := &http.Server{Addr: cfg.Addr, Handler: httpapi.NewRouter(false, nil), ReadHeaderTimeout: 10 * time.Second}
		log.Printf("referral listening disabled on %s", cfg.Addr)
		log.Fatal(server.ListenAndServe())
	}
	st, err := store.NewMySQLStore(cfg.MySQLDSN)
	if err != nil {
		log.Fatalf("init referral store: %v", err)
	}
	defer st.Close()
	svc := service.New(st, cfg.PublicBaseURL)
	server := &http.Server{
		Addr:              cfg.Addr,
		Handler:           httpapi.NewRouter(true, svc),
		ReadHeaderTimeout: 10 * time.Second,
	}
	log.Printf("referral listening on %s", cfg.Addr)
	log.Fatal(server.ListenAndServe())
}
