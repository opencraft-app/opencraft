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
	AllowedOrigins       []string
	MySQLDSN             string
	PaymentBaseURL       string
	AdminToken           string
	AIGatewayBaseURL     string
	PlanMappings         map[string]string
}

func Load() (Config, error) {
	cfg := Config{
		Addr:           envOrDefault("SUBSCRIPTION_ADDR", ":8086"),
		AllowedOrigins: splitCSV(os.Getenv("SUBSCRIPTION_ALLOWED_ORIGINS")),
		MySQLDSN: firstNonEmpty(strings.TrimSpace(os.Getenv("SUBSCRIPTION_MYSQL_DSN")), buildMySQLDSN(
			envOrDefault("SUBSCRIPTION_DB_USER", "subscription"),
			strings.TrimSpace(os.Getenv("SUBSCRIPTION_DB_PASSWORD")),
			envOrDefault("MYSQL_HOST", "127.0.0.1"),
			envOrDefault("MYSQL_PORT", "3306"),
			strings.TrimSpace(os.Getenv("SUBSCRIPTION_DB")),
		)),
		PaymentBaseURL:   strings.TrimSpace(os.Getenv("PAYMENT_INTERNAL_BASE_URL")),
		AdminToken:       strings.TrimSpace(os.Getenv("SUBSCRIPTION_ADMIN_TOKEN")),
		AIGatewayBaseURL: strings.TrimSpace(os.Getenv("AI_GATEWAY_BASE_URL")),
		PlanMappings: map[string]string{
			"free": strings.TrimSpace(os.Getenv("SUBSCRIPTION_FREE_PLAN_ID")),
			"lite": strings.TrimSpace(os.Getenv("SUBSCRIPTION_LITE_PLAN_ID")),
			"pro":  strings.TrimSpace(os.Getenv("SUBSCRIPTION_PRO_PLAN_ID")),
		},
	}
	if cfg.MySQLDSN == "" {
		return Config{}, fmt.Errorf("SUBSCRIPTION_MYSQL_DSN is required")
	}
	cfg.MySQLDSN = normalizeMySQLDSN(cfg.MySQLDSN)
	if cfg.PaymentBaseURL == "" {
		return Config{}, fmt.Errorf("PAYMENT_INTERNAL_BASE_URL is required")
	}
	if cfg.AIGatewayBaseURL == "" {
		return Config{}, fmt.Errorf("AI_GATEWAY_BASE_URL is required")
	}
	for code, planID := range cfg.PlanMappings {
		if planID == "" {
			return Config{}, fmt.Errorf("%s plan mapping is required", code)
		}
	}
	return cfg, nil
}

func envOrDefault(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func splitCSV(raw string) []string {
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
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
