package main

import (
	"log"

	"git.woa.com/wisp/mono/referral/internal/config"
	"git.woa.com/wisp/mono/referral/internal/migrations"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("load config: %v", err)
	}
	if err := migrations.Run(cfg.MySQLDSN); err != nil {
		log.Fatalf("run migrations: %v", err)
	}
}
