package main

import (
	"log"

	"git.woa.com/wisp/mono/credit/internal/config"
	"git.woa.com/wisp/mono/credit/internal/migrations"
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
