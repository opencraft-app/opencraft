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
	return c.createTask(ctx, "/risk-control-forge/content/CreateTextTask", "text", req)
}

func (c *Client) CreateImageTask(ctx context.Context, req CreateImageTaskRequest) (*CreateTextTaskResponse, error) {
	return c.createTask(ctx, "/risk-control-forge/content/CreateImageTask", "image", req)
}

func (c *Client) createTask(ctx context.Context, path string, mediaType string, req any) (*CreateTextTaskResponse, error) {
	payload, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("marshal create %s task request: %w", mediaType, err)
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint+path, bytes.NewReader(payload))
	if err != nil {
		return nil, fmt.Errorf("build create %s task request: %w", mediaType, err)
	}
	httpReq.Header.Set("Content-Type", "application/json; charset=utf-8")
	if c.proxyToken != "" {
		httpReq.Header.Set("X-Proxy-Token", c.proxyToken)
	}

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("send create %s task request: %w", mediaType, err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, fmt.Errorf("read create %s task response: %w", mediaType, err)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("create %s task http status=%d body=%s", mediaType, resp.StatusCode, strings.TrimSpace(string(body)))
	}

	var result CreateTextTaskResponse
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, fmt.Errorf("decode create %s task response: %w (body=%s)", mediaType, err, strings.TrimSpace(string(body)))
	}
	if result.Response.Error != nil {
		return &result, fmt.Errorf("create %s task error: code=%s message=%s", mediaType, result.Response.Error.Code, result.Response.Error.Message)
	}
	return &result, nil
}
