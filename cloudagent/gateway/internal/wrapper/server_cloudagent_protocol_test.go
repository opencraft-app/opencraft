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
		Events []cloudAgentRunEvent  `json:"events"`
	}
	if err := json.Unmarshal(eventsResp.Body.Bytes(), &replay); err != nil {
		t.Fatal(err)
	}
	if replay.Run.RunID != submitted.RunID || len(replay.Events) == 0 {
		t.Fatalf("expected replay events for run, got %#v", replay)
	}
	if replay.Events[0].Seq <= 0 || replay.Events[0].SessionID != session.SessionID {
		t.Fatalf("bad replay event identity: %#v", replay.Events[0])
	}
	if replay.Events[0].Kind == "" {
		t.Fatalf("cloudagent protocol events must expose stable kind: %#v", replay.Events[0])
	}

	afterResp := request(t, srv, http.MethodGet, "/v1/cloudagent/runs/"+submitted.RunID+"/events?after_seq="+itoa64(replay.Events[len(replay.Events)-1].Seq), "tenant-a", "project-a", nil, "")
	if afterResp.Code != http.StatusOK {
		t.Fatalf("after events status=%d body=%s", afterResp.Code, afterResp.Body.String())
	}
	var afterReplay struct {
		Events []cloudAgentRunEvent `json:"events"`
	}
	if err := json.Unmarshal(afterResp.Body.Bytes(), &afterReplay); err != nil {
		t.Fatal(err)
	}
	if len(afterReplay.Events) != 0 {
		t.Fatalf("after_seq replay should not repeat old events: %#v", afterReplay.Events)
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
		Object      string   `json:"object"`
		Protocol    string   `json:"protocol"`
		Version     string   `json:"version"`
		RunProtocol bool     `json:"run_protocol"`
		Features    []string `json:"features"`
		Endpoints   []string `json:"endpoints"`
	}
	if err := json.Unmarshal(resp.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out.Object != "cloudagent.capabilities" || out.Protocol != "cloudagent.run" || out.Version != "v1" || !out.RunProtocol {
		t.Fatalf("unexpected capabilities response: %#v", out)
	}
	if !stringSliceContains(out.Features, "after_seq_replay") || !stringSliceContains(out.Features, "idempotent_run_id") {
		t.Fatalf("capabilities missing durable protocol features: %#v", out.Features)
	}
	for _, endpoint := range []string{
		"GET /v1/cloudagent/sessions",
		"GET /v1/cloudagent/runs",
		"GET /v1/cloudagent/runs/{run_id}/events?after_seq=N&stream=true",
	} {
		if !stringSliceContains(out.Endpoints, endpoint) {
			t.Fatalf("capabilities missing endpoint %q: %#v", endpoint, out.Endpoints)
		}
	}
	for _, feature := range []string{"session_list", "run_list"} {
		if !stringSliceContains(out.Features, feature) {
			t.Fatalf("capabilities missing feature %q: %#v", feature, out.Features)
		}
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
	_ = waitCloudAgentRun(t, srv, runA)
	_ = waitCloudAgentRun(t, srv, runB)

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
	if runsList.Object != "list" || !cloudAgentRunListContains(runsList.Data, runA) || !cloudAgentRunListContains(runsList.Data, runB) || cloudAgentRunListContains(runsList.Data, "job_other_scope") {
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

func TestCloudAgentHTTPProtocolStreamsReplayAsNDJSON(t *testing.T) {
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
	body := streamResp.Body.String()
	if !strings.Contains(body, `"type":"event"`) || !strings.Contains(body, `"type":"run"`) || !strings.Contains(body, `"status":"completed"`) {
		t.Fatalf("stream replay should include event and terminal run records, got:\n%s", body)
	}
}

func TestCloudAgentHTTPProtocolSubmitRunIDIsIdempotent(t *testing.T) {
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
	result := waitCloudAgentRun(t, srv, "job_idempotent")
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
	if secondResult.RunID != "job_idempotent" || secondResult.Status != "completed" || secondResult.OutputText != "once" {
		t.Fatalf("duplicate submit should return existing run, got %#v", secondResult)
	}
	if got := worker.calls.Load(); got != 1 {
		t.Fatalf("duplicate run_id must execute worker once, got %d", got)
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

func TestCloudAgentHTTPProtocolRejectsCrossSessionRunIDBeforeRuntimeRecovery(t *testing.T) {
	manager := &recordingACPRuntimeManager{}
	srv := newACPTestServerWithRuntime(t, manager)
	sessionA := createCloudAgentHTTPSession(t, srv)
	sessionB := createCloudAgentHTTPSession(t, srv)
	if err := srv.store.CreateCloudAgentRun(cloudAgentRunRecord{
		RunID:     "job_owned_by_a",
		SessionID: sessionA,
		Status:    "running",
	}); err != nil {
		t.Fatal(err)
	}
	srv.acpGate.mu.Lock()
	session := srv.acpGate.sessions[sessionB]
	session.Closed = true
	session.State = acpRuntimeStateClosed
	session.Runtime.RuntimeID = "old_runtime_b"
	session.Runtime.OuterSandboxID = "old_outer_b"
	srv.acpGate.persistSession(session)
	srv.acpGate.mu.Unlock()
	manager.mu.Lock()
	startsBefore := len(manager.starts)
	manager.mu.Unlock()

	resp := jsonRequest(t, srv, http.MethodPost, "/v1/cloudagent/sessions/"+sessionB+"/runs", "tenant-a", "project-a", map[string]any{
		"run_id": "job_owned_by_a",
		"text":   "must not recover runtime",
	})
	if resp.Code != http.StatusConflict {
		t.Fatalf("cross-session run id should be rejected before runtime recovery, status=%d body=%s", resp.Code, resp.Body.String())
	}
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if got := len(manager.starts); got != startsBefore {
		t.Fatalf("cross-session run id should not start/recover runtime, starts before=%d after=%d", startsBefore, got)
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
	if _, existed, err := srv.store.TryReserveCloudAgentRun(Scope{TenantID: "tenant-a", ProjectID: "project-a"}, "job_reserved_unstarted", session.SessionID); err != nil || existed {
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
	if submitted.RunID != "job_submit_disconnect" {
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
	select {
	case <-worker.started:
	case <-time.After(time.Second):
		t.Fatal("worker did not start")
	}
	store.SetFailCloudAgentEventAppend(true)
	close(worker.release)
	result := waitCloudAgentRun(t, srv, "job_event_append_failure")
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
	select {
	case <-workerA.started:
	case <-time.After(time.Second):
		t.Fatal("gateway A worker did not start")
	}

	second := jsonRequest(t, gatewayB, http.MethodPost, "/v1/cloudagent/sessions/"+sessionID+"/runs", "tenant-a", "project-a", map[string]any{
		"run_id": "job_cross_gateway",
		"text":   "duplicate should only attach",
	})
	if second.Code != http.StatusOK {
		t.Fatalf("second submit status=%d body=%s", second.Code, second.Body.String())
	}
	var duplicate cloudAgentRunResponse
	if err := json.Unmarshal(second.Body.Bytes(), &duplicate); err != nil {
		t.Fatal(err)
	}
	if duplicate.RunID != "job_cross_gateway" || duplicate.Status != "running" {
		t.Fatalf("duplicate submit should return existing running run, got %#v", duplicate)
	}
	if got := workerB.calls.Load(); got != 0 {
		t.Fatalf("duplicate run on second gateway must not execute worker, got %d calls", got)
	}

	close(workerA.release)
	result := waitCloudAgentRun(t, gatewayB, "job_cross_gateway")
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
	select {
	case <-workerA.started:
	case <-time.After(time.Second):
		t.Fatal("gateway A worker did not emit first event")
	}

	streamDone := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		streamDone <- request(t, gatewayB, http.MethodGet, "/v1/cloudagent/runs/job_cross_gateway_stream/events?after_seq=0&stream=true", "tenant-a", "project-a", nil, "")
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
		`"type":"event"`,
		`"kind":"user_message"`,
		`stream from gateway b`,
		`first `,
		`second`,
		`"type":"run"`,
		`"status":"completed"`,
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("cross-gateway stream missing %q in:\n%s", want, body)
		}
	}
	if strings.Count(body, `"type":"event"`) < 3 {
		t.Fatalf("cross-gateway stream should expose append-only user + two assistant events, got:\n%s", body)
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
		Events []cloudAgentRunEvent  `json:"events"`
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
	if replay.Events[0].Seq != 2 || replay.Events[0].Kind != "assistant_text" {
		t.Fatalf("runtime event should be offset after local user event, got %#v", replay.Events[0])
	}
	var payload map[string]any
	if err := json.Unmarshal(replay.Events[0].Event, &payload); err != nil {
		t.Fatal(err)
	}
	if payload["sessionUpdate"] != "agent_message_chunk" || payload["turnId"] != turn.TurnID {
		t.Fatalf("unexpected recovered payload: %#v", payload)
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
		Events []cloudAgentRunEvent  `json:"events"`
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
	if durableReplay.Events[0].Kind != "user_message" || durableReplay.Events[1].Kind != "assistant_text" {
		t.Fatalf("durable replay should keep event order and kinds, got %#v", durableReplay.Events)
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
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		resp := request(t, srv, http.MethodGet, "/v1/cloudagent/runs/"+runID+"/result", "tenant-a", "project-a", nil, "")
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
	if submitted.RunID != runID || submitted.SessionID != sessionID {
		t.Fatalf("unexpected submit response: %#v", submitted)
	}
	return submitted.RunID
}

func cloudAgentRunListContains(runs []cloudAgentRunResponse, runID string) bool {
	for _, run := range runs {
		if run.RunID == runID {
			return true
		}
	}
	return false
}

type countingWorker struct {
	FakeWorker
	calls atomic.Int64
}

func (w *countingWorker) Run(ctx context.Context, job workerJob, emit func(workerEvent) error) (workerResult, error) {
	w.calls.Add(1)
	return w.FakeWorker.Run(ctx, job, emit)
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
