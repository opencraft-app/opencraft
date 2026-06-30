package acp

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type CloudAgentClient struct {
	baseURL              string
	headers              http.Header
	client               *http.Client
	supportsSessionClose bool
	supportsWorkspaceKey bool
	sandboxBackend       string
}

type cloudAgentRunResponse struct {
	RunID      string `json:"run_id"`
	SessionID  string `json:"session_id"`
	Status     string `json:"status"`
	StopReason string `json:"stop_reason"`
	Error      string `json:"error"`
	OutputText string `json:"output_text"`
}

type cloudAgentEventsResponse struct {
	Run        cloudAgentRunResponse     `json:"run"`
	RunID      string                    `json:"run_id,omitempty"`
	SessionID  string                    `json:"session_id,omitempty"`
	Status     string                    `json:"status,omitempty"`
	StopReason string                    `json:"stop_reason,omitempty"`
	Error      string                    `json:"error,omitempty"`
	OutputText string                    `json:"output_text,omitempty"`
	Events     []cloudAgentEventEnvelope `json:"events"`
	Data       []cloudAgentEventEnvelope `json:"data"`
}

type cloudAgentEventEnvelope struct {
	ID        string          `json:"id"`
	Seq       int64           `json:"seq"`
	Type      string          `json:"type"`
	RunID     string          `json:"run_id,omitempty"`
	SessionID string          `json:"session_id,omitempty"`
	Content   json.RawMessage `json:"content,omitempty"`
	Thinking  string          `json:"thinking,omitempty"`
}

type RunObservationInterruptedError struct {
	RunID string
	Err   error
}

type CloudAgentHTTPError struct {
	Method     string
	Path       string
	StatusCode int
	Body       string
}

type CloudAgentProtocolUnavailableError struct {
	Reason string
}

type CloudAgentSessionCloseUnsupportedError struct{}

func (e CloudAgentHTTPError) Error() string {
	return fmt.Sprintf("cloudagent http %s %s failed: HTTP %d: %s", e.Method, e.Path, e.StatusCode, strings.TrimSpace(e.Body))
}

func (e CloudAgentProtocolUnavailableError) Error() string {
	reason := strings.TrimSpace(e.Reason)
	if reason == "" {
		reason = "missing cloudagent run protocol capability"
	}
	return "cloudagent run protocol unavailable: " + reason
}

func (e CloudAgentSessionCloseUnsupportedError) Error() string {
	return "cloudagent session close unsupported by advertised capabilities"
}

func (e RunObservationInterruptedError) Error() string {
	if e.Err == nil {
		return "cloudagent session event observation interrupted"
	}
	return "cloudagent session event observation interrupted: " + e.Err.Error()
}

func (e RunObservationInterruptedError) Unwrap() error {
	return e.Err
}

func IsRunObservationInterrupted(err error) bool {
	var target RunObservationInterruptedError
	return errors.As(err, &target)
}

func RunObservationInterruptedRunID(err error) string {
	var target RunObservationInterruptedError
	if errors.As(err, &target) {
		return target.RunID
	}
	return ""
}

func IsCloudAgentProtocolUnavailable(err error) bool {
	var target CloudAgentProtocolUnavailableError
	return errors.As(err, &target)
}

func IsCloudAgentSessionCloseUnsupported(err error) bool {
	var target CloudAgentSessionCloseUnsupportedError
	return errors.As(err, &target)
}

func IsCloudAgentRuntimeOwnership(err error) bool {
	var httpErr CloudAgentHTTPError
	if !errors.As(err, &httpErr) {
		return false
	}
	if httpErr.StatusCode != http.StatusConflict {
		return false
	}
	body := strings.ToLower(httpErr.Body)
	return strings.Contains(body, "runtime_owned") ||
		strings.Contains(body, "runtime ownership") ||
		strings.Contains(body, "ownership is held")
}

func NewCloudAgentClient(baseURL string, headers http.Header) *CloudAgentClient {
	return &CloudAgentClient{
		baseURL: strings.TrimRight(strings.TrimSpace(baseURL), "/"),
		headers: headers,
		client:  &http.Client{},
	}
}

func (c *CloudAgentClient) SetSandboxBackend(backend string) {
	c.sandboxBackend = strings.TrimSpace(backend)
}

func (c *CloudAgentClient) Initialize(ctx context.Context) error {
	if c.baseURL == "" {
		return errors.New("cloudagent base url is required")
	}
	return c.checkRunProtocol(ctx)
}

func (c *CloudAgentClient) Close() error { return nil }

func (c *CloudAgentClient) SetWorkspaceLifecycleHandler(WorkspaceLifecycleHandler) {}

func (c *CloudAgentClient) NewSession(ctx context.Context, cwd, workspaceKey string) (string, error) {
	var result struct {
		SessionID string `json:"session_id"`
	}
	body := map[string]any{"cwd": defaultCWD(cwd)}
	if c.sandboxBackend != "" {
		body["sandbox_backend"] = c.sandboxBackend
	}
	if c.supportsWorkspaceKey && strings.TrimSpace(workspaceKey) != "" {
		body["workspace_key"] = workspaceKey
	}
	if err := c.doJSON(ctx, http.MethodPost, "/v1/cloudagent/sessions", body, &result); err != nil {
		return "", err
	}
	if strings.TrimSpace(result.SessionID) == "" {
		return "", errors.New("cloudagent session create response missing session_id")
	}
	return result.SessionID, nil
}

func (c *CloudAgentClient) CloseSession(ctx context.Context, sessionID string) error {
	if strings.TrimSpace(sessionID) == "" {
		return errors.New("missing session id")
	}
	if !c.supportsSessionClose {
		return CloudAgentSessionCloseUnsupportedError{}
	}
	var ignored map[string]any
	return c.doJSON(ctx, http.MethodPost, "/v1/cloudagent/sessions/"+url.PathEscape(sessionID)+"/close", nil, &ignored)
}

func (c *CloudAgentClient) LoadSession(ctx context.Context, sessionID, cwd string) error {
	if strings.TrimSpace(sessionID) == "" {
		return errors.New("missing session id")
	}
	path := "/v1/cloudagent/sessions/" + url.PathEscape(sessionID)
	if strings.TrimSpace(cwd) != "" {
		path += "?cwd=" + url.QueryEscape(cwd)
	}
	var ignored map[string]any
	return c.doJSON(ctx, http.MethodGet, path, nil, &ignored)
}

func (c *CloudAgentClient) EnsureRuntimeReady(ctx context.Context, sessionID, cwd string) (RuntimeReadyResult, error) {
	if err := c.LoadSession(ctx, sessionID, cwd); err != nil {
		return RuntimeReadyResult{}, err
	}
	return RuntimeReadyResult{Raw: json.RawMessage(`{"status":"ready"}`)}, nil
}

func (c *CloudAgentClient) Prompt(ctx context.Context, sessionID, text string) (PromptResult, error) {
	return c.PromptWithRunID(ctx, sessionID, text, newCloudAgentClientRunID())
}

func (c *CloudAgentClient) PromptWithRunID(ctx context.Context, sessionID, text, runID string) (PromptResult, error) {
	if strings.TrimSpace(sessionID) == "" {
		return PromptResult{}, errors.New("missing session id")
	}
	runID = strings.TrimSpace(runID)
	if runID == "" {
		runID = newCloudAgentClientRunID()
	}
	idempotencyKey := runID
	var submitted cloudAgentEventsResponse
	submitBody := map[string]any{
		"text": text,
		"events": []map[string]any{
			{
				"type":            "user.message",
				"client_event_id": idempotencyKey,
				"content":         []map[string]string{{"type": "text", "text": text}},
			},
		},
	}
	submitHeaders := http.Header{"Idempotency-Key": []string{idempotencyKey}}
	var submitErr error
	for attempt := 0; attempt < 2; attempt++ {
		submitErr = c.doJSONWithHeaders(ctx, http.MethodPost, "/v1/cloudagent/sessions/"+url.PathEscape(sessionID)+"/events", submitBody, &submitted, submitHeaders)
		if submitErr == nil {
			break
		}
		if attempt == 0 && isCloudAgentRunIDSessionConflict(submitErr) {
			idempotencyKey = newCloudAgentClientRunID()
			submitHeaders.Set("Idempotency-Key", idempotencyKey)
			continue
		}
		if ctx.Err() != nil {
			return PromptResult{}, RunObservationInterruptedError{RunID: idempotencyKey, Err: ctx.Err()}
		}
		select {
		case <-ctx.Done():
			return PromptResult{}, RunObservationInterruptedError{RunID: idempotencyKey, Err: ctx.Err()}
		case <-time.After(time.Duration(attempt+1) * 100 * time.Millisecond):
		}
	}
	if submitErr != nil {
		if isCloudAgentRetriableSubmitError(submitErr) {
			return PromptResult{}, RunObservationInterruptedError{RunID: idempotencyKey, Err: submitErr}
		}
		return PromptResult{}, submitErr
	}
	submitEvents := submitted.normalizedEvents()
	if len(submitEvents) == 0 && submitted.RunID == "" {
		return PromptResult{}, errors.New("cloudagent session events submit response missing events")
	}
	if len(submitEvents) > 0 {
		runID = firstNonEmpty(submitEvents[0].RunID, idempotencyKey)
	} else {
		runID = firstNonEmpty(submitted.RunID, idempotencyKey)
	}
	var observed strings.Builder
	for _, event := range submitEvents {
		if event.RunID != "" && runID != "" && event.RunID != runID {
			continue
		}
		if text := cloudAgentEventText(event); text != "" {
			observed.WriteString(text)
		}
	}
	if cloudAgentTerminal(submitted.Run.Status) && (submitted.Run.RunID == "" || runID == "" || submitted.Run.RunID == runID) {
		return promptResultFromCloudAgentRun(submitted.Run, observed.String())
	}
	var afterSeq int64
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	var followFailures int
	for {
		eventBatch, err := c.followRunEvents(ctx, runID, afterSeq)
		if err != nil {
			followFailures++
			if err := waitCloudAgentRetry(ctx, followFailures); err != nil {
				return PromptResult{}, RunObservationInterruptedError{RunID: runID, Err: err}
			}
			continue
		}
		followFailures = 0
		for _, event := range eventBatch.normalizedEvents() {
			if event.Seq <= afterSeq {
				continue
			}
			afterSeq = event.Seq
			if runID != "" && event.RunID != "" && event.RunID != runID {
				continue
			}
			if event.RunID != "" {
				runID = event.RunID
			}
			if text := cloudAgentEventText(event); text != "" {
				observed.WriteString(text)
			}
		}
		if cloudAgentTerminal(eventBatch.Run.Status) && (eventBatch.Run.RunID == "" || runID == "" || eventBatch.Run.RunID == runID) {
			return promptResultFromCloudAgentRun(eventBatch.Run, observed.String())
		}
		select {
		case <-ctx.Done():
			return PromptResult{}, RunObservationInterruptedError{RunID: runID, Err: ctx.Err()}
		case <-ticker.C:
		}
	}
}

func promptResultFromCloudAgentRun(result cloudAgentRunResponse, observed string) (PromptResult, error) {
	if result.Status == "failed" {
		return PromptResult{}, errors.New(firstNonEmpty(result.Error, "cloudagent run failed"))
	}
	output := result.OutputText
	if output == "" {
		output = observed
	}
	return PromptResult{StopReason: cloudAgentStopReason(result), Text: output}, nil
}

func (r cloudAgentEventsResponse) normalizedEvents() []cloudAgentEventEnvelope {
	if len(r.Events) > 0 {
		return r.Events
	}
	return r.Data
}

func (c *CloudAgentClient) followRunEvents(ctx context.Context, runID string, afterSeq int64) (cloudAgentEventsResponse, error) {
	result, err := c.fetchRunEventsStream(ctx, runID, afterSeq)
	if err == nil {
		return result, nil
	}
	return c.fetchRunEvents(ctx, runID, afterSeq)
}

func (c *CloudAgentClient) fetchRunEvents(ctx context.Context, runID string, afterSeq int64) (cloudAgentEventsResponse, error) {
	var result cloudAgentEventsResponse
	path := fmt.Sprintf("/v1/cloudagent/runs/%s/events?after_seq=%d", url.PathEscape(runID), afterSeq)
	if err := c.doJSON(ctx, http.MethodGet, path, nil, &result); err != nil {
		return cloudAgentEventsResponse{}, err
	}
	return result, nil
}

func (c *CloudAgentClient) fetchRunEventsStream(ctx context.Context, runID string, afterSeq int64) (cloudAgentEventsResponse, error) {
	path := fmt.Sprintf("/v1/cloudagent/runs/%s/events?after_seq=%d&stream=true", url.PathEscape(runID), afterSeq)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+path, nil)
	if err != nil {
		return cloudAgentEventsResponse{}, err
	}
	for key, values := range c.headers {
		for _, value := range values {
			req.Header.Add(key, value)
		}
	}
	resp, err := c.client.Do(req)
	if err != nil {
		return cloudAgentEventsResponse{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		raw, _ := io.ReadAll(resp.Body)
		return cloudAgentEventsResponse{}, fmt.Errorf("cloudagent http %s %s failed: HTTP %d: %s", http.MethodGet, path, resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	if !strings.Contains(strings.ToLower(resp.Header.Get("Content-Type")), "text/event-stream") {
		_, _ = io.Copy(io.Discard, resp.Body)
		return cloudAgentEventsResponse{}, fmt.Errorf("cloudagent event stream returned non-SSE content type %q", resp.Header.Get("Content-Type"))
	}
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	var result cloudAgentEventsResponse
	var sseEvent string
	var sseData strings.Builder
	flushSSE := func() (bool, error) {
		if strings.TrimSpace(sseData.String()) == "" {
			sseEvent = ""
			return false, nil
		}
		done, err := accumulateCloudAgentStreamPayload(&result, sseEvent, []byte(strings.TrimSpace(sseData.String())))
		sseEvent = ""
		sseData.Reset()
		return done, err
	}
	for scanner.Scan() {
		rawLine := scanner.Text()
		line := strings.TrimSpace(rawLine)
		if line == "" {
			done, err := flushSSE()
			if err != nil {
				if len(result.Events) > 0 || result.Run.RunID != "" {
					return result, nil
				}
				return cloudAgentEventsResponse{}, err
			}
			if done {
				return result, nil
			}
			continue
		}
		switch {
		case strings.HasPrefix(line, "event:"):
			sseEvent = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
			continue
		case strings.HasPrefix(line, "data:"):
			if sseData.Len() > 0 {
				sseData.WriteByte('\n')
			}
			sseData.WriteString(strings.TrimSpace(strings.TrimPrefix(line, "data:")))
			continue
		case strings.HasPrefix(line, "id:") || strings.HasPrefix(line, ":"):
			continue
		}
		done, err := accumulateCloudAgentStreamPayload(&result, "", []byte(line))
		if err != nil {
			if len(result.Events) > 0 || result.Run.RunID != "" {
				return result, nil
			}
			return cloudAgentEventsResponse{}, fmt.Errorf("decode cloudagent event stream: %w", err)
		}
		if done {
			return result, nil
		}
	}
	if done, err := flushSSE(); err != nil {
		if len(result.Events) > 0 || result.Run.RunID != "" {
			return result, nil
		}
		return cloudAgentEventsResponse{}, err
	} else if done {
		return result, nil
	}
	if err := scanner.Err(); err != nil {
		if len(result.Events) > 0 || result.Run.RunID != "" {
			return result, nil
		}
		return cloudAgentEventsResponse{}, err
	}
	return result, nil
}

func accumulateCloudAgentStreamPayload(result *cloudAgentEventsResponse, eventType string, raw []byte) (bool, error) {
	var event cloudAgentEventEnvelope
	if err := json.Unmarshal(raw, &event); err != nil {
		return false, err
	}
	if event.Type == "" {
		event.Type = eventType
	}
	switch event.Type {
	case "heartbeat":
		return true, nil
	case "session.status_idle":
		result.Events = append(result.Events, event)
		result.Run = cloudAgentRunResponse{
			RunID:      eventRunID(raw),
			SessionID:  eventSessionID(raw),
			Status:     "completed",
			StopReason: eventStopReason(raw),
		}
		return true, nil
	case "session.error":
		result.Events = append(result.Events, event)
		result.Run = cloudAgentRunResponse{
			RunID:     eventRunID(raw),
			SessionID: eventSessionID(raw),
			Status:    "failed",
			Error:     eventErrorMessage(raw),
		}
		return true, nil
	default:
		result.Events = append(result.Events, event)
		return false, nil
	}
}

func (c *CloudAgentClient) fetchRun(ctx context.Context, runID string) (cloudAgentRunResponse, error) {
	var result cloudAgentRunResponse
	if err := c.doJSON(ctx, http.MethodGet, "/v1/cloudagent/runs/"+url.PathEscape(runID)+"/result", nil, &result); err != nil {
		return cloudAgentRunResponse{}, err
	}
	return result, nil
}

func (c *CloudAgentClient) checkRunProtocol(ctx context.Context) error {
	ok, err := c.checkCapabilities(ctx)
	if err == nil && ok {
		return nil
	}
	if err != nil {
		var httpErr CloudAgentHTTPError
		if errors.As(err, &httpErr) && httpErr.StatusCode == http.StatusNotFound {
			return CloudAgentProtocolUnavailableError{Reason: "capabilities endpoint does not exist; session_event_protocol is required"}
		}
		return err
	}
	return CloudAgentProtocolUnavailableError{Reason: "capabilities response does not advertise session_event_protocol"}
}

func (c *CloudAgentClient) checkCapabilities(ctx context.Context) (bool, error) {
	var body struct {
		Object               string   `json:"object"`
		Protocol             string   `json:"protocol"`
		Version              string   `json:"version"`
		RunProtocol          bool     `json:"run_protocol"`
		SessionEventProtocol bool     `json:"session_event_protocol"`
		Features             []string `json:"features"`
		Endpoints            []string `json:"endpoints"`
	}
	if err := c.doJSON(ctx, http.MethodGet, "/v1/cloudagent/capabilities", nil, &body); err != nil {
		return false, err
	}
	if !body.SessionEventProtocol {
		return false, CloudAgentProtocolUnavailableError{Reason: "capabilities response does not advertise session_event_protocol"}
	}
	if protocol := strings.TrimSpace(body.Protocol); protocol != "cloudagent.session_events" {
		return false, CloudAgentProtocolUnavailableError{Reason: "capabilities response has unexpected protocol " + body.Protocol}
	}
	if strings.TrimSpace(body.Version) != "v1" {
		return false, CloudAgentProtocolUnavailableError{Reason: "unsupported cloudagent run protocol version " + body.Version}
	}
	c.supportsSessionClose = stringListContains(body.Features, "session_close") ||
		stringListContains(body.Features, "session.close") ||
		stringListContains(body.Endpoints, "POST /v1/cloudagent/sessions/{session_id}/close")
	c.supportsWorkspaceKey = stringListContains(body.Features, "workspace_key") ||
		stringListContains(body.Features, "workspace_reuse")
	return true, nil
}

func stringListContains(values []string, want string) bool {
	want = strings.TrimSpace(want)
	for _, value := range values {
		if strings.TrimSpace(value) == want {
			return true
		}
	}
	return false
}

func (c *CloudAgentClient) checkSelfCheckRunProtocol(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+"/v1/selfcheck", nil)
	if err != nil {
		return err
	}
	for key, values := range c.headers {
		for _, value := range values {
			req.Header.Add(key, value)
		}
	}
	resp, err := c.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	if resp.StatusCode == http.StatusNotFound {
		// Some unit tests and transitional deployments do not expose selfcheck.
		// If selfcheck exists, it is authoritative; if it does not, later calls
		// still validate the concrete run routes.
		return nil
	}
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return CloudAgentHTTPError{Method: http.MethodGet, Path: "/v1/selfcheck", StatusCode: resp.StatusCode, Body: strings.TrimSpace(string(raw))}
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		// Selfcheck may return 503 for AGS/Wisp artifact readiness. That should
		// not hide whether this gateway binary has the run protocol routes.
		if resp.StatusCode != http.StatusServiceUnavailable {
			return CloudAgentHTTPError{Method: http.MethodGet, Path: "/v1/selfcheck", StatusCode: resp.StatusCode, Body: strings.TrimSpace(string(raw))}
		}
	}
	var body struct {
		Summary struct {
			CloudAgentRunProtocol bool `json:"cloudagent_run_protocol"`
		} `json:"summary"`
		Checks []struct {
			Name   string `json:"name"`
			Status string `json:"status"`
		} `json:"checks"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return fmt.Errorf("decode cloudagent selfcheck: %w", err)
	}
	if body.Summary.CloudAgentRunProtocol {
		return nil
	}
	for _, check := range body.Checks {
		if check.Name == "cloudagent.run_protocol" && check.Status == "pass" {
			return nil
		}
	}
	return CloudAgentProtocolUnavailableError{Reason: "gateway selfcheck does not advertise /v1/cloudagent/* routes"}
}

func (c *CloudAgentClient) doJSON(ctx context.Context, method, path string, in any, out any) error {
	return c.doJSONWithHeaders(ctx, method, path, in, out, nil)
}

func (c *CloudAgentClient) doJSONWithHeaders(ctx context.Context, method, path string, in any, out any, extraHeaders http.Header) error {
	var body io.Reader
	if in != nil {
		raw, err := json.Marshal(in)
		if err != nil {
			return err
		}
		body = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, body)
	if err != nil {
		return err
	}
	for key, values := range c.headers {
		for _, value := range values {
			req.Header.Add(key, value)
		}
	}
	for key, values := range extraHeaders {
		for _, value := range values {
			req.Header.Add(key, value)
		}
	}
	if in != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return CloudAgentHTTPError{Method: method, Path: path, StatusCode: resp.StatusCode, Body: strings.TrimSpace(string(raw))}
	}
	if out == nil || len(raw) == 0 {
		return nil
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("decode cloudagent response: %w", err)
	}
	return nil
}

func isCloudAgentRunIDSessionConflict(err error) bool {
	var httpErr CloudAgentHTTPError
	if !errors.As(err, &httpErr) {
		return false
	}
	if httpErr.StatusCode < 400 || httpErr.StatusCode >= 500 {
		return false
	}
	return strings.Contains(strings.ToLower(httpErr.Body), "run id belongs to another session")
}

func isCloudAgentRetriableSubmitError(err error) bool {
	if err == nil {
		return false
	}
	var httpErr CloudAgentHTTPError
	if errors.As(err, &httpErr) {
		return httpErr.StatusCode >= 500 || httpErr.StatusCode == http.StatusTooManyRequests || httpErr.StatusCode == http.StatusRequestTimeout
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	var urlErr *url.Error
	if errors.As(err, &urlErr) {
		return true
	}
	var netErr net.Error
	return errors.As(err, &netErr)
}

func cloudAgentEventText(envelope cloudAgentEventEnvelope) string {
	if envelope.Type == "agent.message" {
		var blocks []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		}
		if err := json.Unmarshal(envelope.Content, &blocks); err == nil {
			var out strings.Builder
			for _, block := range blocks {
				if block.Type == "text" {
					out.WriteString(block.Text)
				}
			}
			return out.String()
		}
	}
	return ""
}

func cloudAgentTerminal(status string) bool {
	switch status {
	case "completed", "failed", "cancelled", "interrupted":
		return true
	default:
		return false
	}
}

func cloudAgentStopReason(result cloudAgentRunResponse) string {
	if strings.TrimSpace(result.StopReason) != "" {
		return result.StopReason
	}
	switch strings.TrimSpace(result.Status) {
	case "cancelled":
		return "cancelled"
	case "interrupted":
		return "interrupted"
	default:
		return "end_turn"
	}
}

func eventRunID(raw []byte) string {
	var event struct {
		RunID string `json:"run_id"`
	}
	_ = json.Unmarshal(raw, &event)
	return event.RunID
}

func eventSessionID(raw []byte) string {
	var event struct {
		SessionID string `json:"session_id"`
	}
	_ = json.Unmarshal(raw, &event)
	return event.SessionID
}

func eventStopReason(raw []byte) string {
	var event struct {
		StopReason any `json:"stop_reason"`
	}
	_ = json.Unmarshal(raw, &event)
	switch value := event.StopReason.(type) {
	case string:
		return value
	case map[string]any:
		if typed, _ := value["type"].(string); typed != "" {
			return typed
		}
	}
	return "end_turn"
}

func eventErrorMessage(raw []byte) string {
	var event struct {
		Error any `json:"error"`
	}
	_ = json.Unmarshal(raw, &event)
	switch value := event.Error.(type) {
	case string:
		return value
	case map[string]any:
		if message, _ := value["message"].(string); message != "" {
			return message
		}
	}
	return "cloudagent run failed"
}

func defaultCWD(cwd string) string {
	if strings.TrimSpace(cwd) == "" {
		return "/workspace"
	}
	return cwd
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func waitCloudAgentRetry(ctx context.Context, failures int) error {
	if failures < 1 {
		failures = 1
	}
	delay := time.Duration(failures) * 100 * time.Millisecond
	if delay > time.Second {
		delay = time.Second
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(delay):
		return nil
	}
}

func newCloudAgentClientRunID() string {
	var raw [12]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return fmt.Sprintf("job_channel_%d", time.Now().UnixNano())
	}
	return "job_channel_" + hex.EncodeToString(raw[:])
}
