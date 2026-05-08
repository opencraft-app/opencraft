package config

import (
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/go-sql-driver/mysql"
)

// Config 集中管理 trade 服务运行时配置。
//
// 与设计稿 §3.2 / §3.5.5 / §6.4 等章节对齐：
//   - InternalServiceToken：lightclaw 内部服务间互信 token（与 payment / subscription 共享同一密钥）
//   - CtlInternalBaseURL：trade → ctl 反向调（Q33 GetInternalBundleByID / 复活 createResource 链路用）
//   - ShadowInternalBaseURL：trade → shadow 反向调（Q12 / Q30 externalUserId → uin/appId 解绑）
//   - JifeiCGWGatewayURL / JifeiCGWHostHeader：jifei CGW 询价 / 下单 / 退款响应等所有出向请求统一入口（Q51 / §3.5.5）
//   - JifeiCallbackSignatureKey：jifei → trade 回调验签密钥（Q13 checkCreate signature 校验；与 Q47
//     trade → jifei 请求方向不签名严格区分两个签名方向）
//
// 环境变量命名遵循 monorepo 既有约定：
//   - TRADE_*：trade 服务私有
//   - LIGHTCLAW_*：跨服务通用
type Config struct {
	Addr     string
	MySQLDSN string

	InternalServiceToken string
	CtlInternalBaseURL   string
	ShadowInternalBaseURL string

	JifeiCGWGatewayURL          string
	JifeiCGWHostHeader          string
	JifeiCallbackSignatureKey   string
}

// Load 从环境变量构建 Config，未设必填项时返回 error。
func Load() (Config, error) {
	cfg := Config{
		Addr: envOrDefault("TRADE_ADDR", ":8080"),
		MySQLDSN: firstNonEmpty(
			strings.TrimSpace(os.Getenv("TRADE_MYSQL_DSN")),
			buildMySQLDSN(
				envOrDefault("TRADE_DB_USER", "trade"),
				strings.TrimSpace(os.Getenv("TRADE_DB_PASSWORD")),
				envOrDefault("MYSQL_HOST", "127.0.0.1"),
				envOrDefault("MYSQL_PORT", "3306"),
				strings.TrimSpace(os.Getenv("TRADE_DB")),
			),
		),
		InternalServiceToken:      strings.TrimSpace(os.Getenv("LIGHTCLAW_INTERNAL_SERVICE_TOKEN")),
		CtlInternalBaseURL:        strings.TrimSpace(os.Getenv("CTL_INTERNAL_BASE_URL")),
		ShadowInternalBaseURL:     strings.TrimSpace(os.Getenv("SHADOW_INTERNAL_BASE_URL")),
		JifeiCGWGatewayURL:        strings.TrimSpace(os.Getenv("JIFEI_CGW_GATEWAY_URL")),
		JifeiCGWHostHeader:        strings.TrimSpace(os.Getenv("JIFEI_CGW_HOST_HEADER")),
		JifeiCallbackSignatureKey: strings.TrimSpace(os.Getenv("TRADE_TENCENT_BILLING_SIGNATURE_KEY")),
	}

	if cfg.MySQLDSN == "" {
		return Config{}, fmt.Errorf("TRADE_MYSQL_DSN is required")
	}
	cfg.MySQLDSN = normalizeMySQLDSN(cfg.MySQLDSN)

	if cfg.InternalServiceToken == "" {
		return Config{}, fmt.Errorf("LIGHTCLAW_INTERNAL_SERVICE_TOKEN is required")
	}
	if cfg.CtlInternalBaseURL == "" {
		return Config{}, fmt.Errorf("CTL_INTERNAL_BASE_URL is required")
	}
	if cfg.ShadowInternalBaseURL == "" {
		return Config{}, fmt.Errorf("SHADOW_INTERNAL_BASE_URL is required")
	}
	// JifeiCGWGatewayURL / JifeiCGWHostHeader / JifeiCallbackSignatureKey 在迭代 3 / 5 真正接入
	// jifei CGW 适配层时再做强校验；当前迭代 1 骨架阶段允许为空，避免本地起服失败。
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
