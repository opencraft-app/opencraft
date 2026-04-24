package adapter

// APIFormat 表示客户端使用的 API 格式。
type APIFormat string

const (
	FormatOpenAI    APIFormat = "openai"
	FormatAnthropic APIFormat = "anthropic"
	FormatGemini    APIFormat = "gemini"
)

// Context key 常量
const (
	ContextKeyAPIFormat     = "api_format"
	ContextKeyOriginalBody  = "original_request_body"
	ContextKeyAnthropicMeta = "anthropic_meta"
	ContextKeyGeminiModel   = "gemini_model"
	ContextKeyIsStream      = "is_stream"
)

// AnthropicMeta 保存 Anthropic 请求的元数据，用于响应转换。
type AnthropicMeta struct {
	AnthropicVersion string // anthropic-version header 值
	Stream           bool   // 是否流式请求
	OriginalModel    string // 原始模型名
}

// GetAPIFormat 从 gin.Context 获取 API 格式，默认 OpenAI。
func GetAPIFormat(getter func(key string) (interface{}, bool)) APIFormat {
	if v, exists := getter(ContextKeyAPIFormat); exists {
		if f, ok := v.(APIFormat); ok {
			return f
		}
	}
	return FormatOpenAI
}
