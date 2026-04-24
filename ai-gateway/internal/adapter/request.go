package adapter

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
)

// AnthropicToOpenAI 将 Anthropic Messages API 请求体转换为 OpenAI chat/completions 格式。
func AnthropicToOpenAI(body []byte) ([]byte, *AnthropicMeta, error) {
	var req map[string]interface{}
	if err := json.Unmarshal(body, &req); err != nil {
		return nil, nil, fmt.Errorf("invalid JSON: %w", err)
	}

	openAIReq := make(map[string]interface{})

	// model 直接映射
	modelName, _ := req["model"].(string)
	openAIReq["model"] = modelName

	// 构建 messages
	var messages []interface{}

	// Anthropic 的 system 字段 → OpenAI system message
	if system, ok := req["system"].(string); ok && system != "" {
		messages = append(messages, map[string]interface{}{
			"role":    "system",
			"content": system,
		})
	}
	// system 也可能是 content block 数组
	if systemArr, ok := req["system"].([]interface{}); ok {
		text := flattenContentBlocks(systemArr)
		if text != "" {
			messages = append(messages, map[string]interface{}{
				"role":    "system",
				"content": text,
			})
		}
	}

	// messages 映射
	if msgs, ok := req["messages"].([]interface{}); ok {
		for _, m := range msgs {
			msg, ok := m.(map[string]interface{})
			if !ok {
				continue
			}
			messages = append(messages, map[string]interface{}{
				"role":    msg["role"],
				"content": contentBlocksToOpenAI(msg["content"]),
			})
		}
	}
	openAIReq["messages"] = messages

	// 参数直接映射
	copyIfExists(req, openAIReq, "max_tokens")
	copyIfExists(req, openAIReq, "temperature")
	copyIfExists(req, openAIReq, "top_p")
	copyIfExists(req, openAIReq, "stream")

	// stop_sequences → stop
	if v, ok := req["stop_sequences"]; ok {
		openAIReq["stop"] = v
	}

	meta := &AnthropicMeta{
		Stream:        getBool(req, "stream"),
		OriginalModel: modelName,
	}

	result, err := json.Marshal(openAIReq)
	return result, meta, err
}

// GeminiToOpenAI 将 Google Gemini API 请求体转换为 OpenAI chat/completions 格式。
func GeminiToOpenAI(body []byte, modelFromPath string, isStream bool) ([]byte, error) {
	var req map[string]interface{}
	if err := json.Unmarshal(body, &req); err != nil {
		return nil, fmt.Errorf("invalid JSON: %w", err)
	}

	openAIReq := map[string]interface{}{
		"model":  modelFromPath,
		"stream": isStream,
	}

	var messages []interface{}

	// systemInstruction → system message
	if si, ok := req["systemInstruction"].(map[string]interface{}); ok {
		text, imgParts := extractPartsWithImages(si["parts"])
		if text != "" || len(imgParts) > 0 {
			messages = append(messages, buildOpenAIMessageWithImages("system", text, imgParts))
		}
	}

	// contents → messages
	if contents, ok := req["contents"].([]interface{}); ok {
		for _, c := range contents {
			content, ok := c.(map[string]interface{})
			if !ok {
				continue
			}
			role := "user"
			if r, ok := content["role"].(string); ok {
				switch r {
				case "model":
					role = "assistant"
				case "user":
					role = "user"
				}
			}
			text, imgParts := extractPartsWithImages(content["parts"])
			messages = append(messages, buildOpenAIMessageWithImages(role, text, imgParts))
		}
	}
	openAIReq["messages"] = messages

	// generationConfig → 扁平化参数
	if gc, ok := req["generationConfig"].(map[string]interface{}); ok {
		copyIfExists(gc, openAIReq, "temperature")
		if v, ok := gc["maxOutputTokens"]; ok {
			openAIReq["max_tokens"] = v
		}
		if v, ok := gc["topP"]; ok {
			openAIReq["top_p"] = v
		}
		if v, ok := gc["stopSequences"]; ok {
			openAIReq["stop"] = v
		}
	}

	result, err := json.Marshal(openAIReq)
	return result, err
}

// ParseGeminiPath 从 Gemini URL path 中解析模型名和操作类型。
// 输入: "/gemini-pro:generateContent" 或 "/gemini-pro:streamGenerateContent"
// 返回: model="gemini-pro", isStream=false/true
func ParseGeminiPath(path string) (model string, isStream bool) {
	// 去掉前导斜杠
	path = strings.TrimPrefix(path, "/")

	// 查找冒号分隔 model 和 action
	idx := strings.LastIndex(path, ":")
	if idx < 0 {
		return path, false
	}

	model = path[:idx]
	action := path[idx+1:]
	isStream = action == "streamGenerateContent"
	return
}

// --- 辅助函数 ---

// anthropicContentToOpenAI 将 Anthropic content block 数组转换为 OpenAI content block 数组。
// 只处理多模态 block，返回 nil 如果没有多模态内容。
func anthropicContentToOpenAI(blocks []interface{}) []interface{} {
	var result []interface{}
	for _, item := range blocks {
		block, ok := item.(map[string]interface{})
		if !ok {
			continue
		}
		if block["type"] == "image" {
			// Anthropic image block:
			// {type:"image", source:{type:"base64"|"url", media_type:"image/xxx", data:"..."|url:"..."}}
			source, ok := block["source"].(map[string]interface{})
			if !ok {
				continue
			}
			sourceType, _ := source["type"].(string)
			if sourceType == "base64" {
				mediaType, _ := source["media_type"].(string)
				data, _ := source["data"].(string)
				if data != "" {
					openAIBlock := map[string]interface{}{
						"type": "image_url",
						"image_url": map[string]interface{}{
							"url":    "data:" + mediaType + ";base64," + data,
							"detail": "auto",
						},
					}
					result = append(result, openAIBlock)
				}
			} else if sourceType == "url" {
				url, _ := source["url"].(string)
				if url != "" {
					openAIBlock := map[string]interface{}{
						"type": "image_url",
						"image_url": map[string]interface{}{
							"url":    url,
							"detail": "auto",
						},
					}
					result = append(result, openAIBlock)
				}
			}
		}
		// text 类型由 flattenContentBlocks 处理，不在这里处理
	}
	return result
}

// flattenContent 处理 Anthropic 消息的 content 字段。
// 可能是 string 或 content block 数组 [{"type":"text","text":"..."}]。
// 返回纯文本。
func flattenContent(content interface{}) string {
	if s, ok := content.(string); ok {
		return s
	}
	if arr, ok := content.([]interface{}); ok {
		return flattenContentBlocks(arr)
	}
	return fmt.Sprintf("%v", content)
}

// flattenContentBlocks 将 Anthropic content block 数组拼接为纯文本。
func flattenContentBlocks(blocks []interface{}) string {
	var parts []string
	for _, item := range blocks {
		block, ok := item.(map[string]interface{})
		if !ok {
			continue
		}
		if block["type"] == "text" {
			if text, ok := block["text"].(string); ok {
				parts = append(parts, text)
			}
		}
	}
	return strings.Join(parts, "")
}

// contentBlocksToOpenAI 将 Anthropic content 字段（string 或 block 数组）转换为 OpenAI content 格式。
// 保留多模态结构，用于支持 Vision。
func contentBlocksToOpenAI(content interface{}) interface{} {
	if s, ok := content.(string); ok {
		return s
	}
	if arr, ok := content.([]interface{}); ok {
		var textParts []string
		var imageBlocks []interface{}
		for _, item := range arr {
			block, ok := item.(map[string]interface{})
			if !ok {
				continue
			}
			if block["type"] == "text" {
				if text, ok := block["text"].(string); ok {
					textParts = append(textParts, text)
				}
			} else if block["type"] == "image" {
				// 收集 image block 供统一转换
				imageBlocks = append(imageBlocks, block)
			}
		}

		// 构建 OpenAI content block 数组
		var openAIContent []interface{}
		if textPartsStr := strings.Join(textParts, ""); textPartsStr != "" {
			openAIContent = append(openAIContent, map[string]interface{}{
				"type": "text",
				"text": textPartsStr,
			})
		}

		// 转换 image blocks
		for _, imgBlock := range imageBlocks {
			source, ok := imgBlock.(map[string]interface{})["source"].(map[string]interface{})
			if !ok {
				continue
			}
			sourceType, _ := source["type"].(string)
			if sourceType == "base64" {
				mediaType, _ := source["media_type"].(string)
				data, _ := source["data"].(string)
				if data != "" {
					openAIContent = append(openAIContent, map[string]interface{}{
						"type": "image_url",
						"image_url": map[string]interface{}{
							"url":    "data:" + mediaType + ";base64," + data,
							"detail": "auto",
						},
					})
				}
			} else if sourceType == "url" {
				url, _ := source["url"].(string)
				if url != "" {
					openAIContent = append(openAIContent, map[string]interface{}{
						"type": "image_url",
						"image_url": map[string]interface{}{
							"url":    url,
							"detail": "auto",
						},
					})
				}
			}
		}

		if len(openAIContent) == 0 {
			return ""
		}
		if len(openAIContent) == 1 {
			// 只有一个文本块，退化为字符串
			if t, ok := openAIContent[0].(map[string]interface{}); ok {
				if t["type"] == "text" {
					return t["text"]
				}
			}
		}
		return openAIContent
	}
	return fmt.Sprintf("%v", content)
}

// extractPartsWithImages 从 Gemini 的 parts 数组中提取文本和图片（inlineData）。
// 返回 text 和 inlineData 列表。
func extractPartsWithImages(parts interface{}) (text string, inlineData []map[string]interface{}) {
	arr, ok := parts.([]interface{})
	if !ok {
		return "", nil
	}
	var texts []string
	for _, p := range arr {
		part, ok := p.(map[string]interface{})
		if !ok {
			continue
		}
		if t, ok := part["text"].(string); ok {
			texts = append(texts, t)
		}
		if img, ok := part["inlineData"].(map[string]interface{}); ok {
			dataLen := 0
			if d, ok := img["data"].(string); ok {
				dataLen = len(d)
			}
			slog.Debug("extractPartsWithImages: 提取到图片",
				"mimeType", img["mimeType"],
				"dataLen", dataLen,
			)
			inlineData = append(inlineData, img)
		}
	}
	slog.Debug("extractPartsWithImages: 提取完成",
		"textLen", len(strings.Join(texts, "")),
		"imageCount", len(inlineData),
	)
	return strings.Join(texts, ""), inlineData
}

// buildOpenAIMessageWithImages 构建带文本和图片的 OpenAI 消息。
// 如果只有文本，返回简单的 string content；如果有图片，返回 content block 数组。
func buildOpenAIMessageWithImages(role, text string, imgParts []map[string]interface{}) map[string]interface{} {
	if len(imgParts) == 0 {
		return map[string]interface{}{
			"role":    role,
			"content": text,
		}
	}
	var contentBlocks []interface{}
	if text != "" {
		contentBlocks = append(contentBlocks, map[string]interface{}{
			"type": "text",
			"text": text,
		})
	}
	for _, img := range imgParts {
		mimeType, _ := img["mimeType"].(string)
		data, _ := img["data"].(string)
		slog.Debug("buildOpenAIMessageWithImages: 处理图片",
			"role", role,
			"mimeType", mimeType,
			"dataLen", len(data),
		)
		contentBlocks = append(contentBlocks, map[string]interface{}{
			"type": "image_url",
			"image_url": map[string]interface{}{
				"url":    "data:" + mimeType + ";base64," + data,
				"detail": "auto",
			},
		})
	}
	return map[string]interface{}{
		"role":    role,
		"content": contentBlocks,
	}
}

// copyIfExists 如果 src 中存在 key，则复制到 dst。
func copyIfExists(src, dst map[string]interface{}, key string) {
	if v, ok := src[key]; ok {
		dst[key] = v
	}
}

// getBool 安全获取 bool 值。
func getBool(m map[string]interface{}, key string) bool {
	v, _ := m[key].(bool)
	return v
}
