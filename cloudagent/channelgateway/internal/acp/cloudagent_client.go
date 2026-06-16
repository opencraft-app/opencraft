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
	baseURL string
	headers http.Header
	client  *http.Client
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
	Run    cloudAgentRunResponse     `json:"run"`
	Events []cloudAgentEventEnvelope `json:"events"`
}

type cloudAgentEventEnvelope struct {
	Seq   int64           `json:"seq"`
	Kind  string          `json:"kind"`
	Event json.RawMessage `json:"event"`
}

type cloudAgentEventStreamFrame struct {
	Type     string                    `json:"type"`
	Event    cloudAgentEventEnvelope   `json:"event"`
	Run      cloudAgentRunResponse     `json:"run"`
	Events   []cloudAgentEventEnvelope `json:"events"`
	Error    string                    `json:"error"`
	AfterSeq int64                     `json:"after_seq"`
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

func (e RunObservationInterruptedError) Error() string {
	if e.Err == nil {
		return "cloudagent run observation interrupted"
	}
	return "cloudagent run observation interrupted: " + e.Err.Error()
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

func NewCloudAgentClient(baseURL string, headers http.Header) *CloudAgentClient {
	return &CloudAgentClient{
		baseURL: strings.TrimRight(strings.TrimSpace(baseURL), "/"),
		headers: headers,
		client:  &http.Client{},
	}
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
	if strings.TrimSpace(workspaceKey) != "" {
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
	var submitted cloudAgentRunResponse
	submitBody := map[string]any{
		"text":       text,
		"inbox_mode": "prompt",
	}
	submitHeaders := http.Header{"Idempotency-Key": []string{runID}}
	var submitErr error
	for attempt := 0; attempt < 2; attempt++ {
		submitErr = c.doJSONWithHeaders(ctx, http.MethodPost, "/v1/cloudagent/sessions/"+url.PathEscape(sessionID)+"/runs", submitBody, &submitted, submitHeaders)
		if submitErr == nil {
			break
		}
		if attempt == 0 && isCloudAgentRunIDSessionConflict(submitErr) {
			runID = newCloudAgentClientRunID()
			submitHeaders.Set("Idempotency-Key", runID)
			continue
		}
		if ctx.Err() != nil {
			return PromptResult{}, RunObservationInterruptedError{RunID: runID, Err: ctx.Err()}
		}
		select {
		case <-ctx.Done():
			return PromptResult{}, RunObservationInterruptedError{RunID: runID, Err: ctx.Err()}
		case <-time.After(time.Duration(attempt+1) * 100 * time.Millisecond):
		}
	}
	if submitErr != nil {
		if isCloudAgentRetriableSubmitError(submitErr) {
			return PromptResult{}, RunObservationInterruptedError{RunID: runID, Err: submitErr}
		}
		return PromptResult{}, submitErr
	}
	if submitted.RunID == "" {
		return PromptResult{}, errors.New("cloudagent run submit response missing run_id")
	}
	var afterSeq int64
	var observed strings.Builder
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	var followFailures int
	for {
		eventBatch, err := c.followEvents(ctx, submitted.RunID, afterSeq)
		if err != nil {
			followFailures++
			if err := waitCloudAgentRetry(ctx, followFailures); err != nil {
				return PromptResult{}, RunObservationInterruptedError{RunID: submitted.RunID, Err: err}
			}
			continue
		}
		followFailures = 0
		for _, event := range eventBatch.Events {
			if event.Seq <= afterSeq {
				continue
			}
			afterSeq = event.Seq
			if text := cloudAgentEventText(event); text != "" {
				observed.WriteString(text)
			}
		}
		if cloudAgentTerminal(eventBatch.Run.Status) {
			result := eventBatch.Run
			if result.Status == "failed" {
				return PromptResult{}, errors.New(firstNonEmpty(result.Error, "cloudagent run failed"))
			}
			output := result.OutputText
			if output == "" {
				output = observed.String()
			}
			return PromptResult{StopReason: cloudAgentStopReason(result), Text: output}, nil
		}
		result, err := c.fetchRun(ctx, submitted.RunID)
		if err != nil {
			followFailures++
			if err := waitCloudAgentRetry(ctx, followFailures); err != nil {
				return PromptResult{}, RunObservationInterruptedError{RunID: submitted.RunID, Err: err}
			}
			continue
		}
		followFailures = 0
		if cloudAgentTerminal(result.Status) {
			if result.Status == "failed" {
				return PromptResult{}, errors.New(firstNonEmpty(result.Error, "cloudagent run failed"))
			}
			output := result.OutputText
			if output == "" {
				output = observed.String()
			}
			return PromptResult{StopReason: cloudAgentStopReason(result), Text: output}, nil
		}
		select {
		case <-ctx.Done():
			return PromptResult{}, RunObservationInterruptedError{RunID: submitted.RunID, Err: ctx.Err()}
		case <-ticker.C:
		}
	}
}

func (c *CloudAgentClient) followEvents(ctx context.Context, runID string, afterSeq int64) (cloudAgentEventsResponse, error) {
	result, err := c.fetchEventsStream(ctx, runID, afterSeq)
	if err == nil {
		return result, nil
	}
	return c.fetchEvents(ctx, runID, afterSeq)
}

func (c *CloudAgentClient) fetchEvents(ctx context.Context, runID string, afterSeq int64) (cloudAgentEventsResponse, error) {
	var result cloudAgentEventsResponse
	path := fmt.Sprintf("/v1/cloudagent/runs/%s/events?after_seq=%d", url.PathEscape(runID), afterSeq)
	if err := c.doJSON(ctx, http.MethodGet, path, nil, &result); err != nil {
		return cloudAgentEventsResponse{}, err
	}
	return result, nil
}

func (c *CloudAgentClient) fetchEventsStream(ctx context.Context, runID string, afterSeq int64) (cloudAgentEventsResponse, error) {
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
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	var result cloudAgentEventsResponse
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var frame cloudAgentEventStreamFrame
		if err := json.Unmarshal([]byte(line), &frame); err != nil {
			if len(result.Events) > 0 || result.Run.RunID != "" {
				return result, nil
			}
			return cloudAgentEventsResponse{}, fmt.Errorf("decode cloudagent event stream: %w", err)
		}
		if frame.Type == "" {
			return cloudAgentEventsResponse{Run: frame.Run, Events: frame.Events}, nil
		}
		switch frame.Type {
		case "event":
			result.Events = append(result.Events, frame.Event)
		case "run":
			result.Run = frame.Run
			return result, nil
		case "heartbeat":
			return result, nil
		case "error":
			if len(result.Events) > 0 || result.Run.RunID != "" {
				return result, nil
			}
			return cloudAgentEventsResponse{}, errors.New(firstNonEmpty(frame.Error, "cloudagent event stream failed"))
		default:
			if len(result.Events) > 0 || result.Run.RunID != "" {
				return result, nil
			}
			return cloudAgentEventsResponse{}, fmt.Errorf("unknown cloudagent event stream frame type %q", frame.Type)
		}
	}
	if err := scanner.Err(); err != nil {
		if len(result.Events) > 0 || result.Run.RunID != "" {
			return result, nil
		}
		return cloudAgentEventsResponse{}, err
	}
	return result, nil
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
		if !errors.As(err, &httpErr) || httpErr.StatusCode != http.StatusNotFound {
			return err
		}
	}
	return c.checkSelfCheckRunProtocol(ctx)
}

func (c *CloudAgentClient) checkCapabilities(ctx context.Context) (bool, error) {
	var body struct {
		Object      string   `json:"object"`
		Protocol    string   `json:"protocol"`
		Version     string   `json:"version"`
		RunProtocol bool     `json:"run_protocol"`
		Features    []string `json:"features"`
	}
	if err := c.doJSON(ctx, http.MethodGet, "/v1/cloudagent/capabilities", nil, &body); err != nil {
		return false, err
	}
	if !body.RunProtocol {
		return false, CloudAgentProtocolUnavailableError{Reason: "capabilities response does not advertise run_protocol"}
	}
	if strings.TrimSpace(body.Protocol) != "cloudagent.run" {
		return false, CloudAgentProtocolUnavailableError{Reason: "capabilities response has unexpected protocol " + body.Protocol}
	}
	if strings.TrimSpace(body.Version) != "v1" {
		return false, CloudAgentProtocolUnavailableError{Reason: "unsupported cloudagent run protocol version " + body.Version}
	}
	return true, nil
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
	if envelope.Kind != "" && envelope.Kind != "assistant_text" {
		return ""
	}
	var event struct {
		SessionUpdate string `json:"sessionUpdate"`
		Content       struct {
			Text string `json:"text"`
		} `json:"content"`
	}
	_ = json.Unmarshal(envelope.Event, &event)
	if envelope.Kind == "" && event.SessionUpdate != "agent_message_chunk" {
		return ""
	}
	return event.Content.Text
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
