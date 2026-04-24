package main

import (
	"fmt"
	"log"
	"net/url"
	"os"
	"strings"

	"git.woa.com/wisp/mono/subscription/internal/migrations"
)

func main() {
	dsn := strings.TrimSpace(os.Getenv("SUBSCRIPTION_MYSQL_DSN"))
	if dsn == "" {
		dsn = buildMySQLDSN(
			envOrDefault("SUBSCRIPTION_DB_USER", "subscription"),
			strings.TrimSpace(os.Getenv("SUBSCRIPTION_DB_PASSWORD")),
			envOrDefault("MYSQL_HOST", "127.0.0.1"),
			envOrDefault("MYSQL_PORT", "3306"),
			strings.TrimSpace(os.Getenv("SUBSCRIPTION_DB")),
		)
	}
	if dsn == "" {
		log.Fatal("SUBSCRIPTION_MYSQL_DSN is required")
	}
	if err := migrations.Run(dsn); err != nil {
		log.Fatalf("apply migrations: %v", err)
	}
	log.Print("subscription migrations applied")
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
