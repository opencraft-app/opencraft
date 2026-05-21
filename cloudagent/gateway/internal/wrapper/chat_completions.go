package wrapper

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

func decodeChatCompletionRequest(body io.Reader, out *chatCompletionRequest) error {
	var raw map[string]json.RawMessage
	dec := json.NewDecoder(body)
	dec.UseNumber()
	if err := dec.Decode(&raw); err != nil {
		return err
	}
	if len(raw) == 0 {
		return fmt.Errorf("request body is required")
	}
	for key := range raw {
		switch key {
		case "model", "messages", "stream", "temperature", "top_p", "user", "max_tokens", "max_completion_tokens", "tools", "tool_choice", "parallel_tool_calls", "stream_options":
		default:
			return fmt.Errorf("unsupported field %q", key)
		}
	}
	if value, ok := raw["model"]; ok {
		if err := json.Unmarshal(value, &out.Model); err != nil {
			return fmt.Errorf("model must be a string")
		}
	}
	if value, ok := raw["messages"]; ok {
		if err := json.Unmarshal(value, &out.Messages); err != nil {
			return fmt.Errorf("messages must be an array")
		}
	}
	if value, ok := raw["stream"]; ok {
		if err := json.Unmarshal(value, &out.Stream); err != nil {
			return fmt.Errorf("stream must be a boolean")
		}
	}
	if strings.TrimSpace(out.Model) == "" {
		return fmt.Errorf("model is required")
	}
	if len(out.Messages) == 0 {
		return fmt.Errorf("messages are required")
	}
	return nil
}

func chatMessagesInstruction(messages []chatMessage) (string, error) {
	var b strings.Builder
	for _, msg := range messages {
		role := strings.TrimSpace(msg.Role)
		if role == "" {
			return "", fmt.Errorf("message role is required")
		}
		text, err := chatContentText(msg.Content)
		if err != nil {
			return "", err
		}
		text = strings.TrimSpace(text)
		if text == "" {
			continue
		}
		if b.Len() > 0 {
			b.WriteString("\n\n")
		}
		b.WriteString(role)
		b.WriteString(": ")
		b.WriteString(text)
	}
	out := strings.TrimSpace(b.String())
	if out == "" {
		return "", fmt.Errorf("messages must contain text")
	}
	return out, nil
}

func chatContentText(content any) (string, error) {
	switch value := content.(type) {
	case string:
		return value, nil
	case []any:
		var parts []string
		for _, item := range value {
			obj, ok := item.(map[string]any)
			if !ok {
				continue
			}
			typ, _ := obj["type"].(string)
			switch typ {
			case "text":
				if text, ok := obj["text"].(string); ok {
					parts = append(parts, text)
				}
			case "input_text":
				if text, ok := obj["text"].(string); ok {
					parts = append(parts, text)
				}
			}
		}
		return strings.Join(parts, "\n"), nil
	case nil:
		return "", nil
	default:
		return "", fmt.Errorf("unsupported message content")
	}
}

func chatCompletionResponse(id string, created int64, model, output string) map[string]any {
	return map[string]any{
		"id":      id,
		"object":  "chat.completion",
		"created": created,
		"model":   model,
		"choices": []map[string]any{
			{
				"index": 0,
				"message": map[string]any{
					"role":    "assistant",
					"content": output,
				},
				"finish_reason": "stop",
			},
		},
	}
}

func chatCompletionChunk(id string, created int64, model, delta, finishReason string) map[string]any {
	choice := map[string]any{
		"index": 0,
		"delta": map[string]any{},
	}
	if delta != "" {
		choice["delta"] = map[string]any{"content": delta}
	}
	if finishReason != "" {
		choice["finish_reason"] = finishReason
	} else {
		choice["finish_reason"] = nil
	}
	return map[string]any{
		"id":      id,
		"object":  "chat.completion.chunk",
		"created": created,
		"model":   model,
		"choices": []map[string]any{choice},
	}
}

func chatCompletionError(w http.ResponseWriter, status int, code, message string) {
	writeError(w, status, code, message)
}

func chatCompletionID() string {
	return "chatcmpl_" + randomHex(18)
}

func chatCompletionCreated() int64 {
	return time.Now().UTC().Unix()
}
