package config

import "testing"

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
