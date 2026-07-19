package clients

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"git.woa.com/wisp/mono2/llmgateway/test/regression/framework"
)

const maxHTTPResponseBytes = 4 << 20

type HTTPError struct {
	Method  string
	Path    string
	Status  int
	Message string
}

func (e *HTTPError) Error() string {
	if e.Message == "" {
		return fmt.Sprintf("%s %s returned %d", e.Method, e.Path, e.Status)
	}
	return fmt.Sprintf("%s %s returned %d: %s", e.Method, e.Path, e.Status, e.Message)
}

type JSONClient struct {
	baseURL   string
	token     framework.Secret
	http      *http.Client
	sanitizer *framework.Sanitizer
}

type envelope struct {
	Success bool            `json:"success"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data"`
}

func NewJSONClient(baseURL string, token framework.Secret, client *http.Client, sanitizer *framework.Sanitizer) *JSONClient {
	if client == nil {
		client = &http.Client{Timeout: 90 * time.Second}
	}
	if sanitizer == nil {
		sanitizer = framework.NewSanitizer()
	}
	return &JSONClient{baseURL: strings.TrimRight(baseURL, "/"), token: token, http: client, sanitizer: sanitizer}
}

func (c *JSONClient) Do(ctx context.Context, method, path string, body, out any) error {
	var reader io.Reader
	if body != nil {
		payload, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("encode %s %s request: %w", method, path, err)
		}
		reader = bytes.NewReader(payload)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, reader)
	if err != nil {
		return fmt.Errorf("build %s %s request: %w", method, path, err)
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if !c.token.Empty() {
		req.Header.Set("Authorization", "Bearer "+c.token.Reveal())
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("%s %s request failed: %w", method, path, c.sanitizer.Error(err))
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxHTTPResponseBytes))
	if err != nil {
		return fmt.Errorf("read %s %s response: %w", method, path, err)
	}
	var response envelope
	decodeErr := json.Unmarshal(raw, &response)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		message := http.StatusText(resp.StatusCode)
		if decodeErr == nil && strings.TrimSpace(response.Message) != "" {
			message = c.sanitizer.String(strings.TrimSpace(response.Message))
		}
		return &HTTPError{Method: method, Path: path, Status: resp.StatusCode, Message: message}
	}
	if decodeErr != nil {
		return fmt.Errorf("decode %s %s response: invalid JSON response", method, path)
	}
	if !response.Success {
		return &HTTPError{Method: method, Path: path, Status: resp.StatusCode, Message: c.sanitizer.String(response.Message)}
	}
	if out != nil && len(response.Data) > 0 && string(response.Data) != "null" {
		if err := json.Unmarshal(response.Data, out); err != nil {
			return fmt.Errorf("decode %s %s data: %w", method, path, err)
		}
	}
	return nil
}
