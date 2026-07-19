package pacer

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

type FaultPolicy struct {
	Enabled    bool   `json:"enabled"`
	Model      string `json:"model,omitempty"`
	StatusCode int    `json:"status_code,omitempty"`
	Message    string `json:"message,omitempty"`
}

type faultState struct {
	mu     sync.RWMutex
	policy FaultPolicy
}

func (s *faultState) get() FaultPolicy {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.policy
}

func (s *faultState) set(policy FaultPolicy) {
	s.mu.Lock()
	s.policy = policy
	s.mu.Unlock()
}

func NewHandler(upstreamBaseURL string, streamDuration time.Duration, longStreamModel string, client *http.Client) (http.Handler, error) {
	return NewHandlerWithFaultControl(upstreamBaseURL, streamDuration, longStreamModel, "", client)
}

func NewHandlerWithFaultControl(upstreamBaseURL string, streamDuration time.Duration, longStreamModel, faultToken string, client *http.Client) (http.Handler, error) {
	upstream, err := url.Parse(upstreamBaseURL)
	if err != nil || upstream.Scheme == "" || upstream.Host == "" {
		return nil, fmt.Errorf("invalid pacer upstream URL")
	}
	if client == nil {
		client = &http.Client{Transport: http.DefaultTransport}
	}
	faults := &faultState{}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/healthz" || r.URL.Path == "/readyz" {
			w.WriteHeader(http.StatusOK)
			return
		}
		if r.URL.Path == "/__regression/fault" {
			handleFaultControl(w, r, faultToken, faults)
			return
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, 4<<20))
		if err != nil {
			http.Error(w, "invalid request body", http.StatusBadRequest)
			return
		}
		if policy := faults.get(); policy.Enabled && (strings.TrimSpace(policy.Model) == "" || requestModel(body) == strings.TrimSpace(policy.Model)) {
			status := policy.StatusCode
			if status < 400 || status > 599 {
				status = http.StatusServiceUnavailable
			}
			message := strings.TrimSpace(policy.Message)
			if message == "" {
				message = "regression fault injected"
			}
			http.Error(w, message, status)
			return
		}
		target := *upstream
		target.Path = joinPath(upstream.Path, r.URL.Path)
		target.RawQuery = r.URL.RawQuery
		request, err := http.NewRequestWithContext(r.Context(), r.Method, target.String(), bytes.NewReader(body))
		if err != nil {
			http.Error(w, "build upstream request", http.StatusInternalServerError)
			return
		}
		copyHeaders(request.Header, r.Header)
		response, err := client.Do(request)
		if err != nil {
			http.Error(w, "upstream unavailable", http.StatusBadGateway)
			return
		}
		defer response.Body.Close()
		copyHeaders(w.Header(), response.Header)
		if !shouldPace(body, longStreamModel) || response.StatusCode >= http.StatusBadRequest {
			w.WriteHeader(response.StatusCode)
			_, _ = io.Copy(w, response.Body)
			return
		}
		payload, err := io.ReadAll(io.LimitReader(response.Body, 8<<20))
		if err != nil {
			http.Error(w, "read upstream stream", http.StatusBadGateway)
			return
		}
		events := splitSSEEvents(payload)
		if len(events) == 0 {
			http.Error(w, "upstream returned no SSE events", http.StatusBadGateway)
			return
		}
		w.Header().Del("Content-Length")
		w.WriteHeader(response.StatusCode)
		interval := time.Duration(0)
		if len(events) > 1 {
			interval = streamDuration / time.Duration(len(events)-1)
		}
		keepalive := keepaliveEvent(longStreamModel)
		keepaliveInterval := streamDuration / 12
		if keepaliveInterval > 10*time.Second {
			keepaliveInterval = 10 * time.Second
		}
		writeEvent := func(event []byte) bool {
			if _, err := w.Write(event); err != nil {
				return false
			}
			if flusher, ok := w.(http.Flusher); ok {
				flusher.Flush()
			}
			return true
		}
		if !writeEvent(routeIdentityEvent(longStreamModel, r.RemoteAddr)) {
			return
		}
		for index, event := range events {
			if index > 0 && !waitWithKeepalives(r.Context(), interval, keepaliveInterval, func() bool {
				return writeEvent(keepalive)
			}) {
				return
			}
			if !writeEvent(event) {
				return
			}
		}
	}), nil
}

func routeIdentityEvent(model, remoteAddr string) []byte {
	host, _, err := net.SplitHostPort(strings.TrimSpace(remoteAddr))
	if err != nil {
		host = strings.Trim(strings.TrimSpace(remoteAddr), "[]")
	}
	payload, _ := json.Marshal(map[string]any{
		"id": "chatcmpl-llmgateway-regression-route", "object": "chat.completion.chunk", "created": 0, "model": model,
		"choices": []map[string]any{{"index": 0, "delta": map[string]any{"content": "llmgateway-regression-source-ip=" + host}, "finish_reason": nil}},
	})
	return append(append([]byte("data: "), payload...), '\n', '\n')
}

func requestModel(body []byte) string {
	var request struct {
		Model string `json:"model"`
	}
	if json.Unmarshal(body, &request) != nil {
		return ""
	}
	return request.Model
}

func handleFaultControl(w http.ResponseWriter, r *http.Request, token string, state *faultState) {
	if token == "" {
		http.NotFound(w, r)
		return
	}
	provided := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if len(provided) != len(token) || subtle.ConstantTimeCompare([]byte(provided), []byte(token)) != 1 {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var policy FaultPolicy
	decoder := json.NewDecoder(io.LimitReader(r.Body, 64<<10))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&policy); err != nil {
		http.Error(w, "invalid fault policy", http.StatusBadRequest)
		return
	}
	if policy.Enabled && policy.StatusCode != 0 && (policy.StatusCode < 400 || policy.StatusCode > 599) {
		http.Error(w, "invalid fault status", http.StatusBadRequest)
		return
	}
	state.set(policy)
	w.Header().Set("Content-Type", "application/json")
	_, _ = io.WriteString(w, `{"success":true}`)
}

func keepaliveEvent(model string) []byte {
	payload, _ := json.Marshal(map[string]any{
		"id": "chatcmpl-llmgateway-regression-keepalive", "object": "chat.completion.chunk", "created": 0, "model": model,
		"choices": []map[string]any{{"index": 0, "delta": map[string]any{"content": " "}, "finish_reason": nil}},
	})
	return append(append([]byte("data: "), payload...), '\n', '\n')
}

func waitWithKeepalives(ctx context.Context, duration, keepaliveInterval time.Duration, keepalive func() bool) bool {
	if duration <= 0 {
		return true
	}
	if keepaliveInterval <= 0 || keepaliveInterval >= duration {
		return waitContext(ctx, duration)
	}
	deadline := time.NewTimer(duration)
	defer deadline.Stop()
	ticker := time.NewTicker(keepaliveInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return false
		case <-deadline.C:
			return true
		case <-ticker.C:
			if !keepalive() {
				return false
			}
		}
	}
}

func isStreamingRequest(body []byte) bool {
	compact := bytes.Map(func(r rune) rune {
		if r == ' ' || r == '\n' || r == '\r' || r == '\t' {
			return -1
		}
		return r
	}, body)
	return bytes.Contains(compact, []byte(`"stream":true`))
}

func shouldPace(body []byte, longStreamModel string) bool {
	if !isStreamingRequest(body) {
		return false
	}
	var request struct {
		Model string `json:"model"`
	}
	return json.Unmarshal(body, &request) == nil && request.Model == longStreamModel
}

func splitSSEEvents(payload []byte) [][]byte {
	normalized := bytes.ReplaceAll(payload, []byte("\r\n"), []byte("\n"))
	parts := bytes.Split(normalized, []byte("\n\n"))
	events := make([][]byte, 0, len(parts))
	for _, part := range parts {
		if len(bytes.TrimSpace(part)) == 0 {
			continue
		}
		event := append([]byte(nil), part...)
		event = append(event, '\n', '\n')
		events = append(events, event)
	}
	return events
}

func waitContext(ctx context.Context, duration time.Duration) bool {
	if duration <= 0 {
		return true
	}
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

func copyHeaders(destination, source http.Header) {
	for name, values := range source {
		for _, value := range values {
			destination.Add(name, value)
		}
	}
}

func joinPath(left, right string) string {
	return strings.TrimRight(left, "/") + "/" + strings.TrimLeft(right, "/")
}
