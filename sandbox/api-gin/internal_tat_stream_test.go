package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"cvm-mock-e2b/internal/provider"
	"cvm-mock-e2b/internal/service"
	"cvm-mock-e2b/internal/store"
)

type stubTerminalCommandStreamer struct {
	req       provider.TerminalCommandStreamRequest
	exitCode  int
	streamErr error
}

func (s *stubTerminalCommandStreamer) StreamTerminalCommand(_ context.Context, req provider.TerminalCommandStreamRequest, emit func(provider.TerminalCommandStreamEvent) error) (provider.TerminalCommandResult, error) {
	s.req = req
	if err := emit(provider.TerminalCommandStreamEvent{
		Type:        provider.TerminalCommandEventStarted,
		ExecutionID: "pty:test1234",
	}); err != nil {
		return provider.TerminalCommandResult{}, err
	}
	if err := emit(provider.TerminalCommandStreamEvent{
		Type:        provider.TerminalCommandEventOutput,
		ExecutionID: "pty:test1234",
		Index:       0,
		Chunk:       "hello\n",
	}); err != nil {
		return provider.TerminalCommandResult{}, err
	}
	if s.streamErr != nil {
		return provider.TerminalCommandResult{}, s.streamErr
	}
	return provider.TerminalCommandResult{ExecutionID: "pty:test1234", ExitCode: s.exitCode}, nil
}

func TestInternalTATExecStreamEmitsNDJSONContract(t *testing.T) {
	gin.SetMode(gin.TestMode)

	svc := service.NewService(store.NewMemoryStore())
	_, _, sb := createAllocatedSandbox(t, svc)
	streamer := &stubTerminalCommandStreamer{}
	router := newInternalTATTestRouter(&handler{svc: svc, terminalCommands: streamer})
	req := httptest.NewRequest(
		http.MethodPost,
		"/internal/sandboxes/"+sb.ID+"/tat/exec-stream",
		bytes.NewBufferString(`{"command":"printf hello","username":"agentuser","working_directory":"/home/agentuser","timeout_seconds":500}`),
	)
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()

	router.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rr.Code, rr.Body.String())
	}
	if got := rr.Header().Get("Content-Type"); got != "application/x-ndjson" {
		t.Fatalf("expected application/x-ndjson, got %q", got)
	}
	if streamer.req.Region != "ap-beijing" || streamer.req.InstanceID != "ins-test-1" {
		t.Fatalf("unexpected sandbox context: %+v", streamer.req)
	}
	if streamer.req.TimeoutSeconds != 300 {
		t.Fatalf("expected timeout clamped to 300, got %d", streamer.req.TimeoutSeconds)
	}

	lines := strings.Split(strings.TrimSpace(rr.Body.String()), "\n")
	if len(lines) != 3 {
		t.Fatalf("expected 3 NDJSON lines, got %d body=%q", len(lines), rr.Body.String())
	}
	var events []map[string]any
	for _, line := range lines {
		var event map[string]any
		if err := json.Unmarshal([]byte(line), &event); err != nil {
			t.Fatalf("decode event %q: %v", line, err)
		}
		events = append(events, event)
	}
	if events[0]["type"] != "started" || events[0]["execution_id"] != "pty:test1234" {
		t.Fatalf("unexpected started event: %+v", events[0])
	}
	if events[1]["type"] != "output" || events[1]["chunk"] != "hello\n" || events[1]["index"] != float64(0) {
		t.Fatalf("unexpected output event: %+v", events[1])
	}
	if events[2]["type"] != "finished" || events[2]["status"] != "SUCCESS" || events[2]["exit_code"] != float64(0) {
		t.Fatalf("unexpected finished event: %+v", events[2])
	}
}

func TestInternalTATExecStreamMapsNonZeroExitToFailed(t *testing.T) {
	gin.SetMode(gin.TestMode)

	svc := service.NewService(store.NewMemoryStore())
	_, _, sb := createAllocatedSandbox(t, svc)
	streamer := &stubTerminalCommandStreamer{exitCode: 17}
	router := newInternalTATTestRouter(&handler{svc: svc, terminalCommands: streamer})
	req := httptest.NewRequest(
		http.MethodPost,
		"/internal/sandboxes/"+sb.ID+"/tat/exec-stream",
		bytes.NewBufferString(`{"command":"false","username":"agentuser","working_directory":"/home/agentuser","timeout_seconds":30}`),
	)
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()

	router.ServeHTTP(rr, req)

	lines := strings.Split(strings.TrimSpace(rr.Body.String()), "\n")
	var finished map[string]any
	if err := json.Unmarshal([]byte(lines[len(lines)-1]), &finished); err != nil {
		t.Fatalf("decode finished event: %v", err)
	}
	if finished["type"] != "finished" || finished["status"] != "FAILED" || finished["exit_code"] != float64(17) {
		t.Fatalf("unexpected finished event: %+v", finished)
	}
}

func TestInternalTATExecStreamEmitsErrorAfterStarted(t *testing.T) {
	gin.SetMode(gin.TestMode)

	svc := service.NewService(store.NewMemoryStore())
	_, _, sb := createAllocatedSandbox(t, svc)
	streamer := &stubTerminalCommandStreamer{
		streamErr: &provider.TerminalCommandStreamError{
			Code:    provider.TerminalCommandErrorTimeout,
			Message: "command timed out",
		},
	}
	router := newInternalTATTestRouter(&handler{svc: svc, terminalCommands: streamer})
	req := httptest.NewRequest(
		http.MethodPost,
		"/internal/sandboxes/"+sb.ID+"/tat/exec-stream",
		bytes.NewBufferString(`{"command":"sleep 60","username":"agentuser","working_directory":"/home/agentuser","timeout_seconds":30}`),
	)
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()

	router.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected streaming status 200, got %d", rr.Code)
	}
	lines := strings.Split(strings.TrimSpace(rr.Body.String()), "\n")
	var terminal map[string]any
	if err := json.Unmarshal([]byte(lines[len(lines)-1]), &terminal); err != nil {
		t.Fatalf("decode terminal event: %v", err)
	}
	if terminal["type"] != "error" || terminal["code"] != "TIMEOUT" || terminal["message"] != "command timed out" {
		t.Fatalf("unexpected error event: %+v", terminal)
	}
}

func TestInternalTATRoutesRequireConfiguredAPIKey(t *testing.T) {
	gin.SetMode(gin.TestMode)
	tests := []struct {
		name        string
		expectedKey string
		providedKey string
	}{
		{name: "missing", expectedKey: internalTATTestAPIKey},
		{name: "wrong", expectedKey: internalTATTestAPIKey, providedKey: "wrong-key"},
		{name: "server unconfigured", providedKey: internalTATTestAPIKey},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := gin.New()
			internal := r.Group("/internal")
			internal.Use(internalAPIKeyAuth(tt.expectedKey))
			registerInternalTATInvocationRoutes(internal, &handler{})
			req := httptest.NewRequest(http.MethodPost, "/internal/sandboxes/sbx-1/tat/invocations", strings.NewReader(`{}`))
			if tt.providedKey != "" {
				req.Header.Set("X-API-Key", tt.providedKey)
			}
			rec := httptest.NewRecorder()

			r.ServeHTTP(rec, req)

			if rec.Code != http.StatusUnauthorized {
				t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
			}
		})
	}
}

const internalTATTestAPIKey = "test-sandbox-api-key"

func authorizeInternalTATRequest(req *http.Request) {
	req.Header.Set("X-API-Key", internalTATTestAPIKey)
}

func newInternalTATTestRouter(h *handler) *gin.Engine {
	r := gin.New()
	internal := r.Group("/internal")
	registerInternalTATStreamRoute(internal, h)
	internalInvocations := internal.Group("")
	internalInvocations.Use(internalAPIKeyAuth(internalTATTestAPIKey))
	registerInternalTATInvocationRoutes(internalInvocations, h)
	return r
}
