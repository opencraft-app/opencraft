package middleware

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"

	"git.woa.com/wisp/mono/ai-gateway/internal/service"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

// Context keys for cache data.
const (
	ContextKeyCacheEmbedding  = "cache_embedding"
	ContextKeyCacheContentHash = "cache_content_hash"
	ContextKeyCacheScopeKey   = "cache_scope_key"
	ContextKeyCacheText       = "cache_text"
)

// ResponseCache 语义缓存中间件，仅用于 /v1/chat/completions。
// 检查缓存命中，命中时直接返回缓存响应。
func ResponseCache(cacheSvc *service.CacheService, embeddingSvc *service.EmbeddingService) gin.HandlerFunc {
	return func(c *gin.Context) {
		// 1. 检查缓存开关
		if !cacheSvc.IsEnabled() {
			c.Next()
			return
		}

		cfg := cacheSvc.GetConfig()

		// 2. 从 context 获取 request_body 和 request_model（ModelAuth 已设置）
		bodyRaw, exists := c.Get("request_body")
		if !exists {
			c.Next()
			return
		}
		body := bodyRaw.([]byte)

		modelName, _ := c.Get("request_model")
		if modelName == nil || modelName.(string) == "" {
			c.Next()
			return
		}
		model := modelName.(string)

		// 3. 提取缓存文本：system prompt + 最后一条 user message
		cacheText := service.ExtractCacheText(body)
		if cacheText == "" {
			c.Next()
			return
		}

		// 4. 计算 scope_key
		user := GetUserFromContext(c)
		userID := ""
		if user != nil {
			userID = user.ID.String()
		}
		scopeKey := cacheSvc.GetScopeKey(userID, body)

		// 5. 计算 content_hash
		contentHash := service.ContentHash(model, scopeKey, cacheText)

		// 6. 调用 EmbeddingService 获取向量（失败降级跳过）
		embedding, err := embeddingSvc.Embed(c.Request.Context(), cacheText)
		if err != nil {
			slog.Warn("embedding 调用失败，跳过缓存查询",
				"error", err,
				"model", model,
			)
			cacheSvc.RecordMiss()
			c.Header("X-Cache", "SKIP")
			c.Next()
			return
		}

		// 7. 搜索相似缓存
		cached, similarity, err := cacheSvc.SearchSimilar(
			c.Request.Context(),
			model,
			scopeKey,
			embedding,
			cfg.SimilarityThreshold,
		)
		if err != nil {
			slog.Warn("缓存搜索失败，跳过缓存",
				"error", err,
				"model", model,
			)
			cacheSvc.RecordMiss()
			c.Header("X-Cache", "SKIP")
			// 仍然传递 embedding 以便后续写入
			c.Set(ContextKeyCacheEmbedding, embedding)
			c.Set(ContextKeyCacheContentHash, contentHash)
			c.Set(ContextKeyCacheScopeKey, scopeKey)
			c.Set(ContextKeyCacheText, cacheText)
			c.Next()
			return
		}

		// 8. 命中缓存
		if cached != nil {
			cacheSvc.RecordHit(cached.TotalTokens)

			// 记录 cache usage log（不扣 token）
			go logCacheUsage(c, model, cached)

			// 检查客户端是否请求流式返回
			var reqBody struct {
				Stream bool `json:"stream"`
			}
			json.Unmarshal(body, &reqBody)

			c.Header("X-Cache", "HIT")
			c.Header("X-Cache-Similarity", fmt.Sprintf("%.4f", similarity))
			c.Header("X-Cache-ID", cached.ID.String())

			if reqBody.Stream {
				// 流式返回：将缓存响应转为 SSE 格式
				writeCachedSSEResponse(c, cached)
			} else {
				// 非流式返回
				c.Data(http.StatusOK, "application/json", cached.Response)
			}
			c.Abort()
			return
		}

		// 9. 未命中：传递 embedding 到 context，继续处理
		cacheSvc.RecordMiss()
		c.Header("X-Cache", "MISS")
		c.Set(ContextKeyCacheEmbedding, embedding)
		c.Set(ContextKeyCacheContentHash, contentHash)
		c.Set(ContextKeyCacheScopeKey, scopeKey)
		c.Set(ContextKeyCacheText, cacheText)
		c.Next()
	}
}

// logCacheUsage 记录缓存命中的 usage log（source=cache）。
func logCacheUsage(c *gin.Context, model string, cached *service.CachedResponse) {
	user := GetUserFromContext(c)
	sub := GetSubscriptionFromContext(c)
	if user == nil || sub == nil {
		return
	}

	requestID := ""
	if v, exists := c.Get("request_id"); exists {
		requestID, _ = v.(string)
	}

	slog.Info("cache_hit_usage",
		"user_id", user.ID,
		"subscription_id", sub.ID,
		"model", model,
		"prompt_tokens", cached.PromptTokens,
		"completion_tokens", cached.CompletionTokens,
		"total_tokens", cached.TotalTokens,
		"source", "cache",
		"similarity", cached.Similarity,
		"cache_id", cached.ID,
		"request_id", requestID,
	)
}

// writeCachedSSEResponse 将缓存的非流式响应转为 SSE 格式返回。
func writeCachedSSEResponse(c *gin.Context, cached *service.CachedResponse) {
	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-cache")
	c.Header("Connection", "keep-alive")
	c.Status(http.StatusOK)

	flusher, ok := c.Writer.(http.Flusher)
	if !ok {
		// 降级为非流式
		c.Data(http.StatusOK, "application/json", cached.Response)
		return
	}

	// 解析原始响应
	var resp struct {
		ID      string `json:"id"`
		Object  string `json:"object"`
		Created int64  `json:"created"`
		Model   string `json:"model"`
		Choices []struct {
			Index   int `json:"index"`
			Message struct {
				Role    string `json:"role"`
				Content string `json:"content"`
			} `json:"message"`
			FinishReason string `json:"finish_reason"`
		} `json:"choices"`
		Usage json.RawMessage `json:"usage"`
	}

	if err := json.Unmarshal(cached.Response, &resp); err != nil {
		// 解析失败，直接返回原始响应
		c.Data(http.StatusOK, "application/json", cached.Response)
		return
	}

	chatID := resp.ID
	if chatID == "" {
		chatID = "chatcmpl-cache-" + uuid.New().String()[:8]
	}

	// 发送内容 chunk
	for _, choice := range resp.Choices {
		chunk := map[string]interface{}{
			"id":      chatID,
			"object":  "chat.completion.chunk",
			"created": resp.Created,
			"model":   resp.Model,
			"choices": []map[string]interface{}{
				{
					"index": choice.Index,
					"delta": map[string]interface{}{
						"role":    choice.Message.Role,
						"content": choice.Message.Content,
					},
					"finish_reason": nil,
				},
			},
		}
		data, _ := json.Marshal(chunk)
		c.Writer.Write([]byte("data: " + string(data) + "\n\n"))
		flusher.Flush()
	}

	// 发送完成 chunk（含 usage）
	for i, choice := range resp.Choices {
		finishChunk := map[string]interface{}{
			"id":      chatID,
			"object":  "chat.completion.chunk",
			"created": resp.Created,
			"model":   resp.Model,
			"choices": []map[string]interface{}{
				{
					"index":         i,
					"delta":         map[string]interface{}{},
					"finish_reason": choice.FinishReason,
				},
			},
		}
		// 在最后一个 choice 附带 usage
		if i == len(resp.Choices)-1 && resp.Usage != nil {
			finishChunk["usage"] = json.RawMessage(resp.Usage)
		}
		data, _ := json.Marshal(finishChunk)
		c.Writer.Write([]byte("data: " + string(data) + "\n\n"))
		flusher.Flush()
	}

	// 发送 [DONE]
	c.Writer.Write([]byte("data: [DONE]\n\n"))
	flusher.Flush()
}

// GetCacheEmbedding 从 context 获取 embedding（用于 proxy handler 写缓存）。
func GetCacheEmbedding(c *gin.Context) []float32 {
	v, exists := c.Get(ContextKeyCacheEmbedding)
	if !exists {
		return nil
	}
	emb, _ := v.([]float32)
	return emb
}

// GetCacheContentHash 从 context 获取 content_hash。
func GetCacheContentHash(c *gin.Context) string {
	v, _ := c.Get(ContextKeyCacheContentHash)
	s, _ := v.(string)
	return s
}

// GetCacheScopeKey 从 context 获取 scope_key。
func GetCacheScopeKey(c *gin.Context) string {
	v, _ := c.Get(ContextKeyCacheScopeKey)
	s, _ := v.(string)
	return s
}
