package main

import (
	"context"
	"log"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"

	"git.woa.com/wisp/mono/credit/internal/authcode"
	"git.woa.com/wisp/mono/credit/internal/config"
	"git.woa.com/wisp/mono/credit/internal/httpapi"
	"git.woa.com/wisp/mono/credit/internal/llmgateway"
	"git.woa.com/wisp/mono/credit/internal/objectid"
	"git.woa.com/wisp/mono/credit/internal/service"
	"git.woa.com/wisp/mono/credit/internal/store"
	"git.woa.com/wisp/mono/credit/internal/tradeclient"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("load config: %v", err)
	}
	if err := cfg.ValidatePackageID(); err != nil {
		log.Fatalf("validate package ID config: %v", err)
	}
	if err := cfg.ValidateAuthCode(); err != nil {
		log.Fatalf("validate auth code config: %v", err)
	}
	st, err := store.NewMySQLStore(cfg.MySQLDSN)
	if err != nil {
		log.Fatalf("init mysql store: %v", err)
	}
	defer st.Close()
	redisClient := redis.NewClient(&redis.Options{
		Addr:     cfg.RedisAddr,
		Password: cfg.RedisPassword,
		DB:       cfg.RedisDB,
	})
	defer redisClient.Close()
	pingCtx, pingCancel := context.WithTimeout(context.Background(), 5*time.Second)
	if err := redisClient.Ping(pingCtx).Err(); err != nil {
		pingCancel()
		log.Fatalf("init auth code redis: %v", err)
	}
	pingCancel()
	authCodes := authcode.New(redisClient, cfg.AuthCodeTTL)
	llm := llmgateway.NewClient(cfg.LLMGatewayBaseURL, cfg.LLMGatewayInternalToken)
	trade := tradeclient.NewClient(cfg.TradeBaseURL, cfg.InternalServiceToken)
	objectIDPassword := "creditmon" + cfg.ObjectIDPasswordSuffix
	svc := service.New(st, llm, service.Options{
		CreditTokenRatio: cfg.CreditTokenRatio,
		GeneratePackageID: func(ctx context.Context, dealName string) (string, error) {
			autoID, err := st.AllocatePackageAutoID(ctx, dealName)
			if err != nil {
				return "", err
			}
			return objectid.GenerateCreditPackageID(autoID, objectIDPassword, cfg.Region)
		},
	})
	server := &http.Server{
		Addr:              cfg.Addr,
		Handler:           httpapi.NewRouter(svc, st, trade, authCodes, cfg.InternalServiceToken),
		ReadHeaderTimeout: 10 * time.Second,
	}
	log.Printf("credit listening on %s", cfg.Addr)
	log.Fatal(server.ListenAndServe())
}
