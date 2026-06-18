package wrapper

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
)

type cloudAgentCreateSessionRequest struct {
	CWD              string `json:"cwd,omitempty"`
	SandboxBackend   string `json:"sandbox_backend,omitempty"`
	OuterRuntime     string `json:"outer_runtime,omitempty"`
	RuntimeRecovery  string `json:"runtime_recovery,omitempty"`
	AgentVersion     string `json:"agent_version,omitempty"`
	WorkspaceVersion string `json:"workspace_version,omitempty"`
	SidecarURL       string `json:"sidecar_url,omitempty"`
	SidecarSHA256    string `json:"sidecar_sha256,omitempty"`
	SidecarSigURL    string `json:"sidecar_sig_url,omitempty"`
	SigningKeyID     string `json:"signing_key_id,omitempty"`
}

type cloudAgentSubmitRunRequest struct {
	RunID          string `json:"run_id,omitempty"`
	IdempotencyKey string `json:"idempotency_key,omitempty"`
	Text           string `json:"text"`
	CWD            string `json:"cwd,omitempty"`
	InboxMode      string `json:"inbox_mode,omitempty"`
}

type cloudAgentSessionEventRequest struct {
	Events []cloudAgentSessionInputEvent `json:"events"`
}

type cloudAgentSessionInputEvent struct {
	Type          string `json:"type"`
	ClientEventID string `json:"client_event_id,omitempty"`
	Content       any    `json:"content,omitempty"`
	Text          string `json:"text,omitempty"`
	CWD           string `json:"cwd,omitempty"`
	InboxMode     string `json:"inbox_mode,omitempty"`
}

type cloudAgentRunResponse struct {
	RunID          string `json:"run_id"`
	SessionID      string `json:"session_id"`
	IdempotencyKey string `json:"idempotency_key,omitempty"`
	Status         string `json:"status"`
	StopReason     string `json:"stop_reason,omitempty"`
	Error          string `json:"error,omitempty"`
	OutputText     string `json:"output_text,omitempty"`
}

var cloudAgentRunStreamHeartbeatInterval = 20 * time.Second

func (s *Server) handleCloudAgentCapabilities(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	scope, errResp := scopeFromRequest(r)
	if errResp != nil {
		serverTimeline(start, "cloudagent_capabilities_denied", "code="+errResp.Code)
		writeError(w, http.StatusUnauthorized, errResp.Code, errResp.Message)
		return
	}
	serverTimeline(start, "cloudagent_capabilities_done", "tenant="+quoteServerField(scope.TenantID), "project="+quoteServerField(scope.ProjectID))
	spec := CloudAgentRunSpec()
	writeJSON(w, http.StatusOK, map[string]any{
		"object":                 spec.Object,
		"protocol":               spec.Protocol,
		"version":                spec.Version,
		"session_event_protocol": true,
		"run_protocol":           true,
		"features":               spec.Features,
		"endpoints":              spec.EndpointStrings(),
	})
}

func (s *Server) handleCloudAgentListSessions(w http.ResponseWriter, r *http.Request) {
	scope, errResp := scopeFromRequest(r)
	if errResp != nil {
		writeError(w, http.StatusUnauthorized, errResp.Code, errResp.Message)
		return
	}
	limit := parseCloudAgentListLimit(r.URL.Query().Get("limit"))
	sessions, err := s.store.ListACPSessions(scope)
	if err != nil {
		writeError(w, httpStatusForGatewayError(err), "session_list_failed", err.Error())
		return
	}
	items := make([]map[string]any, 0, minInt(len(sessions), limit))
	for _, session := range sessions {
		if len(items) >= limit {
			break
		}
		items = append(items, cloudAgentSessionListItem(session))
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"object": "list",
		"data":   items,
	})
}

func (s *Server) handleCloudAgentCreateSession(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "method not allowed")
		return
	}
	scope, errResp := scopeFromRequest(r)
	if errResp != nil {
		serverTimeline(start, "cloudagent_session_create_denied", "code="+errResp.Code)
		writeError(w, http.StatusUnauthorized, errResp.Code, errResp.Message)
		return
	}
	var req cloudAgentCreateSessionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", err.Error())
		return
	}
	session, err := s.acpGate.createSession(r.Context(), scope, cloudAgentCreateSessionACPRequest(req))
	if err != nil {
		serverTimeline(start, "cloudagent_session_create_failed", "error="+quoteServerField(err.Error()))
		writeError(w, http.StatusInternalServerError, "session_create_failed", err.Error())
		return
	}
	serverTimeline(start, "cloudagent_session_create_done", "session_id="+session.SessionID)
	writeJSON(w, http.StatusOK, map[string]any{
		"session_id":         session.SessionID,
		"state":              string(session.State),
		"runtime_generation": session.RuntimeGeneration,
	})
}

func (s *Server) handleCloudAgentSessionPath(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/v1/cloudagent/sessions/")
	parts := strings.Split(strings.Trim(rest, "/"), "/")
	if len(parts) == 1 && parts[0] != "" && r.Method == http.MethodGet {
		s.handleCloudAgentLoadSession(w, r, parts[0])
		return
	}
	if len(parts) == 2 && parts[1] == "runs" && r.Method == http.MethodPost {
		s.handleCloudAgentSubmitRun(w, r, parts[0])
		return
	}
	if len(parts) == 2 && parts[1] == "close" && r.Method == http.MethodPost {
		s.handleCloudAgentCloseSession(w, r, parts[0])
		return
	}
	if len(parts) == 2 && parts[1] == "events" {
		switch r.Method {
		case http.MethodPost:
			s.handleCloudAgentSubmitSessionEvents(w, r, parts[0])
			return
		case http.MethodGet:
			s.handleCloudAgentSessionEvents(w, r, parts[0], parseBoolQuery(r.URL.Query().Get("stream")))
			return
		}
	}
	if len(parts) == 3 && parts[1] == "events" && parts[2] == "stream" && r.Method == http.MethodGet {
		s.handleCloudAgentSessionEvents(w, r, parts[0], true)
		return
	}
	writeError(w, http.StatusNotFound, "not_found", "unknown cloudagent session endpoint")
}

func (s *Server) handleCloudAgentCloseSession(w http.ResponseWriter, r *http.Request, sessionID string) {
	start := time.Now()
	scope, errResp := scopeFromRequest(r)
	if errResp != nil {
		serverTimeline(start, "cloudagent_session_close_denied", "code="+errResp.Code)
		writeError(w, http.StatusUnauthorized, errResp.Code, errResp.Message)
		return
	}
	if strings.TrimSpace(sessionID) == "" {
		writeError(w, http.StatusBadRequest, "session_id_required", "session_id is required")
		return
	}
	if err := s.acpGate.closeSession(scope, sessionID); err != nil {
		serverTimeline(start, "cloudagent_session_close_failed", "session_id="+sessionID, "error="+quoteServerField(err.Error()))
		writeError(w, httpStatusForGatewayError(err), "session_close_failed", err.Error())
		return
	}
	session, err := s.acpGate.getSession(scope, sessionID)
	if err != nil {
		serverTimeline(start, "cloudagent_session_close_load_failed", "session_id="+sessionID, "error="+quoteServerField(err.Error()))
		writeError(w, httpStatusForGatewayError(err), "session_load_failed", err.Error())
		return
	}
	serverTimeline(start, "cloudagent_session_close_done", "session_id="+sessionID, "state="+string(session.State))
	writeJSON(w, http.StatusOK, cloudAgentSessionListItem(cloneSession(session)))
}

func (s *Server) handleCloudAgentLoadSession(w http.ResponseWriter, r *http.Request, sessionID string) {
	scope, errResp := scopeFromRequest(r)
	if errResp != nil {
		writeError(w, http.StatusUnauthorized, errResp.Code, errResp.Message)
		return
	}
	session, err := s.acpGate.loadSession(scope, sessionID, r.URL.Query().Get("cwd"))
	if err != nil {
		writeError(w, httpStatusForGatewayError(err), "session_load_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"session_id":         session.SessionID,
		"state":              string(session.State),
		"runtime_generation": session.RuntimeGeneration,
	})
}

func (s *Server) handleCloudAgentListRuns(w http.ResponseWriter, r *http.Request) {
	scope, errResp := scopeFromRequest(r)
	if errResp != nil {
		writeError(w, http.StatusUnauthorized, errResp.Code, errResp.Message)
		return
	}
	limit := parseCloudAgentListLimit(r.URL.Query().Get("limit"))
	sessionID := strings.TrimSpace(r.URL.Query().Get("session_id"))
	runs, err := s.store.ListCloudAgentRuns(scope, sessionID, limit)
	if err != nil {
		writeError(w, httpStatusForGatewayError(err), "run_list_failed", err.Error())
		return
	}
	items := make([]cloudAgentRunResponse, 0, len(runs))
	for _, run := range runs {
		items = append(items, cloudAgentRunRecordResponse(run))
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"object": "list",
		"data":   items,
	})
}

func (s *Server) handleCloudAgentRunPath(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/v1/cloudagent/runs/")
	parts := strings.Split(strings.Trim(rest, "/"), "/")
	if len(parts) == 1 && parts[0] != "" && r.Method == http.MethodGet {
		s.handleCloudAgentRunStatus(w, r, parts[0])
		return
	}
	if len(parts) == 2 && parts[0] != "" {
		switch {
		case parts[1] == "events" && r.Method == http.MethodGet:
			s.handleCloudAgentRunEvents(w, r, parts[0])
			return
		case parts[1] == "result" && r.Method == http.MethodGet:
			s.handleCloudAgentRunResult(w, r, parts[0])
			return
		case parts[1] == "cancel" && r.Method == http.MethodPost:
			s.handleCloudAgentCancelRun(w, r, parts[0])
			return
		}
	}
	writeError(w, http.StatusNotFound, "not_found", "unknown cloudagent run endpoint")
}

func (s *Server) handleCloudAgentSubmitRun(w http.ResponseWriter, r *http.Request, sessionID string) {
	start := time.Now()
	scope, errResp := scopeFromRequest(r)
	if errResp != nil {
		serverTimeline(start, "cloudagent_run_submit_denied", "code="+errResp.Code)
		writeError(w, http.StatusUnauthorized, errResp.Code, errResp.Message)
		return
	}
	var req cloudAgentSubmitRunRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", err.Error())
		return
	}
	req.IdempotencyKey = cloudAgentRequestIdempotencyKey(r, req)
	runID, err := s.acpGate.startCloudAgentRun(r.Context(), scope, sessionID, req)
	if err != nil {
		serverTimeline(start, "cloudagent_run_submit_failed", "session_id="+sessionID, "error="+quoteServerField(err.Error()))
		writeError(w, httpStatusForGatewayError(err), "run_submit_failed", err.Error())
		return
	}
	serverTimeline(start, "cloudagent_run_submit_done", "session_id="+sessionID, "run_id="+runID)
	if run, loadErr := s.store.LoadCloudAgentRun(scope, runID); loadErr == nil {
		writeJSON(w, http.StatusOK, cloudAgentRunRecordResponse(run))
		return
	}
	writeJSON(w, http.StatusOK, cloudAgentRunResponse{RunID: runID, SessionID: sessionID, Status: "running"})
}

func (s *Server) handleCloudAgentSubmitSessionEvents(w http.ResponseWriter, r *http.Request, sessionID string) {
	start := time.Now()
	scope, errResp := scopeFromRequest(r)
	if errResp != nil {
		serverTimeline(start, "cloudagent_session_events_submit_denied", "code="+errResp.Code)
		writeError(w, http.StatusUnauthorized, errResp.Code, errResp.Message)
		return
	}
	var req cloudAgentSessionEventRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", err.Error())
		return
	}
	input, err := cloudAgentSelectUserMessageEvent(req)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_event", err.Error())
		return
	}
	text := strings.TrimSpace(cloudAgentSessionInputText(input))
	if text == "" {
		writeError(w, http.StatusBadRequest, "invalid_event", "user.message content is required")
		return
	}
	idempotencyKey := firstNonEmpty(r.Header.Get("Idempotency-Key"), input.ClientEventID)
	runReq := cloudAgentSubmitRunRequest{
		IdempotencyKey: idempotencyKey,
		Text:           text,
		CWD:            input.CWD,
		InboxMode:      firstNonEmpty(input.InboxMode, "prompt"),
	}
	runID, err := s.acpGate.startCloudAgentRun(r.Context(), scope, sessionID, runReq)
	if err != nil {
		serverTimeline(start, "cloudagent_session_events_submit_failed", "session_id="+sessionID, "error="+quoteServerField(err.Error()))
		writeError(w, httpStatusForGatewayError(err), "event_submit_failed", err.Error())
		return
	}
	events := s.acpGate.cloudAgentSessionPublicEventsSince(r.Context(), scope, sessionID, 0, 200)
	ack := make([]map[string]any, 0, 1)
	for _, event := range events {
		if event["run_id"] == runID && event["type"] == "user.message" {
			ack = append(ack, event)
			break
		}
	}
	if len(ack) == 0 {
		ack = append(ack, cloudAgentSyntheticUserMessageEvent(sessionID, runID, text, input.ClientEventID))
	}
	serverTimeline(start, "cloudagent_session_events_submit_done", "session_id="+sessionID, "run_id="+runID)
	writeJSON(w, http.StatusOK, map[string]any{
		"object": "list",
		"data":   ack,
		"events": ack,
	})
}

func (s *Server) handleCloudAgentSessionEvents(w http.ResponseWriter, r *http.Request, sessionID string, stream bool) {
	scope, errResp := scopeFromRequest(r)
	if errResp != nil {
		writeError(w, http.StatusUnauthorized, errResp.Code, errResp.Message)
		return
	}
	afterSeq, err := parseCloudAgentAfterSeqFromRequest(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_after_seq", err.Error())
		return
	}
	if _, err := s.store.LoadACPSession(scope, sessionID); err != nil {
		writeError(w, httpStatusForGatewayError(err), "session_not_found", err.Error())
		return
	}
	limit := parseCloudAgentListLimit(r.URL.Query().Get("limit"))
	if !stream {
		events := s.acpGate.cloudAgentSessionPublicEventsSince(r.Context(), scope, sessionID, afterSeq, limit)
		writeJSON(w, http.StatusOK, map[string]any{
			"object": "list",
			"data":   events,
			"events": events,
		})
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	flusher, _ := w.(http.Flusher)
	deadline := time.Now().Add(5 * time.Minute)
	nextHeartbeat := time.Now().Add(cloudAgentRunStreamHeartbeatInterval)
	for {
		events := s.acpGate.cloudAgentSessionPublicEventsSince(r.Context(), scope, sessionID, afterSeq, 200)
		for _, event := range events {
			if seq, ok := numericMapInt64(event["seq"]); ok && seq > afterSeq {
				afterSeq = seq
			}
			eventID, _ := event["id"].(string)
			eventType, _ := event["type"].(string)
			if err := writeCloudAgentSSE(w, flusher, eventID, eventType, event); err != nil {
				return
			}
		}
		now := time.Now()
		if now.After(deadline) || now.After(nextHeartbeat) {
			if err := writeCloudAgentSSE(w, flusher, "", "heartbeat", map[string]any{
				"type":      "heartbeat",
				"after_seq": afterSeq,
			}); err != nil {
				return
			}
			return
		}
		select {
		case <-r.Context().Done():
			return
		case <-time.After(100 * time.Millisecond):
		}
	}
}

func (s *Server) handleCloudAgentRunStatus(w http.ResponseWriter, r *http.Request, runID string) {
	scope, errResp := scopeFromRequest(r)
	if errResp != nil {
		writeError(w, http.StatusUnauthorized, errResp.Code, errResp.Message)
		return
	}
	run, err := s.store.LoadCloudAgentRun(scope, runID)
	if err != nil {
		writeError(w, httpStatusForGatewayError(err), "run_not_found", err.Error())
		return
	}
	run = s.acpGate.reconcileCloudAgentRunFromRuntime(r.Context(), scope, run)
	writeJSON(w, http.StatusOK, cloudAgentRunRecordResponse(run))
}

func (s *Server) handleCloudAgentRunResult(w http.ResponseWriter, r *http.Request, runID string) {
	scope, errResp := scopeFromRequest(r)
	if errResp != nil {
		writeError(w, http.StatusUnauthorized, errResp.Code, errResp.Message)
		return
	}
	run, err := s.store.LoadCloudAgentRun(scope, runID)
	if err != nil {
		writeError(w, httpStatusForGatewayError(err), "run_not_found", err.Error())
		return
	}
	run = s.acpGate.reconcileCloudAgentRunFromRuntime(r.Context(), scope, run)
	writeJSON(w, http.StatusOK, cloudAgentRunRecordResponse(run))
}

func (s *Server) handleCloudAgentRunEvents(w http.ResponseWriter, r *http.Request, runID string) {
	scope, errResp := scopeFromRequest(r)
	if errResp != nil {
		writeError(w, http.StatusUnauthorized, errResp.Code, errResp.Message)
		return
	}
	afterSeq, err := parseCloudAgentAfterSeqFromRequest(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_after_seq", err.Error())
		return
	}
	stream := parseBoolQuery(r.URL.Query().Get("stream"))
	if !stream {
		run, events, err := s.store.CloudAgentRunEventsSince(scope, runID, afterSeq)
		if err != nil {
			writeError(w, httpStatusForGatewayError(err), "run_events_failed", err.Error())
			return
		}
		run = s.acpGate.reconcileCloudAgentRunFromRuntime(r.Context(), scope, run)
		events = s.acpGate.cloudAgentRuntimeRunEventsSince(r.Context(), scope, run, afterSeq, events)
		writeJSON(w, http.StatusOK, map[string]any{
			"run":    cloudAgentRunRecordResponse(run),
			"events": cloudAgentPublicRunEvents(events),
		})
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	flusher, _ := w.(http.Flusher)
	deadline := time.Now().Add(5 * time.Minute)
	nextHeartbeat := time.Now().Add(cloudAgentRunStreamHeartbeatInterval)
	for {
		run, events, err := s.store.CloudAgentRunEventsSince(scope, runID, afterSeq)
		if err != nil {
			errorEvent := cloudAgentSessionErrorEvent(runID, afterSeq+1, err.Error())
			eventID, _ := errorEvent["id"].(string)
			eventType, _ := errorEvent["type"].(string)
			_ = writeCloudAgentSSE(w, flusher, eventID, eventType, errorEvent)
			return
		}
		run = s.acpGate.reconcileCloudAgentRunFromRuntime(r.Context(), scope, run)
		events = s.acpGate.cloudAgentRuntimeRunEventsSince(r.Context(), scope, run, afterSeq, events)
		for _, event := range events {
			if event.Seq > afterSeq {
				afterSeq = event.Seq
			}
			publicEvent := cloudAgentPublicRunEvent(event)
			eventID, _ := publicEvent["id"].(string)
			eventType, _ := publicEvent["type"].(string)
			if err := writeCloudAgentSSE(w, flusher, eventID, eventType, publicEvent); err != nil {
				return
			}
		}
		if cloudAgentRunTerminal(run.Status) {
			terminalSeq := cloudAgentRunTerminalSeq(s.store, scope, run.RunID, afterSeq+1)
			if afterSeq >= terminalSeq {
				return
			}
			terminalEvent := cloudAgentRunTerminalEvent(run, terminalSeq)
			eventID, _ := terminalEvent["id"].(string)
			eventType, _ := terminalEvent["type"].(string)
			if err := writeCloudAgentSSE(w, flusher, eventID, eventType, terminalEvent); err != nil {
				return
			}
			return
		}
		now := time.Now()
		if now.After(deadline) || now.After(nextHeartbeat) {
			if err := writeCloudAgentSSE(w, flusher, "", "heartbeat", map[string]any{
				"type":      "heartbeat",
				"after_seq": afterSeq,
			}); err != nil {
				return
			}
			return
		}
		select {
		case <-r.Context().Done():
			return
		case <-time.After(100 * time.Millisecond):
		}
	}
}

func (s *Server) handleCloudAgentCancelRun(w http.ResponseWriter, r *http.Request, runID string) {
	scope, errResp := scopeFromRequest(r)
	if errResp != nil {
		writeError(w, http.StatusUnauthorized, errResp.Code, errResp.Message)
		return
	}
	if err := s.acpGate.cancelCloudAgentRun(scope, runID); err != nil {
		writeError(w, httpStatusForGatewayError(err), "run_cancel_failed", err.Error())
		return
	}
	if run, err := s.store.LoadCloudAgentRun(scope, runID); err == nil {
		writeJSON(w, http.StatusOK, cloudAgentRunRecordResponse(run))
		return
	}
	writeJSON(w, http.StatusOK, cloudAgentRunResponse{RunID: runID, Status: "cancelled", StopReason: "cancelled"})
}

func (g *ACPGateway) startCloudAgentRun(ctx context.Context, scope Scope, sessionID string, req cloudAgentSubmitRunRequest) (string, error) {
	text := strings.TrimSpace(req.Text)
	if text == "" {
		return "", fmt.Errorf("text is required")
	}
	inboxMode, err := normalizeACPInboxMode(req.InboxMode)
	if err != nil {
		return "", err
	}
	idempotencyKey := strings.TrimSpace(req.IdempotencyKey)
	if idempotencyKey != "" {
		if err := validateCloudAgentIdempotencyKey(idempotencyKey); err != nil {
			return "", err
		}
	}
	requestFingerprint := cloudAgentRunRequestFingerprint(req)
	runID := "job_" + randomHex(12)
	if err := validateCloudAgentRunID(runID); err != nil {
		return "", err
	}
	session, err := g.loadSession(scope, sessionID, req.CWD)
	if err != nil {
		return "", err
	}
	precheckedUnstartedRun := false
	if idempotencyKey != "" && g.store != nil {
		existing, err := g.store.LoadCloudAgentRunByIdempotencyKey(scope, session.SessionID, idempotencyKey)
		if err == nil {
			if existing.RequestFingerprint != "" && existing.RequestFingerprint != requestFingerprint {
				return "", fmt.Errorf("idempotency key reused with a different request body")
			}
			if !cloudAgentRunNeedsDispatch(existing) {
				return existing.RunID, nil
			}
			runID = existing.RunID
			precheckedUnstartedRun = true
			serverTimeline(time.Now(), "cloudagent_run_resume_unstarted", "session_id="+session.SessionID, "run_id="+existing.RunID)
		} else if !isCloudAgentRunNotFound(err) {
			return "", err
		}
	}
	if session.Closed || session.State == acpRuntimeStateClosed {
		session, err = g.resumeSession(scope, sessionID, req.CWD)
		if err != nil {
			return "", err
		}
		if session.Closed || session.State == acpRuntimeStateClosed {
			return "", fmt.Errorf("session runtime is unavailable: %s", firstNonEmpty(session.LastRuntimeError, session.ReadOnlyReason))
		}
	}
	if idempotencyKey != "" && g.store != nil {
		existing, existed, err := g.store.TryReserveCloudAgentRun(scope, runID, session.SessionID, idempotencyKey, requestFingerprint)
		if err != nil {
			return "", err
		}
		if existed {
			if existing.RequestFingerprint != "" && existing.RequestFingerprint != requestFingerprint {
				return "", fmt.Errorf("idempotency key reused with a different request body")
			}
			if !cloudAgentRunNeedsDispatch(existing) {
				return existing.RunID, nil
			}
			runID = existing.RunID
			if !precheckedUnstartedRun {
				serverTimeline(time.Now(), "cloudagent_run_resume_unstarted", "session_id="+session.SessionID, "run_id="+runID)
			}
		}
	} else if g.store != nil {
		if err := g.store.CreateCloudAgentRun(cloudAgentRunRecord{RunID: runID, SessionID: session.SessionID, Status: "running"}); err != nil {
			return "", err
		}
	}
	responseID := "resp_" + randomHex(18)
	ownership, err := g.acquireRuntimeOwnership(context.Background(), session.SessionID, session.RuntimeGeneration, runID, "cloudagent_run")
	if err != nil {
		if g.store != nil {
			if !errors.Is(err, ErrRuntimeOwnershipHeld) {
				_ = g.store.UpdateCloudAgentRun(runID, "failed", "failed", err.Error(), "")
			}
		}
		return "", err
	}
	releaseOwnership := true
	stopPreflightHeartbeat := g.startRuntimeOwnershipHeartbeat(context.Background(), ownership, nil)
	defer func() {
		stopPreflightHeartbeat()
		if releaseOwnership {
			g.releaseRuntimeOwnership(ownership)
		}
	}()
	if err := g.preflightPromptRuntime(session.Scope, session.SessionID); err != nil {
		if g.store != nil {
			_ = g.store.UpdateCloudAgentRun(runID, "failed", "failed", err.Error(), "")
		}
		return "", err
	}
	if err := g.validatePromptSessionRunLease(session.Scope, session.SessionID); err != nil {
		if g.store != nil {
			_ = g.store.UpdateCloudAgentRun(runID, "failed", "failed", err.Error(), "")
		}
		return "", err
	}
	if err := g.refreshPromptRuntimeIfIdle(session.Scope, session.SessionID); err != nil {
		if g.store != nil {
			_ = g.store.UpdateCloudAgentRun(runID, "failed", "failed", err.Error(), "")
		}
		return "", err
	}
	if !g.runtimeOwnershipHeld(ownership) {
		err := RuntimeOwnershipHeldError{SessionID: session.SessionID, Generation: session.RuntimeGeneration, RunID: runID, OwnerID: g.ownerID, Operation: "cloudagent_run"}
		if g.store != nil {
			_ = g.store.UpdateCloudAgentRun(runID, "failed", "failed", err.Error(), "")
		}
		return "", err
	}
	promptCtx, cancel := context.WithCancel(context.Background())
	run, promptJob, err := g.beginPrompt(session.Scope, session.SessionID, cancel, req.CWD, inboxMode, text, text, runID, responseID, nil, ownership)
	if err != nil {
		cancel()
		if g.store != nil {
			_ = g.store.UpdateCloudAgentRun(runID, "failed", "failed", err.Error(), "")
		}
		return "", err
	}
	releaseOwnership = false
	go g.runPromptAsync(promptCtx, nil, nil, session.SessionID, promptJob, run, false)
	return runID, nil
}

func (g *ACPGateway) reconcileCloudAgentRunFromRuntime(ctx context.Context, scope Scope, run cloudAgentRunRecord) cloudAgentRunRecord {
	if g == nil || g.store == nil || g.runtimeManager == nil || cloudAgentRunTerminal(run.Status) {
		return run
	}
	session, err := g.loadSession(scope, run.SessionID, "")
	if err != nil {
		return run
	}
	if session.Runtime.RuntimeID == "" && session.Runtime.OuterSandboxID == "" {
		return run
	}
	statusCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	status, err := g.runtimeManager.SessionRuntimeStatus(statusCtx, session.Runtime, session.SessionID)
	cancel()
	if err != nil {
		return run
	}
	for _, runtimeRun := range status.RunLedgerTail {
		if runtimeRun.RunID != run.RunID {
			continue
		}
		nextStatus, stopReason, errorMessage, ok := cloudAgentRuntimeRunStatus(runtimeRun)
		if !ok {
			return run
		}
		outputText := run.OutputText
		if reader, ok := g.runtimeManager.(ACPSessionRuntimeRunReader); ok {
			if result, err := reader.SessionRuntimeRunResult(ctx, session.Runtime, session.SessionID, run.RunID); err == nil {
				if result.Status != "" {
					nextStatus = result.Status
				}
				if result.StopReason != "" {
					stopReason = result.StopReason
				}
				if result.ErrorMessage != "" {
					errorMessage = result.ErrorMessage
				}
				if result.OutputText != "" {
					outputText = result.OutputText
				}
			}
		}
		if outputText != "" || cloudAgentRunTerminal(nextStatus) {
			if err := g.store.UpdateCloudAgentRun(run.RunID, nextStatus, stopReason, errorMessage, outputText); err != nil {
				return run
			}
		} else if err := g.store.UpdateCloudAgentRunFromRuntime(run.RunID, nextStatus, stopReason, errorMessage); err != nil {
			return run
		}
		if updated, err := g.store.LoadCloudAgentRun(scope, run.RunID); err == nil {
			return updated
		}
		return run
	}
	return run
}

func (g *ACPGateway) cloudAgentRuntimeRunEventsSince(ctx context.Context, scope Scope, run cloudAgentRunRecord, afterSeq int64, local []cloudAgentRunEvent) []cloudAgentRunEvent {
	if g == nil || g.store == nil {
		return local
	}
	if run.TurnID != "" {
		if err := g.store.SeedCloudAgentRunEventsFromTurn(run.RunID); err != nil {
			serverTimeline(time.Now(), "cloudagent_run_seed_events_failed", "session_id="+run.SessionID, "run_id="+run.RunID, "error="+quoteServerField(err.Error()))
			return local
		}
		if _, seededLocal, err := g.store.CloudAgentRunEventsSince(scope, run.RunID, afterSeq); err == nil {
			local = seededLocal
		}
	}
	reader, ok := g.runtimeManager.(ACPSessionRuntimeRunReader)
	if !ok {
		return local
	}
	if len(local) > 0 && cloudAgentRunTerminal(run.Status) && run.OutputText != "" {
		return local
	}
	session, err := g.loadSession(scope, run.SessionID, "")
	if err != nil {
		return local
	}
	if session.Runtime.RuntimeID == "" && session.Runtime.OuterSandboxID == "" {
		return local
	}
	_, userPrefix, err := g.store.CloudAgentRunUserEventPrefix(scope, run.RunID)
	if err != nil {
		return local
	}
	runtimeAfterSeq := afterSeq - userPrefix
	if runtimeAfterSeq < 0 {
		runtimeAfterSeq = 0
	}
	readCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	runtimeEvents, err := reader.SessionRuntimeRunEvents(readCtx, session.Runtime, session.SessionID, run.RunID, runtimeAfterSeq)
	cancel()
	if err != nil || len(runtimeEvents) == 0 {
		return local
	}
	merged := append([]cloudAgentRunEvent(nil), local...)
	seenSeq := make(map[int64]struct{}, len(local)+len(runtimeEvents))
	for _, event := range local {
		seenSeq[event.Seq] = struct{}{}
	}
	for _, runtimeEvent := range runtimeEvents {
		event, ok := cloudAgentRunEventFromRuntime(run, runtimeEvent, userPrefix)
		if !ok || event.Seq <= afterSeq {
			continue
		}
		if _, exists := seenSeq[event.Seq]; exists {
			continue
		}
		if err := g.store.ImportCloudAgentRunEvent(event); err != nil {
			serverTimeline(time.Now(), "cloudagent_runtime_event_import_failed", "session_id="+run.SessionID, "run_id="+run.RunID, "error="+quoteServerField(err.Error()))
			continue
		}
		seenSeq[event.Seq] = struct{}{}
		merged = append(merged, event)
	}
	sort.SliceStable(merged, func(i, j int) bool {
		return merged[i].Seq < merged[j].Seq
	})
	return merged
}

func (g *ACPGateway) cloudAgentSessionPublicEventsSince(ctx context.Context, scope Scope, sessionID string, afterSeq int64, limit int) []map[string]any {
	if g == nil || g.store == nil {
		return nil
	}
	if limit <= 0 {
		limit = 50
	}
	runs, err := g.store.ListCloudAgentRunsForSession(scope, sessionID, 1000)
	if err != nil {
		return []map[string]any{cloudAgentSessionScopedErrorEvent(sessionID, afterSeq+1, err.Error())}
	}
	out := make([]map[string]any, 0, minInt(limit, 50))
	var sessionSeq int64
	for _, run := range runs {
		run = g.reconcileCloudAgentRunFromRuntime(ctx, scope, run)
		_, runEvents, err := g.store.CloudAgentRunEventsSince(scope, run.RunID, 0)
		if err != nil {
			continue
		}
		runEvents = g.cloudAgentRuntimeRunEventsSince(ctx, scope, run, 0, runEvents)
		for _, event := range runEvents {
			sessionSeq++
			if sessionSeq <= afterSeq {
				continue
			}
			publicEvent := cloudAgentPublicRunEvent(event)
			cloudAgentRewriteSessionEvent(publicEvent, sessionID, sessionSeq)
			out = append(out, publicEvent)
			if len(out) >= limit {
				return out
			}
		}
		if cloudAgentRunTerminal(run.Status) {
			sessionSeq++
			if sessionSeq <= afterSeq {
				continue
			}
			terminalEvent := cloudAgentRunTerminalEvent(run, sessionSeq)
			cloudAgentRewriteSessionEvent(terminalEvent, sessionID, sessionSeq)
			out = append(out, terminalEvent)
			if len(out) >= limit {
				return out
			}
		}
	}
	return out
}

func (g *ACPGateway) cancelCloudAgentRun(scope Scope, runID string) error {
	run, err := g.store.LoadCloudAgentRun(scope, runID)
	if err != nil {
		return err
	}
	if cloudAgentRunTerminal(run.Status) {
		return nil
	}
	g.mu.Lock()
	session, ok := g.sessions[run.SessionID]
	var active *acpPromptRun
	var runtime ACPSessionRuntime
	if ok {
		active = session.PromptRuns[runID]
		runtime = session.Runtime
	}
	g.mu.Unlock()
	if active != nil {
		active.interrupt("cancelled")
	}
	if runtime.RuntimeID == "" && runtime.OuterSandboxID == "" {
		loaded, loadErr := g.loadSession(scope, run.SessionID, "")
		if loadErr != nil {
			return loadErr
		}
		runtime = loaded.Runtime
	}
	if runtime.RuntimeID == "" && runtime.OuterSandboxID == "" {
		serverTimeline(time.Now(), "cloudagent_run_cancel_local_terminal", "session_id="+run.SessionID, "run_id="+runID, "reason=runtime_identity_missing")
		return g.store.UpdateCloudAgentRun(runID, "cancelled", "cancelled", "", run.OutputText)
	}
	cancelCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	err = g.runtimeManager.CancelSessionRuntime(cancelCtx, runtime, run.SessionID, runID)
	cancel()
	if err != nil {
		return err
	}
	return g.store.UpdateCloudAgentRun(runID, "cancelled", "cancelled", "", run.OutputText)
}

func cloudAgentRunEventFromRuntime(run cloudAgentRunRecord, runtimeEvent ACPSessionRuntimeRunEvent, userPrefix int64) (cloudAgentRunEvent, bool) {
	update, _, ok := acpUpdateFromWorkerEvent(runtimeEvent.Event)
	if !ok {
		return cloudAgentRunEvent{}, false
	}
	if run.TurnID != "" {
		update["turnId"] = run.TurnID
	}
	raw, err := json.Marshal(update)
	if err != nil {
		return cloudAgentRunEvent{}, false
	}
	seq := runtimeEvent.Seq + userPrefix
	return cloudAgentRunEvent{
		Seq:       seq,
		RunID:     run.RunID,
		SessionID: run.SessionID,
		TurnID:    run.TurnID,
		Kind:      cloudAgentRunEventKind(raw),
		Event:     raw,
		CreatedAt: time.Now().UTC(),
	}, true
}

func cloudAgentCreateSessionACPRequest(req cloudAgentCreateSessionRequest) acpSessionRequest {
	return acpSessionRequest{
		CWD: req.CWD,
		Meta: acpSessionMeta{CloudAgent: acpCloudAgentSessionMeta{
			SandboxBackend:   req.SandboxBackend,
			OuterRuntime:     req.OuterRuntime,
			RuntimeRecovery:  req.RuntimeRecovery,
			AgentVersion:     req.AgentVersion,
			WorkspaceVersion: req.WorkspaceVersion,
			SidecarURL:       req.SidecarURL,
			SidecarSHA256:    req.SidecarSHA256,
			SidecarSigURL:    req.SidecarSigURL,
			SigningKeyID:     req.SigningKeyID,
		}},
	}
}

func cloudAgentRunRecordResponse(run cloudAgentRunRecord) cloudAgentRunResponse {
	return cloudAgentRunResponse{
		RunID:          run.RunID,
		SessionID:      run.SessionID,
		IdempotencyKey: run.IdempotencyKey,
		Status:         run.Status,
		StopReason:     run.StopReason,
		Error:          run.ErrorMessage,
		OutputText:     run.OutputText,
	}
}

func cloudAgentSelectUserMessageEvent(req cloudAgentSessionEventRequest) (cloudAgentSessionInputEvent, error) {
	if len(req.Events) == 0 {
		return cloudAgentSessionInputEvent{}, fmt.Errorf("events must contain a user.message event")
	}
	var selected cloudAgentSessionInputEvent
	for _, event := range req.Events {
		if strings.TrimSpace(event.Type) == "" {
			return cloudAgentSessionInputEvent{}, fmt.Errorf("events[].type is required")
		}
		if event.Type != "user.message" {
			return cloudAgentSessionInputEvent{}, fmt.Errorf("unsupported event type %q", event.Type)
		}
		if selected.Type != "" {
			return cloudAgentSessionInputEvent{}, fmt.Errorf("only one user.message event is supported per request")
		}
		selected = event
	}
	return selected, nil
}

func cloudAgentSessionInputText(event cloudAgentSessionInputEvent) string {
	if strings.TrimSpace(event.Text) != "" {
		return event.Text
	}
	switch value := event.Content.(type) {
	case string:
		return value
	case []any:
		var out strings.Builder
		for _, item := range value {
			block, ok := item.(map[string]any)
			if !ok {
				continue
			}
			if blockType, _ := block["type"].(string); blockType != "" && blockType != "text" {
				continue
			}
			if text, _ := block["text"].(string); text != "" {
				out.WriteString(text)
			}
		}
		return out.String()
	case []map[string]any:
		var out strings.Builder
		for _, block := range value {
			if blockType, _ := block["type"].(string); blockType != "" && blockType != "text" {
				continue
			}
			if text, _ := block["text"].(string); text != "" {
				out.WriteString(text)
			}
		}
		return out.String()
	default:
		return ""
	}
}

func cloudAgentRewriteSessionEvent(event map[string]any, sessionID string, seq int64) {
	event["id"] = fmt.Sprintf("evt_%s_%d", sessionID, seq)
	event["seq"] = seq
	event["session_id"] = sessionID
}

func cloudAgentSyntheticUserMessageEvent(sessionID, runID, text, clientEventID string) map[string]any {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	event := map[string]any{
		"id":              fmt.Sprintf("evt_%s_%d", sessionID, 0),
		"seq":             int64(0),
		"type":            "user.message",
		"run_id":          runID,
		"session_id":      sessionID,
		"schema_version":  "1.0",
		"content":         text,
		"created_at":      now,
		"processed_at":    now,
		"client_event_id": clientEventID,
	}
	return event
}

func cloudAgentSessionScopedErrorEvent(sessionID string, seq int64, message string) map[string]any {
	event := cloudAgentSessionErrorEvent(sessionID, seq, message)
	event["session_id"] = sessionID
	event["id"] = fmt.Sprintf("evt_%s_%d", sessionID, seq)
	delete(event, "run_id")
	return event
}

func cloudAgentPublicRunEvents(events []cloudAgentRunEvent) []map[string]any {
	out := make([]map[string]any, 0, len(events))
	for _, event := range events {
		publicEvent := cloudAgentPublicRunEvent(event)
		if publicEvent["type"] == "agent.raw" {
			continue
		}
		out = append(out, publicEvent)
	}
	return out
}

func cloudAgentPublicRunEvent(event cloudAgentRunEvent) map[string]any {
	var update struct {
		SessionUpdate string         `json:"sessionUpdate"`
		Content       any            `json:"content"`
		ToolCallID    string         `json:"toolCallId"`
		Name          string         `json:"name"`
		Title         string         `json:"title"`
		Status        string         `json:"status"`
		Kind          string         `json:"kind"`
		RawInput      map[string]any `json:"rawInput"`
		RawOutput     map[string]any `json:"rawOutput"`
	}
	_ = json.Unmarshal(event.Event, &update)
	eventType := "agent.raw"
	payload := map[string]any{}
	text := cloudAgentInternalContentText(update.Content)
	switch firstNonEmpty(update.SessionUpdate, event.Kind) {
	case "user_message_chunk", "user_message":
		eventType = "user.message"
		payload["content"] = text
	case "agent_message_chunk", "assistant_text":
		eventType = "agent.message"
		payload["content"] = []map[string]any{{"type": "text", "text": text}}
	case "agent_thought_chunk", "reasoning":
		eventType = "agent.thinking"
		payload["thinking"] = text
	case "tool_call":
		eventType = "agent.tool_use"
		payload["tool_use_id"] = firstNonEmpty(update.ToolCallID, cloudAgentRunEventID(event))
		payload["name"] = firstNonEmpty(update.Name, update.Title)
		payload["input"] = update.RawInput
		payload["evaluated_permission"] = "allow"
	case "tool_call_update":
		eventType = "agent.tool_result"
		payload["tool_use_id"] = firstNonEmpty(update.ToolCallID, cloudAgentRunEventID(event))
		payload["content"] = cloudAgentToolResultContent(update)
		payload["is_error"] = update.Status == "failed" || update.Status == "error"
	case "lifecycle":
		status := strings.ToLower(strings.TrimSpace(update.Status))
		switch status {
		case "failed", "error":
			eventType = "session.error"
			payload["status"] = "error"
			payload["error"] = map[string]any{"message": firstNonEmpty(text, "cloudagent run failed"), "type": "unknown_error"}
			payload["details"] = map[string]any{"message": firstNonEmpty(text, "cloudagent run failed")}
			payload["retry_status"] = map[string]any{"type": "exhausted"}
		default:
			eventType = "session.status_idle"
			payload["status"] = firstNonEmpty(status, "idle")
			payload["stop_reason"] = map[string]any{"type": firstNonEmpty(status, "end_turn")}
		}
	default:
		payload["event"] = update
	}
	payload["id"] = cloudAgentRunEventID(event)
	payload["seq"] = event.Seq
	payload["type"] = eventType
	payload["run_id"] = event.RunID
	payload["session_id"] = event.SessionID
	if event.TurnID != "" {
		payload["turn_id"] = event.TurnID
	}
	payload["schema_version"] = "1.0"
	payload["created_at"] = event.CreatedAt.Format(time.RFC3339Nano)
	payload["processed_at"] = event.CreatedAt.Format(time.RFC3339Nano)
	return payload
}

func cloudAgentToolResultContent(update struct {
	SessionUpdate string         `json:"sessionUpdate"`
	Content       any            `json:"content"`
	ToolCallID    string         `json:"toolCallId"`
	Name          string         `json:"name"`
	Title         string         `json:"title"`
	Status        string         `json:"status"`
	Kind          string         `json:"kind"`
	RawInput      map[string]any `json:"rawInput"`
	RawOutput     map[string]any `json:"rawOutput"`
}) []map[string]any {
	if text := cloudAgentInternalContentText(update.Content); text != "" {
		return []map[string]any{{"type": "text", "text": text}}
	}
	if len(update.RawOutput) > 0 {
		raw, _ := json.Marshal(update.RawOutput)
		return []map[string]any{{"type": "text", "text": string(raw)}}
	}
	return []map[string]any{{"type": "text", "text": ""}}
}

func cloudAgentInternalContentText(content any) string {
	switch value := content.(type) {
	case map[string]any:
		text, _ := value["text"].(string)
		return text
	case []any:
		var out strings.Builder
		for _, item := range value {
			block, ok := item.(map[string]any)
			if !ok {
				continue
			}
			if text, _ := block["text"].(string); text != "" {
				out.WriteString(text)
				continue
			}
			if text, _ := block["content"].(string); text != "" {
				out.WriteString(text)
			}
		}
		return out.String()
	case string:
		return value
	default:
		return ""
	}
}

func cloudAgentRunEventID(event cloudAgentRunEvent) string {
	if event.RunID == "" || event.Seq <= 0 {
		return "evt_" + randomHex(16)
	}
	return fmt.Sprintf("evt_%s_%d", event.RunID, event.Seq)
}

func cloudAgentRunTerminalEvent(run cloudAgentRunRecord, seq int64) map[string]any {
	if seq < 0 {
		seq = 0
	}
	eventType := "session.status_idle"
	payload := map[string]any{
		"id":             fmt.Sprintf("evt_%s_%d", run.RunID, seq),
		"seq":            seq,
		"type":           eventType,
		"run_id":         run.RunID,
		"session_id":     run.SessionID,
		"schema_version": "1.0",
		"status":         "idle",
		"stop_reason":    map[string]any{"type": firstNonEmpty(run.StopReason, "end_turn")},
		"created_at":     firstNonZeroTime(run.CompletedAt, run.UpdatedAt, time.Now().UTC()).Format(time.RFC3339Nano),
		"processed_at":   firstNonZeroTime(run.CompletedAt, run.UpdatedAt, time.Now().UTC()).Format(time.RFC3339Nano),
	}
	if run.TurnID != "" {
		payload["turn_id"] = run.TurnID
	}
	if run.Status == "failed" {
		payload["type"] = "session.error"
		payload["status"] = "error"
		payload["error"] = map[string]any{"message": firstNonEmpty(run.ErrorMessage, "cloudagent run failed"), "type": "unknown_error"}
		payload["details"] = map[string]any{"message": firstNonEmpty(run.ErrorMessage, "cloudagent run failed")}
		payload["retry_status"] = map[string]any{"type": "exhausted"}
	}
	return payload
}

func cloudAgentRunTerminalSeq(store *Store, scope Scope, runID string, fallback int64) int64 {
	if fallback < 1 {
		fallback = 1
	}
	if store == nil {
		return fallback
	}
	_, events, err := store.CloudAgentRunEventsSince(scope, runID, 0)
	if err != nil {
		return fallback
	}
	var maxSeq int64
	for _, event := range events {
		if event.Seq > maxSeq {
			maxSeq = event.Seq
		}
	}
	terminalSeq := maxSeq + 1
	if terminalSeq < 1 {
		return fallback
	}
	return terminalSeq
}

func cloudAgentSessionErrorEvent(runID string, seq int64, message string) map[string]any {
	if seq < 1 {
		seq = 1
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	return map[string]any{
		"id":             fmt.Sprintf("evt_%s_%d", runID, seq),
		"seq":            seq,
		"type":           "session.error",
		"run_id":         runID,
		"schema_version": "1.0",
		"created_at":     now,
		"processed_at":   now,
		"error":          map[string]any{"message": message, "type": "unknown_error"},
		"details":        map[string]any{"message": message},
		"retry_status":   map[string]any{"type": "exhausted"},
	}
}

func firstNonZeroTime(values ...time.Time) time.Time {
	for _, value := range values {
		if !value.IsZero() {
			return value
		}
	}
	return time.Now().UTC()
}

func writeCloudAgentSSE(w http.ResponseWriter, flusher http.Flusher, id, eventType string, payload any) error {
	if eventType == "" {
		eventType = "message"
	}
	if id != "" {
		if _, err := fmt.Fprintf(w, "id: %s\n", id); err != nil {
			return err
		}
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", eventType, raw); err != nil {
		return err
	}
	if flusher != nil {
		flusher.Flush()
	}
	return nil
}

func cloudAgentSessionListItem(session *acpSession) map[string]any {
	item := map[string]any{
		"session_id":         session.SessionID,
		"state":              string(session.State),
		"runtime_generation": session.RuntimeGeneration,
		"cwd":                session.CWD,
		"workspace_key":      session.WorkspaceKey,
		"closed":             session.Closed,
		"created_at":         session.CreatedAt,
		"updated_at":         session.UpdatedAt,
	}
	if session.ReadOnlyReason != "" {
		item["read_only_reason"] = session.ReadOnlyReason
	}
	if session.LastRuntimeError != "" {
		item["last_runtime_error"] = session.LastRuntimeError
	}
	return item
}

func cloudAgentRunTerminal(status string) bool {
	switch status {
	case "completed", "failed", "cancelled", "interrupted":
		return true
	default:
		return false
	}
}

func validateCloudAgentRunID(runID string) error {
	if strings.TrimSpace(runID) == "" {
		return fmt.Errorf("run_id is required")
	}
	if len(runID) > 128 {
		return fmt.Errorf("run_id is too long")
	}
	for _, ch := range runID {
		if (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch == '_' || ch == '-' {
			continue
		}
		return fmt.Errorf("run_id contains unsupported characters")
	}
	return nil
}

func validateCloudAgentIdempotencyKey(key string) error {
	if strings.TrimSpace(key) == "" {
		return fmt.Errorf("idempotency_key is required")
	}
	if len(key) > 256 {
		return fmt.Errorf("idempotency_key is too long")
	}
	for _, ch := range key {
		if (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch == '_' || ch == '-' {
			continue
		}
		return fmt.Errorf("idempotency_key contains unsupported characters")
	}
	return nil
}

func cloudAgentRequestIdempotencyKey(r *http.Request, req cloudAgentSubmitRunRequest) string {
	if key := strings.TrimSpace(r.Header.Get("Idempotency-Key")); key != "" {
		return key
	}
	if key := strings.TrimSpace(req.IdempotencyKey); key != "" {
		return key
	}
	return strings.TrimSpace(req.RunID)
}

func cloudAgentRunRequestFingerprint(req cloudAgentSubmitRunRequest) string {
	payload := struct {
		Text      string `json:"text"`
		CWD       string `json:"cwd,omitempty"`
		InboxMode string `json:"inbox_mode,omitempty"`
	}{
		Text:      strings.TrimSpace(req.Text),
		CWD:       strings.TrimSpace(req.CWD),
		InboxMode: strings.TrimSpace(req.InboxMode),
	}
	raw, _ := json.Marshal(payload)
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

func cloudAgentRunNeedsDispatch(run cloudAgentRunRecord) bool {
	return run.Status == "running" && strings.TrimSpace(run.TurnID) == "" && strings.TrimSpace(run.ResponseID) == ""
}

func parseCloudAgentListLimit(value string) int {
	const defaultLimit = 50
	const maxLimit = 200
	value = strings.TrimSpace(value)
	if value == "" {
		return defaultLimit
	}
	limit, err := strconv.Atoi(value)
	if err != nil || limit <= 0 {
		return defaultLimit
	}
	if limit > maxLimit {
		return maxLimit
	}
	return limit
}

func cloudAgentRuntimeRunStatus(run ACPSessionRuntimeRunRecord) (status, stopReason, errorMessage string, ok bool) {
	switch strings.ToLower(strings.TrimSpace(run.Status)) {
	case "succeeded", "completed":
		return "completed", "end_turn", "", true
	case "failed":
		return "failed", "failed", firstNonEmpty(run.ErrorMessage, run.ErrorCode), true
	case "canceled", "cancelled":
		return "cancelled", "cancelled", firstNonEmpty(run.ErrorMessage, run.ErrorCode), true
	case "interrupted":
		return "interrupted", "interrupted", firstNonEmpty(run.ErrorMessage, run.ErrorCode), true
	default:
		return "", "", "", false
	}
}

func parseBoolQuery(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "1", "true", "yes", "y":
		return true
	default:
		return false
	}
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func parseCloudAgentAfterSeq(value string) (int64, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0, nil
	}
	afterSeq, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("after_seq must be a non-negative integer")
	}
	if afterSeq < 0 {
		return 0, fmt.Errorf("after_seq must be a non-negative integer")
	}
	return afterSeq, nil
}

func parseCloudAgentAfterSeqFromRequest(r *http.Request) (int64, error) {
	if value := strings.TrimSpace(r.URL.Query().Get("after_seq")); value != "" {
		return parseCloudAgentAfterSeq(value)
	}
	afterID := firstNonEmpty(r.URL.Query().Get("after_id"), r.Header.Get("Last-Event-ID"))
	if afterID == "" {
		return 0, nil
	}
	seq, ok := parseCloudAgentEventSeqFromID(afterID)
	if !ok {
		return 0, fmt.Errorf("after_id must be a CloudAgent event id with a numeric suffix")
	}
	return seq, nil
}

func parseCloudAgentEventSeqFromID(eventID string) (int64, bool) {
	eventID = strings.TrimSpace(eventID)
	if eventID == "" {
		return 0, false
	}
	idx := strings.LastIndex(eventID, "_")
	if idx < 0 || idx == len(eventID)-1 {
		return 0, false
	}
	seq, err := strconv.ParseInt(eventID[idx+1:], 10, 64)
	if err != nil || seq < 0 {
		return 0, false
	}
	return seq, true
}

func numericMapInt64(value any) (int64, bool) {
	switch typed := value.(type) {
	case int64:
		return typed, true
	case int:
		return int64(typed), true
	case float64:
		return int64(typed), true
	case json.Number:
		seq, err := typed.Int64()
		return seq, err == nil
	default:
		return 0, false
	}
}

func httpStatusForGatewayError(err error) int {
	if err == nil {
		return http.StatusOK
	}
	msg := strings.ToLower(err.Error())
	switch {
	case strings.Contains(msg, "not found"):
		return http.StatusNotFound
	case strings.Contains(msg, "outside caller scope"), strings.Contains(msg, "scope"):
		return http.StatusForbidden
	case strings.Contains(msg, "required"), strings.Contains(msg, "unsupported"):
		return http.StatusBadRequest
	default:
		return http.StatusConflict
	}
}
