package adapter

import (
	"encoding/json"
	"testing"
)

func TestAnthropicToOpenAI_Basic(t *testing.T) {
	body := `{
		"model": "claude-3-opus-20240229",
		"max_tokens": 1024,
		"messages": [{"role": "user", "content": "Hello"}]
	}`

	result, meta, err := AnthropicToOpenAI([]byte(body))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var oai map[string]interface{}
	json.Unmarshal(result, &oai)

	if oai["model"] != "claude-3-opus-20240229" {
		t.Errorf("expected model claude-3-opus-20240229, got %v", oai["model"])
	}

	msgs := oai["messages"].([]interface{})
	if len(msgs) != 1 {
		t.Errorf("expected 1 message, got %d", len(msgs))
	}

	msg := msgs[0].(map[string]interface{})
	if msg["role"] != "user" || msg["content"] != "Hello" {
		t.Errorf("unexpected message: %v", msg)
	}

	if meta.OriginalModel != "claude-3-opus-20240229" {
		t.Errorf("meta model mismatch: %s", meta.OriginalModel)
	}
}

func TestAnthropicToOpenAI_WithSystemPrompt(t *testing.T) {
	body := `{
		"model": "claude-3-haiku-20240307",
		"max_tokens": 100,
		"system": "You are a helpful assistant",
		"messages": [{"role": "user", "content": "Hi"}]
	}`

	result, _, err := AnthropicToOpenAI([]byte(body))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var oai map[string]interface{}
	json.Unmarshal(result, &oai)

	msgs := oai["messages"].([]interface{})
	if len(msgs) != 2 {
		t.Fatalf("expected 2 messages (system + user), got %d", len(msgs))
	}

	sysMsg := msgs[0].(map[string]interface{})
	if sysMsg["role"] != "system" || sysMsg["content"] != "You are a helpful assistant" {
		t.Errorf("unexpected system message: %v", sysMsg)
	}
}

func TestAnthropicToOpenAI_ContentArray(t *testing.T) {
	body := `{
		"model": "claude-3-opus-20240229",
		"max_tokens": 100,
		"messages": [{
			"role": "user",
			"content": [
				{"type": "text", "text": "Hello "},
				{"type": "text", "text": "World"}
			]
		}]
	}`

	result, _, err := AnthropicToOpenAI([]byte(body))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var oai map[string]interface{}
	json.Unmarshal(result, &oai)

	msgs := oai["messages"].([]interface{})
	msg := msgs[0].(map[string]interface{})
	if msg["content"] != "Hello World" {
		t.Errorf("expected 'Hello World', got %v", msg["content"])
	}
}

func TestAnthropicToOpenAI_Stream(t *testing.T) {
	body := `{
		"model": "claude-3-haiku-20240307",
		"max_tokens": 100,
		"messages": [{"role": "user", "content": "Hi"}],
		"stream": true
	}`

	result, meta, err := AnthropicToOpenAI([]byte(body))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if !meta.Stream {
		t.Error("expected stream=true in meta")
	}

	var oai map[string]interface{}
	json.Unmarshal(result, &oai)
	if oai["stream"] != true {
		t.Error("expected stream=true in converted body")
	}
}

func TestAnthropicToOpenAI_StopSequences(t *testing.T) {
	body := `{
		"model": "claude-3-opus-20240229",
		"max_tokens": 100,
		"messages": [{"role": "user", "content": "Hi"}],
		"stop_sequences": ["\n\nHuman:"]
	}`

	result, _, err := AnthropicToOpenAI([]byte(body))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var oai map[string]interface{}
	json.Unmarshal(result, &oai)
	stop := oai["stop"].([]interface{})
	if len(stop) != 1 || stop[0] != "\n\nHuman:" {
		t.Errorf("unexpected stop: %v", stop)
	}
}

func TestAnthropicToOpenAI_MultiTurn(t *testing.T) {
	body := `{
		"model": "claude-3-opus-20240229",
		"max_tokens": 100,
		"messages": [
			{"role": "user", "content": "Hello"},
			{"role": "assistant", "content": "Hi there!"},
			{"role": "user", "content": "How are you?"}
		]
	}`

	result, _, err := AnthropicToOpenAI([]byte(body))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var oai map[string]interface{}
	json.Unmarshal(result, &oai)
	msgs := oai["messages"].([]interface{})
	if len(msgs) != 3 {
		t.Errorf("expected 3 messages, got %d", len(msgs))
	}
}

// --- Gemini 转换测试 ---

func TestGeminiToOpenAI_Basic(t *testing.T) {
	body := `{
		"contents": [
			{"parts": [{"text": "Hello Gemini"}]}
		]
	}`

	result, err := GeminiToOpenAI([]byte(body), "gemini-pro", false)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var oai map[string]interface{}
	json.Unmarshal(result, &oai)

	if oai["model"] != "gemini-pro" {
		t.Errorf("expected model gemini-pro, got %v", oai["model"])
	}
	if oai["stream"] != false {
		t.Error("expected stream=false")
	}

	msgs := oai["messages"].([]interface{})
	if len(msgs) != 1 {
		t.Fatalf("expected 1 message, got %d", len(msgs))
	}
	msg := msgs[0].(map[string]interface{})
	if msg["content"] != "Hello Gemini" {
		t.Errorf("expected 'Hello Gemini', got %v", msg["content"])
	}
}

func TestGeminiToOpenAI_WithSystemInstruction(t *testing.T) {
	body := `{
		"contents": [{"parts": [{"text": "Hi"}]}],
		"systemInstruction": {"parts": [{"text": "You are helpful"}]}
	}`

	result, err := GeminiToOpenAI([]byte(body), "gemini-pro", false)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var oai map[string]interface{}
	json.Unmarshal(result, &oai)

	msgs := oai["messages"].([]interface{})
	if len(msgs) != 2 {
		t.Fatalf("expected 2 messages, got %d", len(msgs))
	}
	sys := msgs[0].(map[string]interface{})
	if sys["role"] != "system" {
		t.Errorf("expected system role, got %v", sys["role"])
	}
}

func TestGeminiToOpenAI_GenerationConfig(t *testing.T) {
	body := `{
		"contents": [{"parts": [{"text": "Hi"}]}],
		"generationConfig": {
			"temperature": 0.7,
			"maxOutputTokens": 500,
			"topP": 0.9,
			"stopSequences": ["END"]
		}
	}`

	result, err := GeminiToOpenAI([]byte(body), "gemini-pro", true)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var oai map[string]interface{}
	json.Unmarshal(result, &oai)

	if oai["temperature"] != 0.7 {
		t.Errorf("expected temperature 0.7, got %v", oai["temperature"])
	}
	if oai["max_tokens"] != 500.0 {
		t.Errorf("expected max_tokens 500, got %v", oai["max_tokens"])
	}
	if oai["stream"] != true {
		t.Error("expected stream=true")
	}
}

func TestGeminiToOpenAI_ModelRole(t *testing.T) {
	body := `{
		"contents": [
			{"role": "user", "parts": [{"text": "Hello"}]},
			{"role": "model", "parts": [{"text": "Hi!"}]},
			{"role": "user", "parts": [{"text": "How are you?"}]}
		]
	}`

	result, err := GeminiToOpenAI([]byte(body), "gemini-pro", false)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var oai map[string]interface{}
	json.Unmarshal(result, &oai)

	msgs := oai["messages"].([]interface{})
	if len(msgs) != 3 {
		t.Fatalf("expected 3 messages, got %d", len(msgs))
	}
	// model → assistant
	assistantMsg := msgs[1].(map[string]interface{})
	if assistantMsg["role"] != "assistant" {
		t.Errorf("expected role assistant, got %v", assistantMsg["role"])
	}
}

func TestGeminiToOpenAI_WithInlineImage(t *testing.T) {
	body := `{
		"contents": [
			{"parts": [
				{"text": "Describe this image"},
				{"inlineData": {"mimeType": "image/png", "data": "YWJjMTIz"}}
			]}
		]
	}`

	result, err := GeminiToOpenAI([]byte(body), "gemini-pro", false)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var oai map[string]interface{}
	json.Unmarshal(result, &oai)

	msgs := oai["messages"].([]interface{})
	content := msgs[0].(map[string]interface{})["content"].([]interface{})
	if len(content) != 2 {
		t.Fatalf("expected 2 content blocks, got %d", len(content))
	}

	imageBlock := content[1].(map[string]interface{})
	if imageBlock["type"] != "image_url" {
		t.Fatalf("expected image_url block, got %v", imageBlock["type"])
	}

	imageURL := imageBlock["image_url"].(map[string]interface{})
	if imageURL["url"] != "data:image/png;base64,YWJjMTIz" {
		t.Fatalf("unexpected image url: %v", imageURL["url"])
	}
}

func TestAnthropicToOpenAI_WithImageBlocks(t *testing.T) {
	body := `{
		"model": "claude-3-sonnet",
		"messages": [{
			"role": "user",
			"content": [
				{"type": "text", "text": "Look"},
				{"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "YWJjMTIz"}},
				{"type": "image", "source": {"type": "url", "url": "https://example.com/cat.png"}}
			]
		}]
	}`

	result, _, err := AnthropicToOpenAI([]byte(body))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var oai map[string]interface{}
	json.Unmarshal(result, &oai)

	msgs := oai["messages"].([]interface{})
	content := msgs[0].(map[string]interface{})["content"].([]interface{})
	if len(content) != 3 {
		t.Fatalf("expected 3 content blocks, got %d", len(content))
	}

	first := content[0].(map[string]interface{})
	if first["type"] != "text" || first["text"] != "Look" {
		t.Fatalf("unexpected first block: %v", first)
	}

	second := content[1].(map[string]interface{})["image_url"].(map[string]interface{})
	if second["url"] != "data:image/png;base64,YWJjMTIz" {
		t.Fatalf("unexpected base64 image url: %v", second["url"])
	}

	third := content[2].(map[string]interface{})["image_url"].(map[string]interface{})
	if third["url"] != "https://example.com/cat.png" {
		t.Fatalf("unexpected url image: %v", third["url"])
	}
}

// --- ParseGeminiPath 测试 ---

func TestParseGeminiPath(t *testing.T) {
	tests := []struct {
		path     string
		model    string
		isStream bool
	}{
		{"/gemini-pro:generateContent", "gemini-pro", false},
		{"/gemini-pro:streamGenerateContent", "gemini-pro", true},
		{"gemini-1.5-flash:generateContent", "gemini-1.5-flash", false},
		{"/gemini-2.0-flash:streamGenerateContent", "gemini-2.0-flash", true},
	}
	for _, tt := range tests {
		model, isStream := ParseGeminiPath(tt.path)
		if model != tt.model || isStream != tt.isStream {
			t.Errorf("ParseGeminiPath(%q) = (%q, %v), want (%q, %v)",
				tt.path, model, isStream, tt.model, tt.isStream)
		}
	}
}
