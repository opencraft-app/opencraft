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
