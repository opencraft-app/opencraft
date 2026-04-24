package main

import (
	"log"
	"net/http"
	"time"

	"git.woa.com/wisp/mono/payment/internal/config"
	"git.woa.com/wisp/mono/payment/internal/httpapi"
	"git.woa.com/wisp/mono/payment/internal/service"
	"git.woa.com/wisp/mono/payment/internal/store"
	subscriptionclient "git.woa.com/wisp/mono/payment/internal/subscription"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("load config: %v", err)
	}
	orderStore, err := store.NewMySQLStore(cfg.MySQLDSN)
	if err != nil {
		log.Fatalf("init mysql store: %v", err)
	}
	defer orderStore.Close()

	svc := service.New(service.Config{
		Provider: cfg.Provider,
	}, orderStore, subscriptionclient.NewClient(cfg.SubscriptionBaseURL, cfg.InternalServiceToken))

	router := httpapi.NewRouter(svc, httpapi.ServerConfig{
		InternalServiceToken: cfg.InternalServiceToken,
	})
	server := &http.Server{
		Addr:              cfg.Addr,
		Handler:           router,
		ReadHeaderTimeout: 10 * time.Second,
	}
	log.Printf("payment listening on %s", cfg.Addr)
	log.Fatal(server.ListenAndServe())
}
