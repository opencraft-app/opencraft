package contentaudit

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

type Config struct {
	Endpoint   string
	ProxyToken string
	HTTPClient HTTPDoer
}

type HTTPDoer interface {
	Do(req *http.Request) (*http.Response, error)
}

type Client struct {
	endpoint   string
	proxyToken string
	httpClient HTTPDoer
}

func New(cfg Config) (*Client, error) {
	endpoint := strings.TrimSpace(cfg.Endpoint)
	if endpoint == "" {
		return nil, errors.New("content audit endpoint is required")
	}
	httpClient := cfg.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 30 * time.Second}
	}
	return &Client{
		endpoint:   strings.TrimRight(endpoint, "/"),
		proxyToken: strings.TrimSpace(cfg.ProxyToken),
		httpClient: httpClient,
	}, nil
}

func (c *Client) CreateTextTask(ctx context.Context, req CreateTextTaskRequest) (*CreateTextTaskResponse, error) {
	payload, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("marshal create text task request: %w", err)
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint+"/risk-control-forge/content/CreateTextTask", bytes.NewReader(payload))
	if err != nil {
		return nil, fmt.Errorf("build create text task request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json; charset=utf-8")
	if c.proxyToken != "" {
		httpReq.Header.Set("X-Proxy-Token", c.proxyToken)
	}

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("send create text task request: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, fmt.Errorf("read create text task response: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("create text task http status=%d body=%s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	var result CreateTextTaskResponse
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, fmt.Errorf("decode create text task response: %w (body=%s)", err, strings.TrimSpace(string(body)))
	}
	if result.Response.Error != nil {
		return &result, fmt.Errorf("create text task error: code=%s message=%s", result.Response.Error.Code, result.Response.Error.Message)
	}
	return &result, nil
}
