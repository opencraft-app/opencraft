package config

import (
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/go-sql-driver/mysql"
)

type Config struct {
	Addr           string
	AllowedOrigins []string
	MySQLDSN       string
	AdminToken     string
	// SupportAgentIDs 是反馈后台（/support/feedback/list、/attachment）允许的运营用户
	// 白名单。取值为 lightclaw 用户 ID 列表，需与上游鉴权网关在 access: authenticated
	// 路由下注入的 X-User-Id 一致。空列表表示无运营可访问（接口恒 401）。
	SupportAgentIDs []string
}

func Load() (Config, error) {
	cfg := Config{
		Addr:           envOrDefault("TICKET_ADDR", ":8090"),
		AllowedOrigins: splitCSV(os.Getenv("TICKET_ALLOWED_ORIGINS")),
		MySQLDSN: firstNonEmpty(strings.TrimSpace(os.Getenv("TICKET_MYSQL_DSN")), buildMySQLDSN(
			envOrDefault("TICKET_DB_USER", "ticket"),
			strings.TrimSpace(os.Getenv("TICKET_DB_PASSWORD")),
			envOrDefault("MYSQL_HOST", "127.0.0.1"),
			envOrDefault("MYSQL_PORT", "3306"),
			envOrDefault("TICKET_DB", "lightvela_ticket"),
		)),
		AdminToken:      strings.TrimSpace(os.Getenv("TICKET_ADMIN_TOKEN")),
		SupportAgentIDs: splitCSV(os.Getenv("SUPPORT_AGENT_IDS")),
	}
	if cfg.MySQLDSN != "" {
		cfg.MySQLDSN = normalizeMySQLDSN(cfg.MySQLDSN)
	}
	// MySQL DSN 不再强制要求：本地无库时工单和反馈接口会降级为 503。
	if cfg.AdminToken == "" {
		return Config{}, fmt.Errorf("TICKET_ADMIN_TOKEN is required")
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
