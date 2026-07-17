package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
)

func main() {
	cfg := LoadConfig(os.Getenv)
	if err := cfg.Validate(); err != nil {
		log.Fatal(err)
	}
	client := &http.Client{Timeout: cfg.HTTPTimeout}
	runner := NewRunner(cfg, client)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	log.Printf("llmgateway load runner: profile=%s users=%d max_concurrent_users=%d arrival=%s chat_interval=%s byok_per_user=%d byok_interval=%s platform_channels=%d duration=%s stream=%v prepare=%v disable_newapi_protection=%v",
		cfg.Profile,
		cfg.Users,
		cfg.MaxConcurrentUsers,
		cfg.UserArrivalInterval,
		cfg.ChatInterval,
		cfg.BYOKProvidersPerUser,
		cfg.BYOKConfigInterval,
		cfg.PlatformChannels,
		cfg.RunDuration,
		cfg.Stream,
		cfg.Prepare,
		cfg.DisableNewAPIProtection,
	)

	err := runner.Run(ctx)
	if err != nil {
		runner.stats.RecordError("run", err)
	}
	snapshot := runner.stats.Snapshot()
	raw, marshalErr := json.MarshalIndent(snapshot, "", "  ")
	if marshalErr != nil {
		log.Printf("encode load report failed: %v", marshalErr)
	} else {
		fmt.Println(string(raw))
		_ = os.WriteFile("/dev/termination-log", raw, 0o644)
	}
	if err != nil {
		log.Fatal(err)
	}
	if code := exitCodeFor(nil, snapshot); code != 0 {
		os.Exit(code)
	}
}

func exitCodeFor(runErr error, snapshot StatsSnapshot) int {
	if runErr != nil {
		return 1
	}
	if snapshot.HasErrors() {
		return 2
	}
	return 0
}
