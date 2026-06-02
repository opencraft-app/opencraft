package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"git.woa.com/wisp/mono/vibebase/internal/config"
	"git.woa.com/wisp/mono/vibebase/internal/httpapi"
	"git.woa.com/wisp/mono/vibebase/internal/store/redisstore"
)

func main() {
	cfg, err := config.FromEnv()
	if err != nil {
		log.Fatalf("load config: %v", err)
	}

	store := redisstore.NewClientStore(redisstore.Options{
		Addr:           cfg.RedisAddr,
		Username:       cfg.RedisUsername,
		Password:       cfg.RedisPassword,
		DB:             cfg.RedisDB,
		MaxKeysPerUser: cfg.MaxKeysPerUser,
		DialTimeout:    cfg.RedisTimeout,
		ReadTimeout:    cfg.RedisTimeout,
		WriteTimeout:   cfg.RedisTimeout,
	})

	handler := httpapi.New(httpapi.Options{
		Store:         store,
		MaxNameBytes:  cfg.MaxNameBytes,
		MaxValueBytes: cfg.MaxValueBytes,
	})
	server := &http.Server{Addr: cfg.Addr, Handler: handler}

	go func() {
		log.Printf("vibebase listening on %s", cfg.Addr)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("serve: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := server.Shutdown(ctx); err != nil {
		log.Printf("shutdown: %v", err)
	}
}
