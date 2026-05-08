package main

import (
	"fmt"
	"log"
	"net/url"
	"os"
	"strings"

	"git.woa.com/wisp/mono/trade/internal/migrations"
)

func main() {
	dsn := strings.TrimSpace(os.Getenv("TRADE_MYSQL_DSN"))
	if dsn == "" {
		dsn = buildMySQLDSN(
			envOrDefault("TRADE_DB_USER", "trade"),
			strings.TrimSpace(os.Getenv("TRADE_DB_PASSWORD")),
			envOrDefault("MYSQL_HOST", "127.0.0.1"),
			envOrDefault("MYSQL_PORT", "3306"),
			strings.TrimSpace(os.Getenv("TRADE_DB")),
		)
	}
	if dsn == "" {
		log.Fatal("TRADE_MYSQL_DSN is required")
	}
	if err := migrations.Run(dsn); err != nil {
		log.Fatalf("apply migrations: %v", err)
	}
	log.Print("trade migrations applied")
}

func envOrDefault(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func buildMySQLDSN(user, password, host, port, database string) string {
	if strings.TrimSpace(user) == "" || strings.TrimSpace(password) == "" || strings.TrimSpace(database) == "" {
		return ""
	}
	query := url.Values{}
	query.Set("parseTime", "true")
	return fmt.Sprintf("%s:%s@tcp(%s:%s)/%s?%s",
		strings.TrimSpace(user),
		strings.TrimSpace(password),
		strings.TrimSpace(host),
		strings.TrimSpace(port),
		strings.TrimSpace(database),
		query.Encode(),
	)
}
