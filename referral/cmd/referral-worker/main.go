package main

import (
	"context"
	"errors"
	"log"
	"os"
	"os/signal"
	"syscall"

	"git.woa.com/wisp/mono/referral/internal/broker"
	"git.woa.com/wisp/mono/referral/internal/config"
	"git.woa.com/wisp/mono/referral/internal/ctlclient"
	"git.woa.com/wisp/mono/referral/internal/service"
	"git.woa.com/wisp/mono/referral/internal/store"
	"git.woa.com/wisp/mono/referral/internal/worker"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("load config: %v", err)
	}
	if !cfg.Enabled || !cfg.ProcessingEnabled {
		log.Print("referral worker disabled")
		return
	}
	st, err := store.NewMySQLStore(cfg.MySQLDSN)
	if err != nil {
		log.Fatalf("init referral store: %v", err)
	}
	defer st.Close()
	consumer, err := broker.NewPulsarConsumer(cfg.PulsarURL, cfg.PulsarToken, cfg.PulsarTopic, cfg.PulsarSubscription, cfg.PulsarDeadLetterTopic)
	if err != nil {
		log.Fatalf("init referral consumer: %v", err)
	}
	defer consumer.Close()
	svc := service.New(st, cfg.PublicBaseURL)
	w := worker.New(st, svc, consumer, ctlclient.New(cfg.CTLBaseURL, cfg.CTLInternalToken), cfg.WorkerBatchSize, cfg.WorkerPollInterval, cfg.RewardLeaseDuration)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := w.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
		log.Fatalf("run referral worker: %v", err)
	}
}
