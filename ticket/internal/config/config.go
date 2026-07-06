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
	// SupportAgentIDs 是反馈后台（/support/feedback/list、/sign）允许的运营用户
	// 白名单。取值为 lightclaw 用户 ID 列表，需与上游鉴权网关在 access: authenticated
	// 路由下注入的 X-User-Id 一致。空列表表示无运营可访问（接口恒 401）。
	SupportAgentIDs []string
	// SupportCOS 是用户反馈系统（COS 内容层）的私有凭证。
	// 仅服务端持有，前端永远拿不到 SecretKey；通过预签名 URL 下发上传/下载权限。
	// 允许为空：为空时反馈相关接口返回 503，不影响 ticket 主流程。
	SupportCOS SupportCOSConfig
}

// SupportCOSConfig 描述反馈系统使用的 COS 桶与私有凭证。
type SupportCOSConfig struct {
	BucketURL string
	SecretID  string
	SecretKey string
	Prefix    string
	SignedTTL time.Duration
	// Accelerate 开启 COS 全球加速：上传/下载/读桶统一走
	// <bucket>.cos.accelerate.myqcloud.com（公网加速，浏览器可达）。
	Accelerate bool
	// Internal 开启 COS 全球内网加速：仅服务端读桶走
	// <bucket>.cos-internal.accelerate.tencentcos.cn（腾讯云内网，更快免流量费）。
	// 注意：内网域名浏览器不可达，绝不能用于下发给前端的预签名 URL；
	// 且要求本服务运行在腾讯云内网（VPC）中。
	Internal bool
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
		AdminToken: strings.TrimSpace(os.Getenv("TICKET_ADMIN_TOKEN")),
		SupportAgentIDs: splitCSV(os.Getenv("SUPPORT_AGENT_IDS")),
		SupportCOS: SupportCOSConfig{
			BucketURL: strings.TrimSpace(os.Getenv("SUPPORT_COS_BUCKET_URL")),
			SecretID:  strings.TrimSpace(os.Getenv("SUPPORT_COS_SECRET_ID")),
			SecretKey: strings.TrimSpace(os.Getenv("SUPPORT_COS_SECRET_KEY")),
			Prefix:    envOrDefault("SUPPORT_COS_PREFIX", "support-feedback"),
			SignedTTL: 15 * time.Minute,
			// 加速开关：默认关闭。开启后由 support.go 改写 COS 域名。
			// SUPPORT_COS_ACCELERATE 必开（前端上传/下载走公网加速）；
			// SUPPORT_COS_INTERNAL 仅当本服务确在腾讯云内网(VPC)才开（服务端读桶走内网加速）。
			Accelerate: parseBoolEnv(os.Getenv("SUPPORT_COS_ACCELERATE")),
			Internal:   parseBoolEnv(os.Getenv("SUPPORT_COS_INTERNAL")),
		},
	}
	if cfg.MySQLDSN != "" {
		cfg.MySQLDSN = normalizeMySQLDSN(cfg.MySQLDSN)
	}
	// MySQL DSN 不再强制要求：纯反馈模式（只读 COS）不需要工单数据库。
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

func parseBoolEnv(raw string) bool {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
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
