package config

import (
	"strings"
	"testing"
)

func TestLoadDoesNotRequireAIGatewayAdminToken(t *testing.T) {
	t.Setenv("SUBSCRIPTION_MYSQL_DSN", "user:pass@tcp(127.0.0.1:3306)/subscription?parseTime=true")
	t.Setenv("PAYMENT_INTERNAL_BASE_URL", "http://payment.user-auth.svc.cluster.local")
	t.Setenv("AI_GATEWAY_BASE_URL", "http://gateway.ai-gateway.svc.cluster.local")
	t.Setenv("AI_GATEWAY_ADMIN_TOKEN", "")
	t.Setenv("SUBSCRIPTION_FREE_PLAN_ID", "plan-free")
	t.Setenv("SUBSCRIPTION_LITE_PLAN_ID", "plan-lite")
	t.Setenv("SUBSCRIPTION_PRO_PLAN_ID", "plan-pro")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("expected config to load without admin token, got error: %v", err)
	}
	if cfg.AIGatewayBaseURL != "http://gateway.ai-gateway.svc.cluster.local" {
		t.Fatalf("unexpected ai gateway base url: %q", cfg.AIGatewayBaseURL)
	}
	if got := cfg.MySQLDSN; got == "" || strings.Contains(got, "loc=Local") || !strings.Contains(got, "parseTime=true") || !strings.Contains(got, "time_zone=") {
		t.Fatalf("unexpected normalized mysql dsn: %q", got)
	}
}
