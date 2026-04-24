package service

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"git.woa.com/wisp/mono/ai-gateway/internal/model"
	"github.com/google/uuid"
)

const anthropicValidationVersion = "2023-06-01"

type ProviderValidationInput struct {
	ProviderID     uuid.UUID
	ProviderType   string
	BaseURL        string
	APIKey         string
	HealthCheckURL string
}

type ProviderValidationResult struct {
	OK              bool   `json:"ok"`
	Message         string `json:"message"`
	Endpoint        string `json:"endpoint"`
	StatusCode      int    `json:"status_code,omitempty"`
	LatencyMs       int64  `json:"latency_ms"`
	ErrorType       string `json:"error_type,omitempty"`
	ResponseExcerpt string `json:"response_excerpt,omitempty"`
	UsedSavedAPIKey bool   `json:"used_saved_api_key"`
}

func (s *ProviderService) SetHTTPClient(httpClient *http.Client) {
	if httpClient != nil {
		s.httpClient = httpClient
	}
}

func (s *ProviderService) ValidateConnectivity(ctx context.Context, input ProviderValidationInput) (*ProviderValidationResult, error) {
	resolved, err := s.resolveValidationInput(input)
	if err != nil {
		return nil, err
	}

	targets, err := buildValidationTargets(resolved.BaseURL, resolved.HealthCheckURL)
	if err != nil {
		return nil, err
	}

	var lastResult *ProviderValidationResult
	for i, endpoint := range targets {
		result, allowFallback := s.validateTarget(ctx, resolved.ProviderType, resolved.APIKey, endpoint, resolved.UsedSavedAPIKey)
		lastResult = result
		if result.OK || !allowFallback || i == len(targets)-1 {
			return result, nil
		}
	}

	if lastResult != nil {
		return lastResult, nil
	}
	return nil, fmt.Errorf("no validation endpoint available")
}

type resolvedProviderValidationInput struct {
	ProviderType    string
	BaseURL         string
	APIKey          string
	HealthCheckURL  string
	UsedSavedAPIKey bool
}

func (s *ProviderService) resolveValidationInput(input ProviderValidationInput) (*resolvedProviderValidationInput, error) {
	resolved := &resolvedProviderValidationInput{
		ProviderType:   strings.TrimSpace(input.ProviderType),
		BaseURL:        strings.TrimSpace(input.BaseURL),
		APIKey:         strings.TrimSpace(input.APIKey),
		HealthCheckURL: strings.TrimSpace(input.HealthCheckURL),
	}

	if input.ProviderID != uuid.Nil {
		provider, err := s.provRepo.GetByID(input.ProviderID)
		if err != nil {
			return nil, err
		}

		if resolved.ProviderType == "" {
			resolved.ProviderType = provider.ProviderType
		}
		if resolved.BaseURL == "" {
			resolved.BaseURL = provider.BaseURL
		}
		if resolved.HealthCheckURL == "" {
			resolved.HealthCheckURL = provider.HealthCheckURL
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

	if resolved.BaseURL == "" {
		return nil, fmt.Errorf("base_url is required")
	}
	if resolved.APIKey == "" {
		return nil, fmt.Errorf("api_key is required")
	}
	if resolved.ProviderType == "" {
		return nil, fmt.Errorf("provider_type is required")
	}

	return resolved, nil
}

func buildValidationTargets(baseURL string, healthCheckURL string) ([]string, error) {
	if strings.TrimSpace(healthCheckURL) != "" {
		target, err := normalizeValidationURL(healthCheckURL)
		if err != nil {
			return nil, fmt.Errorf("invalid health_check_url: %w", err)
		}
		return []string{target}, nil
	}

	base, err := normalizeValidationURL(baseURL)
	if err != nil {
		return nil, fmt.Errorf("invalid base_url: %w", err)
	}

	u, err := url.Parse(base)
	if err != nil {
		return nil, fmt.Errorf("parse base_url: %w", err)
	}

	path := strings.TrimRight(u.Path, "/")
	switch {
	case path == "":
		return []string{
			appendValidationPath(u, "/v1/models"),
			appendValidationPath(u, "/models"),
		}, nil
	case strings.HasSuffix(path, "/models"):
		return []string{u.String()}, nil
	default:
		return []string{appendValidationPath(u, path+"/models")}, nil
	}
}

func normalizeValidationURL(raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", fmt.Errorf("empty url")
	}
	u, err := url.Parse(trimmed)
	if err != nil {
		return "", err
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", fmt.Errorf("unsupported scheme %q", u.Scheme)
	}
	if u.Host == "" {
		return "", fmt.Errorf("missing host")
	}
	return u.String(), nil
}

func appendValidationPath(base *url.URL, path string) string {
	clone := *base
	clone.Path = path
	return clone.String()
}

func (s *ProviderService) validateTarget(
	ctx context.Context,
	providerType string,
	apiKey string,
	endpoint string,
	usedSavedAPIKey bool,
) (*ProviderValidationResult, bool) {
	start := time.Now()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return &ProviderValidationResult{
			OK:              false,
			Message:         "创建验证请求失败: " + err.Error(),
			Endpoint:        endpoint,
			LatencyMs:       time.Since(start).Milliseconds(),
			ErrorType:       "request",
			UsedSavedAPIKey: usedSavedAPIKey,
		}, false
	}

	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "ai-gateway-provider-validator/1.0")
	if strings.EqualFold(providerType, model.ProviderTypeAnthropic) {
		req.Header.Set("x-api-key", apiKey)
		req.Header.Set("anthropic-version", anthropicValidationVersion)
	} else {
		req.Header.Set("Authorization", "Bearer "+apiKey)
	}

	resp, err := s.httpClient.Do(req)
	elapsed := time.Since(start).Milliseconds()
	if err != nil {
		return &ProviderValidationResult{
			OK:              false,
			Message:         "连接失败: " + err.Error(),
			Endpoint:        endpoint,
			LatencyMs:       elapsed,
			ErrorType:       "network",
			UsedSavedAPIKey: usedSavedAPIKey,
		}, false
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
	excerpt := compactValidationBody(string(body))
	result := &ProviderValidationResult{
		OK:              resp.StatusCode >= http.StatusOK && resp.StatusCode < http.StatusMultipleChoices,
		Message:         validationMessage(resp.StatusCode, excerpt),
		Endpoint:        endpoint,
		StatusCode:      resp.StatusCode,
		LatencyMs:       elapsed,
		UsedSavedAPIKey: usedSavedAPIKey,
	}
	if excerpt != "" {
		result.ResponseExcerpt = excerpt
	}
	if !result.OK {
		result.ErrorType = classifyValidationError(resp.StatusCode)
	}

	return result, resp.StatusCode == http.StatusNotFound
}

func classifyValidationError(statusCode int) string {
	switch statusCode {
	case http.StatusUnauthorized, http.StatusForbidden:
		return "authentication"
	case http.StatusNotFound:
		return "endpoint"
	case http.StatusTooManyRequests:
		return "rate_limit"
	default:
		if statusCode >= http.StatusInternalServerError {
			return "upstream"
		}
		return "http"
	}
}

func validationMessage(statusCode int, excerpt string) string {
	switch statusCode {
	case http.StatusOK:
		return "验证成功，配置可正常访问"
	case http.StatusUnauthorized, http.StatusForbidden:
		return "验证失败：API Key 无效或无访问权限"
	case http.StatusNotFound:
		return "验证失败：访问地址不可用，请检查 base_url 或 health_check_url"
	case http.StatusTooManyRequests:
		return "验证失败：上游返回限流，请稍后重试"
	default:
		if statusCode >= http.StatusInternalServerError {
			return fmt.Sprintf("验证失败：上游服务返回 %d", statusCode)
		}
		if excerpt != "" {
			return fmt.Sprintf("验证失败：上游返回 %d", statusCode)
		}
		return "验证失败：无法访问配置的供应商"
	}
}

func compactValidationBody(body string) string {
	if body == "" {
		return ""
	}
	compacted := strings.Join(strings.Fields(body), " ")
	if len(compacted) > 240 {
		return compacted[:240] + "..."
	}
	return compacted
}
