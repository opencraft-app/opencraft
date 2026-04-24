package adapter

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"strings"

	"git.woa.com/wisp/mono/ai-gateway/internal/pkg/response"
	"github.com/gin-gonic/gin"
)

// FormatAdapter 检测 API 格式并将非 OpenAI 格式的请求体转换为 OpenAI 格式。
// 转换后的请求体替换 c.Request.Body，下游中间件无感知。
// 同时解析 stream 字段并存入 context，避免 ResponseAdapter 重复读取 body。
func FormatAdapter() gin.HandlerFunc {
	return func(c *gin.Context) {
		format := detectFormat(c)
		c.Set(ContextKeyAPIFormat, format)

		if format == FormatOpenAI {
			c.Next()
			return
		}

		// 读取原始请求体
		body, err := io.ReadAll(c.Request.Body)
		if err != nil || len(body) == 0 {
			response.ErrBadRequest(c, "请求体为空或读取失败")
			return
		}
		c.Set(ContextKeyOriginalBody, body)

		// 从原始 body 解析 stream 字段并存入 context
		var parsedReq struct {
			Stream bool `json:"stream"`
		}
		json.Unmarshal(body, &parsedReq)
		c.Set(ContextKeyIsStream, parsedReq.Stream)

		var convertedBody []byte

		switch format {
		case FormatAnthropic:
			var meta *AnthropicMeta
			convertedBody, meta, err = AnthropicToOpenAI(body)
			if meta != nil {
				meta.AnthropicVersion = c.GetHeader("anthropic-version")
				meta.Stream = parsedReq.Stream
			}
			c.Set(ContextKeyAnthropicMeta, meta)

		case FormatGemini:
			path := c.Param("path")
			modelName, isStream := ParseGeminiPath(path)
			c.Set(ContextKeyGeminiModel, modelName)
			// isStream 从 path 解析（来自 URL），stream flag 存 context
			_ = isStream
			convertedBody, err = GeminiToOpenAI(body, modelName, parsedReq.Stream)
		}

		if err != nil {
			response.ErrBadRequest(c, "格式转换失败: "+err.Error())
			return
		}

		// 调试日志：记录转换后的请求体（包含图片信息）
		slog.Debug("FormatAdapter 转换后的请求体",
			"format", format,
			"originalLen", len(body),
			"convertedLen", len(convertedBody),
		)

		// 替换请求体为 OpenAI 格式
		c.Request.Body = io.NopCloser(bytes.NewReader(convertedBody))
		c.Request.ContentLength = int64(len(convertedBody))

		c.Next()
	}
}

// ResponseAdapter 包装 ResponseWriter，在响应输出时自动将 OpenAI 格式转换回客户端期望的格式。
// 必须在 FormatAdapter 之后注册。
// stream 信息从 context 读取，避免重复读取请求 body。
func ResponseAdapter() gin.HandlerFunc {
	return func(c *gin.Context) {
		formatVal, _ := c.Get(ContextKeyAPIFormat)
		format, _ := formatVal.(APIFormat)

		if format == FormatOpenAI || format == "" {
			c.Next()
			return
		}

		// 直接从 context 获取 stream 信息（由 FormatAdapter 设置）
		isStream := false
		if v, exists := c.Get(ContextKeyIsStream); exists {
			isStream, _ = v.(bool)
		}

		// 获取 Anthropic 元数据
		var meta *AnthropicMeta
		if format == FormatAnthropic {
			if m, exists := c.Get(ContextKeyAnthropicMeta); exists {
				meta, _ = m.(*AnthropicMeta)
			}
		}

		// 包装 ResponseWriter
		writer := NewAdaptedResponseWriter(c.Writer, format, meta, isStream)
		c.Writer = writer

		c.Next()

		// 非流式：响应完成后触发格式转换
		if !isStream {
			writer.Finalize()
		}
	}
}

// detectFormat 根据请求路径判断 API 格式。
func detectFormat(c *gin.Context) APIFormat {
	path := c.Request.URL.Path

	// Anthropic: /v1/messages
	if strings.HasPrefix(path, "/v1/messages") {
		return FormatAnthropic
	}

	// Gemini: /v1beta/models/...
	if strings.HasPrefix(path, "/v1beta/models/") {
		return FormatGemini
	}

	return FormatOpenAI
}
