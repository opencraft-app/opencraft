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
