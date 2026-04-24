package service

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"git.woa.com/wisp/mono/ai-gateway/internal/model"
	"github.com/google/uuid"
)

type ProviderModelDiscoveryInput struct {
	ProviderID             uuid.UUID
	ModelDiscoveryProtocol string
	BaseURL                string
	APIKey                 string
	HealthCheckURL         string
}

type ProviderModelDiscoveryResult struct {
	OK              bool     `json:"ok"`
	Message         string   `json:"message"`
	Endpoint        string   `json:"endpoint"`
	Models          []string `json:"models"`
	RawCount        int      `json:"raw_count"`
	NormalizedCount int      `json:"normalized_count"`
	StatusCode      int      `json:"status_code,omitempty"`
	ErrorType       string   `json:"error_type,omitempty"`
	ResponseExcerpt string   `json:"response_excerpt,omitempty"`
	UsedSavedAPIKey bool     `json:"used_saved_api_key"`
}

type ProviderModelRequestValidationInput struct {
	ProviderID             uuid.UUID
	ModelDiscoveryProtocol string
	BaseURL                string
	APIKey                 string
	Model                  string
}

type ProviderModelRequestValidationResult struct {
	OK              bool   `json:"ok"`
	Message         string `json:"message"`
	Endpoint        string `json:"endpoint"`
	Model           string `json:"model"`
	StatusCode      int    `json:"status_code,omitempty"`
	LatencyMs       int64  `json:"latency_ms"`
	ErrorType       string `json:"error_type,omitempty"`
	ResponseExcerpt string `json:"response_excerpt,omitempty"`
	UsedSavedAPIKey bool   `json:"used_saved_api_key"`
}

type resolvedProviderAccessInput struct {
	Protocol        string
	BaseURL         string
	APIKey          string
	HealthCheckURL  string
	UsedSavedAPIKey bool
}

func (s *ProviderService) DiscoverModels(ctx context.Context, input ProviderModelDiscoveryInput) (*ProviderModelDiscoveryResult, error) {
	resolved, err := s.resolveProviderAccessInput(input.ProviderID, input.ModelDiscoveryProtocol, input.BaseURL, input.APIKey, input.HealthCheckURL)
	if err != nil {
		return nil, err
	}

	if resolved.Protocol == model.ModelDiscoveryProtocolAnthropic {
		return &ProviderModelDiscoveryResult{
			OK:              false,
			Message:         "Anthropic 当前不支持自动发现模型，请手动补充模型名称",
			UsedSavedAPIKey: resolved.UsedSavedAPIKey,
		}, nil
	}

	targets, err := buildModelDiscoveryTargets(resolved.Protocol, resolved.BaseURL, resolved.HealthCheckURL)
	if err != nil {
		return nil, err
	}

	var lastResult *ProviderModelDiscoveryResult
	for i, endpoint := range targets {
		result, allowFallback := s.discoverModelsFromTarget(ctx, resolved, endpoint)
		lastResult = result
		if result.OK || !allowFallback || i == len(targets)-1 {
			return result, nil
		}
	}

	if lastResult != nil {
		return lastResult, nil
	}
	return nil, fmt.Errorf("no discovery endpoint available")
}

func (s *ProviderService) ValidateModelRequest(ctx context.Context, input ProviderModelRequestValidationInput) (*ProviderModelRequestValidationResult, error) {
	resolved, err := s.resolveProviderAccessInput(input.ProviderID, input.ModelDiscoveryProtocol, input.BaseURL, input.APIKey, "")
	if err != nil {
		return nil, err
	}

	modelName := strings.TrimSpace(input.Model)
	if modelName == "" {
		return nil, fmt.Errorf("model is required")
	}

	endpoint, requestBody, err := buildModelRequestValidationPayload(resolved.Protocol, resolved.BaseURL, modelName)
	if err != nil {
		return nil, err
	}

	start := time.Now()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(requestBody))
	if err != nil {
		return &ProviderModelRequestValidationResult{
			OK:              false,
			Message:         "创建模型调用验证请求失败: " + err.Error(),
			Endpoint:        endpoint,
			Model:           modelName,
			LatencyMs:       time.Since(start).Milliseconds(),
			ErrorType:       "request",
			UsedSavedAPIKey: resolved.UsedSavedAPIKey,
		}, nil
	}

	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "ai-gateway-provider-validator/1.0")
	applyProtocolAuth(req, resolved.Protocol, resolved.APIKey)

	resp, err := s.httpClient.Do(req)
	elapsed := time.Since(start).Milliseconds()
	if err != nil {
		return &ProviderModelRequestValidationResult{
			OK:              false,
			Message:         "模型调用验证失败: " + err.Error(),
			Endpoint:        endpoint,
			Model:           modelName,
			LatencyMs:       elapsed,
			ErrorType:       "network",
			UsedSavedAPIKey: resolved.UsedSavedAPIKey,
		}, nil
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
	excerpt := compactValidationBody(string(body))
	result := &ProviderModelRequestValidationResult{
		OK:              resp.StatusCode >= http.StatusOK && resp.StatusCode < http.StatusMultipleChoices,
		Message:         modelRequestValidationMessage(resp.StatusCode),
		Endpoint:        endpoint,
		Model:           modelName,
		StatusCode:      resp.StatusCode,
		LatencyMs:       elapsed,
		UsedSavedAPIKey: resolved.UsedSavedAPIKey,
	}
	if excerpt != "" {
		result.ResponseExcerpt = excerpt
	}
	if !result.OK {
		result.ErrorType = classifyValidationError(resp.StatusCode)
	}
	return result, nil
}

func (s *ProviderService) resolveProviderAccessInput(providerID uuid.UUID, protocol string, baseURL string, apiKey string, healthCheckURL string) (*resolvedProviderAccessInput, error) {
	resolved := &resolvedProviderAccessInput{
		Protocol:       strings.TrimSpace(protocol),
		BaseURL:        strings.TrimSpace(baseURL),
		APIKey:         strings.TrimSpace(apiKey),
		HealthCheckURL: strings.TrimSpace(healthCheckURL),
	}

	if providerID != uuid.Nil {
		provider, err := s.provRepo.GetByID(providerID)
		if err != nil {
			return nil, err
		}

		if resolved.Protocol == "" {
			resolved.Protocol = strings.TrimSpace(provider.ModelDiscoveryProtocol)
			if resolved.Protocol == "" {
				resolved.Protocol = defaultModelDiscoveryProtocol(provider.ProviderType)
			}
		}
		if resolved.BaseURL == "" {
			resolved.BaseURL = strings.TrimSpace(provider.BaseURL)
		}
		if resolved.HealthCheckURL == "" {
			resolved.HealthCheckURL = strings.TrimSpace(provider.HealthCheckURL)
		}
		if resolved.APIKey == "" {
			decryptedKey, err := s.DecryptProviderKey(provider)
			if err != nil {
				return nil, fmt.Errorf("decrypt provider api key: %w", err)
			}
			resolved.APIKey = decryptedKey
			resolved.UsedSavedAPIKey = true
		}
	}

	if resolved.Protocol == "" {
		return nil, fmt.Errorf("model_discovery_protocol is required")
	}
	if !isValidModelDiscoveryProtocol(resolved.Protocol) {
		return nil, fmt.Errorf("invalid model_discovery_protocol: must be one of openai_compatible, anthropic, gemini")
	}
	if resolved.BaseURL == "" {
		return nil, fmt.Errorf("base_url is required")
	}
	if resolved.APIKey == "" {
		return nil, fmt.Errorf("api_key is required")
	}
	return resolved, nil
}

func buildModelDiscoveryTargets(protocol string, baseURL string, healthCheckURL string) ([]string, error) {
	switch protocol {
	case model.ModelDiscoveryProtocolOpenAICompatible:
		return buildValidationTargets(baseURL, healthCheckURL)
	case model.ModelDiscoveryProtocolGemini:
		target, err := buildGeminiModelsEndpoint(baseURL)
		if err != nil {
			return nil, err
		}
		return []string{target}, nil
	default:
		return nil, fmt.Errorf("unsupported discovery protocol %q", protocol)
	}
}

func (s *ProviderService) discoverModelsFromTarget(ctx context.Context, resolved *resolvedProviderAccessInput, endpoint string) (*ProviderModelDiscoveryResult, bool) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return &ProviderModelDiscoveryResult{
			OK:              false,
			Message:         "创建模型发现请求失败: " + err.Error(),
			Endpoint:        endpoint,
			ErrorType:       "request",
			UsedSavedAPIKey: resolved.UsedSavedAPIKey,
		}, false
	}

	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "ai-gateway-provider-validator/1.0")
	applyProtocolAuth(req, resolved.Protocol, resolved.APIKey)

	resp, err := s.httpClient.Do(req)
	if err != nil {
		return &ProviderModelDiscoveryResult{
			OK:              false,
			Message:         "模型发现失败: " + err.Error(),
			Endpoint:        endpoint,
			ErrorType:       "network",
			UsedSavedAPIKey: resolved.UsedSavedAPIKey,
		}, false
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	excerpt := compactValidationBody(string(body))
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		result := &ProviderModelDiscoveryResult{
			OK:              false,
			Message:         discoveryMessage(resp.StatusCode),
			Endpoint:        endpoint,
			StatusCode:      resp.StatusCode,
			ErrorType:       classifyValidationError(resp.StatusCode),
			UsedSavedAPIKey: resolved.UsedSavedAPIKey,
		}
		if excerpt != "" {
			result.ResponseExcerpt = excerpt
		}
		return result, resp.StatusCode == http.StatusNotFound && resolved.Protocol == model.ModelDiscoveryProtocolOpenAICompatible
	}

	models, rawCount, err := parseDiscoveredModels(resolved.Protocol, body)
	if err != nil {
		return &ProviderModelDiscoveryResult{
			OK:              false,
			Message:         "模型发现失败：无法解析上游模型列表",
			Endpoint:        endpoint,
			StatusCode:      resp.StatusCode,
			ErrorType:       "parse",
			ResponseExcerpt: excerpt,
			UsedSavedAPIKey: resolved.UsedSavedAPIKey,
		}, false
	}
	if len(models) == 0 {
		return &ProviderModelDiscoveryResult{
			OK:              false,
			Message:         "模型发现未返回可用模型，请手动补充模型名称",
			Endpoint:        endpoint,
			StatusCode:      resp.StatusCode,
			RawCount:        rawCount,
			UsedSavedAPIKey: resolved.UsedSavedAPIKey,
		}, false
	}

	return &ProviderModelDiscoveryResult{
		OK:              true,
		Message:         fmt.Sprintf("发现 %d 个可选模型", len(models)),
		Endpoint:        endpoint,
		Models:          models,
		RawCount:        rawCount,
		NormalizedCount: len(models),
		StatusCode:      resp.StatusCode,
		UsedSavedAPIKey: resolved.UsedSavedAPIKey,
	}, false
}

func parseDiscoveredModels(protocol string, body []byte) ([]string, int, error) {
	switch protocol {
	case model.ModelDiscoveryProtocolOpenAICompatible:
		var payload struct {
			Data []struct {
				ID string `json:"id"`
			} `json:"data"`
		}
		if err := json.Unmarshal(body, &payload); err != nil {
			return nil, 0, err
		}
		raw := make([]string, 0, len(payload.Data))
		for _, item := range payload.Data {
			raw = append(raw, item.ID)
		}
		return normalizeDiscoveredModels(raw), len(raw), nil
	case model.ModelDiscoveryProtocolGemini:
		var payload struct {
			Models []struct {
				Name string `json:"name"`
			} `json:"models"`
		}
		if err := json.Unmarshal(body, &payload); err != nil {
			return nil, 0, err
		}
		raw := make([]string, 0, len(payload.Models))
		for _, item := range payload.Models {
			raw = append(raw, strings.TrimPrefix(item.Name, "models/"))
		}
		return normalizeDiscoveredModels(raw), len(raw), nil
	default:
		return nil, 0, fmt.Errorf("unsupported discovery protocol %q", protocol)
	}
}

func normalizeDiscoveredModels(items []string) []string {
	seen := make(map[string]struct{}, len(items))
	models := make([]string, 0, len(items))
	for _, item := range items {
		name := strings.TrimSpace(item)
		if name == "" {
			continue
		}
		key := strings.ToLower(name)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		models = append(models, name)
	}
	return models
}

func buildModelRequestValidationPayload(protocol string, baseURL string, modelName string) (string, []byte, error) {
	switch protocol {
	case model.ModelDiscoveryProtocolOpenAICompatible:
		endpoint, err := appendEndpointPath(baseURL, "/v1/chat/completions", "/chat/completions")
		if err != nil {
			return "", nil, err
		}
		body, err := json.Marshal(map[string]interface{}{
			"model": modelName,
			"messages": []map[string]string{
				{"role": "user", "content": "ping"},
			},
			"max_tokens": 1,
		})
		return endpoint, body, err
	case model.ModelDiscoveryProtocolAnthropic:
		endpoint, err := appendEndpointPath(baseURL, "/v1/messages", "/messages")
		if err != nil {
			return "", nil, err
		}
		body, err := json.Marshal(map[string]interface{}{
			"model":      modelName,
			"max_tokens": 1,
			"messages": []map[string]string{
				{"role": "user", "content": "ping"},
			},
		})
		return endpoint, body, err
	case model.ModelDiscoveryProtocolGemini:
		endpoint, err := buildGeminiGenerateContentEndpoint(baseURL, modelName)
		if err != nil {
			return "", nil, err
		}
		body, err := json.Marshal(map[string]interface{}{
			"contents": []map[string]interface{}{
				{
					"parts": []map[string]string{
						{"text": "ping"},
					},
				},
			},
			"generationConfig": map[string]int{
				"maxOutputTokens": 1,
			},
		})
		return endpoint, body, err
	default:
		return "", nil, fmt.Errorf("unsupported model_discovery_protocol %q", protocol)
	}
}

func appendEndpointPath(baseURL string, emptyPathDefault string, suffix string) (string, error) {
	base, err := normalizeValidationURL(baseURL)
	if err != nil {
		return "", fmt.Errorf("invalid base_url: %w", err)
	}
	u, err := url.Parse(base)
	if err != nil {
		return "", fmt.Errorf("parse base_url: %w", err)
	}
	path := strings.TrimRight(u.Path, "/")
	switch {
	case path == "":
		u.Path = emptyPathDefault
	case strings.HasSuffix(path, suffix):
		u.Path = path
	default:
		u.Path = path + suffix
	}
	return u.String(), nil
}

func buildGeminiModelsEndpoint(baseURL string) (string, error) {
	return appendEndpointPath(baseURL, "/v1beta/models", "/models")
}

func buildGeminiGenerateContentEndpoint(baseURL string, modelName string) (string, error) {
	base, err := appendEndpointPath(baseURL, "/v1beta/models", "/models")
	if err != nil {
		return "", err
	}
	u, err := url.Parse(base)
	if err != nil {
		return "", fmt.Errorf("parse gemini base_url: %w", err)
	}
	normalizedModel := strings.TrimPrefix(strings.TrimSpace(modelName), "models/")
	u.Path = strings.TrimRight(u.Path, "/") + "/" + normalizedModel + ":generateContent"
	return u.String(), nil
}

func applyProtocolAuth(req *http.Request, protocol string, apiKey string) {
	switch protocol {
	case model.ModelDiscoveryProtocolAnthropic:
		req.Header.Set("x-api-key", apiKey)
		req.Header.Set("anthropic-version", anthropicValidationVersion)
	case model.ModelDiscoveryProtocolGemini:
		q := req.URL.Query()
		q.Set("key", apiKey)
		req.URL.RawQuery = q.Encode()
	default:
		req.Header.Set("Authorization", "Bearer "+apiKey)
	}
}

func isValidModelDiscoveryProtocol(protocol string) bool {
	switch protocol {
	case model.ModelDiscoveryProtocolOpenAICompatible, model.ModelDiscoveryProtocolAnthropic, model.ModelDiscoveryProtocolGemini:
		return true
	default:
		return false
	}
}

func discoveryMessage(statusCode int) string {
	switch statusCode {
	case http.StatusUnauthorized, http.StatusForbidden:
		return "模型发现失败：API Key 无效或无访问权限"
	case http.StatusNotFound:
		return "模型发现失败：模型列表接口不可用"
	case http.StatusTooManyRequests:
		return "模型发现失败：上游返回限流，请稍后重试"
	default:
		if statusCode >= http.StatusInternalServerError {
			return fmt.Sprintf("模型发现失败：上游服务返回 %d", statusCode)
		}
		return fmt.Sprintf("模型发现失败：上游返回 %d", statusCode)
	}
}

func modelRequestValidationMessage(statusCode int) string {
	switch statusCode {
	case http.StatusOK:
		return "模型调用验证成功"
	case http.StatusUnauthorized, http.StatusForbidden:
		return "模型调用验证失败：API Key 无效或无访问权限"
	case http.StatusNotFound:
		return "模型调用验证失败：模型或接口不存在"
	case http.StatusTooManyRequests:
		return "模型调用验证失败：上游返回限流，请稍后重试"
	default:
		if statusCode >= http.StatusInternalServerError {
			return fmt.Sprintf("模型调用验证失败：上游服务返回 %d", statusCode)
		}
		return fmt.Sprintf("模型调用验证失败：上游返回 %d", statusCode)
	}
}
