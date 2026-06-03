package wecom

import (
	"encoding/json"
	"strings"

	"cloudagent/channelgateway/internal/channel"
)

const (
	cmdSubscribe = "aibot_subscribe"
	cmdCallback  = "aibot_msg_callback"
	cmdSend      = "aibot_send_msg"
	cmdRespond   = "aibot_respond_msg"
	cmdPing      = "ping"
)

type frame struct {
	Cmd     string          `json:"cmd,omitempty"`
	Headers frameHeaders    `json:"headers,omitempty"`
	Body    json.RawMessage `json:"body,omitempty"`
	ErrCode int             `json:"errcode,omitempty"`
	ErrMsg  string          `json:"errmsg,omitempty"`
}

type frameHeaders struct {
	ReqID string `json:"req_id,omitempty"`
}

func parseInbound(raw []byte, accountID string) (channel.Message, bool, error) {
	var payload frame
	if err := json.Unmarshal(raw, &payload); err != nil {
		return channel.Message{}, false, err
	}
	if payload.Cmd != cmdCallback || len(payload.Body) == 0 {
		return channel.Message{}, false, nil
	}
	var body map[string]any
	if err := json.Unmarshal(payload.Body, &body); err != nil {
		return channel.Message{}, false, err
	}
	msgID := stringValue(body["msgid"])
	if msgID == "" {
		msgID = payload.Headers.ReqID
	}
	sender := mapValue(body["from"])
	senderID := strings.TrimSpace(stringValue(sender["userid"]))
	chatID := strings.TrimSpace(stringValue(body["chatid"]))
	if chatID == "" {
		chatID = senderID
	}
	if chatID == "" {
		return channel.Message{}, false, nil
	}
	chatType := channel.ChatDM
	if strings.EqualFold(stringValue(body["chattype"]), "group") {
		chatType = channel.ChatGroup
	}
	text := extractText(body)
	kind := channel.MessageText
	if text == "" {
		kind = channel.MessageFile
	}
	rawCopy := append(json.RawMessage(nil), raw...)
	return channel.Message{
		ChannelAccountID:       accountID,
		ChannelType:            channel.TypeWeCom,
		ExternalMessageID:      msgID,
		ExternalConversationID: chatID,
		ExternalUserID:         senderID,
		ExternalUserName:       senderID,
		ChatType:               chatType,
		Kind:                   kind,
		Text:                   text,
		Raw:                    rawCopy,
	}, true, nil
}

func subscribeFrame(reqID, botID, secret string) any {
	return map[string]any{
		"cmd":     cmdSubscribe,
		"headers": map[string]any{"req_id": reqID},
		"body":    map[string]any{"bot_id": botID, "secret": secret},
	}
}

func pingFrame(reqID string) any {
	return map[string]any{"cmd": cmdPing, "headers": map[string]any{"req_id": reqID}, "body": map[string]any{}}
}

func sendMarkdownFrame(reqID, chatID, text string) any {
	return map[string]any{
		"cmd":     cmdSend,
		"headers": map[string]any{"req_id": reqID},
		"body": map[string]any{
			"chatid":   chatID,
			"msgtype":  "markdown",
			"markdown": map[string]any{"content": text},
		},
	}
}

func respondStreamFrame(reqID, text string) any {
	return map[string]any{
		"cmd":     cmdRespond,
		"headers": map[string]any{"req_id": reqID},
		"body": map[string]any{
			"msgtype": "stream",
			"stream": map[string]any{
				"id":      reqID + "-stream",
				"finish":  true,
				"content": text,
			},
		},
	}
}

func extractText(body map[string]any) string {
	msgType := strings.ToLower(stringValue(body["msgtype"]))
	var parts []string
	if msgType == "mixed" {
		mixed := mapValue(body["mixed"])
		items, _ := mixed["msg_item"].([]any)
		for _, itemRaw := range items {
			item := mapValue(itemRaw)
			if strings.ToLower(stringValue(item["msgtype"])) != "text" {
				continue
			}
			if content := strings.TrimSpace(stringValue(mapValue(item["text"])["content"])); content != "" {
				parts = append(parts, content)
			}
		}
	} else {
		if content := strings.TrimSpace(stringValue(mapValue(body["text"])["content"])); content != "" {
			parts = append(parts, content)
		}
		if msgType == "voice" {
			if content := strings.TrimSpace(stringValue(mapValue(body["voice"])["content"])); content != "" {
				parts = append(parts, content)
			}
		}
		if msgType == "appmsg" {
			if title := strings.TrimSpace(stringValue(mapValue(body["appmsg"])["title"])); title != "" {
				parts = append(parts, title)
			}
		}
	}
	return strings.Join(parts, "\n")
}

func mapValue(v any) map[string]any {
	if value, ok := v.(map[string]any); ok {
		return value
	}
	return map[string]any{}
}

func stringValue(v any) string {
	switch value := v.(type) {
	case string:
		return value
	case json.Number:
		return value.String()
	default:
		return ""
	}
}
