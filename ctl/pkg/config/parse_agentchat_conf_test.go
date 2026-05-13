package config

import (
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
	t.Setenv("CTL_AIGATEWAY_ADMIN_TOKEN", "env-admin-token")
	t.Setenv("CTL_AIGATEWAY_INTERNAL_SERVICE_TOKEN", "env-internal-token")
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
	if ServerConf.AdapterConfig.AiGateway.AdminToken != "env-admin-token" {
		t.Fatalf("aigateway admin token was not overridden from env")
	}
	if ServerConf.AdapterConfig.AiGateway.InternalServiceToken != "env-internal-token" {
		t.Fatalf("aigateway internal token was not overridden from env")
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
