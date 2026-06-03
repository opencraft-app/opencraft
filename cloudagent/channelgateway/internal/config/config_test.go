package config

import (
	"encoding/json"
	"testing"
)

func TestWeComWebSocketURLFallbacks(t *testing.T) {
	t.Setenv("WECOM_WEBSOCKET_URL", "")
	t.Setenv("CODEBUDDY_WECOM_BOT_WS_URL", "")
	if got := LoadFromEnv().WeCom.WebSocketURL; got != "wss://openws.work.weixin.qq.com" {
		t.Fatalf("default websocket url = %q", got)
	}

	t.Setenv("CODEBUDDY_WECOM_BOT_WS_URL", "wss://codebuddy.example/ws")
	if got := LoadFromEnv().WeCom.WebSocketURL; got != "wss://codebuddy.example/ws" {
		t.Fatalf("codebuddy websocket url fallback = %q", got)
	}

	t.Setenv("WECOM_WEBSOCKET_URL", "wss://wecom.example/ws")
	if got := LoadFromEnv().WeCom.WebSocketURL; got != "wss://wecom.example/ws" {
		t.Fatalf("explicit wecom websocket url should win, got %q", got)
	}
}

func TestWeComAccountsJSONSeedsMultipleAccounts(t *testing.T) {
	raw, err := json.Marshal([]map[string]any{
		{
			"account_id":    "wecom-a",
			"bot_id":        "bot-a",
			"secret":        "secret-a",
			"websocket_url": "ws://wecom-a",
			"tenant_id":     "tenant-a",
			"project_id":    "project-a",
			"agent_id":      "agent-a",
		},
		{
			"account_id":    "wecom-b",
			"bot_id":        "bot-b",
			"secret":        "secret-b",
			"websocket_url": "ws://wecom-b",
			"tenant_id":     "tenant-b",
			"project_id":    "project-b",
			"agent_id":      "agent-b",
		},
	})
	if err != nil {
		t.Fatalf("marshal accounts json: %v", err)
	}
	t.Setenv("CHANNELGATEWAY_WECOM_ENABLED", "true")
	t.Setenv("CHANNELGATEWAY_WECOM_ACCOUNTS_JSON", string(raw))
	cfg := LoadFromEnv()
	if err := cfg.Validate(); err != nil {
		t.Fatalf("validate: %v", err)
	}
	accounts := cfg.EnabledWeComAccounts()
	if len(accounts) != 2 {
		t.Fatalf("expected two accounts, got %#v", accounts)
	}
	if accounts[0].AccountID != "wecom-a" || accounts[0].TenantID != "tenant-a" || accounts[0].BotID != "bot-a" {
		t.Fatalf("unexpected first account: %#v", accounts[0])
	}
	if accounts[1].AccountID != "wecom-b" || accounts[1].ProjectID != "project-b" || accounts[1].Secret != "secret-b" {
		t.Fatalf("unexpected second account: %#v", accounts[1])
	}
}

func TestWeComAccountsJSONRejectsDuplicateAccountID(t *testing.T) {
	t.Setenv("CHANNELGATEWAY_WECOM_ACCOUNTS_JSON", `[{"account_id":"dup"},{"account_id":"dup"}]`)
	if err := LoadFromEnv().Validate(); err == nil {
		t.Fatal("duplicate account_id should fail config validation")
	}
}
