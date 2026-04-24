package adapter

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

// AdaptedResponseWriter 包装 gin.ResponseWriter，拦截响应并转换格式。
type AdaptedResponseWriter struct {
	gin.ResponseWriter
	format      APIFormat
	meta        *AnthropicMeta // Anthropic 元数据（仅 Anthropic 格式使用）
	buffer      *bytes.Buffer  // 非流式响应缓冲
	isStream    bool
	streamState *streamConvertState
	finalized   bool
}

// WriteError 直接写入错误响应（绕过格式转换），用于流式请求中上游返回非 SSE 错误体。
func (w *AdaptedResponseWriter) WriteError(status int, body []byte) {
	w.ResponseWriter.WriteHeader(status)
	w.ResponseWriter.Write(body)
}

// streamConvertState 流式转换状态机。
type streamConvertState struct {
	sentMessageStart      bool
	sentContentBlockStart bool
	model                 string
	messageID             string
	geminiFirstChunk      bool   // Gemini JSON 数组是否已发送第一个 chunk
	promptTokens          int    // Anthropic 流式：累计 prompt_tokens
	errorBuffer           []byte // 上游返回的非 SSE 错误体（如 400 JSON）
	pendingLine           []byte // 跨 Write 边界缓存未完成的一行
}

// NewAdaptedResponseWriter 创建适配 ResponseWriter。
func NewAdaptedResponseWriter(w gin.ResponseWriter, format APIFormat, meta *AnthropicMeta, isStream bool) *AdaptedResponseWriter {
	return &AdaptedResponseWriter{
		ResponseWriter: w,
		format:         format,
		meta:           meta,
		buffer:         &bytes.Buffer{},
		isStream:       isStream,
		streamState:    &streamConvertState{},
	}
}

func (w *AdaptedResponseWriter) Write(data []byte) (int, error) {
	if w.format == FormatOpenAI {
		return w.ResponseWriter.Write(data)
	}

	if !w.isStream {
		// 非流式：缓冲全部数据
		return w.buffer.Write(data)
	}

	w.consumeStreamBytes(data, false)

	return len(data), nil
}

func (w *AdaptedResponseWriter) consumeStreamBytes(data []byte, flushRemainder bool) {
	state := w.streamState
	if len(state.pendingLine) > 0 {
		data = append(append([]byte{}, state.pendingLine...), data...)
		state.pendingLine = nil
	}

	start := 0
	for i, b := range data {
		if b != '\n' {
			continue
		}
		w.processStreamLine(data[start:i])
		start = i + 1
	}

	if start < len(data) {
		if flushRemainder {
			w.processStreamLine(data[start:])
		} else {
			state.pendingLine = append(state.pendingLine[:0], data[start:]...)
		}
	}
}

func (w *AdaptedResponseWriter) processStreamLine(raw []byte) {
	line := strings.TrimSpace(string(raw))
	if line == "" {
		return
	}
	if !strings.HasPrefix(line, "data: ") {
		w.streamState.errorBuffer = append(w.streamState.errorBuffer, raw...)
		return
	}

	switch w.format {
	case FormatAnthropic:
		w.convertStreamChunkAnthropic(line)
	case FormatGemini:
		w.convertStreamChunkGemini(line)
	}
}

// Finalize 在非流式响应完成后调用，执行格式转换并写入实际响应。
func (w *AdaptedResponseWriter) Finalize() {
	if w.finalized || w.isStream || w.format == FormatOpenAI {
		return
	}
	w.finalized = true

	body := w.buffer.Bytes()
	if len(body) == 0 {
		return
	}

	var converted []byte
	var err error

	switch w.format {
	case FormatAnthropic:
		converted, err = OpenAIToAnthropic(body, "")
	case FormatGemini:
		converted, err = OpenAIToGemini(body)
	}

	if err != nil {
		// 转换失败，返回原始响应
		w.ResponseWriter.Write(body)
		return
	}

	w.ResponseWriter.Header().Set("Content-Type", "application/json")
	w.ResponseWriter.Write(converted)
}

// --- Anthropic 流式转换 ---

func (w *AdaptedResponseWriter) convertStreamChunkAnthropic(line string) {
	data := strings.TrimPrefix(line, "data: ")

	if data == "[DONE]" {
		// 发送 message_stop
		w.writeAnthropicSSE("message_stop", `{"type":"message_stop"}`)
		return
	}

	var chunk struct {
		ID      string `json:"id"`
		Model   string `json:"model"`
		Choices []struct {
			Delta struct {
				Role    string `json:"role"`
				Content string `json:"content"`
			} `json:"delta"`
			FinishReason *string `json:"finish_reason"`
		} `json:"choices"`
		Usage *struct {
			PromptTokens     int `json:"prompt_tokens"`
			CompletionTokens int `json:"completion_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal([]byte(data), &chunk); err != nil {
		return
	}

	state := w.streamState
	if chunk.Model != "" {
		state.model = chunk.Model
	}
	if chunk.ID != "" {
		state.messageID = chunk.ID
	}

	// 提取并累计 prompt_tokens（OpenAI 流式在首个 chunk 中返回）
	if chunk.Usage != nil && chunk.Usage.PromptTokens > 0 {
		state.promptTokens = chunk.Usage.PromptTokens
	}

	// 1. 首次收到 → 发送 message_start
	if !state.sentMessageStart {
		state.sentMessageStart = true

		model := state.model
		if model == "" && w.meta != nil {
			model = w.meta.OriginalModel
		}

		msgID := "msg_" + strings.TrimPrefix(state.messageID, "chatcmpl-")
		if msgID == "msg_" {
			msgID = "msg_unknown"
		}

		msgStart, _ := json.Marshal(map[string]interface{}{
			"type": "message_start",
			"message": map[string]interface{}{
				"id":            msgID,
				"type":          "message",
				"role":          "assistant",
				"content":       []interface{}{},
				"model":         model,
				"stop_reason":   nil,
				"stop_sequence": nil,
				"usage": map[string]interface{}{
					"input_tokens":  0,
					"output_tokens": 0,
				},
			},
		})
		w.writeAnthropicSSE("message_start", string(msgStart))
	}

	if len(chunk.Choices) == 0 {
		return
	}
	choice := chunk.Choices[0]

	// 2. 有内容 → content_block_start（首次）+ content_block_delta
	if choice.Delta.Content != "" {
		if !state.sentContentBlockStart {
			state.sentContentBlockStart = true
			blockStart, _ := json.Marshal(map[string]interface{}{
				"type":  "content_block_start",
				"index": 0,
				"content_block": map[string]interface{}{
					"type": "text",
					"text": "",
				},
			})
			w.writeAnthropicSSE("content_block_start", string(blockStart))
		}

		delta, _ := json.Marshal(map[string]interface{}{
			"type":  "content_block_delta",
			"index": 0,
			"delta": map[string]interface{}{
				"type": "text_delta",
				"text": choice.Delta.Content,
			},
		})
		w.writeAnthropicSSE("content_block_delta", string(delta))
	}

	// 3. finish_reason → content_block_stop + message_delta
	if choice.FinishReason != nil {
		// content_block_stop
		if state.sentContentBlockStart {
			w.writeAnthropicSSE("content_block_stop", `{"type":"content_block_stop","index":0}`)
		}

		// message_delta with usage
		outputTokens := 0
		if chunk.Usage != nil {
			outputTokens = chunk.Usage.CompletionTokens
		}

		msgDelta, _ := json.Marshal(map[string]interface{}{
			"type": "message_delta",
			"delta": map[string]interface{}{
				"stop_reason":   mapFinishReasonToAnthropic(*choice.FinishReason),
				"stop_sequence": nil,
			},
			"usage": map[string]interface{}{
				"input_tokens":  state.promptTokens,
				"output_tokens": outputTokens,
			},
		})
		w.writeAnthropicSSE("message_delta", string(msgDelta))
	}
}

func (w *AdaptedResponseWriter) writeAnthropicSSE(event, data string) {
	w.ResponseWriter.Write([]byte("event: " + event + "\n"))
	w.ResponseWriter.Write([]byte("data: " + data + "\n\n"))
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// --- Gemini 流式转换 ---

func (w *AdaptedResponseWriter) convertStreamChunkGemini(line string) {
	data := strings.TrimPrefix(line, "data: ")

	if data == "[DONE]" {
		// 关闭 JSON 数组
		w.ResponseWriter.Write([]byte("\n]\n"))
		if f, ok := w.ResponseWriter.(http.Flusher); ok {
			f.Flush()
		}
		return
	}

	// 将每个 OpenAI chunk 转换为 Gemini 格式
	geminiChunk, err := openAIChunkToGemini([]byte(data))
	if err != nil {
		return
	}

	state := w.streamState
	if !state.geminiFirstChunk {
		state.geminiFirstChunk = true
		w.ResponseWriter.Write([]byte("[\n"))
	} else {
		w.ResponseWriter.Write([]byte(",\n"))
	}

	w.ResponseWriter.Write(geminiChunk)
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// openAIChunkToGemini 将单个 OpenAI 流式 chunk 转换为 Gemini 格式。
func openAIChunkToGemini(data []byte) ([]byte, error) {
	var chunk struct {
		Choices []struct {
			Delta struct {
				Content string `json:"content"`
			} `json:"delta"`
			FinishReason *string `json:"finish_reason"`
		} `json:"choices"`
		Usage *struct {
			PromptTokens     int `json:"prompt_tokens"`
			CompletionTokens int `json:"completion_tokens"`
			TotalTokens      int `json:"total_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(data, &chunk); err != nil {
		return nil, err
	}

	result := map[string]interface{}{}

	if len(chunk.Choices) > 0 {
		text := chunk.Choices[0].Delta.Content
		finishReason := ""
		if chunk.Choices[0].FinishReason != nil {
			finishReason = mapFinishReasonToGemini(*chunk.Choices[0].FinishReason)
		}

		candidate := map[string]interface{}{
			"content": map[string]interface{}{
				"parts": []map[string]interface{}{{"text": text}},
				"role":  "model",
			},
		}
		if finishReason != "" {
			candidate["finishReason"] = finishReason
		}
		result["candidates"] = []interface{}{candidate}
	}

	if chunk.Usage != nil {
		result["usageMetadata"] = map[string]interface{}{
			"promptTokenCount":     chunk.Usage.PromptTokens,
			"candidatesTokenCount": chunk.Usage.CompletionTokens,
			"totalTokenCount":      chunk.Usage.TotalTokens,
		}
	}

	return json.Marshal(result)
}

// WriteHeaderNow delegates to the underlying writer with format-specific Content-Type.
func (w *AdaptedResponseWriter) WriteHeaderNow() {
	if w.format != FormatOpenAI && w.isStream {
		switch w.format {
		case FormatAnthropic:
			w.ResponseWriter.Header().Set("Content-Type", "text/event-stream")
		case FormatGemini:
			w.ResponseWriter.Header().Set("Content-Type", "application/json")
		}
	}
	w.ResponseWriter.WriteHeaderNow()
}

// WriteString implements io.StringWriter.
func (w *AdaptedResponseWriter) WriteString(s string) (int, error) {
	return w.Write([]byte(s))
}

// Flush implements http.Flusher.
func (w *AdaptedResponseWriter) Flush() {
	if w.isStream && len(w.streamState.pendingLine) > 0 {
		w.consumeStreamBytes(nil, true)
	}
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// CloseNotify implements http.CloseNotifier (deprecated but Gin may use it).
func (w *AdaptedResponseWriter) CloseNotify() <-chan bool {
	if cn, ok := w.ResponseWriter.(http.CloseNotifier); ok {
		return cn.CloseNotify()
	}
	return make(chan bool)
}

// Status returns the HTTP status code.
func (w *AdaptedResponseWriter) Status() int {
	return w.ResponseWriter.Status()
}

// Size returns the number of bytes written.
func (w *AdaptedResponseWriter) Size() int {
	return w.ResponseWriter.Size()
}

// Written returns whether the header has been written.
func (w *AdaptedResponseWriter) Written() bool {
	return w.ResponseWriter.Written()
}

// Pusher implements http.Pusher.
func (w *AdaptedResponseWriter) Pusher() http.Pusher {
	if p, ok := w.ResponseWriter.(http.Pusher); ok {
		return p
	}
	return nil
}

// Hijack implements http.Hijacker.
func (w *AdaptedResponseWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	if hj, ok := w.ResponseWriter.(http.Hijacker); ok {
		return hj.Hijack()
	}
	return nil, nil, fmt.Errorf("hijack not supported")
}
