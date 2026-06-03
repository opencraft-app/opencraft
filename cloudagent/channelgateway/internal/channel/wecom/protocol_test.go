package wecom

import (
	"encoding/json"
	"testing"

	"cloudagent/channelgateway/internal/channel"
)

func TestParseInboundTextCallback(t *testing.T) {
	raw := []byte(`{
		"cmd":"aibot_msg_callback",
		"headers":{"req_id":"req-1"},
		"body":{
			"msgid":"msg-1",
			"chatid":"chat-1",
			"chattype":"group",
			"msgtype":"text",
			"from":{"userid":"user-1"},
			"text":{"content":"hello"}
		}
	}`)
	msg, ok, err := parseInbound(raw, "account-a")
	if err != nil || !ok {
		t.Fatalf("parse ok=%v err=%v", ok, err)
	}
	if msg.ChannelAccountID != "account-a" || msg.ChatType != channel.ChatGroup || msg.Text != "hello" {
		t.Fatalf("unexpected message: %#v", msg)
	}
}

func TestParseInboundMixedTextCallback(t *testing.T) {
	body := map[string]any{
		"cmd":     "aibot_msg_callback",
		"headers": map[string]any{"req_id": "req-1"},
		"body": map[string]any{
			"chatid":  "user-1",
			"msgtype": "mixed",
			"from":    map[string]any{"userid": "user-1"},
			"mixed":   map[string]any{"msg_item": []any{map[string]any{"msgtype": "text", "text": map[string]any{"content": "first"}}, map[string]any{"msgtype": "text", "text": map[string]any{"content": "second"}}}},
		},
	}
	raw, _ := json.Marshal(body)
	msg, ok, err := parseInbound(raw, "account-a")
	if err != nil || !ok {
		t.Fatalf("parse ok=%v err=%v", ok, err)
	}
	if msg.ChatType != channel.ChatDM || msg.Text != "first\nsecond" {
		t.Fatalf("unexpected message: %#v", msg)
	}
}
