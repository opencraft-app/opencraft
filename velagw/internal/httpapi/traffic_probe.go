package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"
)

func (s *Server) adminTrafficProbe(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var input struct {
		Mode   string `json:"mode"`
		APIKey string `json:"api_key"`
		UserID string `json:"user_id"`
		Model  string `json:"model"`
		Prompt string `json:"prompt"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json")
		return
	}
	input.Mode = strings.TrimSpace(input.Mode)
	if input.Mode == "" {
		input.Mode = "gateway"
	}
	input.APIKey = strings.TrimSpace(input.APIKey)
	input.UserID = strings.TrimSpace(input.UserID)
	input.Model = strings.TrimSpace(input.Model)
	input.Prompt = strings.TrimSpace(input.Prompt)
	if (input.APIKey == "" && input.UserID == "") || input.Model == "" || input.Prompt == "" {
		writeError(w, http.StatusBadRequest, "api_key or user_id, model and prompt are required")
		return
	}

	targetBaseURL := strings.TrimRight(strings.TrimSpace(s.config.TrafficBaseURL), "/")
	authorizationKey := input.APIKey
	userID := input.UserID
	setID := ""
	keyID := ""
	keyCreated := false
	if authorizationKey == "" {
		probeKey, err := s.svc.GetOrCreateTrafficProbeKey(r.Context(), input.UserID)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		authorizationKey = probeKey.Binding.ExternalKey
		userID = probeKey.Binding.UserID
		setID = probeKey.Binding.SetID
		keyID = probeKey.Binding.ExternalKeyID
		keyCreated = probeKey.Created
	}
	switch input.Mode {
	case "gateway":
		if targetBaseURL == "" {
			writeError(w, http.StatusServiceUnavailable, "traffic probe gateway is not configured")
			return
		}
	case "set_direct":
		target, err := s.svc.ResolveDirectTrafficProbeTarget(r.Context(), authorizationKey)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		targetBaseURL = target.BaseURL
		authorizationKey = target.UpstreamKey
		userID = target.UserID
		setID = target.SetID
	default:
		writeError(w, http.StatusBadRequest, "mode must be gateway or set_direct")
		return
	}

	body, err := json.Marshal(map[string]any{
		"model": input.Model,
		"messages": []map[string]string{
			{"role": "system", "content": "You are a concise LLMGateway health-check assistant."},
			{"role": "user", "content": input.Prompt},
		},
		"stream": false,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	timeout := s.config.TrafficProbeTimeout
	if timeout <= 0 {
		timeout = 2 * time.Minute
	}
	ctx, cancel := context.WithTimeout(r.Context(), timeout)
	defer cancel()
	upstreamRequest, err := http.NewRequestWithContext(ctx, http.MethodPost, targetBaseURL+"/v1/chat/completions", bytes.NewReader(body))
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	upstreamRequest.Header.Set("Authorization", "Bearer "+authorizationKey)
	upstreamRequest.Header.Set("Content-Type", "application/json")
	upstreamRequest.Header.Set("Accept", "application/json")
	client := s.config.TrafficProbeClient
	if client == nil {
		client = &http.Client{}
	}
	startedAt := time.Now()
	upstreamResponse, err := client.Do(upstreamRequest)
	duration := time.Since(startedAt)
	if err != nil {
		writeError(w, http.StatusBadGateway, "traffic probe failed: "+err.Error())
		return
	}
	defer upstreamResponse.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(upstreamResponse.Body, 16<<20))
	if err != nil {
		writeError(w, http.StatusBadGateway, "read traffic probe response: "+err.Error())
		return
	}
	probeResult := struct {
		Mode           string          `json:"mode"`
		UserID         string          `json:"user_id,omitempty"`
		SetID          string          `json:"set_id,omitempty"`
		KeyID          string          `json:"key_id,omitempty"`
		KeyCreated     bool            `json:"key_created,omitempty"`
		Endpoint       string          `json:"endpoint"`
		UpstreamStatus int             `json:"upstream_status"`
		DurationMS     int64           `json:"duration_ms"`
		Response       json.RawMessage `json:"response"`
	}{
		Mode:           input.Mode,
		UserID:         userID,
		SetID:          setID,
		KeyID:          keyID,
		KeyCreated:     keyCreated,
		Endpoint:       "/v1/chat/completions",
		UpstreamStatus: upstreamResponse.StatusCode,
		DurationMS:     duration.Milliseconds(),
		Response:       json.RawMessage(raw),
	}
	if !json.Valid(raw) {
		probeResult.Response, _ = json.Marshal(string(raw))
	}
	if upstreamResponse.StatusCode < 200 || upstreamResponse.StatusCode >= 300 {
		writeJSON(w, http.StatusBadGateway, response{
			Success: false,
			Message: trafficProbeErrorMessage(raw, upstreamResponse.Status),
			Data:    probeResult,
		})
		return
	}
	writeJSON(w, http.StatusOK, response{Success: true, Data: probeResult})
}

func trafficProbeErrorMessage(raw []byte, fallback string) string {
	var payload struct {
		Message string `json:"message"`
		Error   struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if json.Unmarshal(raw, &payload) == nil {
		if strings.TrimSpace(payload.Error.Message) != "" {
			return payload.Error.Message
		}
		if strings.TrimSpace(payload.Message) != "" {
			return payload.Message
		}
	}
	if strings.TrimSpace(string(raw)) != "" {
		return strings.TrimSpace(string(raw))
	}
	return fallback
}
