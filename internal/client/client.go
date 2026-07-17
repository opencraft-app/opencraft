package client

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const maxResponseBytes = 16 << 20

type Client struct {
	config Config
	http   *http.Client
}

func New(config Config) (*Client, error) {
	if config.Timeout <= 0 {
		config.Timeout = 30 * time.Second
	}
	for name, raw := range map[string]string{"control URL": config.ControlURL, "traffic URL": config.TrafficURL} {
		if strings.TrimSpace(raw) == "" {
			continue
		}
		parsed, err := url.ParseRequestURI(strings.TrimRight(raw, "/"))
		if err != nil || parsed.Scheme == "" || parsed.Host == "" {
			return nil, fmt.Errorf("invalid %s %q", name, raw)
		}
	}
	httpClient := config.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{Timeout: config.Timeout}
	} else if httpClient.Timeout == 0 {
		copied := *httpClient
		copied.Timeout = config.Timeout
		httpClient = &copied
	}
	return &Client{config: config, http: httpClient}, nil
}

func (c *Client) WithAPIKey(apiKey string) *Client {
	copy := *c
	copy.config.APIKey = strings.TrimSpace(apiKey)
	return &copy
}

func (c *Client) doJSON(ctx context.Context, lane AuthLane, method string, path string, input any) (result Result, err error) {
	start := time.Now()
	result.Request = RequestSummary{Lane: lane, Method: method, Path: path}
	defer func() {
		if c.config.Trace != nil {
			c.config.Trace(Trace{Lane: lane, Method: method, Path: path, StatusCode: result.StatusCode, Duration: time.Since(start), DryRun: result.DryRun, Err: err})
		}
	}()

	baseURL, token, err := c.credentials(lane)
	if err != nil {
		return result, err
	}
	if c.config.DryRun {
		result.DryRun = true
		return result, nil
	}

	var body io.Reader
	if input != nil {
		raw, marshalErr := json.Marshal(input)
		if marshalErr != nil {
			return result, fmt.Errorf("encode request: %w", marshalErr)
		}
		body = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(baseURL, "/")+path, body)
	if err != nil {
		return result, fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	if input != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return result, fmt.Errorf("%s %s: %w", method, path, err)
	}
	defer resp.Body.Close()
	result.StatusCode = resp.StatusCode
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes+1))
	if err != nil {
		return result, fmt.Errorf("read response: %w", err)
	}
	if len(raw) > maxResponseBytes {
		return result, fmt.Errorf("%s %s response exceeds %d bytes", method, path, maxResponseBytes)
	}
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		return result, decodeAPIError(resp.StatusCode, method, path, raw)
	}
	result.Data = append(json.RawMessage(nil), raw...)
	if lane == AuthInternal || lane == AuthAdmin {
		result.Data = unwrapData(raw)
	}
	return result, nil
}

func (c *Client) credentials(lane AuthLane) (string, string, error) {
	var baseURL string
	var token string
	switch lane {
	case AuthInternal:
		baseURL, token = c.config.ControlURL, c.config.InternalToken
	case AuthAdmin:
		baseURL, token = c.config.ControlURL, c.config.AdminToken
	case AuthTraffic:
		baseURL, token = c.config.TrafficURL, c.config.APIKey
	default:
		return "", "", fmt.Errorf("unknown authentication lane %q", lane)
	}
	if strings.TrimSpace(baseURL) == "" {
		return "", "", fmt.Errorf("%s URL is required", lane)
	}
	if strings.TrimSpace(token) == "" {
		return "", "", fmt.Errorf("%s token is required", lane)
	}
	return baseURL, token, nil
}

func unwrapData(raw []byte) json.RawMessage {
	if len(bytes.TrimSpace(raw)) == 0 {
		return json.RawMessage("null")
	}
	var envelope struct {
		Data json.RawMessage `json:"data"`
	}
	if json.Unmarshal(raw, &envelope) == nil && len(envelope.Data) > 0 {
		return envelope.Data
	}
	return append(json.RawMessage(nil), raw...)
}

func decodeAPIError(status int, method string, path string, raw []byte) error {
	payload := struct {
		Message string `json:"message"`
		Error   struct {
			Message string `json:"message"`
			Code    string `json:"code"`
		} `json:"error"`
	}{}
	_ = json.Unmarshal(raw, &payload)
	message := strings.TrimSpace(payload.Message)
	if message == "" {
		message = strings.TrimSpace(payload.Error.Message)
	}
	if message == "" {
		message = strings.TrimSpace(string(raw))
	}
	if message == "" {
		message = http.StatusText(status)
	}
	message = strings.Join(strings.Fields(message), " ")
	return &APIError{StatusCode: status, Method: method, Path: path, Message: message, Code: payload.Error.Code}
}

func IsStatus(err error, status int) bool {
	var apiErr *APIError
	return errors.As(err, &apiErr) && apiErr.StatusCode == status
}
