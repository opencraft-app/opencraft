package adapter

import (
	"encoding/json"
	"fmt"
	"strings"
)

// OpenAIToAnthropic 将 OpenAI chat/completions 非流式响应转换为 Anthropic Messages API 格式。
func OpenAIToAnthropic(body []byte, originalModel string) ([]byte, error) {
	var oaiResp map[string]interface{}
	if err := json.Unmarshal(body, &oaiResp); err != nil {
		return nil, fmt.Errorf("invalid OpenAI response: %w", err)
	}

	// 如果是错误响应，转为 Anthropic 错误格式
	if errObj, ok := oaiResp["error"]; ok {
		return marshalAnthropicError(errObj)
	}

	// 提取 content 和 finish_reason
	var contentBlocks []map[string]interface{}
	stopReason := "end_turn"

	if choices, ok := oaiResp["choices"].([]interface{}); ok && len(choices) > 0 {
		if choice, ok := choices[0].(map[string]interface{}); ok {
			if msg, ok := choice["message"].(map[string]interface{}); ok {
				text, _ := msg["content"].(string)
				contentBlocks = append(contentBlocks, map[string]interface{}{
					"type": "text",
					"text": text,
				})
			}
			if fr, ok := choice["finish_reason"].(string); ok {
				stopReason = mapFinishReasonToAnthropic(fr)
			}
		}
	}

	if contentBlocks == nil {
		contentBlocks = []map[string]interface{}{}
	}

	// usage 映射
	inputTokens := 0
	outputTokens := 0
	if u, ok := oaiResp["usage"].(map[string]interface{}); ok {
		inputTokens = getInt(u, "prompt_tokens")
		outputTokens = getInt(u, "completion_tokens")
	}

	// 生成 Anthropic 格式 ID
	oaiID, _ := oaiResp["id"].(string)
	anthropicID := "msg_" + strings.TrimPrefix(oaiID, "chatcmpl-")
	if anthropicID == "msg_" {
		anthropicID = "msg_unknown"
	}

	if originalModel == "" {
		originalModel, _ = oaiResp["model"].(string)
	}

	resp := map[string]interface{}{
		"id":           anthropicID,
		"type":         "message",
		"role":         "assistant",
		"content":      contentBlocks,
		"model":        originalModel,
		"stop_reason":  stopReason,
		"stop_sequence": nil,
		"usage": map[string]interface{}{
			"input_tokens":  inputTokens,
			"output_tokens": outputTokens,
		},
	}

	return json.Marshal(resp)
}

// OpenAIToGemini 将 OpenAI chat/completions 非流式响应转换为 Google Gemini API 格式。
func OpenAIToGemini(body []byte) ([]byte, error) {
	var oaiResp map[string]interface{}
	if err := json.Unmarshal(body, &oaiResp); err != nil {
		return nil, fmt.Errorf("invalid OpenAI response: %w", err)
	}

	// 错误响应转换
	if errObj, ok := oaiResp["error"]; ok {
		return marshalGeminiError(errObj)
	}

	var candidates []interface{}
	if choices, ok := oaiResp["choices"].([]interface{}); ok {
		for _, ch := range choices {
			choice, ok := ch.(map[string]interface{})
			if !ok {
				continue
			}
			msg, ok := choice["message"].(map[string]interface{})
			if !ok {
				continue
			}
			text, _ := msg["content"].(string)

			finishReason := "STOP"
			if fr, ok := choice["finish_reason"].(string); ok {
				finishReason = mapFinishReasonToGemini(fr)
			}

			candidates = append(candidates, map[string]interface{}{
				"content": map[string]interface{}{
					"parts": []map[string]interface{}{{"text": text}},
					"role":  "model",
				},
				"finishReason": finishReason,
			})
		}
	}

	if candidates == nil {
		candidates = []interface{}{}
	}

	promptTokens := 0
	completionTokens := 0
	if u, ok := oaiResp["usage"].(map[string]interface{}); ok {
		promptTokens = getInt(u, "prompt_tokens")
		completionTokens = getInt(u, "completion_tokens")
	}

	resp := map[string]interface{}{
		"candidates": candidates,
		"usageMetadata": map[string]interface{}{
			"promptTokenCount":     promptTokens,
			"candidatesTokenCount": completionTokens,
			"totalTokenCount":      promptTokens + completionTokens,
		},
	}

	return json.Marshal(resp)
}

// --- finish_reason 映射 ---

func mapFinishReasonToAnthropic(fr string) string {
	switch fr {
	case "stop":
		return "end_turn"
	case "length":
		return "max_tokens"
	case "content_filter":
		return "end_turn"
	default:
		return "end_turn"
	}
}

func mapFinishReasonToGemini(fr string) string {
	switch fr {
	case "stop":
		return "STOP"
	case "length":
		return "MAX_TOKENS"
	case "content_filter":
		return "SAFETY"
	default:
		return "STOP"
	}
}

// --- 错误格式转换 ---

func marshalAnthropicError(errObj interface{}) ([]byte, error) {
	errMap, ok := errObj.(map[string]interface{})
	if !ok {
		errMap = map[string]interface{}{}
	}
	message, _ := errMap["message"].(string)
	errType, _ := errMap["type"].(string)
	if errType == "" {
		errType = "api_error"
	}

	resp := map[string]interface{}{
		"type": "error",
		"error": map[string]interface{}{
			"type":    errType,
			"message": message,
		},
	}
	return json.Marshal(resp)
}

func marshalGeminiError(errObj interface{}) ([]byte, error) {
	errMap, ok := errObj.(map[string]interface{})
	if !ok {
		errMap = map[string]interface{}{}
	}
	message, _ := errMap["message"].(string)

	resp := map[string]interface{}{
		"error": map[string]interface{}{
			"code":    500,
			"message": message,
			"status":  "INTERNAL",
		},
	}
	return json.Marshal(resp)
}

// --- 辅助函数 ---

func getInt(m map[string]interface{}, key string) int {
	if v, ok := m[key]; ok {
		switch n := v.(type) {
		case float64:
			return int(n)
		case int:
			return n
		case json.Number:
			i, _ := n.Int64()
			return int(i)
		}
	}
	return 0
}
