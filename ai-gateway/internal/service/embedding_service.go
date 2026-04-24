package service

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"time"
)

// EmbeddingService 调用提供商 Embedding API，将文本转为向量。
// 独立配置 embedding 提供商，不走 ProviderService。
type EmbeddingService struct {
	httpClient  *http.Client
	configStore *CacheConfigStore
}

// NewEmbeddingService 创建 EmbeddingService。
func NewEmbeddingService(configStore *CacheConfigStore) *EmbeddingService {
	return &EmbeddingService{
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
		configStore: configStore,
	}
}

// embeddingRequest OpenAI Embeddings API 请求格式。
type embeddingRequest struct {
	Model string `json:"model"`
	Input string `json:"input"`
}

// embeddingResponse OpenAI Embeddings API 响应格式。
type embeddingResponse struct {
	Data []struct {
		Embedding []float32 `json:"embedding"`
	} `json:"data"`
	Usage struct {
		PromptTokens int `json:"prompt_tokens"`
		TotalTokens  int `json:"total_tokens"`
	} `json:"usage"`
}

// Embed 将文本转为 embedding 向量。失败返回 error，调用方降级处理。
func (s *EmbeddingService) Embed(ctx context.Context, text string) ([]float32, error) {
	cfg := s.configStore.Get()

	if cfg.EmbeddingBaseURL == "" || cfg.EmbeddingAPIKey == "" {
		return nil, fmt.Errorf("embedding 提供商未配置")
	}

	reqBody := embeddingRequest{
		Model: cfg.EmbeddingModel,
		Input: text,
	}
	bodyBytes, err := json.Marshal(reqBody)
	if err != nil {
		return nil, fmt.Errorf("序列化 embedding 请求失败: %w", err)
	}

	url := fmt.Sprintf("%s/v1/embeddings", cfg.EmbeddingBaseURL)
	req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(bodyBytes))
	if err != nil {
		return nil, fmt.Errorf("创建 embedding 请求失败: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+cfg.EmbeddingAPIKey)

	resp, err := s.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("embedding API 调用失败: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("读取 embedding 响应失败: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		slog.Warn("embedding API 返回错误",
			"status", resp.StatusCode,
			"body", string(respBody),
		)
		return nil, fmt.Errorf("embedding API 返回 %d: %s", resp.StatusCode, string(respBody))
	}

	var embResp embeddingResponse
	if err := json.Unmarshal(respBody, &embResp); err != nil {
		return nil, fmt.Errorf("解析 embedding 响应失败: %w", err)
	}

	if len(embResp.Data) == 0 || len(embResp.Data[0].Embedding) == 0 {
		return nil, fmt.Errorf("embedding 响应中无向量数据")
	}

	slog.Debug("embedding 完成",
		"model", cfg.EmbeddingModel,
		"dimensions", len(embResp.Data[0].Embedding),
		"tokens", embResp.Usage.TotalTokens,
	)

	return embResp.Data[0].Embedding, nil
}
