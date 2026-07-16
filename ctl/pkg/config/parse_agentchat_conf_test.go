package config

import (
	"reflect"
	"testing"

	"ctl/pkg/util"
)

func TestParseAgentChatConfDefaultsAndDecryptsSecrets(t *testing.T) {
	original := ServerConf
	t.Cleanup(func() {
		ServerConf = original
	})
	ServerConf = &GlobalConfig{
		AgentChat: &AgentChatConfig{
			SecretID:          "lightvela_2026",
			SecretKey:         util.EncryptString("lightvela_ai_A6zP39qL"),
			LaunchTokenSecret: util.EncryptString("launch-secret"),
		},
	}

	parseAgentChatConf()

	if ServerConf.AgentChat.BusinessCode != "lightvela" {
		t.Fatalf("unexpected business code: %q", ServerConf.AgentChat.BusinessCode)
	}
	if ServerConf.AgentChat.LaunchTokenTTLSeconds != 300 || ServerConf.AgentChat.TimestampSkewSeconds != 300 {
		t.Fatalf("unexpected ttl/skew: %+v", ServerConf.AgentChat)
	}
	if ServerConf.AgentChat.SecretKey != "lightvela_ai_A6zP39qL" {
		t.Fatalf("secret key was not decrypted")
	}
	if ServerConf.AgentChat.LaunchTokenSecret != "launch-secret" {
		t.Fatalf("launch token secret was not decrypted")
	}
}

func TestParseAgentChatConfUsesRuntimeSecretEnv(t *testing.T) {
	original := ServerConf
	t.Cleanup(func() {
		ServerConf = original
	})
	t.Setenv("AGENTCHAT_SECRET_ID", "env-secret-id")
	t.Setenv("AGENTCHAT_SECRET_KEY", "env-secret-key")
	t.Setenv("AGENTCHAT_LAUNCH_TOKEN_SECRET", "env-launch-secret")
	ServerConf = &GlobalConfig{
		AgentChat: &AgentChatConfig{
			BusinessCode:          "lightvela",
			SecretID:              "toml-secret-id",
			SecretKey:             util.EncryptString("toml-secret-key"),
			LaunchTokenSecret:     util.EncryptString("toml-launch-secret"),
			LaunchTokenTTLSeconds: 300,
			TimestampSkewSeconds:  300,
		},
	}

	parseAgentChatConf()

	if ServerConf.AgentChat.SecretID != "env-secret-id" {
		t.Fatalf("secret id was not overridden from env: %q", ServerConf.AgentChat.SecretID)
	}
	if ServerConf.AgentChat.SecretKey != "env-secret-key" {
		t.Fatalf("secret key was not overridden from env: %q", ServerConf.AgentChat.SecretKey)
	}
	if ServerConf.AgentChat.LaunchTokenSecret != "env-launch-secret" {
		t.Fatalf("launch token secret was not overridden from env: %q", ServerConf.AgentChat.LaunchTokenSecret)
	}
}

func TestRuntimeSecretEnvOverridesSharedConfig(t *testing.T) {
	original := ServerConf
	t.Cleanup(func() {
		ServerConf = original
	})
	t.Setenv("CTL_REDIS_PASS", "env-redis-pass")
	t.Setenv("CTL_DB_PASSWORD", "env-db-password")
	t.Setenv("CTL_MQ_STREAM_KEY", "env-stream-key")
	t.Setenv("CTL_LLMGATEWAY_ADMIN_TOKEN", "env-llm-admin-token")
	t.Setenv("CTL_LLMGATEWAY_INTERNAL_SERVICE_TOKEN", "env-llm-internal-token")
	t.Setenv("CTL_LLMGATEWAY_BASE_URL", "https://llmgateway.example.com")
	t.Setenv("CTL_SHADOW_TOKEN", "env-shadow-token")
	ServerConf = &GlobalConfig{
		RedisConfig: &RedisConfig{
			Pass: util.EncryptString("toml-redis-pass"),
		},
		DBConfig: &DBConfig{
			Password: util.EncryptString("toml-db-password"),
		},
		MQConfig: &MQConfig{
			StreamKey: "toml-stream-key",
		},
		AdapterConfig: &AdapterConfig{
			AiGateway: &AiGatewayConfig{
				AdminToken:           "toml-admin-token",
				InternalServiceToken: "toml-internal-token",
			},
			LLMGateway: &LLMGatewayConfig{
				AdminToken:           "toml-llm-admin-token",
				InternalServiceToken: "toml-llm-internal-token",
			},
			Shadow: &ShadowConfig{
				Token:   "toml-shadow-token",
				Timeout: 5,
			},
		},
	}

	parseRedisConf()
	parseMySQLConf()
	parseMQConf()
	parseAdapterConf()

	if ServerConf.RedisConfig.Pass != "env-redis-pass" {
		t.Fatalf("redis pass was not overridden from env")
	}
	if ServerConf.DBConfig.Password != "env-db-password" {
		t.Fatalf("db password was not overridden from env")
	}
	if ServerConf.MQConfig.StreamKey != "env-stream-key" {
		t.Fatalf("mq stream key was not overridden from env")
	}
	if ServerConf.AdapterConfig.LLMGateway.AdminToken != "env-llm-admin-token" {
		t.Fatalf("llmgateway admin token was not overridden from env")
	}
	if ServerConf.AdapterConfig.LLMGateway.InternalServiceToken != "env-llm-internal-token" {
		t.Fatalf("llmgateway internal token was not overridden from env")
	}
	if !ServerConf.AdapterConfig.LLMGateway.Enabled {
		t.Fatal("llmgateway should be enabled when all explicit runtime settings are present")
	}
	if ServerConf.AdapterConfig.Shadow.Token != "env-shadow-token" {
		t.Fatalf("shadow token was not overridden from env")
	}
}

func TestParseAdapterConfRequiresCompleteExplicitLLMGatewaySettings(t *testing.T) {
	tests := []struct {
		name          string
		baseURL       string
		adminToken    string
		internalToken string
		wantEnabled   bool
	}{
		{name: "complete", baseURL: "https://llmgateway.example.com", adminToken: "admin", internalToken: "internal", wantEnabled: true},
		{name: "missing base url", adminToken: "admin", internalToken: "internal"},
		{name: "missing admin token", baseURL: "https://llmgateway.example.com", internalToken: "internal"},
		{name: "missing internal token", baseURL: "https://llmgateway.example.com", adminToken: "admin"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			original := ServerConf
			t.Cleanup(func() { ServerConf = original })
			t.Setenv("CTL_LLMGATEWAY_BASE_URL", tt.baseURL)
			t.Setenv("CTL_LLMGATEWAY_ADMIN_TOKEN", tt.adminToken)
			t.Setenv("CTL_LLMGATEWAY_INTERNAL_SERVICE_TOKEN", tt.internalToken)
			ServerConf = &GlobalConfig{
				AdapterConfig: &AdapterConfig{
					AiGateway: &AiGatewayConfig{
						BaseURL:              "https://legacy.example.com",
						AdminToken:           "legacy-admin",
						InternalServiceToken: "legacy-internal",
					},
				},
			}

			parseAdapterConf()

			if got := ServerConf.AdapterConfig.LLMGateway.Enabled; got != tt.wantEnabled {
				t.Fatalf("LLMGateway.Enabled = %v, want %v", got, tt.wantEnabled)
			}
			if !tt.wantEnabled && ServerConf.AdapterConfig.LLMGateway.BaseURL != "https://legacy.example.com" {
				t.Fatalf("disabled LLMGateway.BaseURL = %q, want legacy endpoint", ServerConf.AdapterConfig.LLMGateway.BaseURL)
			}
		})
	}
}

func TestParseAdapterConfLoadsLLMGatewayNewUserAllowlist(t *testing.T) {
	original := ServerConf
	t.Cleanup(func() { ServerConf = original })
	t.Setenv("CTL_LLMGATEWAY_BASE_URL", "https://llmgateway.example.com")
	t.Setenv("CTL_LLMGATEWAY_ADMIN_TOKEN", "admin")
	t.Setenv("CTL_LLMGATEWAY_INTERNAL_SERVICE_TOKEN", "internal")
	t.Setenv("CTL_LLMGATEWAY_NEW_USER_ALLOWLIST", " usr-canary,usr-second,usr-canary ")
	ServerConf = &GlobalConfig{AdapterConfig: &AdapterConfig{}}

	parseAdapterConf()

	got := ServerConf.AdapterConfig.LLMGateway.NewAllocationUserAllowlist
	want := []string{"usr-canary", "usr-second"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("NewAllocationUserAllowlist = %#v, want %#v", got, want)
	}
}

func TestParseAgentChatConfInitializesMissingBlock(t *testing.T) {
	original := ServerConf
	t.Cleanup(func() {
		ServerConf = original
	})
	ServerConf = &GlobalConfig{}

	parseAgentChatConf()

	if ServerConf.AgentChat == nil {
		t.Fatal("expected agentchat config to be initialized")
	}
	if ServerConf.AgentChat.BusinessCode != "lightvela" {
		t.Fatalf("unexpected business code: %q", ServerConf.AgentChat.BusinessCode)
	}
}
