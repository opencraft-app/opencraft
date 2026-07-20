package clients

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"strings"
	"time"

	"git.woa.com/wisp/mono2/llmgateway/test/regression/framework"
)

type TrafficClient struct {
	http      *http.Client
	sanitizer *framework.Sanitizer
	now       func() time.Time
}

type ChatResult struct {
	StatusCode  int           `json:"status_code"`
	Duration    time.Duration `json:"duration"`
	MarkerFound bool          `json:"marker_found"`
}

type StreamEvent struct {
	At       time.Time
	Payload  json.RawMessage
	SourceIP string
	Done     bool
}

type StreamResult struct {
	StatusCode   int           `json:"status_code"`
	StartedAt    time.Time     `json:"started_at"`
	FirstEventAt time.Time     `json:"first_event_at"`
	FinishedAt   time.Time     `json:"finished_at"`
	Duration     time.Duration `json:"duration"`
	RequestCount int           `json:"request_count"`
	EventCount   int           `json:"event_count"`
	MarkerFound  bool          `json:"marker_found"`
	Done         bool          `json:"done"`
}

func NewTrafficClient(client *http.Client, sanitizer *framework.Sanitizer) *TrafficClient {
	if client == nil {
		client = &http.Client{}
	}
	if sanitizer == nil {
		sanitizer = framework.NewSanitizer()
	}
	return &TrafficClient{http: client, sanitizer: sanitizer, now: func() time.Time { return time.Now().UTC() }}
}

func (c *TrafficClient) Chat(ctx context.Context, baseURL string, key framework.Secret, model, marker string) (ChatResult, error) {
	started := c.now()
	req, err := c.chatRequest(ctx, baseURL, key, model, false)
	if err != nil {
		return ChatResult{}, err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return ChatResult{}, fmt.Errorf("chat request failed: %w", c.sanitizer.Error(err))
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxHTTPResponseBytes))
	if err != nil {
		return ChatResult{}, err
	}
	result := ChatResult{StatusCode: resp.StatusCode, Duration: c.now().Sub(started)}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return result, &HTTPError{Method: http.MethodPost, Path: "/v1/chat/completions", Status: resp.StatusCode, Message: http.StatusText(resp.StatusCode)}
	}
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		return result, errorsWithoutBody("decode chat response")
	}
	result.MarkerFound = strings.Contains(string(raw), marker)
	if !result.MarkerFound {
		return result, fmt.Errorf("chat response did not contain expected marker")
	}
	return result, nil
}

func (c *TrafficClient) Stream(ctx context.Context, baseURL string, key framework.Secret, model, marker string, onEvent func(StreamEvent)) (StreamResult, error) {
	result := StreamResult{StartedAt: c.now(), RequestCount: 1}
	req, err := c.chatRequest(ctx, baseURL, key, model, true)
	if err != nil {
		return result, err
	}
	req.Header.Set("Accept", "text/event-stream")
	resp, err := c.http.Do(req)
	if err != nil {
		return result, fmt.Errorf("stream request failed: %w", c.sanitizer.Error(err))
	}
	defer resp.Body.Close()
	result.StatusCode = resp.StatusCode
	if resp.StatusCode != http.StatusOK {
		return result, &HTTPError{Method: http.MethodPost, Path: "/v1/chat/completions", Status: resp.StatusCode, Message: http.StatusText(resp.StatusCode)}
	}
	mediaType, _, err := mime.ParseMediaType(resp.Header.Get("Content-Type"))
	if err != nil || mediaType != "text/event-stream" {
		return result, fmt.Errorf("stream response content type is not text/event-stream")
	}
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 64*1024), 2<<20)
	seenDone := false
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "" {
			continue
		}
		if seenDone {
			return result, fmt.Errorf("stream contained data after [DONE]")
		}
		if data == "[DONE]" {
			seenDone = true
			result.Done = true
			if onEvent != nil {
				onEvent(StreamEvent{At: c.now(), Done: true})
			}
			continue
		}
		var payload json.RawMessage
		if err := json.Unmarshal([]byte(data), &payload); err != nil {
			return result, fmt.Errorf("stream data payload is not valid JSON")
		}
		now := c.now()
		if result.FirstEventAt.IsZero() {
			result.FirstEventAt = now
		}
		result.EventCount++
		if strings.Contains(data, marker) {
			result.MarkerFound = true
		}
		if onEvent != nil {
			onEvent(StreamEvent{At: now, Payload: payload, SourceIP: regressionSourceIP(payload)})
		}
	}
	if err := scanner.Err(); err != nil {
		return result, fmt.Errorf("read stream: %w", c.sanitizer.Error(err))
	}
	result.FinishedAt = c.now()
	result.Duration = result.FinishedAt.Sub(result.StartedAt)
	if !result.Done {
		return result, fmt.Errorf("stream ended without [DONE]")
	}
	if !result.MarkerFound {
		return result, fmt.Errorf("stream response did not contain expected marker")
	}
	return result, nil
}

func regressionSourceIP(payload []byte) string {
	var event struct {
		Choices []struct {
			Delta struct {
				Content string `json:"content"`
			} `json:"delta"`
		} `json:"choices"`
	}
	if json.Unmarshal(payload, &event) != nil || len(event.Choices) == 0 {
		return ""
	}
	const prefix = "llmgateway-regression-source-ip="
	content := strings.TrimSpace(event.Choices[0].Delta.Content)
	if !strings.HasPrefix(content, prefix) {
		return ""
	}
	candidate := strings.TrimPrefix(content, prefix)
	if net.ParseIP(candidate) == nil {
		return ""
	}
	return candidate
}

func (c *TrafficClient) chatRequest(ctx context.Context, baseURL string, key framework.Secret, model string, stream bool) (*http.Request, error) {
	body := map[string]any{
		"model": model, "stream": stream,
		"messages": []map[string]string{{"role": "user", "content": "reply with regression-marker"}},
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(baseURL, "/")+"/v1/chat/completions", bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+key.Reveal())
	return req, nil
}

func errorsWithoutBody(operation string) error {
	return fmt.Errorf("%s: invalid JSON response", operation)
}
