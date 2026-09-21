package config

import (
	"strings"
	"testing"
	"time"
)

func TestLoadRequiresSeparateLLMGatewayInternalToken(t *testing.T) {
	t.Setenv("LIGHTCLAW_INTERNAL_SERVICE_TOKEN", "credit-internal")
	t.Setenv("TRADE_INTERNAL_BASE_URL", "http://trade.local")
	t.Setenv("LLMGATEWAY_INTERNAL_BASE_URL", "https://llmgw-control.local")
	t.Setenv("CREDIT_DB_PASSWORD", "db-password")
	t.Setenv("CREDIT_DB", "credit")
	t.Setenv("CREDIT_REGION", "ap-beijing")
	t.Setenv("CREDIT_OBJECT_ID_PASSWORD_SUFFIX", "sandbox_bj_7")

	_, err := Load()
	if err == nil || !strings.Contains(err.Error(), "LLMGATEWAY_INTERNAL_SERVICE_TOKEN") {
		t.Fatalf("Load() error = %v, want LLMGateway token requirement", err)
	}

	t.Setenv("LLMGATEWAY_INTERNAL_SERVICE_TOKEN", "llmgw-internal")
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load(): %v", err)
	}
	if cfg.InternalServiceToken != "credit-internal" {
		t.Fatalf("InternalServiceToken = %q", cfg.InternalServiceToken)
	}
	if cfg.LLMGatewayInternalToken != "llmgw-internal" {
		t.Fatalf("LLMGatewayInternalToken = %q", cfg.LLMGatewayInternalToken)
	}
}

func TestLoadMigrationRequiresOnlyDatabaseConfig(t *testing.T) {
	t.Setenv("CREDIT_MYSQL_DSN", "credit:password@tcp(mysql.local:3306)/credit")
	t.Setenv("LIGHTCLAW_INTERNAL_SERVICE_TOKEN", "")
	t.Setenv("TRADE_INTERNAL_BASE_URL", "")
	t.Setenv("LLMGATEWAY_INTERNAL_BASE_URL", "")
	t.Setenv("LLMGATEWAY_INTERNAL_SERVICE_TOKEN", "")

	cfg, err := LoadMigration()
	if err != nil {
		t.Fatalf("LoadMigration(): %v", err)
	}
	if !strings.Contains(cfg.MySQLDSN, "parseTime=true") {
		t.Fatalf("MySQLDSN = %q, want normalized migration DSN", cfg.MySQLDSN)
	}
}

func TestLoadUsageWorkerSettings(t *testing.T) {
	t.Setenv("LIGHTCLAW_INTERNAL_SERVICE_TOKEN", "credit-internal")
	t.Setenv("TRADE_INTERNAL_BASE_URL", "http://trade.local")
	t.Setenv("LLMGATEWAY_INTERNAL_BASE_URL", "https://llmgw-control.local")
	t.Setenv("LLMGATEWAY_INTERNAL_SERVICE_TOKEN", "llmgw-internal")
	t.Setenv("CREDIT_DB_PASSWORD", "db-password")
	t.Setenv("CREDIT_DB", "credit")
	t.Setenv("CREDIT_REGION", "ap-beijing")
	t.Setenv("CREDIT_OBJECT_ID_PASSWORD_SUFFIX", "sandbox_bj_7")
	t.Setenv("CREDIT_TOKEN_RATIO", "20000")
	t.Setenv("CREDIT_USAGE_WORKER_POLL_INTERVAL", "5s")
	t.Setenv("CREDIT_USAGE_WORKER_LEASE_DURATION", "45s")
	t.Setenv("CREDIT_USAGE_WORKER_BATCH_SIZE", "25")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load(): %v", err)
	}
	if cfg.CreditTokenRatio != 20000 || cfg.UsageWorkerPollInterval.String() != "5s" ||
		cfg.UsageWorkerLeaseDuration.String() != "45s" || cfg.UsageWorkerBatchSize != 25 {
		t.Fatalf("unexpected worker config: %+v", cfg)
	}
	if cfg.Region != "ap-beijing" || cfg.ObjectIDPasswordSuffix != "sandbox_bj_7" {
		t.Fatalf("unexpected object ID config: %+v", cfg)
	}
}

func TestLoadAllowsMissingCreditObjectIDConfig(t *testing.T) {
	t.Setenv("LIGHTCLAW_INTERNAL_SERVICE_TOKEN", "credit-internal")
	t.Setenv("TRADE_INTERNAL_BASE_URL", "http://trade.local")
	t.Setenv("LLMGATEWAY_INTERNAL_BASE_URL", "https://llmgw-control.local")
	t.Setenv("LLMGATEWAY_INTERNAL_SERVICE_TOKEN", "llmgw-internal")
	t.Setenv("CREDIT_DB_PASSWORD", "db-password")
	t.Setenv("CREDIT_DB", "credit")
	t.Setenv("CREDIT_OBJECT_ID_PASSWORD_SUFFIX", "sandbox_bj_7")
	t.Setenv("CREDIT_REGION", "")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() should allow migration and workers without object ID config: %v", err)
	}
	if cfg.Region != "" {
		t.Fatalf("Region = %q, want empty", cfg.Region)
	}
}

func TestValidatePackageIDConfig(t *testing.T) {
	for _, tt := range []struct {
		name       string
		cfg        Config
		wantErrKey string
	}{
		{name: "missing region", cfg: Config{ObjectIDPasswordSuffix: "sandbox_bj_7"}, wantErrKey: "CREDIT_REGION"},
		{name: "missing password suffix", cfg: Config{Region: "ap-beijing"}, wantErrKey: "CREDIT_OBJECT_ID_PASSWORD_SUFFIX"},
		{name: "complete", cfg: Config{Region: "ap-beijing", ObjectIDPasswordSuffix: "sandbox_bj_7"}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			err := tt.cfg.ValidatePackageID()
			if tt.wantErrKey == "" && err != nil {
				t.Fatalf("ValidatePackageID(): %v", err)
			}
			if tt.wantErrKey != "" && (err == nil || !strings.Contains(err.Error(), tt.wantErrKey)) {
				t.Fatalf("ValidatePackageID() error = %v, want %s requirement", err, tt.wantErrKey)
			}
		})
	}
}

func TestLoadLifecycleWorkerSettings(t *testing.T) {
	t.Setenv("LIGHTCLAW_INTERNAL_SERVICE_TOKEN", "credit-internal")
	t.Setenv("TRADE_INTERNAL_BASE_URL", "http://trade.local")
	t.Setenv("LLMGATEWAY_INTERNAL_BASE_URL", "https://llmgw-control.local")
	t.Setenv("LLMGATEWAY_INTERNAL_SERVICE_TOKEN", "llmgw-internal")
	t.Setenv("CREDIT_DB_PASSWORD", "db-password")
	t.Setenv("CREDIT_DB", "credit")
	t.Setenv("CREDIT_LIFECYCLE_WORKER_POLL_INTERVAL", "6s")
	t.Setenv("CREDIT_LIFECYCLE_WORKER_LEASE_DURATION", "40s")
	t.Setenv("CREDIT_LIFECYCLE_WORKER_BATCH_SIZE", "20")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load(): %v", err)
	}
	if cfg.LifecycleWorkerPollInterval != 6*time.Second ||
		cfg.LifecycleWorkerLeaseDuration != 40*time.Second || cfg.LifecycleWorkerBatchSize != 20 {
		t.Fatalf("unexpected lifecycle worker config: %+v", cfg)
	}
}

func TestLoadAuthCodeRedisSettings(t *testing.T) {
	setRequiredConfig(t)
	t.Setenv("CREDIT_REDIS_ADDR", "redis.local:6379")
	t.Setenv("CREDIT_REDIS_PASSWORD", "redis-password")
	t.Setenv("CREDIT_REDIS_DB", "6")
	t.Setenv("CREDIT_AUTH_CODE_TTL", "12m")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load(): %v", err)
	}
	if cfg.RedisAddr != "redis.local:6379" || cfg.RedisPassword != "redis-password" || cfg.RedisDB != 6 {
		t.Fatalf("unexpected Redis config: %+v", cfg)
	}
	if cfg.AuthCodeTTL != 12*time.Minute {
		t.Fatalf("AuthCodeTTL = %v", cfg.AuthCodeTTL)
	}
}

func TestLoadAuthCodeRedisDefaults(t *testing.T) {
	setRequiredConfig(t)
	t.Setenv("CREDIT_REDIS_DB", "")
	t.Setenv("CREDIT_AUTH_CODE_TTL", "")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load(): %v", err)
	}
	if cfg.RedisDB != 0 || cfg.AuthCodeTTL != 10*time.Minute {
		t.Fatalf("unexpected auth code defaults: %+v", cfg)
	}
}

func TestLoadRejectsInvalidAuthCodeRedisSettings(t *testing.T) {
	for _, tt := range []struct {
		name  string
		key   string
		value string
		want  string
	}{
		{name: "non-integer db", key: "CREDIT_REDIS_DB", value: "db-zero", want: "CREDIT_REDIS_DB"},
		{name: "negative db", key: "CREDIT_REDIS_DB", value: "-1", want: "CREDIT_REDIS_DB"},
		{name: "invalid ttl", key: "CREDIT_AUTH_CODE_TTL", value: "ten-minutes", want: "CREDIT_AUTH_CODE_TTL"},
		{name: "zero ttl", key: "CREDIT_AUTH_CODE_TTL", value: "0s", want: "CREDIT_AUTH_CODE_TTL"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			setRequiredConfig(t)
			t.Setenv(tt.key, tt.value)
			_, err := Load()
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("Load() error = %v, want %s", err, tt.want)
			}
		})
	}
}

func TestValidateAuthCodeConfig(t *testing.T) {
	if err := (Config{}).ValidateAuthCode(); err == nil || !strings.Contains(err.Error(), "CREDIT_REDIS_ADDR") {
		t.Fatalf("ValidateAuthCode() error = %v", err)
	}
	if err := (Config{RedisAddr: "redis.local:6379"}).ValidateAuthCode(); err != nil {
		t.Fatalf("ValidateAuthCode(): %v", err)
	}
}

func setRequiredConfig(t *testing.T) {
	t.Helper()
	t.Setenv("LIGHTCLAW_INTERNAL_SERVICE_TOKEN", "credit-internal")
	t.Setenv("TRADE_INTERNAL_BASE_URL", "http://trade.local")
	t.Setenv("LLMGATEWAY_INTERNAL_BASE_URL", "https://llmgw-control.local")
	t.Setenv("LLMGATEWAY_INTERNAL_SERVICE_TOKEN", "llmgw-internal")
	t.Setenv("CREDIT_DB_PASSWORD", "db-password")
	t.Setenv("CREDIT_DB", "credit")
	t.Setenv("CREDIT_REDIS_ADDR", "")
	t.Setenv("CREDIT_REDIS_PASSWORD", "")
	t.Setenv("CREDIT_REDIS_DB", "")
	t.Setenv("CREDIT_AUTH_CODE_TTL", "")
}
