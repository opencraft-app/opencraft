package config

import (
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/go-sql-driver/mysql"
)

type Config struct {
	Addr                 string
	MySQLDSN             string
	InternalServiceToken string
	SubscriptionBaseURL  string
	Provider             string
}

func Load() (Config, error) {
	cfg := Config{
		Addr: envOrDefault("PAYMENT_ADDR", ":8080"),
		MySQLDSN: firstNonEmpty(strings.TrimSpace(os.Getenv("PAYMENT_MYSQL_DSN")), buildMySQLDSN(
			envOrDefault("PAYMENT_DB_USER", "payment"),
			strings.TrimSpace(os.Getenv("PAYMENT_DB_PASSWORD")),
			envOrDefault("MYSQL_HOST", "127.0.0.1"),
			envOrDefault("MYSQL_PORT", "3306"),
			strings.TrimSpace(os.Getenv("PAYMENT_DB")),
		)),
		InternalServiceToken: strings.TrimSpace(os.Getenv("LIGHTCLAW_INTERNAL_SERVICE_TOKEN")),
		SubscriptionBaseURL:  strings.TrimSpace(os.Getenv("SUBSCRIPTION_INTERNAL_BASE_URL")),
		Provider:             envOrDefault("PAYMENT_PROVIDER", "mock"),
	}
	if cfg.MySQLDSN == "" {
		return Config{}, fmt.Errorf("PAYMENT_MYSQL_DSN is required")
	}
	cfg.MySQLDSN = normalizeMySQLDSN(cfg.MySQLDSN)
	if cfg.InternalServiceToken == "" {
		return Config{}, fmt.Errorf("LIGHTCLAW_INTERNAL_SERVICE_TOKEN is required")
	}
	if cfg.SubscriptionBaseURL == "" {
		return Config{}, fmt.Errorf("SUBSCRIPTION_INTERNAL_BASE_URL is required")
	}
	return cfg, nil
}

func envOrDefault(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func buildMySQLDSN(user, password, host, port, database string) string {
	if strings.TrimSpace(user) == "" || strings.TrimSpace(password) == "" || strings.TrimSpace(database) == "" {
		return ""
	}
	cfg := mysql.NewConfig()
	cfg.User = strings.TrimSpace(user)
	cfg.Passwd = strings.TrimSpace(password)
	cfg.Net = "tcp"
	cfg.Addr = fmt.Sprintf("%s:%s", strings.TrimSpace(host), strings.TrimSpace(port))
	cfg.DBName = strings.TrimSpace(database)
	cfg.ParseTime = true
	cfg.Loc = time.UTC
	cfg.Params = map[string]string{"time_zone": "'+00:00'"}
	return cfg.FormatDSN()
}

func normalizeMySQLDSN(dsn string) string {
	trimmed := strings.TrimSpace(dsn)
	if trimmed == "" {
		return ""
	}
	cfg, err := mysql.ParseDSN(trimmed)
	if err != nil {
		return trimmed
	}
	cfg.ParseTime = true
	cfg.Loc = time.UTC
	if cfg.Params == nil {
		cfg.Params = make(map[string]string)
	}
	cfg.Params["time_zone"] = "'+00:00'"
	return cfg.FormatDSN()
}
