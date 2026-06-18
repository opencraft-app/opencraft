package wrapper

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestCloudAgentHTTPProtocolRunReplayAndResult(t *testing.T) {
	srv, _ := newTestServer(t, FakeWorker{OutputText: "hello from cloudagent http"})
	sessionResp := jsonRequest(t, srv, http.MethodPost, "/v1/cloudagent/sessions", "tenant-a", "project-a", map[string]any{
		"cwd": "/workspace",
	})
	if sessionResp.Code != http.StatusOK {
		t.Fatalf("session create status=%d body=%s", sessionResp.Code, sessionResp.Body.String())
	}
	var session struct {
		SessionID string `json:"session_id"`
		State     string `json:"state"`
	}
	if err := json.Unmarshal(sessionResp.Body.Bytes(), &session); err != nil {
		t.Fatal(err)
	}
	if session.SessionID == "" || session.State != string(acpRuntimeStateReady) {
		t.Fatalf("unexpected session response: %#v", session)
	}

	submitResp := jsonRequest(t, srv, http.MethodPost, "/v1/cloudagent/sessions/"+session.SessionID+"/runs", "tenant-a", "project-a", map[string]any{
		"text":       "say hi",
		"inbox_mode": "prompt",
	})
	if submitResp.Code != http.StatusOK {
		t.Fatalf("run submit status=%d body=%s", submitResp.Code, submitResp.Body.String())
	}
	var submitted cloudAgentRunResponse
	if err := json.Unmarshal(submitResp.Body.Bytes(), &submitted); err != nil {
		t.Fatal(err)
	}
	if submitted.RunID == "" || submitted.SessionID != session.SessionID || submitted.Status != "running" {
		t.Fatalf("unexpected submit response: %#v", submitted)
	}

	result := waitCloudAgentRun(t, srv, submitted.RunID)
	if result.Status != "completed" || result.OutputText != "hello from cloudagent http" {
		t.Fatalf("unexpected run result: %#v", result)
	}

	eventsResp := request(t, srv, http.MethodGet, "/v1/cloudagent/runs/"+submitted.RunID+"/events?after_seq=0", "tenant-a", "project-a", nil, "")
	if eventsResp.Code != http.StatusOK {
		t.Fatalf("events status=%d body=%s", eventsResp.Code, eventsResp.Body.String())
	}
	var replay struct {
		Run    cloudAgentRunResponse `json:"run"`
		Events []map[string]any      `json:"events"`
	}
	if err := json.Unmarshal(eventsResp.Body.Bytes(), &replay); err != nil {
		t.Fatal(err)
	}
	if replay.Run.RunID != submitted.RunID || len(replay.Events) == 0 {
		t.Fatalf("expected replay events for run, got %#v", replay)
	}
	if replay.Events[0]["seq"].(float64) <= 0 || replay.Events[0]["session_id"] != session.SessionID {
		t.Fatalf("bad replay event identity: %#v", replay.Events[0])
	}
	if replay.Events[0]["type"] == "" {
		t.Fatalf("cloudagent protocol events must expose Qoder-style type: %#v", replay.Events[0])
	}
	replayBody := eventsResp.Body.String()
	for _, forbidden := range []string{`"sessionUpdate"`, `"kind":"`, `"event":{`, `WRAPPER_EVENT_JSON`, `timeline source=hermes_sidecar`} {
		if strings.Contains(replayBody, forbidden) {
			t.Fatalf("non-stream replay leaked internal field %q in:\n%s", forbidden, replayBody)
		}
	}

	lastSeq := int64(replay.Events[len(replay.Events)-1]["seq"].(float64))
	afterResp := request(t, srv, http.MethodGet, "/v1/cloudagent/runs/"+submitted.RunID+"/events?after_seq="+itoa64(lastSeq), "tenant-a", "project-a", nil, "")
	if afterResp.Code != http.StatusOK {
		t.Fatalf("after events status=%d body=%s", afterResp.Code, afterResp.Body.String())
	}
	var afterReplay struct {
		Events []map[string]any `json:"events"`
	}
	if err := json.Unmarshal(afterResp.Body.Bytes(), &afterReplay); err != nil {
		t.Fatal(err)
	}
	if len(afterReplay.Events) != 0 {
		t.Fatalf("after_seq replay should not repeat old events: %#v", afterReplay.Events)
	}
}

func TestCloudAgentHTTPSessionEventAPIIsQoderLike(t *testing.T) {
	originalHeartbeat := cloudAgentRunStreamHeartbeatInterval
	cloudAgentRunStreamHeartbeatInterval = 10 * time.Millisecond
	t.Cleanup(func() {
		cloudAgentRunStreamHeartbeatInterval = originalHeartbeat
	})
	srv, _ := newTestServer(t, FakeWorker{OutputText: "hello from session events"})
	sessionResp := jsonRequest(t, srv, http.MethodPost, "/v1/cloudagent/sessions", "tenant-a", "project-a", map[string]any{
		"cwd": "/workspace",
	})
	if sessionResp.Code != http.StatusOK {
		t.Fatalf("session create status=%d body=%s", sessionResp.Code, sessionResp.Body.String())
	}
	var session struct {
		SessionID string `json:"session_id"`
	}
	if err := json.Unmarshal(sessionResp.Body.Bytes(), &session); err != nil {
		t.Fatal(err)
	}

	submitResp := jsonRequestWithHeaders(t, srv, http.MethodPost, "/v1/cloudagent/sessions/"+session.SessionID+"/events", "tenant-a", "project-a", map[string]any{
		"events": []map[string]any{
			{
				"type":            "user.message",
				"client_event_id": "client_msg_1",
				"content":         []map[string]string{{"type": "text", "text": "say hi"}},
			},
		},
	}, map[string]string{"Idempotency-Key": "client_msg_1"})
	if submitResp.Code != http.StatusOK {
		t.Fatalf("session event submit status=%d body=%s", submitResp.Code, submitResp.Body.String())
	}
	var submitted struct {
		Events []map[string]any `json:"events"`
	}
	if err := json.Unmarshal(submitResp.Body.Bytes(), &submitted); err != nil {
		t.Fatal(err)
	}
	if len(submitted.Events) == 0 || submitted.Events[0]["type"] != "user.message" || submitted.Events[0]["session_id"] != session.SessionID {
		t.Fatalf("submit should return public user.message event, got %#v", submitted.Events)
	}
	runID, _ := submitted.Events[0]["run_id"].(string)
	if runID == "" {
		t.Fatalf("public event may expose run_id as metadata, got %#v", submitted.Events[0])
	}

	result := waitCloudAgentRun(t, srv, runID)
	if result.Status != "completed" {
		t.Fatalf("run backing session event did not complete: %#v", result)
	}
	streamResp := request(t, srv, http.MethodGet, "/v1/cloudagent/sessions/"+session.SessionID+"/events/stream?after_seq=0", "tenant-a", "project-a", nil, "")
	if streamResp.Code != http.StatusOK {
		t.Fatalf("session stream status=%d body=%s", streamResp.Code, streamResp.Body.String())
	}
	body := streamResp.Body.String()
	for _, want := range []string{
		"event: user.message",
		"event: agent.message",
		"event: session.status_idle",
		"hello",
		"events",
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("session stream missing %q in:\n%s", want, body)
		}
	}
	if strings.Contains(body, `"sessionUpdate"`) || strings.Contains(body, "WRAPPER_EVENT_JSON") {
		t.Fatalf("session stream leaked internal event shape:\n%s", body)
	}
	terminalID := cloudAgentSSEEventID(body, "session.status_idle")
	if terminalID == "" {
		t.Fatalf("session stream terminal event id missing:\n%s", body)
	}
	replayResp := request(t, srv, http.MethodGet, "/v1/cloudagent/sessions/"+session.SessionID+"/events?after_id="+terminalID, "tenant-a", "project-a", nil, "")
	if replayResp.Code != http.StatusOK {
		t.Fatalf("session replay status=%d body=%s", replayResp.Code, replayResp.Body.String())
	}
	if strings.Contains(replayResp.Body.String(), "agent.message") {
		t.Fatalf("after_id replay should not repeat terminal run events: %s", replayResp.Body.String())
	}
}

func TestCloudAgentHTTPSessionEventsRejectMissingSession(t *testing.T) {
	srv, _ := newTestServer(t, FakeWorker{})
	for _, target := range []string{
		"/v1/cloudagent/sessions/session_missing/events?after_seq=0",
		"/v1/cloudagent/sessions/session_missing/events/stream?after_seq=0",
	} {
		resp := request(t, srv, http.MethodGet, target, "tenant-a", "project-a", nil, "")
		if resp.Code != http.StatusNotFound {
			t.Fatalf("%s status=%d body=%s", target, resp.Code, resp.Body.String())
		}
		if !strings.Contains(resp.Body.String(), "session_not_found") {
			t.Fatalf("%s should return structured session_not_found, got %s", target, resp.Body.String())
		}
	}
}

func TestCloudAgentHTTPProtocolCapabilities(t *testing.T) {
	srv, _ := newTestServer(t, FakeWorker{})

	unauthorized := request(t, srv, http.MethodGet, "/v1/cloudagent/capabilities", "", "", nil, "")
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("capabilities without identity status=%d body=%s", unauthorized.Code, unauthorized.Body.String())
	}

	resp := request(t, srv, http.MethodGet, "/v1/cloudagent/capabilities", "tenant-a", "project-a", nil, "")
	if resp.Code != http.StatusOK {
		t.Fatalf("capabilities status=%d body=%s", resp.Code, resp.Body.String())
	}
	var out struct {
		Object               string   `json:"object"`
		Protocol             string   `json:"protocol"`
		Version              string   `json:"version"`
		RunProtocol          bool     `json:"run_protocol"`
		SessionEventProtocol bool     `json:"session_event_protocol"`
		Features             []string `json:"features"`
		Endpoints            []string `json:"endpoints"`
	}
	if err := json.Unmarshal(resp.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out.Object != "cloudagent.capabilities" || out.Protocol != "cloudagent.session_events" || out.Version != "v1" || !out.SessionEventProtocol || !out.RunProtocol {
		t.Fatalf("unexpected capabilities response: %#v", out)
	}
	if !stringSliceContains(out.Features, "session_event_submit") || !stringSliceContains(out.Features, "idempotency_key") || !stringSliceContains(out.Features, "last_event_id_replay") || !stringSliceContains(out.Features, "sse_event_stream") || !stringSliceContains(out.Features, "session_close") {
		t.Fatalf("capabilities missing durable protocol features: %#v", out.Features)
	}
	for _, endpoint := range []string{
		"GET /v1/cloudagent/sessions",
		"POST /v1/cloudagent/sessions/{session_id}/close",
		"POST /v1/cloudagent/sessions/{session_id}/events",
		"GET /v1/cloudagent/sessions/{session_id}/events/stream",
	} {
		if !stringSliceContains(out.Endpoints, endpoint) {
			t.Fatalf("capabilities missing endpoint %q: %#v", endpoint, out.Endpoints)
		}
	}
	for _, feature := range []string{"session_list", "internal_run_ledger"} {
		if !stringSliceContains(out.Features, feature) {
			t.Fatalf("capabilities missing feature %q: %#v", feature, out.Features)
		}
	}
}

func TestCloudAgentHTTPSessionClosePersistsClosedSession(t *testing.T) {
	srv, _ := newTestServer(t, FakeWorker{})
	sessionID := createCloudAgentHTTPSession(t, srv)

	closeResp := request(t, srv, http.MethodPost, "/v1/cloudagent/sessions/"+sessionID+"/close", "tenant-a", "project-a", nil, "")
	if closeResp.Code != http.StatusOK {
		t.Fatalf("session close status=%d body=%s", closeResp.Code, closeResp.Body.String())
	}
	var closed map[string]any
	if err := json.Unmarshal(closeResp.Body.Bytes(), &closed); err != nil {
		t.Fatal(err)
	}
	if closed["session_id"] != sessionID || closed["closed"] != true || closed["state"] != string(acpRuntimeStateClosed) {
		t.Fatalf("unexpected close response: %#v", closed)
	}

	loadResp := request(t, srv, http.MethodGet, "/v1/cloudagent/sessions/"+sessionID, "tenant-a", "project-a", nil, "")
	if loadResp.Code != http.StatusOK {
		t.Fatalf("session load status=%d body=%s", loadResp.Code, loadResp.Body.String())
	}
	var loaded map[string]any
	if err := json.Unmarshal(loadResp.Body.Bytes(), &loaded); err != nil {
		t.Fatal(err)
	}
	if loaded["session_id"] != sessionID || loaded["state"] != string(acpRuntimeStateClosed) {
		t.Fatalf("load after close should preserve the same closed session: %#v", loaded)
	}
}

func TestCloudAgentHTTPSessionCloseRejectsOtherScope(t *testing.T) {
	srv, _ := newTestServer(t, FakeWorker{})
	sessionID := createCloudAgentHTTPSession(t, srv)

	closeResp := request(t, srv, http.MethodPost, "/v1/cloudagent/sessions/"+sessionID+"/close", "tenant-b", "project-a", nil, "")
	if closeResp.Code != http.StatusForbidden {
		t.Fatalf("cross-scope close status=%d body=%s", closeResp.Code, closeResp.Body.String())
	}
	if !strings.Contains(closeResp.Body.String(), "session_close_failed") || !strings.Contains(closeResp.Body.String(), "outside caller scope") {
		t.Fatalf("cross-scope close should return structured scope error: %s", closeResp.Body.String())
	}
}

func TestCloudAgentHTTPProtocolListsSessionsAndRuns(t *testing.T) {
	srv, _ := newTestServer(t, FakeWorker{OutputText: "listed"})
	sessionA := createCloudAgentHTTPSession(t, srv)
	sessionB := createCloudAgentHTTPSession(t, srv)
	otherScopeResp := jsonRequest(t, srv, http.MethodPost, "/v1/cloudagent/sessions", "tenant-b", "project-a", map[string]any{})
	if otherScopeResp.Code != http.StatusOK {
		t.Fatalf("other scope session create status=%d body=%s", otherScopeResp.Code, otherScopeResp.Body.String())
	}
	var otherScopeSession struct {
		SessionID string `json:"session_id"`
	}
	if err := json.Unmarshal(otherScopeResp.Body.Bytes(), &otherScopeSession); err != nil {
		t.Fatal(err)
	}

	runA := submitCloudAgentHTTPRun(t, srv, sessionA, "job_list_a", "first")
	runB := submitCloudAgentHTTPRun(t, srv, sessionB, "job_list_b", "second")
	otherRunResp := jsonRequest(t, srv, http.MethodPost, "/v1/cloudagent/sessions/"+otherScopeSession.SessionID+"/runs", "tenant-b", "project-a", map[string]any{
		"run_id": "job_other_scope",
		"text":   "other",
	})
	if otherRunResp.Code != http.StatusOK {
		t.Fatalf("other scope run submit status=%d body=%s", otherRunResp.Code, otherRunResp.Body.String())
	}
	var otherSubmitted cloudAgentRunResponse
	if err := json.Unmarshal(otherRunResp.Body.Bytes(), &otherSubmitted); err != nil {
		t.Fatal(err)
	}
	if otherSubmitted.RunID == "" {
		t.Fatalf("other scope run response missing run_id: %s", otherRunResp.Body.String())
	}
	_ = waitCloudAgentRun(t, srv, runA)
	_ = waitCloudAgentRun(t, srv, runB)
	_ = waitCloudAgentRunWithScope(t, srv, otherSubmitted.RunID, "tenant-b", "project-a")

	sessionsResp := request(t, srv, http.MethodGet, "/v1/cloudagent/sessions?limit=1", "tenant-a", "project-a", nil, "")
	if sessionsResp.Code != http.StatusOK {
		t.Fatalf("list sessions status=%d body=%s", sessionsResp.Code, sessionsResp.Body.String())
	}
	var sessionsList struct {
		Object string           `json:"object"`
		Data   []map[string]any `json:"data"`
	}
	if err := json.Unmarshal(sessionsResp.Body.Bytes(), &sessionsList); err != nil {
		t.Fatal(err)
	}
	if sessionsList.Object != "list" || len(sessionsList.Data) != 1 {
		t.Fatalf("expected limited session list, got %#v", sessionsList)
	}
	if sessionsList.Data[0]["session_id"] == otherScopeSession.SessionID {
		t.Fatalf("session list leaked cross-scope session: %#v", sessionsList.Data)
	}

	runsResp := request(t, srv, http.MethodGet, "/v1/cloudagent/runs?limit=10", "tenant-a", "project-a", nil, "")
	if runsResp.Code != http.StatusOK {
		t.Fatalf("list runs status=%d body=%s", runsResp.Code, runsResp.Body.String())
	}
	var runsList struct {
		Object string                  `json:"object"`
		Data   []cloudAgentRunResponse `json:"data"`
	}
	if err := json.Unmarshal(runsResp.Body.Bytes(), &runsList); err != nil {
		t.Fatal(err)
	}
	if runsList.Object != "list" || !cloudAgentRunListContains(runsList.Data, runA) || !cloudAgentRunListContains(runsList.Data, runB) || cloudAgentRunListContains(runsList.Data, otherSubmitted.RunID) {
		t.Fatalf("unexpected scoped run list: %#v", runsList)
	}

	filteredResp := request(t, srv, http.MethodGet, "/v1/cloudagent/runs?session_id="+sessionA, "tenant-a", "project-a", nil, "")
	if filteredResp.Code != http.StatusOK {
		t.Fatalf("filtered list runs status=%d body=%s", filteredResp.Code, filteredResp.Body.String())
	}
	var filtered struct {
		Data []cloudAgentRunResponse `json:"data"`
	}
	if err := json.Unmarshal(filteredResp.Body.Bytes(), &filtered); err != nil {
		t.Fatal(err)
	}
	if len(filtered.Data) != 1 || filtered.Data[0].RunID != runA || filtered.Data[0].SessionID != sessionA {
		t.Fatalf("expected one run for session %s, got %#v", sessionA, filtered.Data)
	}
}

func TestCloudAgentHTTPProtocolScopeGuardsRuns(t *testing.T) {
	srv, _ := newTestServer(t, FakeWorker{OutputText: "scoped"})
	sessionResp := jsonRequest(t, srv, http.MethodPost, "/v1/cloudagent/sessions", "tenant-a", "project-a", map[string]any{})
	if sessionResp.Code != http.StatusOK {
		t.Fatalf("session create status=%d body=%s", sessionResp.Code, sessionResp.Body.String())
	}
	var session struct {
		SessionID string `json:"session_id"`
	}
	if err := json.Unmarshal(sessionResp.Body.Bytes(), &session); err != nil {
		t.Fatal(err)
	}
	submitResp := jsonRequest(t, srv, http.MethodPost, "/v1/cloudagent/sessions/"+session.SessionID+"/runs", "tenant-a", "project-a", map[string]any{"text": "hi"})
	if submitResp.Code != http.StatusOK {
		t.Fatalf("run submit status=%d body=%s", submitResp.Code, submitResp.Body.String())
	}
	var submitted cloudAgentRunResponse
	if err := json.Unmarshal(submitResp.Body.Bytes(), &submitted); err != nil {
		t.Fatal(err)
	}
	_ = waitCloudAgentRun(t, srv, submitted.RunID)

	denied := request(t, srv, http.MethodGet, "/v1/cloudagent/runs/"+submitted.RunID, "tenant-a", "project-b", nil, "")
	if denied.Code != http.StatusForbidden {
		t.Fatalf("cross-scope run status should be denied, got status=%d body=%s", denied.Code, denied.Body.String())
	}
}

func TestCloudAgentHTTPProtocolStreamsReplayAsQoderSSE(t *testing.T) {
	srv, _ := newTestServer(t, FakeWorker{OutputText: "stream replay"})
	sessionResp := jsonRequest(t, srv, http.MethodPost, "/v1/cloudagent/sessions", "tenant-a", "project-a", map[string]any{})
	if sessionResp.Code != http.StatusOK {
		t.Fatalf("session create status=%d body=%s", sessionResp.Code, sessionResp.Body.String())
	}
	var session struct {
		SessionID string `json:"session_id"`
	}
	if err := json.Unmarshal(sessionResp.Body.Bytes(), &session); err != nil {
		t.Fatal(err)
	}
	submitResp := jsonRequest(t, srv, http.MethodPost, "/v1/cloudagent/sessions/"+session.SessionID+"/runs", "tenant-a", "project-a", map[string]any{"text": "hi"})
	if submitResp.Code != http.StatusOK {
		t.Fatalf("run submit status=%d body=%s", submitResp.Code, submitResp.Body.String())
	}
	var submitted cloudAgentRunResponse
	if err := json.Unmarshal(submitResp.Body.Bytes(), &submitted); err != nil {
		t.Fatal(err)
	}
	_ = waitCloudAgentRun(t, srv, submitted.RunID)

	streamResp := request(t, srv, http.MethodGet, "/v1/cloudagent/runs/"+submitted.RunID+"/events?after_seq=0&stream=true", "tenant-a", "project-a", nil, "")
	if streamResp.Code != http.StatusOK {
		t.Fatalf("stream status=%d body=%s", streamResp.Code, streamResp.Body.String())
	}
	if got := streamResp.Header().Get("Content-Type"); !strings.Contains(got, "text/event-stream") {
		t.Fatalf("stream content-type=%q body=%s", got, streamResp.Body.String())
	}
	body := streamResp.Body.String()
	for _, want := range []string{
		"event: user.message",
		"event: agent.message",
		"event: session.status_idle",
		`"schema_version":"1.0"`,
		`"stop_reason":{"type":"end_turn"}`,
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("stream replay missing %q in:\n%s", want, body)
		}
	}
	if strings.Contains(body, `"type":"event"`) || strings.Contains(body, `"sessionUpdate"`) {
		t.Fatalf("stream replay should not expose internal frame or ACP update shape:\n%s", body)
	}
	var currentID string
	var terminalID string
	for _, line := range strings.Split(body, "\n") {
		if strings.HasPrefix(line, "id: ") {
			currentID = strings.TrimSpace(strings.TrimPrefix(line, "id: "))
		}
		if strings.HasPrefix(line, "event: session.status_idle") {
			terminalID = currentID
		}
	}
	if terminalID == "" || strings.HasSuffix(terminalID, "_terminal") {
		t.Fatalf("terminal SSE event must have a numeric Last-Event-ID-compatible id, got %q in:\n%s", terminalID, body)
	}
	resumeResp := request(t, srv, http.MethodGet, "/v1/cloudagent/runs/"+submitted.RunID+"/events?after_id="+terminalID+"&stream=true", "tenant-a", "project-a", nil, "")
	if resumeResp.Code != http.StatusOK {
		t.Fatalf("terminal after_id should be accepted, status=%d body=%s", resumeResp.Code, resumeResp.Body.String())
	}
}

func TestCloudAgentHTTPProtocolSSECursorsPreferAfterSeqAndSupportLastEventID(t *testing.T) {
	srv, _ := newTestServer(t, FakeWorker{OutputText: "cursor replay"})
	sessionID := createCloudAgentHTTPSession(t, srv)
	runID := submitCloudAgentHTTPRun(t, srv, sessionID, "job_cursor", "cursor input")
	_ = waitCloudAgentRun(t, srv, runID)

	full := request(t, srv, http.MethodGet, "/v1/cloudagent/runs/"+runID+"/events?after_seq=0&stream=true", "tenant-a", "project-a", nil, "")
	if full.Code != http.StatusOK {
		t.Fatalf("full stream status=%d body=%s", full.Code, full.Body.String())
	}
	userID := cloudAgentSSEEventID(full.Body.String(), "user.message")
	terminalID := cloudAgentSSEEventID(full.Body.String(), "session.status_idle")
	if userID == "" || terminalID == "" {
		t.Fatalf("expected user and terminal SSE ids, user=%q terminal=%q body=\n%s", userID, terminalID, full.Body.String())
	}

	afterSeqWins := request(t, srv, http.MethodGet, "/v1/cloudagent/runs/"+runID+"/events?after_seq=1&after_id="+terminalID+"&stream=true", "tenant-a", "project-a", nil, "")
	if afterSeqWins.Code != http.StatusOK {
		t.Fatalf("after_seq stream status=%d body=%s", afterSeqWins.Code, afterSeqWins.Body.String())
	}
	if strings.Contains(afterSeqWins.Body.String(), "event: user.message") || !strings.Contains(afterSeqWins.Body.String(), "event: agent.message") {
		t.Fatalf("after_seq must win over after_id and replay only seq > 1, got:\n%s", afterSeqWins.Body.String())
	}

	req := httptest.NewRequest(http.MethodGet, "/v1/cloudagent/runs/"+runID+"/events?stream=true", nil)
	req.Header.Set("X-Tenant-ID", "tenant-a")
	req.Header.Set("X-Project-ID", "project-a")
	req.Header.Set("Last-Event-ID", userID)
	resp := httptest.NewRecorder()
	srv.Handler().ServeHTTP(resp, req)
	if resp.Code != http.StatusOK {
		t.Fatalf("Last-Event-ID stream status=%d body=%s", resp.Code, resp.Body.String())
	}
	if strings.Contains(resp.Body.String(), "event: user.message") || !strings.Contains(resp.Body.String(), "event: agent.message") {
		t.Fatalf("Last-Event-ID should resume after the supplied event id, got:\n%s", resp.Body.String())
	}
}

func TestCloudAgentHTTPProtocolStreamsErrorsAsSequencedSSE(t *testing.T) {
	srv, _ := newTestServer(t, FakeWorker{OutputText: "unused"})

	resp := request(t, srv, http.MethodGet, "/v1/cloudagent/runs/job_missing/events?after_seq=3&stream=true", "tenant-a", "project-a", nil, "")
	if resp.Code != http.StatusOK {
		t.Fatalf("stream error status=%d body=%s", resp.Code, resp.Body.String())
	}
	body := resp.Body.String()
	for _, want := range []string{
		"id: evt_job_missing_4",
		"event: session.error",
		`"seq":4`,
		`"type":"session.error"`,
		`"run_id":"job_missing"`,
		`"schema_version":"1.0"`,
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("stream error missing %q in:\n%s", want, body)
		}
	}
}

func TestCloudAgentHTTPProtocolFailedRunStreamsPublicSessionError(t *testing.T) {
	srv, _ := newTestServer(t, failingCloudAgentWorker{message: "provider exploded"})
	sessionID := createCloudAgentHTTPSession(t, srv)
	runID := submitCloudAgentHTTPRun(t, srv, sessionID, "job_failed_public_stream", "fail")
	result := waitCloudAgentRun(t, srv, runID)
	if result.Status != "failed" || !strings.Contains(result.Error, "provider exploded") {
		t.Fatalf("expected failed run, got %#v", result)
	}

	resp := request(t, srv, http.MethodGet, "/v1/cloudagent/runs/"+runID+"/events?after_seq=0&stream=true", "tenant-a", "project-a", nil, "")
	if resp.Code != http.StatusOK {
		t.Fatalf("failed stream status=%d body=%s", resp.Code, resp.Body.String())
	}
	body := resp.Body.String()
	for _, want := range []string{
		"event: user.message",
		"event: session.error",
		`"type":"session.error"`,
		`"status":"error"`,
		"provider exploded",
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("failed stream missing %q in:\n%s", want, body)
		}
	}
	if strings.Contains(body, `"type":"event"`) || strings.Contains(body, `"sessionUpdate"`) {
		t.Fatalf("failed stream leaked internal event shape:\n%s", body)
	}

	replay := request(t, srv, http.MethodGet, "/v1/cloudagent/runs/"+runID+"/events?after_seq=0", "tenant-a", "project-a", nil, "")
	if replay.Code != http.StatusOK {
		t.Fatalf("failed replay status=%d body=%s", replay.Code, replay.Body.String())
	}
	replayBody := replay.Body.String()
	for _, want := range []string{`"type":"session.error"`, "provider exploded"} {
		if !strings.Contains(replayBody, want) {
			t.Fatalf("failed non-stream replay missing %q in:\n%s", want, replayBody)
		}
	}
	if strings.Contains(replayBody, `"sessionUpdate"`) || strings.Contains(replayBody, `"type":"agent.raw"`) {
		t.Fatalf("failed non-stream replay leaked internal event shape:\n%s", replayBody)
	}
}

func TestCloudAgentPublicRunEventPreservesToolResultContent(t *testing.T) {
	event := cloudAgentRunEvent{
		Seq:       1,
		RunID:     "job_tool",
		SessionID: "session_tool",
		Kind:      "tool_call_update",
		Event: json.RawMessage(`{
			"sessionUpdate":"tool_call_update",
			"toolCallId":"call_1",
			"name":"terminal",
			"status":"completed",
			"content":[{"type":"content","content":"ok"}]
		}`),
		CreatedAt: time.Now().UTC(),
	}
	public := cloudAgentPublicRunEvent(event)
	if public["type"] != "agent.tool_result" || public["tool_use_id"] != "call_1" {
		t.Fatalf("unexpected public tool event: %#v", public)
	}
	content, ok := public["content"].([]map[string]any)
	if !ok || len(content) != 1 || content[0]["text"] != "ok" {
		t.Fatalf("tool result content was not preserved: %#v", public["content"])
	}
}

func TestCloudAgentHTTPProtocolSubmitIdempotencyKeyIsIdempotent(t *testing.T) {
	worker := &countingWorker{FakeWorker: FakeWorker{OutputText: "once"}}
	srv, _ := newTestServer(t, worker)
	sessionResp := jsonRequest(t, srv, http.MethodPost, "/v1/cloudagent/sessions", "tenant-a", "project-a", map[string]any{})
	if sessionResp.Code != http.StatusOK {
		t.Fatalf("session create status=%d body=%s", sessionResp.Code, sessionResp.Body.String())
	}
	var session struct {
		SessionID string `json:"session_id"`
	}
	if err := json.Unmarshal(sessionResp.Body.Bytes(), &session); err != nil {
		t.Fatal(err)
	}
	body := map[string]any{"run_id": "job_idempotent", "text": "hi"}
	first := jsonRequest(t, srv, http.MethodPost, "/v1/cloudagent/sessions/"+session.SessionID+"/runs", "tenant-a", "project-a", body)
	if first.Code != http.StatusOK {
		t.Fatalf("first submit status=%d body=%s", first.Code, first.Body.String())
	}
	var firstRun cloudAgentRunResponse
	if err := json.Unmarshal(first.Body.Bytes(), &firstRun); err != nil {
		t.Fatal(err)
	}
	if firstRun.RunID == "" || firstRun.RunID == "job_idempotent" || firstRun.IdempotencyKey != "job_idempotent" {
		t.Fatalf("first submit should return server-generated run id and preserve idempotency key, got %#v", firstRun)
	}
	result := waitCloudAgentRun(t, srv, firstRun.RunID)
	if result.OutputText != "once" {
		t.Fatalf("unexpected first result: %#v", result)
	}
	second := jsonRequest(t, srv, http.MethodPost, "/v1/cloudagent/sessions/"+session.SessionID+"/runs", "tenant-a", "project-a", body)
	if second.Code != http.StatusOK {
		t.Fatalf("second submit status=%d body=%s", second.Code, second.Body.String())
	}
	var secondResult cloudAgentRunResponse
	if err := json.Unmarshal(second.Body.Bytes(), &secondResult); err != nil {
		t.Fatal(err)
	}
	if secondResult.RunID != firstRun.RunID || secondResult.IdempotencyKey != "job_idempotent" || secondResult.Status != "completed" || secondResult.OutputText != "once" {
		t.Fatalf("duplicate submit should return existing run, got %#v", secondResult)
	}
	if got := worker.calls.Load(); got != 1 {
		t.Fatalf("duplicate idempotency key must execute worker once, got %d", got)
	}
}

func TestCloudAgentHTTPProtocolIdempotencyHeaderOverridesBodyRunID(t *testing.T) {
	worker := &countingWorker{FakeWorker: FakeWorker{OutputText: "header wins"}}
	srv, _ := newTestServer(t, worker)
	sessionID := createCloudAgentHTTPSession(t, srv)

	first := jsonRequestWithHeaders(t, srv, http.MethodPost, "/v1/cloudagent/sessions/"+sessionID+"/runs", "tenant-a", "project-a", map[string]any{
		"run_id": "body_key_one",
		"text":   "same text",
	}, map[string]string{"Idempotency-Key": "header_key"})
	if first.Code != http.StatusOK {
		t.Fatalf("first submit status=%d body=%s", first.Code, first.Body.String())
	}
	var firstRun cloudAgentRunResponse
	if err := json.Unmarshal(first.Body.Bytes(), &firstRun); err != nil {
		t.Fatal(err)
	}
	if firstRun.IdempotencyKey != "header_key" || firstRun.RunID == "header_key" || firstRun.RunID == "body_key_one" {
		t.Fatalf("header idempotency key should override body run_id and server should generate run_id, got %#v", firstRun)
	}
	_ = waitCloudAgentRun(t, srv, firstRun.RunID)

	duplicate := jsonRequestWithHeaders(t, srv, http.MethodPost, "/v1/cloudagent/sessions/"+sessionID+"/runs", "tenant-a", "project-a", map[string]any{
		"run_id": "body_key_two",
		"text":   "same text",
	}, map[string]string{"Idempotency-Key": "header_key"})
	if duplicate.Code != http.StatusOK {
		t.Fatalf("duplicate submit status=%d body=%s", duplicate.Code, duplicate.Body.String())
	}
	var duplicateRun cloudAgentRunResponse
	if err := json.Unmarshal(duplicate.Body.Bytes(), &duplicateRun); err != nil {
		t.Fatal(err)
	}
	if duplicateRun.RunID != firstRun.RunID || duplicateRun.IdempotencyKey != "header_key" {
		t.Fatalf("body run_id changes must not affect header idempotency, got %#v want run_id %s", duplicateRun, firstRun.RunID)
	}

	conflict := jsonRequestWithHeaders(t, srv, http.MethodPost, "/v1/cloudagent/sessions/"+sessionID+"/runs", "tenant-a", "project-a", map[string]any{
		"run_id": "body_key_three",
		"text":   "different text",
	}, map[string]string{"Idempotency-Key": "header_key"})
	if conflict.Code != http.StatusConflict {
		t.Fatalf("same idempotency key with different body should conflict, status=%d body=%s", conflict.Code, conflict.Body.String())
	}
	if !strings.Contains(conflict.Body.String(), "idempotency key reused with a different request body") {
		t.Fatalf("conflict should explain idempotency mismatch, body=%s", conflict.Body.String())
	}
	if got := worker.calls.Load(); got != 1 {
		t.Fatalf("conflicting duplicate must not execute worker again, got %d calls", got)
	}
}

func TestCloudAgentHTTPProtocolRejectsUnsafeRunIDAtSubmit(t *testing.T) {
	srv, _ := newTestServer(t, FakeWorker{OutputText: "unused"})
	sessionID := createCloudAgentHTTPSession(t, srv)
	resp := jsonRequest(t, srv, http.MethodPost, "/v1/cloudagent/sessions/"+sessionID+"/runs", "tenant-a", "project-a", map[string]any{
		"run_id": "../escape",
		"text":   "should not start",
	})
	if resp.Code != http.StatusBadRequest {
		t.Fatalf("unsafe run id should be rejected before dispatch, status=%d body=%s", resp.Code, resp.Body.String())
	}
	if _, err := srv.store.LoadCloudAgentRun(Scope{TenantID: "tenant-a", ProjectID: "project-a"}, "../escape"); err == nil {
		t.Fatal("unsafe run id must not leave a durable run record")
	}
}

func TestCloudAgentHTTPProtocolRejectsUnsafeRunIDBeforeRuntimeRecovery(t *testing.T) {
	manager := &recordingACPRuntimeManager{}
	srv := newACPTestServerWithRuntime(t, manager)
	sessionID := createCloudAgentHTTPSession(t, srv)
	srv.acpGate.mu.Lock()
	session := srv.acpGate.sessions[sessionID]
	session.Closed = true
	session.State = acpRuntimeStateClosed
	session.Runtime.RuntimeID = "old_runtime"
	session.Runtime.OuterSandboxID = "old_outer"
	srv.acpGate.persistSession(session)
	srv.acpGate.mu.Unlock()
	manager.mu.Lock()
	startsBefore := len(manager.starts)
	manager.mu.Unlock()

	resp := jsonRequest(t, srv, http.MethodPost, "/v1/cloudagent/sessions/"+sessionID+"/runs", "tenant-a", "project-a", map[string]any{
		"run_id": "../escape",
		"text":   "must not recover runtime",
	})
	if resp.Code != http.StatusBadRequest {
		t.Fatalf("unsafe run id should be rejected before runtime recovery, status=%d body=%s", resp.Code, resp.Body.String())
	}
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if got := len(manager.starts); got != startsBefore {
		t.Fatalf("unsafe run id should not start/recover runtime, starts before=%d after=%d", startsBefore, got)
	}
}

func TestCloudAgentHTTPProtocolScopesIdempotencyKeyToSession(t *testing.T) {
	worker := &countingWorker{FakeWorker: FakeWorker{OutputText: "ok"}}
	srv, _ := newTestServer(t, worker)
	sessionA := createCloudAgentHTTPSession(t, srv)
	sessionB := createCloudAgentHTTPSession(t, srv)
	body := map[string]any{"run_id": "shared_key", "text": "same external key, different sessions"}
	first := jsonRequest(t, srv, http.MethodPost, "/v1/cloudagent/sessions/"+sessionA+"/runs", "tenant-a", "project-a", body)
	if first.Code != http.StatusOK {
		t.Fatalf("first submit status=%d body=%s", first.Code, first.Body.String())
	}
	second := jsonRequest(t, srv, http.MethodPost, "/v1/cloudagent/sessions/"+sessionB+"/runs", "tenant-a", "project-a", body)
	if second.Code != http.StatusOK {
		t.Fatalf("second submit status=%d body=%s", second.Code, second.Body.String())
	}
	var firstRun, secondRun cloudAgentRunResponse
	if err := json.Unmarshal(first.Body.Bytes(), &firstRun); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(second.Body.Bytes(), &secondRun); err != nil {
		t.Fatal(err)
	}
	if firstRun.RunID == "" || secondRun.RunID == "" || firstRun.RunID == secondRun.RunID {
		t.Fatalf("same idempotency key in different sessions must create distinct server runs: first=%#v second=%#v", firstRun, secondRun)
	}
	if firstRun.IdempotencyKey != "shared_key" || secondRun.IdempotencyKey != "shared_key" {
		t.Fatalf("responses should expose stable idempotency key: first=%#v second=%#v", firstRun, secondRun)
	}
	waitCloudAgentRun(t, srv, firstRun.RunID)
	waitCloudAgentRun(t, srv, secondRun.RunID)
	if got := worker.calls.Load(); got != 2 {
		t.Fatalf("different sessions must execute independently, got %d calls", got)
	}
}

func TestCloudAgentHTTPProtocolDuplicateSubmitDispatchesReservedUnstartedRun(t *testing.T) {
	worker := &countingWorker{FakeWorker: FakeWorker{OutputText: "recovered dispatch"}}
	srv, _ := newTestServer(t, worker)
	sessionResp := jsonRequest(t, srv, http.MethodPost, "/v1/cloudagent/sessions", "tenant-a", "project-a", map[string]any{})
	if sessionResp.Code != http.StatusOK {
		t.Fatalf("session create status=%d body=%s", sessionResp.Code, sessionResp.Body.String())
	}
	var session struct {
		SessionID string `json:"session_id"`
	}
	if err := json.Unmarshal(sessionResp.Body.Bytes(), &session); err != nil {
		t.Fatal(err)
	}
	fingerprint := cloudAgentRunRequestFingerprint(cloudAgentSubmitRunRequest{Text: "recover this"})
	if _, existed, err := srv.store.TryReserveCloudAgentRun(Scope{TenantID: "tenant-a", ProjectID: "project-a"}, "job_reserved_unstarted", session.SessionID, "job_reserved_unstarted", fingerprint); err != nil || existed {
		t.Fatalf("reserve unstarted run existed=%t err=%v", existed, err)
	}
	submit := jsonRequest(t, srv, http.MethodPost, "/v1/cloudagent/sessions/"+session.SessionID+"/runs", "tenant-a", "project-a", map[string]any{
		"run_id": "job_reserved_unstarted",
		"text":   "recover this",
	})
	if submit.Code != http.StatusOK {
		t.Fatalf("submit reserved unstarted run status=%d body=%s", submit.Code, submit.Body.String())
	}
	result := waitCloudAgentRun(t, srv, "job_reserved_unstarted")
	if result.Status != "completed" || result.OutputText != "recovered dispatch" {
		t.Fatalf("reserved unstarted run should dispatch and complete, got %#v", result)
	}
	if got := worker.calls.Load(); got != 1 {
		t.Fatalf("reserved unstarted run should execute exactly once, got %d", got)
	}
	stored, err := srv.store.LoadCloudAgentRun(Scope{TenantID: "tenant-a", ProjectID: "project-a"}, "job_reserved_unstarted")
	if err != nil {
		t.Fatalf("load stored run: %v", err)
	}
	if stored.TurnID == "" || stored.ResponseID == "" {
		t.Fatalf("dispatched run should be bound to turn/response, got %#v", stored)
	}
}

func TestCloudAgentHTTPProtocolRunSurvivesSubmitRequestCancellation(t *testing.T) {
	worker := &blockingCloudAgentWorker{
		FakeWorker: FakeWorker{OutputText: "durable after submit disconnect"},
		started:    make(chan struct{}, 1),
		release:    make(chan struct{}),
	}
	srv, _ := newTestServer(t, worker)
	sessionID := createCloudAgentHTTPSession(t, srv)
	raw, err := json.Marshal(map[string]any{"run_id": "job_submit_disconnect", "text": "keep running"})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	req := httptest.NewRequest(http.MethodPost, "/v1/cloudagent/sessions/"+sessionID+"/runs", bytes.NewReader(raw)).WithContext(ctx)
	req.Header.Set("X-Tenant-ID", "tenant-a")
	req.Header.Set("X-Project-ID", "project-a")
	req.Header.Set("Content-Type", "application/json")
	resp := httptest.NewRecorder()

	srv.Handler().ServeHTTP(resp, req)
	if resp.Code != http.StatusOK {
		t.Fatalf("run submit status=%d body=%s", resp.Code, resp.Body.String())
	}
	var submitted cloudAgentRunResponse
	if err := json.Unmarshal(resp.Body.Bytes(), &submitted); err != nil {
		t.Fatal(err)
	}
	if submitted.RunID == "" || submitted.RunID == "job_submit_disconnect" || submitted.IdempotencyKey != "job_submit_disconnect" {
		t.Fatalf("unexpected submitted run: %#v", submitted)
	}
	select {
	case <-worker.started:
	case <-time.After(time.Second):
		t.Fatal("worker did not start after cloudagent run submit")
	}

	cancel()
	time.Sleep(50 * time.Millisecond)
	close(worker.release)
	result := waitCloudAgentRun(t, srv, submitted.RunID)
	if result.Status != "completed" || result.OutputText != "durable after submit disconnect" {
		t.Fatalf("cloudagent run should outlive submit request cancellation, got %#v", result)
	}
}

func TestCloudAgentHTTPProtocolFailsRunWhenEventLedgerAppendFails(t *testing.T) {
	worker := &waitingEmitCloudAgentWorker{
		started: make(chan struct{}, 1),
		release: make(chan struct{}),
	}
	srv, store := newTestServer(t, worker)
	sessionID := createCloudAgentHTTPSession(t, srv)
	submit := jsonRequest(t, srv, http.MethodPost, "/v1/cloudagent/sessions/"+sessionID+"/runs", "tenant-a", "project-a", map[string]any{
		"run_id": "job_event_append_failure",
		"text":   "event ledger must be durable",
	})
	if submit.Code != http.StatusOK {
		t.Fatalf("submit status=%d body=%s", submit.Code, submit.Body.String())
	}
	var submitted cloudAgentRunResponse
	if err := json.Unmarshal(submit.Body.Bytes(), &submitted); err != nil {
		t.Fatal(err)
	}
	select {
	case <-worker.started:
	case <-time.After(time.Second):
		t.Fatal("worker did not start")
	}
	store.SetFailCloudAgentEventAppend(true)
	close(worker.release)
	result := waitCloudAgentRun(t, srv, submitted.RunID)
	if result.Status != "failed" || result.StopReason != "failed" {
		t.Fatalf("run should fail when durable event append fails, got %#v", result)
	}
	if !strings.Contains(result.Error, "cloudagent run event append disabled") {
		t.Fatalf("run failure should expose event ledger error, got %#v", result)
	}
}

func TestCloudAgentHTTPProtocolDuplicateRunIDAcrossGatewayInstancesExecutesOnce(t *testing.T) {
	root := t.TempDir()
	storeA, err := NewStore(root)
	if err != nil {
		t.Fatal(err)
	}
	storeB, err := NewStore(root)
	if err != nil {
		t.Fatal(err)
	}
	workerA := &blockingCloudAgentWorker{
		FakeWorker: FakeWorker{OutputText: "completed by gateway a"},
		started:    make(chan struct{}, 1),
		release:    make(chan struct{}),
	}
	workerB := &countingWorker{FakeWorker: FakeWorker{OutputText: "should not execute"}}
	gatewayA := NewServer(storeA, workerA)
	gatewayB := NewServer(storeB, workerB)
	sessionID := createCloudAgentHTTPSession(t, gatewayA)

	first := jsonRequest(t, gatewayA, http.MethodPost, "/v1/cloudagent/sessions/"+sessionID+"/runs", "tenant-a", "project-a", map[string]any{
		"run_id": "job_cross_gateway",
		"text":   "do it once",
	})
	if first.Code != http.StatusOK {
		t.Fatalf("first submit status=%d body=%s", first.Code, first.Body.String())
	}
	var firstRun cloudAgentRunResponse
	if err := json.Unmarshal(first.Body.Bytes(), &firstRun); err != nil {
		t.Fatal(err)
	}
	if firstRun.RunID == "" || firstRun.RunID == "job_cross_gateway" || firstRun.IdempotencyKey != "job_cross_gateway" {
		t.Fatalf("first submit should return server-generated run id and preserve idempotency key, got %#v", firstRun)
	}
	select {
	case <-workerA.started:
	case <-time.After(time.Second):
		t.Fatal("gateway A worker did not start")
	}

	second := jsonRequest(t, gatewayB, http.MethodPost, "/v1/cloudagent/sessions/"+sessionID+"/runs", "tenant-a", "project-a", map[string]any{
		"run_id": "job_cross_gateway",
		"text":   "do it once",
	})
	if second.Code != http.StatusOK {
		t.Fatalf("second submit status=%d body=%s", second.Code, second.Body.String())
	}
	var duplicate cloudAgentRunResponse
	if err := json.Unmarshal(second.Body.Bytes(), &duplicate); err != nil {
		t.Fatal(err)
	}
	if duplicate.RunID != firstRun.RunID || duplicate.IdempotencyKey != "job_cross_gateway" || duplicate.Status != "running" {
		t.Fatalf("duplicate submit should return existing running run, got %#v", duplicate)
	}
	if got := workerB.calls.Load(); got != 0 {
		t.Fatalf("duplicate run on second gateway must not execute worker, got %d calls", got)
	}

	close(workerA.release)
	result := waitCloudAgentRun(t, gatewayB, firstRun.RunID)
	if result.Status != "completed" || result.OutputText != "completed by gateway a" {
		t.Fatalf("second gateway should observe first gateway result, got %#v", result)
	}
	if got := workerB.calls.Load(); got != 0 {
		t.Fatalf("second gateway must still not execute duplicate run, got %d calls", got)
	}
}

func TestCloudAgentHTTPProtocolStreamsAppendOnlyEventsAcrossGatewayInstances(t *testing.T) {
	root := t.TempDir()
	storeA, err := NewStore(root)
	if err != nil {
		t.Fatal(err)
	}
	storeB, err := NewStore(root)
	if err != nil {
		t.Fatal(err)
	}
	workerA := &stagedCloudAgentWorker{
		started: make(chan struct{}, 1),
		release: make(chan struct{}),
	}
	gatewayA := NewServer(storeA, workerA)
	gatewayB := NewServer(storeB, FakeWorker{OutputText: "should not run"})
	sessionID := createCloudAgentHTTPSession(t, gatewayA)

	submit := jsonRequest(t, gatewayA, http.MethodPost, "/v1/cloudagent/sessions/"+sessionID+"/runs", "tenant-a", "project-a", map[string]any{
		"run_id": "job_cross_gateway_stream",
		"text":   "stream from gateway b",
	})
	if submit.Code != http.StatusOK {
		t.Fatalf("submit status=%d body=%s", submit.Code, submit.Body.String())
	}
	var submitted cloudAgentRunResponse
	if err := json.Unmarshal(submit.Body.Bytes(), &submitted); err != nil {
		t.Fatal(err)
	}
	if submitted.RunID == "" || submitted.RunID == "job_cross_gateway_stream" {
		t.Fatalf("submit should return server-generated run id, got %#v", submitted)
	}
	select {
	case <-workerA.started:
	case <-time.After(time.Second):
		t.Fatal("gateway A worker did not emit first event")
	}

	streamDone := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		streamDone <- request(t, gatewayB, http.MethodGet, "/v1/cloudagent/runs/"+submitted.RunID+"/events?after_seq=0&stream=true", "tenant-a", "project-a", nil, "")
	}()
	time.Sleep(100 * time.Millisecond)
	close(workerA.release)
	var streamResp *httptest.ResponseRecorder
	select {
	case streamResp = <-streamDone:
	case <-time.After(3 * time.Second):
		t.Fatal("cross-gateway event stream did not finish")
	}
	if streamResp.Code != http.StatusOK {
		t.Fatalf("stream status=%d body=%s", streamResp.Code, streamResp.Body.String())
	}
	body := streamResp.Body.String()
	for _, want := range []string{
		`event: user.message`,
		`event: agent.message`,
		`stream from gateway b`,
		`first `,
		`second`,
		`event: session.status_idle`,
		`"status":"idle"`,
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("cross-gateway stream missing %q in:\n%s", want, body)
		}
	}
	if strings.Count(body, "event: agent.message") < 2 || strings.Count(body, "event: user.message") < 1 {
		t.Fatalf("cross-gateway stream should expose append-only user + two assistant events, got:\n%s", body)
	}
	if strings.Contains(body, `"sessionUpdate"`) {
		t.Fatalf("cross-gateway stream must not expose ACP update shape:\n%s", body)
	}
}

func TestCloudAgentHTTPProtocolStreamHeartbeatsBeforeClientTimeout(t *testing.T) {
	original := cloudAgentRunStreamHeartbeatInterval
	cloudAgentRunStreamHeartbeatInterval = 10 * time.Millisecond
	t.Cleanup(func() {
		cloudAgentRunStreamHeartbeatInterval = original
	})
	srv, _ := newTestServer(t, FakeWorker{OutputText: "unused"})
	sessionID := createCloudAgentHTTPSession(t, srv)
	if err := srv.store.CreateCloudAgentRun(cloudAgentRunRecord{
		RunID:     "job_stream_heartbeat",
		SessionID: sessionID,
		Status:    "running",
	}); err != nil {
		t.Fatal(err)
	}

	resp := request(t, srv, http.MethodGet, "/v1/cloudagent/runs/job_stream_heartbeat/events?after_seq=7&stream=true", "tenant-a", "project-a", nil, "")
	if resp.Code != http.StatusOK {
		t.Fatalf("stream status=%d body=%s", resp.Code, resp.Body.String())
	}
	body := resp.Body.String()
	if !strings.Contains(body, `"type":"heartbeat"`) || !strings.Contains(body, `"after_seq":7`) {
		t.Fatalf("idle stream should return heartbeat frame with last committed seq, got:\n%s", body)
	}
}

func TestCloudAgentHTTPProtocolRejectsInvalidAfterSeq(t *testing.T) {
	srv, _ := newTestServer(t, FakeWorker{OutputText: "unused"})
	sessionID := createCloudAgentHTTPSession(t, srv)
	if err := srv.store.CreateCloudAgentRun(cloudAgentRunRecord{
		RunID:     "job_invalid_after_seq",
		SessionID: sessionID,
		Status:    "running",
	}); err != nil {
		t.Fatal(err)
	}

	for _, target := range []string{
		"/v1/cloudagent/runs/job_invalid_after_seq/events?after_seq=not-a-number",
		"/v1/cloudagent/runs/job_invalid_after_seq/events?after_seq=-1",
		"/v1/cloudagent/runs/job_invalid_after_seq/events?after_seq=not-a-number&stream=true",
	} {
		resp := request(t, srv, http.MethodGet, target, "tenant-a", "project-a", nil, "")
		if resp.Code != http.StatusBadRequest {
			t.Fatalf("invalid after_seq target %s should return 400, got status=%d body=%s", target, resp.Code, resp.Body.String())
		}
		if !strings.Contains(resp.Body.String(), "invalid_after_seq") {
			t.Fatalf("invalid after_seq response should expose protocol error code, got %s", resp.Body.String())
		}
	}
}

func TestCloudAgentHTTPProtocolRejectsInvalidEventCursors(t *testing.T) {
	srv, _ := newTestServer(t, FakeWorker{OutputText: "unused"})
	sessionID := createCloudAgentHTTPSession(t, srv)
	if err := srv.store.CreateCloudAgentRun(cloudAgentRunRecord{
		RunID:     "job_invalid_cursor",
		SessionID: sessionID,
		Status:    "running",
	}); err != nil {
		t.Fatal(err)
	}

	for _, target := range []string{
		"/v1/cloudagent/runs/job_invalid_cursor/events?after_id=evt_job_invalid_cursor_terminal",
		"/v1/cloudagent/runs/job_invalid_cursor/events?after_id=not-an-event-id&stream=true",
	} {
		resp := request(t, srv, http.MethodGet, target, "tenant-a", "project-a", nil, "")
		if resp.Code != http.StatusBadRequest {
			t.Fatalf("invalid event cursor target %s should return 400, got status=%d body=%s", target, resp.Code, resp.Body.String())
		}
		if !strings.Contains(resp.Body.String(), "invalid_after_seq") {
			t.Fatalf("invalid event cursor response should expose protocol error code, got %s", resp.Body.String())
		}
	}

	req := httptest.NewRequest(http.MethodGet, "/v1/cloudagent/runs/job_invalid_cursor/events?stream=true", nil)
	req.Header.Set("X-Tenant-ID", "tenant-a")
	req.Header.Set("X-Project-ID", "project-a")
	req.Header.Set("Last-Event-ID", "evt_job_invalid_cursor_terminal")
	resp := httptest.NewRecorder()
	srv.Handler().ServeHTTP(resp, req)
	if resp.Code != http.StatusBadRequest {
		t.Fatalf("invalid Last-Event-ID should return 400, got status=%d body=%s", resp.Code, resp.Body.String())
	}
	if !strings.Contains(resp.Body.String(), "invalid_after_seq") {
		t.Fatalf("invalid Last-Event-ID response should expose protocol error code, got %s", resp.Body.String())
	}
}

func TestCloudAgentHTTPProtocolReconcilesCompletedRunFromRuntimeLedger(t *testing.T) {
	manager := &recordingACPRuntimeManager{
		status: ACPSessionRuntimeStatusSnapshot{
			RunLedgerTail: []ACPSessionRuntimeRunRecord{
				{RunID: "job_reconcile_done", Status: "succeeded"},
			},
		},
		runResult: ACPSessionRuntimeRunResult{
			RunID:      "job_reconcile_done",
			Status:     "completed",
			StopReason: "end_turn",
			OutputText: "recovered from sidecar",
		},
	}
	srv := newACPTestServerWithRuntime(t, manager)
	sessionID := createCloudAgentHTTPSession(t, srv)
	if err := srv.store.CreateCloudAgentRun(cloudAgentRunRecord{
		RunID:     "job_reconcile_done",
		SessionID: sessionID,
		Status:    "running",
	}); err != nil {
		t.Fatal(err)
	}

	resp := request(t, srv, http.MethodGet, "/v1/cloudagent/runs/job_reconcile_done/result", "tenant-a", "project-a", nil, "")
	if resp.Code != http.StatusOK {
		t.Fatalf("result status=%d body=%s", resp.Code, resp.Body.String())
	}
	var result cloudAgentRunResponse
	if err := json.Unmarshal(resp.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Status != "completed" || result.StopReason != "end_turn" {
		t.Fatalf("runtime terminal status should be reconciled, got %#v", result)
	}
	if result.OutputText != "recovered from sidecar" {
		t.Fatalf("runtime result output should be recovered, got %#v", result)
	}
}

func TestCloudAgentHTTPProtocolReconcilesFailedRunFromRuntimeLedger(t *testing.T) {
	manager := &recordingACPRuntimeManager{
		status: ACPSessionRuntimeStatusSnapshot{
			RunLedgerTail: []ACPSessionRuntimeRunRecord{
				{RunID: "job_reconcile_failed", Status: "failed", ErrorCode: "runtime_error", ErrorMessage: "sandbox crashed"},
			},
		},
	}
	srv := newACPTestServerWithRuntime(t, manager)
	sessionID := createCloudAgentHTTPSession(t, srv)
	if err := srv.store.CreateCloudAgentRun(cloudAgentRunRecord{
		RunID:     "job_reconcile_failed",
		SessionID: sessionID,
		Status:    "running",
	}); err != nil {
		t.Fatal(err)
	}

	resp := request(t, srv, http.MethodGet, "/v1/cloudagent/runs/job_reconcile_failed", "tenant-a", "project-a", nil, "")
	if resp.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
	}
	var result cloudAgentRunResponse
	if err := json.Unmarshal(resp.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Status != "failed" || result.StopReason != "failed" || result.Error != "sandbox crashed" {
		t.Fatalf("runtime failed status should be reconciled, got %#v", result)
	}
}

func TestCloudAgentHTTPProtocolReplaysRuntimeEventsAfterGatewayLedgerLoss(t *testing.T) {
	manager := &recordingACPRuntimeManager{
		status: ACPSessionRuntimeStatusSnapshot{
			RunLedgerTail: []ACPSessionRuntimeRunRecord{
				{RunID: "job_replay_sidecar", Status: "succeeded"},
			},
		},
		runResult: ACPSessionRuntimeRunResult{
			RunID:      "job_replay_sidecar",
			Status:     "completed",
			StopReason: "end_turn",
			OutputText: "runtime replayed answer",
		},
		runEvents: []ACPSessionRuntimeRunEvent{
			{
				Seq: 1,
				Event: workerEvent{
					WorkerContractVersion: WorkerContractVersion,
					JobID:                 "job_replay_sidecar",
					Sequence:              1,
					Kind:                  "output_text_delta",
					Delta:                 "runtime replayed answer",
				},
			},
		},
	}
	srv := newACPTestServerWithRuntime(t, manager)
	sessionID := createCloudAgentHTTPSession(t, srv)
	turn, err := srv.store.BeginACPPromptTurn(sessionID, "resp_replay_sidecar", "remember this", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := srv.store.CreateCloudAgentRun(cloudAgentRunRecord{
		RunID:      "job_replay_sidecar",
		SessionID:  sessionID,
		TurnID:     turn.TurnID,
		ResponseID: "resp_replay_sidecar",
		Status:     "running",
	}); err != nil {
		t.Fatal(err)
	}

	resp := request(t, srv, http.MethodGet, "/v1/cloudagent/runs/job_replay_sidecar/events?after_seq=1", "tenant-a", "project-a", nil, "")
	if resp.Code != http.StatusOK {
		t.Fatalf("events status=%d body=%s", resp.Code, resp.Body.String())
	}
	var replay struct {
		Run    cloudAgentRunResponse `json:"run"`
		Events []map[string]any      `json:"events"`
	}
	if err := json.Unmarshal(resp.Body.Bytes(), &replay); err != nil {
		t.Fatal(err)
	}
	if replay.Run.Status != "completed" || replay.Run.OutputText != "runtime replayed answer" {
		t.Fatalf("run should reconcile while replaying runtime events, got %#v", replay.Run)
	}
	if len(replay.Events) != 1 {
		t.Fatalf("expected one recovered runtime event, got %#v", replay.Events)
	}
	if gotSeq, _ := replay.Events[0]["seq"].(float64); gotSeq != 2 {
		t.Fatalf("runtime event should be offset after local user event, got %#v", replay.Events[0])
	}
	if replay.Events[0]["type"] != "agent.message" || replay.Events[0]["turn_id"] != turn.TurnID {
		t.Fatalf("unexpected recovered event: %#v", replay.Events[0])
	}
	content, ok := replay.Events[0]["content"].([]any)
	if !ok || len(content) != 1 {
		t.Fatalf("unexpected recovered content: %#v", replay.Events[0]["content"])
	}
	block, ok := content[0].(map[string]any)
	if !ok || block["type"] != "text" || block["text"] != "runtime replayed answer" {
		t.Fatalf("unexpected recovered content block: %#v", content)
	}
	manager.mu.Lock()
	manager.runReadErr = errors.New("runtime reader is gone")
	manager.mu.Unlock()
	durableResp := request(t, srv, http.MethodGet, "/v1/cloudagent/runs/job_replay_sidecar/events?after_seq=0", "tenant-a", "project-a", nil, "")
	if durableResp.Code != http.StatusOK {
		t.Fatalf("durable replay status=%d body=%s", durableResp.Code, durableResp.Body.String())
	}
	var durableReplay struct {
		Run    cloudAgentRunResponse `json:"run"`
		Events []map[string]any      `json:"events"`
	}
	if err := json.Unmarshal(durableResp.Body.Bytes(), &durableReplay); err != nil {
		t.Fatal(err)
	}
	if durableReplay.Run.Status != "completed" || durableReplay.Run.OutputText != "runtime replayed answer" {
		t.Fatalf("durable replay should use reconciled run state without runtime reader, got %#v", durableReplay.Run)
	}
	if len(durableReplay.Events) != 2 {
		t.Fatalf("runtime replay import should persist user and assistant events, got %#v", durableReplay.Events)
	}
	if durableReplay.Events[0]["type"] != "user.message" || durableReplay.Events[1]["type"] != "agent.message" {
		t.Fatalf("durable replay should keep public event order and types, got %#v", durableReplay.Events)
	}
}

func TestCloudAgentHTTPProtocolCancelReachesRuntimeAfterGatewayRestart(t *testing.T) {
	store, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	manager := &recordingACPRuntimeManager{}
	first := newACPTestServerWithRuntimeAndStore(store, manager)
	sessionID := createCloudAgentHTTPSession(t, first)
	if err := store.CreateCloudAgentRun(cloudAgentRunRecord{
		RunID:     "job_cancel_after_restart",
		SessionID: sessionID,
		Status:    "running",
	}); err != nil {
		t.Fatal(err)
	}

	restarted := newACPTestServerWithRuntimeAndStore(store, manager)
	resp := request(t, restarted, http.MethodPost, "/v1/cloudagent/runs/job_cancel_after_restart/cancel", "tenant-a", "project-a", nil, "")
	if resp.Code != http.StatusOK {
		t.Fatalf("cancel status=%d body=%s", resp.Code, resp.Body.String())
	}
	var cancelResult cloudAgentRunResponse
	if err := json.Unmarshal(resp.Body.Bytes(), &cancelResult); err != nil {
		t.Fatal(err)
	}
	if cancelResult.Status != "cancelled" || cancelResult.StopReason != "cancelled" {
		t.Fatalf("cancel response should return terminal run state, got %#v", cancelResult)
	}
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if len(manager.cancels) != 1 {
		t.Fatalf("cancel should reach runtime after gateway restart, got %d calls", len(manager.cancels))
	}
	if got := manager.cancelRunIDs[0]; got != "job_cancel_after_restart" {
		t.Fatalf("cancel should target run id, got %q", got)
	}
	if manager.cancels[0].RuntimeID == "" {
		t.Fatalf("cancel should use persisted runtime identity: %#v", manager.cancels[0])
	}
	resultResp := request(t, restarted, http.MethodGet, "/v1/cloudagent/runs/job_cancel_after_restart/result", "tenant-a", "project-a", nil, "")
	if resultResp.Code != http.StatusOK {
		t.Fatalf("cancelled result status=%d body=%s", resultResp.Code, resultResp.Body.String())
	}
	var result cloudAgentRunResponse
	if err := json.Unmarshal(resultResp.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Status != "cancelled" || result.StopReason != "cancelled" {
		t.Fatalf("cancel should persist terminal run state, got %#v", result)
	}
}

func TestCloudAgentHTTPProtocolCancelMarksRunTerminalWhenRuntimeIdentityIsMissing(t *testing.T) {
	store, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	manager := &recordingACPRuntimeManager{}
	first := newACPTestServerWithRuntimeAndStore(store, manager)
	sessionID := createCloudAgentHTTPSession(t, first)
	first.acpGate.mu.Lock()
	session := first.acpGate.sessions[sessionID]
	session.Runtime = ACPSessionRuntime{}
	first.acpGate.persistSession(session)
	first.acpGate.mu.Unlock()
	if err := store.CreateCloudAgentRun(cloudAgentRunRecord{
		RunID:     "job_cancel_missing_runtime",
		SessionID: sessionID,
		Status:    "running",
	}); err != nil {
		t.Fatal(err)
	}

	restarted := newACPTestServerWithRuntimeAndStore(store, manager)
	resp := request(t, restarted, http.MethodPost, "/v1/cloudagent/runs/job_cancel_missing_runtime/cancel", "tenant-a", "project-a", nil, "")
	if resp.Code != http.StatusOK {
		t.Fatalf("cancel without runtime identity should still close durable run, status=%d body=%s", resp.Code, resp.Body.String())
	}
	var cancelResult cloudAgentRunResponse
	if err := json.Unmarshal(resp.Body.Bytes(), &cancelResult); err != nil {
		t.Fatal(err)
	}
	if cancelResult.Status != "cancelled" || cancelResult.StopReason != "cancelled" {
		t.Fatalf("cancel without runtime identity should persist terminal run state, got %#v", cancelResult)
	}
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if len(manager.cancels) != 0 {
		t.Fatalf("missing runtime identity should not call runtime cancel, got %d calls", len(manager.cancels))
	}
}

func waitCloudAgentRun(t *testing.T, srv *Server, runID string) cloudAgentRunResponse {
	return waitCloudAgentRunWithScope(t, srv, runID, "tenant-a", "project-a")
}

func waitCloudAgentRunWithScope(t *testing.T, srv *Server, runID, tenantID, projectID string) cloudAgentRunResponse {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		resp := request(t, srv, http.MethodGet, "/v1/cloudagent/runs/"+runID+"/result", tenantID, projectID, nil, "")
		if resp.Code != http.StatusOK {
			t.Fatalf("run result status=%d body=%s", resp.Code, resp.Body.String())
		}
		var result cloudAgentRunResponse
		if err := json.Unmarshal(resp.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		if cloudAgentRunTerminal(result.Status) {
			return result
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("run %s did not finish", runID)
	return cloudAgentRunResponse{}
}

func createCloudAgentHTTPSession(t *testing.T, srv *Server) string {
	t.Helper()
	sessionResp := jsonRequest(t, srv, http.MethodPost, "/v1/cloudagent/sessions", "tenant-a", "project-a", map[string]any{})
	if sessionResp.Code != http.StatusOK {
		t.Fatalf("session create status=%d body=%s", sessionResp.Code, sessionResp.Body.String())
	}
	var session struct {
		SessionID string `json:"session_id"`
	}
	if err := json.Unmarshal(sessionResp.Body.Bytes(), &session); err != nil {
		t.Fatal(err)
	}
	if session.SessionID == "" {
		t.Fatalf("missing session id: %#v", session)
	}
	return session.SessionID
}

func submitCloudAgentHTTPRun(t *testing.T, srv *Server, sessionID, runID, text string) string {
	t.Helper()
	resp := jsonRequest(t, srv, http.MethodPost, "/v1/cloudagent/sessions/"+sessionID+"/runs", "tenant-a", "project-a", map[string]any{
		"run_id": runID,
		"text":   text,
	})
	if resp.Code != http.StatusOK {
		t.Fatalf("run submit status=%d body=%s", resp.Code, resp.Body.String())
	}
	var submitted cloudAgentRunResponse
	if err := json.Unmarshal(resp.Body.Bytes(), &submitted); err != nil {
		t.Fatal(err)
	}
	if submitted.RunID == "" || submitted.RunID == runID || submitted.SessionID != sessionID || submitted.IdempotencyKey != runID {
		t.Fatalf("unexpected submit response: %#v", submitted)
	}
	return submitted.RunID
}

func jsonRequestWithHeaders(t *testing.T, srv *Server, method, target, tenant, project string, body any, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(method, target, bytes.NewBuffer(raw))
	req.Header.Set("Content-Type", "application/json")
	if tenant != "" {
		req.Header.Set("X-Tenant-ID", tenant)
	}
	if project != "" {
		req.Header.Set("X-Project-ID", project)
	}
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	resp := httptest.NewRecorder()
	srv.Handler().ServeHTTP(resp, req)
	return resp
}

func cloudAgentRunListContains(runs []cloudAgentRunResponse, runID string) bool {
	for _, run := range runs {
		if run.RunID == runID {
			return true
		}
	}
	return false
}

func cloudAgentSSEEventID(body, eventName string) string {
	var currentID string
	for _, line := range strings.Split(body, "\n") {
		if strings.HasPrefix(line, "id: ") {
			currentID = strings.TrimSpace(strings.TrimPrefix(line, "id: "))
			continue
		}
		if strings.TrimSpace(line) == "event: "+eventName {
			return currentID
		}
	}
	return ""
}

type countingWorker struct {
	FakeWorker
	calls atomic.Int64
}

func (w *countingWorker) Run(ctx context.Context, job workerJob, emit func(workerEvent) error) (workerResult, error) {
	w.calls.Add(1)
	return w.FakeWorker.Run(ctx, job, emit)
}

type failingCloudAgentWorker struct {
	message string
}

func (w failingCloudAgentWorker) Run(ctx context.Context, job workerJob, emit func(workerEvent) error) (workerResult, error) {
	return workerResult{}, workerError("provider_error", w.message)
}

func (w failingCloudAgentWorker) FetchArtifact(ctx context.Context, job workerJob, artifact artifactDescriptor) ([]byte, error) {
	return nil, errors.New("no artifact")
}

type blockingCloudAgentWorker struct {
	FakeWorker
	started chan struct{}
	release chan struct{}
}

func (w *blockingCloudAgentWorker) Run(ctx context.Context, job workerJob, emit func(workerEvent) error) (workerResult, error) {
	select {
	case w.started <- struct{}{}:
	default:
	}
	select {
	case <-ctx.Done():
		return workerResult{}, ctx.Err()
	case <-w.release:
	}
	return w.FakeWorker.Run(ctx, job, emit)
}

type stagedCloudAgentWorker struct {
	FakeWorker
	started chan struct{}
	release chan struct{}
}

func (w *stagedCloudAgentWorker) Run(ctx context.Context, job workerJob, emit func(workerEvent) error) (workerResult, error) {
	if err := emit(workerEvent{
		WorkerContractVersion: WorkerContractVersion,
		EventID:               "evt_first",
		JobID:                 job.JobID,
		Sequence:              1,
		Kind:                  "output_text_delta",
		Timestamp:             time.Now().UTC().Unix(),
		Delta:                 "first ",
	}); err != nil {
		return workerResult{}, err
	}
	select {
	case w.started <- struct{}{}:
	default:
	}
	select {
	case <-ctx.Done():
		return workerResult{}, ctx.Err()
	case <-w.release:
	}
	if err := emit(workerEvent{
		WorkerContractVersion: WorkerContractVersion,
		EventID:               "evt_second",
		JobID:                 job.JobID,
		Sequence:              2,
		Kind:                  "output_text_delta",
		Timestamp:             time.Now().UTC().Unix(),
		Delta:                 "second",
	}); err != nil {
		return workerResult{}, err
	}
	return workerResult{
		WorkerContractVersion: WorkerContractVersion,
		JobID:                 job.JobID,
		Status:                "completed",
		OutputText:            "first second",
	}, nil
}

type waitingEmitCloudAgentWorker struct {
	FakeWorker
	started chan struct{}
	release chan struct{}
}

func (w *waitingEmitCloudAgentWorker) Run(ctx context.Context, job workerJob, emit func(workerEvent) error) (workerResult, error) {
	select {
	case w.started <- struct{}{}:
	default:
	}
	select {
	case <-ctx.Done():
		return workerResult{}, ctx.Err()
	case <-w.release:
	}
	if err := emit(workerEvent{
		WorkerContractVersion: WorkerContractVersion,
		EventID:               "evt_append_failure",
		JobID:                 job.JobID,
		Sequence:              1,
		Kind:                  "output_text_delta",
		Timestamp:             time.Now().UTC().Unix(),
		Delta:                 "should fail",
	}); err != nil {
		return workerResult{}, err
	}
	return workerResult{
		WorkerContractVersion: WorkerContractVersion,
		JobID:                 job.JobID,
		Status:                "completed",
		OutputText:            "should fail",
	}, nil
}

func itoa64(value int64) string {
	return fmt.Sprintf("%d", value)
}

func stringSliceContains(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
