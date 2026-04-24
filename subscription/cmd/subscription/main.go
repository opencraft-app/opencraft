package main

import (
	"log"
	"net/http"
	"time"

	"git.woa.com/wisp/mono/subscription/internal/aigateway"
	"git.woa.com/wisp/mono/subscription/internal/config"
	"git.woa.com/wisp/mono/subscription/internal/httpapi"
	paymentclient "git.woa.com/wisp/mono/subscription/internal/payment"
	"git.woa.com/wisp/mono/subscription/internal/service"
	"git.woa.com/wisp/mono/subscription/internal/store"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("load config: %v", err)
	}

	subStore, err := store.NewMySQLStore(cfg.MySQLDSN)
	if err != nil {
		log.Fatalf("init mysql store: %v", err)
	}
	defer subStore.Close()

	svc := service.New(service.Config{
		PlanMappings: cfg.PlanMappings,
	}, subStore, paymentclient.NewClient(cfg.PaymentBaseURL), aigateway.NewClient(cfg.AIGatewayBaseURL))

	router := httpapi.NewRouter(svc, httpapi.ServerConfig{
		AllowedOrigins: cfg.AllowedOrigins,
		AdminToken:     cfg.AdminToken,
	})

	server := &http.Server{
		Addr:              cfg.Addr,
		Handler:           router,
		ReadHeaderTimeout: 10 * time.Second,
	}
	log.Printf("subscription listening on %s", cfg.Addr)
	log.Fatal(server.ListenAndServe())
}
