package adapter

import (
	"encoding/json"
	"testing"
)

func TestOpenAIToAnthropic_Basic(t *testing.T) {
	oaiResp := `{
		"id": "chatcmpl-abc123",
		"object": "chat.completion",
		"choices": [{
			"message": {"role": "assistant", "content": "Hello!"},
			"finish_reason": "stop"
		}],
		"usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}
	}`

	result, err := OpenAIToAnthropic([]byte(oaiResp), "claude-3-opus-20240229")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var resp map[string]interface{}
	json.Unmarshal(result, &resp)

	if resp["type"] != "message" {
		t.Errorf("expected type 'message', got %v", resp["type"])
	}
	if resp["role"] != "assistant" {
		t.Errorf("expected role 'assistant', got %v", resp["role"])
	}
	if resp["stop_reason"] != "end_turn" {
		t.Errorf("expected stop_reason 'end_turn', got %v", resp["stop_reason"])
	}
	if resp["model"] != "claude-3-opus-20240229" {
		t.Errorf("expected model claude-3-opus-20240229, got %v", resp["model"])
	}

	// 验证 content blocks
	content := resp["content"].([]interface{})
	if len(content) != 1 {
		t.Fatalf("expected 1 content block, got %d", len(content))
	}
	block := content[0].(map[string]interface{})
	if block["type"] != "text" || block["text"] != "Hello!" {
		t.Errorf("unexpected content block: %v", block)
	}

	// 验证 usage 映射
	usage := resp["usage"].(map[string]interface{})
	if usage["input_tokens"] != float64(10) {
		t.Errorf("expected input_tokens=10, got %v", usage["input_tokens"])
	}
	if usage["output_tokens"] != float64(5) {
		t.Errorf("expected output_tokens=5, got %v", usage["output_tokens"])
	}

	// 验证 ID 格式
	if resp["id"] != "msg_abc123" {
		t.Errorf("expected id 'msg_abc123', got %v", resp["id"])
	}
}

func TestOpenAIToAnthropic_FinishReasonLength(t *testing.T) {
	oaiResp := `{
		"id": "chatcmpl-xxx",
		"choices": [{
			"message": {"role": "assistant", "content": "..."},
			"finish_reason": "length"
		}],
		"usage": {"prompt_tokens": 5, "completion_tokens": 100}
	}`

	result, err := OpenAIToAnthropic([]byte(oaiResp), "claude-3-haiku")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var resp map[string]interface{}
	json.Unmarshal(result, &resp)
	if resp["stop_reason"] != "max_tokens" {
		t.Errorf("expected stop_reason 'max_tokens', got %v", resp["stop_reason"])
	}
}

func TestOpenAIToAnthropic_ErrorResponse(t *testing.T) {
	oaiResp := `{"error": {"message": "Invalid request", "type": "invalid_request_error"}}`

	result, err := OpenAIToAnthropic([]byte(oaiResp), "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var resp map[string]interface{}
	json.Unmarshal(result, &resp)
	if resp["type"] != "error" {
		t.Errorf("expected type 'error', got %v", resp["type"])
	}
	errObj := resp["error"].(map[string]interface{})
	if errObj["message"] != "Invalid request" {
		t.Errorf("unexpected error message: %v", errObj["message"])
	}
}

// --- Gemini 响应转换 ---

func TestOpenAIToGemini_Basic(t *testing.T) {
	oaiResp := `{
		"id": "chatcmpl-abc",
		"choices": [{
			"message": {"role": "assistant", "content": "Hello!"},
			"finish_reason": "stop"
		}],
		"usage": {"prompt_tokens": 5, "completion_tokens": 10, "total_tokens": 15}
	}`

	result, err := OpenAIToGemini([]byte(oaiResp))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var resp map[string]interface{}
	json.Unmarshal(result, &resp)

	candidates := resp["candidates"].([]interface{})
	if len(candidates) != 1 {
		t.Fatalf("expected 1 candidate, got %d", len(candidates))
	}

	candidate := candidates[0].(map[string]interface{})
	if candidate["finishReason"] != "STOP" {
		t.Errorf("expected finishReason STOP, got %v", candidate["finishReason"])
	}

	content := candidate["content"].(map[string]interface{})
	if content["role"] != "model" {
		t.Errorf("expected role 'model', got %v", content["role"])
	}

	parts := content["parts"].([]interface{})
	part := parts[0].(map[string]interface{})
	if part["text"] != "Hello!" {
		t.Errorf("expected 'Hello!', got %v", part["text"])
	}

	// 验证 usageMetadata
	usage := resp["usageMetadata"].(map[string]interface{})
	if usage["promptTokenCount"] != float64(5) {
		t.Errorf("expected promptTokenCount=5, got %v", usage["promptTokenCount"])
	}
	if usage["candidatesTokenCount"] != float64(10) {
		t.Errorf("expected candidatesTokenCount=10, got %v", usage["candidatesTokenCount"])
	}
	if usage["totalTokenCount"] != float64(15) {
		t.Errorf("expected totalTokenCount=15, got %v", usage["totalTokenCount"])
	}
}

func TestOpenAIToGemini_FinishReasonLength(t *testing.T) {
	oaiResp := `{
		"choices": [{
			"message": {"role": "assistant", "content": "..."},
			"finish_reason": "length"
		}],
		"usage": {"prompt_tokens": 5, "completion_tokens": 100}
	}`

	result, err := OpenAIToGemini([]byte(oaiResp))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var resp map[string]interface{}
	json.Unmarshal(result, &resp)
	candidate := resp["candidates"].([]interface{})[0].(map[string]interface{})
	if candidate["finishReason"] != "MAX_TOKENS" {
		t.Errorf("expected MAX_TOKENS, got %v", candidate["finishReason"])
	}
}

func TestOpenAIToGemini_ErrorResponse(t *testing.T) {
	oaiResp := `{"error": {"message": "Server error"}}`

	result, err := OpenAIToGemini([]byte(oaiResp))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var resp map[string]interface{}
	json.Unmarshal(result, &resp)
	errObj := resp["error"].(map[string]interface{})
	if errObj["message"] != "Server error" {
		t.Errorf("unexpected error message: %v", errObj["message"])
	}
}

// --- finish_reason 映射测试 ---

func TestMapFinishReasonToAnthropic(t *testing.T) {
	tests := []struct {
		input    string
		expected string
	}{
		{"stop", "end_turn"},
		{"length", "max_tokens"},
		{"content_filter", "end_turn"},
		{"unknown", "end_turn"},
	}
	for _, tt := range tests {
		got := mapFinishReasonToAnthropic(tt.input)
		if got != tt.expected {
			t.Errorf("mapFinishReasonToAnthropic(%q) = %q, want %q", tt.input, got, tt.expected)
		}
	}
}

func TestMapFinishReasonToGemini(t *testing.T) {
	tests := []struct {
		input    string
		expected string
	}{
		{"stop", "STOP"},
		{"length", "MAX_TOKENS"},
		{"content_filter", "SAFETY"},
		{"unknown", "STOP"},
	}
	for _, tt := range tests {
		got := mapFinishReasonToGemini(tt.input)
		if got != tt.expected {
			t.Errorf("mapFinishReasonToGemini(%q) = %q, want %q", tt.input, got, tt.expected)
		}
	}
}
