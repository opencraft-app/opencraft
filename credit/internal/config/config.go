package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/go-sql-driver/mysql"
)

type Config struct {
	Addr                         string
	MySQLDSN                     string
	InternalServiceToken         string
	TradeBaseURL                 string
	LLMGatewayBaseURL            string
	LLMGatewayInternalToken      string
	Region                       string
	ObjectIDPasswordSuffix       string
	CreditTokenRatio             int64
	UsageWorkerPollInterval      time.Duration
	UsageWorkerLeaseDuration     time.Duration
	UsageWorkerBatchSize         int
	LifecycleWorkerPollInterval  time.Duration
	LifecycleWorkerLeaseDuration time.Duration
	LifecycleWorkerBatchSize     int
}

func Load() (Config, error) {
	cfg := Config{
		Addr:                         envOrDefault("CREDIT_ADDR", ":8080"),
		MySQLDSN:                     strings.TrimSpace(os.Getenv("CREDIT_MYSQL_DSN")),
		InternalServiceToken:         strings.TrimSpace(os.Getenv("LIGHTCLAW_INTERNAL_SERVICE_TOKEN")),
		TradeBaseURL:                 strings.TrimSpace(os.Getenv("TRADE_INTERNAL_BASE_URL")),
		LLMGatewayBaseURL:            strings.TrimSpace(os.Getenv("LLMGATEWAY_INTERNAL_BASE_URL")),
		LLMGatewayInternalToken:      strings.TrimSpace(os.Getenv("LLMGATEWAY_INTERNAL_SERVICE_TOKEN")),
		Region:                       strings.TrimSpace(os.Getenv("CREDIT_REGION")),
		ObjectIDPasswordSuffix:       strings.TrimSpace(os.Getenv("CREDIT_OBJECT_ID_PASSWORD_SUFFIX")),
		CreditTokenRatio:             10000,
		UsageWorkerPollInterval:      10 * time.Second,
		UsageWorkerLeaseDuration:     30 * time.Second,
		UsageWorkerBatchSize:         50,
		LifecycleWorkerPollInterval:  10 * time.Second,
		LifecycleWorkerLeaseDuration: 30 * time.Second,
		LifecycleWorkerBatchSize:     50,
	}
	if raw := strings.TrimSpace(os.Getenv("CREDIT_TOKEN_RATIO")); raw != "" {
		value, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || value <= 0 {
			return Config{}, fmt.Errorf("CREDIT_TOKEN_RATIO must be a positive integer")
		}
		cfg.CreditTokenRatio = value
	}
	for key, target := range map[string]*time.Duration{
		"CREDIT_USAGE_WORKER_POLL_INTERVAL":      &cfg.UsageWorkerPollInterval,
		"CREDIT_USAGE_WORKER_LEASE_DURATION":     &cfg.UsageWorkerLeaseDuration,
		"CREDIT_LIFECYCLE_WORKER_POLL_INTERVAL":  &cfg.LifecycleWorkerPollInterval,
		"CREDIT_LIFECYCLE_WORKER_LEASE_DURATION": &cfg.LifecycleWorkerLeaseDuration,
	} {
		if raw := strings.TrimSpace(os.Getenv(key)); raw != "" {
			value, err := time.ParseDuration(raw)
			if err != nil || value <= 0 {
				return Config{}, fmt.Errorf("%s must be a positive duration", key)
			}
			*target = value
		}
	}
	if raw := strings.TrimSpace(os.Getenv("CREDIT_USAGE_WORKER_BATCH_SIZE")); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value <= 0 || value > 50 {
			return Config{}, fmt.Errorf("CREDIT_USAGE_WORKER_BATCH_SIZE must be between 1 and 50")
		}
		cfg.UsageWorkerBatchSize = value
	}
	if raw := strings.TrimSpace(os.Getenv("CREDIT_LIFECYCLE_WORKER_BATCH_SIZE")); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value <= 0 || value > 50 {
			return Config{}, fmt.Errorf("CREDIT_LIFECYCLE_WORKER_BATCH_SIZE must be between 1 and 50")
		}
		cfg.LifecycleWorkerBatchSize = value
	}
	if cfg.MySQLDSN == "" {
		cfg.MySQLDSN = buildMySQLDSN(
			envOrDefault("CREDIT_DB_USER", "credit"),
			strings.TrimSpace(os.Getenv("CREDIT_DB_PASSWORD")),
			envOrDefault("MYSQL_HOST", "127.0.0.1"),
			envOrDefault("MYSQL_PORT", "3306"),
			strings.TrimSpace(os.Getenv("CREDIT_DB")),
		)
	}
	if cfg.MySQLDSN == "" {
		return Config{}, fmt.Errorf("CREDIT_MYSQL_DSN is required")
	}
	cfg.MySQLDSN = normalizeMySQLDSN(cfg.MySQLDSN)
	if cfg.InternalServiceToken == "" {
		return Config{}, fmt.Errorf("LIGHTCLAW_INTERNAL_SERVICE_TOKEN is required")
	}
	if cfg.TradeBaseURL == "" {
		return Config{}, fmt.Errorf("TRADE_INTERNAL_BASE_URL is required")
	}
	if cfg.LLMGatewayBaseURL == "" {
		return Config{}, fmt.Errorf("LLMGATEWAY_INTERNAL_BASE_URL is required")
	}
	if cfg.LLMGatewayInternalToken == "" {
		return Config{}, fmt.Errorf("LLMGATEWAY_INTERNAL_SERVICE_TOKEN is required")
	}
	return cfg, nil
}

func (c Config) ValidatePackageID() error {
	if strings.TrimSpace(c.Region) == "" {
		return fmt.Errorf("CREDIT_REGION is required")
	}
	if strings.TrimSpace(c.ObjectIDPasswordSuffix) == "" {
		return fmt.Errorf("CREDIT_OBJECT_ID_PASSWORD_SUFFIX is required")
	}
	return nil
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
