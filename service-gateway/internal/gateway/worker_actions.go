package gateway

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	enumspb "go.temporal.io/api/enums/v1"
	"go.temporal.io/api/serviceerror"
	"go.temporal.io/sdk/client"
	sdklog "go.temporal.io/sdk/log"
)

const (
	workerActionRouteName          = "worker-actions"
	workerActionPathPrefix         = "/api/worker-actions"
	workerActionRescueExport       = "rescue_export"
	workerActionHermesImport       = "hermes_import"
	workerActionHermesImportUpload = "hermes_import_upload"
	workerActionWorkflowName       = "ExportWorkflow"
	workerActionImportWorkflowName = "ImportWorkflow"
	workerActionStatusQueryName    = "status"
	rescueArchiveModeHermes        = "hermes"
	rescueArchiveModeGeneric       = "generic"
	defaultHermesRemotePath        = "/home/agentuser/.hermes"
	defaultImportUploadTTLSeconds  = 900
)

var workerActionIDSafePattern = regexp.MustCompile(`[^a-zA-Z0-9_-]+`)

type workerActionService struct {
	ctlBaseURL     string
	sandboxBaseURL string
	backend        workerActionBackend
	cfg            WorkerActionsConfig
	client         *http.Client
}

type workerActionBackend interface {
	StartWorkflow(ctx context.Context, taskQueue string, workflowID string, workflowName string, args ...any) (workerActionWorkflowRun, error)
	QueryWorkflow(ctx context.Context, workflowID string, runID string, queryType string) (map[string]any, error)
	CancelWorkflow(ctx context.Context, workflowID string, runID string) error
}

type workerActionWorkflowRun struct {
	WorkflowID string
	RunID      string
}

type temporalWorkerActionBackend struct {
	cfg WorkerActionTemporalConfig
}

type workerActionRequest struct {
	BotID  string          `json:"bot_id"`
	Action string          `json:"action"`
	Params json.RawMessage `json:"params"`
}

type workerActionCancelRequest struct {
	BotID string `json:"bot_id"`
}

type rescueExportActionParams struct {
	RemotePaths []string `json:"remote_paths"`
	ArchiveMode string   `json:"archive_mode"`
}

type hermesImportUploadParams struct {
	FileName string `json:"file_name"`
	ByteSize int64  `json:"byte_size"`
}

type hermesImportActionParams struct {
	ObjectKey string `json:"object_key"`
	ObjectURL string `json:"object_url"`
}

type workerActionResponse struct {
	ActionRunID string `json:"action_run_id"`
	WorkflowID  string `json:"workflow_id"`
	RunID       string `json:"run_id,omitempty"`
	Action      string `json:"action"`
	BotID       string `json:"bot_id"`
	Status      string `json:"status"`
}

type workerActionUploadResponse struct {
	Action    string `json:"action"`
	BotID     string `json:"bot_id"`
	ObjectKey string `json:"object_key"`
	ObjectURL string `json:"object_url"`
	UploadURL string `json:"upload_url"`
	ExpiresAt string `json:"expires_at"`
	Status    string `json:"status"`
}

type ctlInstanceEnvelope struct {
	Code string `json:"code"`
	Data struct {
		InstanceID string `json:"instance_id"`
		SandboxID  string `json:"sandbox_id"`
		Status     string `json:"status"`
	} `json:"data"`
}

type sandboxDetail struct {
	SandboxID string `json:"sandboxID"`
	CloudID   string `json:"cloudID"`
	Region    string `json:"region"`
}

type rescueExportStartRequest struct {
	BotID                  string
	BotName                string
	InstanceID             string
	Region                 string
	RegionCandidates       []string
	NotificationEmail      string
	NotifyEmail            string
	RescueUsername         string
	RescuePasswordEnv      string
	StopType               string
	DeviceGlobs            []string
	RemotePaths            []string
	ArchiveMode            string
	MountRoot              string
	RemoteWorkDir          string
	LocalOutputDir         string
	CommandTransport       string
	TATUsername            string
	TATWorkingDirectory    string
	TATWaitTimeoutSeconds  int
	COSUploadBucket        string
	COSUploadRegion        string
	COSUploadKeyPrefix     string
	COSUploadURLTTLSeconds int
	Execute                bool
	Confirmed              bool
	WaitTimeoutSeconds     int
	CommandTimeoutSeconds  int
}

type hermesImportStartRequest struct {
	BotID                  string
	BotName                string
	InstanceID             string
	Region                 string
	RegionCandidates       []string
	ImportObjectKey        string
	ImportObjectURL        string
	COSUploadBucket        string
	COSUploadRegion        string
	COSUploadKeyPrefix     string
	COSUploadURLTTLSeconds int
	TATUsername            string
	TATWorkingDirectory    string
	TATWaitTimeoutSeconds  int
	Execute                bool
	WaitTimeoutSeconds     int
	CommandTimeoutSeconds  int
}

type rescueTencentConfig struct {
	RegionCandidates []string
}

func (h *Handler) configureWorkerActions(cfg WorkerActionsConfig) error {
	if !cfg.Enabled && h.workerActionBackend == nil {
		return nil
	}
	ctlBaseURL := strings.TrimRight(findRouteUpstream(h.routes, "/v1/instances"), "/")
	if ctlBaseURL == "" {
		return errors.New("worker actions require a /v1/instances ctl route")
	}
	sandboxBaseURL := strings.TrimRight(findRouteUpstream(h.routes, "/sandboxes"), "/")
	if sandboxBaseURL == "" {
		return errors.New("worker actions require a /sandboxes sandbox route")
	}
	backend := h.workerActionBackend
	if backend == nil {
		backend = temporalWorkerActionBackend{cfg: cfg.Temporal}
	}
	h.workerActions = &workerActionService{
		ctlBaseURL:     ctlBaseURL,
		sandboxBaseURL: sandboxBaseURL,
		backend:        backend,
		cfg:            withWorkerActionDefaults(cfg),
		client:         h.client,
	}
	return nil
}

func findRouteUpstream(routes []compiledRoute, prefix string) string {
	for _, route := range routes {
		if route.route.Prefix == prefix {
			return route.route.Upstream
		}
	}
	return ""
}

func withWorkerActionDefaults(cfg WorkerActionsConfig) WorkerActionsConfig {
	if value := strings.TrimSpace(os.Getenv("WORKER_ACTION_TEMPORAL_ADDRESS")); value != "" {
		cfg.Temporal.Address = value
	}
	if value := strings.TrimSpace(os.Getenv("WORKER_ACTION_TEMPORAL_NAMESPACE")); value != "" {
		cfg.Temporal.Namespace = value
	}
	if value := strings.TrimSpace(os.Getenv("WORKER_ACTION_TEMPORAL_TASK_QUEUE")); value != "" {
		cfg.Temporal.TaskQueue = value
	}
	if value := strings.TrimSpace(os.Getenv("WORKER_ACTION_TEMPORAL_SERVER_NAME")); value != "" {
		cfg.Temporal.ServerName = value
	}
	if value := strings.TrimSpace(os.Getenv("WORKER_ACTION_TEMPORAL_TOKEN_ENV")); value != "" {
		cfg.Temporal.TokenEnv = value
	}
	if value := strings.TrimSpace(os.Getenv("WORKER_ACTION_RESCUE_EXPORT_COS_UPLOAD_BUCKET")); value != "" {
		cfg.RescueExport.COSUploadBucket = value
	}
	if value := strings.TrimSpace(os.Getenv("WORKER_ACTION_RESCUE_EXPORT_TASK_QUEUE")); value != "" {
		cfg.RescueExport.TaskQueue = value
	}
	if value := strings.TrimSpace(os.Getenv("WORKER_ACTION_RESCUE_EXPORT_COS_UPLOAD_REGION")); value != "" {
		cfg.RescueExport.COSUploadRegion = value
	}
	if value := strings.TrimSpace(os.Getenv("WORKER_ACTION_RESCUE_EXPORT_COS_UPLOAD_KEY_PREFIX")); value != "" {
		cfg.RescueExport.COSUploadKeyPrefix = value
	}
	if value := strings.TrimSpace(os.Getenv("WORKER_ACTION_RESCUE_EXPORT_COS_UPLOAD_URL_TTL_SECONDS")); value != "" {
		if seconds, err := strconv.Atoi(value); err == nil {
			cfg.RescueExport.COSUploadURLTTLSeconds = seconds
		}
	}
	if value := strings.TrimSpace(os.Getenv("WORKER_ACTION_HERMES_IMPORT_UPLOAD_KEY_PREFIX")); value != "" {
		cfg.HermesImport.UploadKeyPrefix = value
	}
	if value := strings.TrimSpace(os.Getenv("WORKER_ACTION_HERMES_IMPORT_UPLOAD_URL_TTL_SECONDS")); value != "" {
		if seconds, err := strconv.Atoi(value); err == nil {
			cfg.HermesImport.UploadURLTTLSeconds = seconds
		}
	}
	if value := strings.TrimSpace(os.Getenv("WORKER_ACTION_HERMES_IMPORT_TASK_QUEUE")); value != "" {
		cfg.HermesImport.TaskQueue = value
	}
	if strings.TrimSpace(cfg.Temporal.Namespace) == "" {
		cfg.Temporal.Namespace = "default"
	}
	if strings.TrimSpace(cfg.Temporal.TaskQueue) == "" {
		cfg.Temporal.TaskQueue = "tencent-cvm-rescue-export"
	}
	if strings.TrimSpace(cfg.Temporal.TokenEnv) == "" {
		cfg.Temporal.TokenEnv = "TEMPORAL_BEARER_TOKEN"
	}
	if strings.TrimSpace(cfg.RescueExport.TaskQueue) == "" {
		cfg.RescueExport.TaskQueue = cfg.Temporal.TaskQueue
	}
	if strings.TrimSpace(cfg.HermesImport.TaskQueue) == "" {
		cfg.HermesImport.TaskQueue = "hermes-import"
	}
	if strings.TrimSpace(cfg.RescueExport.COSUploadRegion) == "" {
		cfg.RescueExport.COSUploadRegion = "ap-beijing"
	}
	if strings.TrimSpace(cfg.RescueExport.COSUploadKeyPrefix) == "" {
		cfg.RescueExport.COSUploadKeyPrefix = "rescue-exports"
	}
	if cfg.RescueExport.COSUploadURLTTLSeconds <= 0 {
		cfg.RescueExport.COSUploadURLTTLSeconds = 28800
	}
	if strings.TrimSpace(cfg.HermesImport.UploadKeyPrefix) == "" {
		cfg.HermesImport.UploadKeyPrefix = strings.TrimSpace(cfg.RescueExport.ImportUploadKeyPrefix)
	}
	if strings.TrimSpace(cfg.HermesImport.UploadKeyPrefix) == "" {
		cfg.HermesImport.UploadKeyPrefix = "rescue-imports"
	}
	if cfg.HermesImport.UploadURLTTLSeconds <= 0 {
		cfg.HermesImport.UploadURLTTLSeconds = cfg.RescueExport.ImportUploadURLTTLSeconds
	}
	if cfg.HermesImport.UploadURLTTLSeconds <= 0 {
		cfg.HermesImport.UploadURLTTLSeconds = defaultImportUploadTTLSeconds
	}
	return cfg
}

func (h *Handler) isWorkerActionPath(path string) bool {
	return h.workerActions != nil && strings.HasPrefix(path, workerActionPathPrefix)
}

func (h *Handler) serveWorkerActionRoute(start time.Time, w http.ResponseWriter, r *http.Request) {
	methods := []string{http.MethodGet, http.MethodPost, http.MethodOptions}
	applyCORSHeaders(h.allowedOrigins, w.Header(), r, methods)
	rec := newStatusRecorder(w)
	if isCORSPreflight(r) {
		rec.WriteHeader(http.StatusNoContent)
		h.observeRequest(start, workerActionRouteName, r, rec.statusCode())
		return
	}
	if !methodAllowed(methods, r.Method) {
		writeJSONAny(rec, http.StatusMethodNotAllowed, map[string]string{"error": "method_not_allowed"})
		h.observeRequest(start, workerActionRouteName, r, rec.statusCode())
		return
	}

	clearIdentityHeaders(r.Header)
	session, err := h.introspect(r.Context(), r)
	if err != nil {
		writeJSONAny(rec, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		h.observeRequest(start, workerActionRouteName, r, rec.statusCode())
		h.logRequest(start, compiledRoute{route: Route{Name: workerActionRouteName}}, nil, r, rec.statusCode(), "")
		return
	}
	if r.Method == http.MethodPost && h.realnameWallEnabled && !session.Session.User.RealnameVerified {
		writeJSONAny(rec, http.StatusForbidden, map[string]string{"error": "realname_required"})
		h.observeRequest(start, workerActionRouteName, r, rec.statusCode())
		h.logRequest(start, compiledRoute{route: Route{Name: workerActionRouteName}}, session, r, rec.statusCode(), "")
		return
	}

	route, ok := parseWorkerActionPath(r.URL.Path)
	if !ok {
		writeJSONAny(rec, http.StatusNotFound, map[string]string{"error": "route_not_found"})
		h.observeRequest(start, workerActionRouteName, r, rec.statusCode())
		h.logRequest(start, compiledRoute{route: Route{Name: workerActionRouteName}}, session, r, rec.statusCode(), "")
		return
	}

	switch {
	case r.Method == http.MethodPost && route.actionRunID == "" && !route.cancel:
		h.workerActions.handleStart(rec, r, session)
	case r.Method == http.MethodGet && route.actionRunID == "" && !route.cancel:
		h.workerActions.handleCurrent(rec, r, session)
	case r.Method == http.MethodGet && route.actionRunID != "" && !route.cancel:
		h.workerActions.handleQuery(rec, r, session, route.actionRunID)
	case r.Method == http.MethodPost && route.actionRunID != "" && route.cancel:
		h.workerActions.handleCancel(rec, r, session, route.actionRunID)
	default:
		writeJSONAny(rec, http.StatusMethodNotAllowed, map[string]string{"error": "method_not_allowed"})
	}
	h.observeRequest(start, workerActionRouteName, r, rec.statusCode())
	h.logRequest(start, compiledRoute{route: Route{Name: workerActionRouteName}}, session, r, rec.statusCode(), "")
}

type parsedWorkerActionPath struct {
	actionRunID string
	cancel      bool
}

func parseWorkerActionPath(path string) (parsedWorkerActionPath, bool) {
	trimmed := strings.Trim(path, "/")
	parts := strings.Split(trimmed, "/")
	if len(parts) != 2 && len(parts) != 3 && len(parts) != 4 {
		return parsedWorkerActionPath{}, false
	}
	if parts[0] != "api" || parts[1] != "worker-actions" {
		return parsedWorkerActionPath{}, false
	}
	route := parsedWorkerActionPath{}
	if len(parts) >= 3 {
		route.actionRunID = parts[2]
	}
	if len(parts) == 4 {
		if parts[3] != "cancel" {
			return parsedWorkerActionPath{}, false
		}
		route.cancel = true
	}
	return route, true
}

func (s *workerActionService) handleStart(w http.ResponseWriter, r *http.Request, session *sessionEnvelope) {
	var req workerActionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSONAny(w, http.StatusBadRequest, map[string]string{"error": "invalid_json"})
		return
	}
	botID := strings.TrimSpace(req.BotID)
	if botID == "" {
		writeJSONAny(w, http.StatusBadRequest, map[string]string{"error": "bot_id_required"})
		return
	}
	action := strings.TrimSpace(req.Action)
	if action != workerActionRescueExport && action != workerActionHermesImport && action != workerActionHermesImportUpload {
		writeJSONAny(w, http.StatusBadRequest, map[string]string{"error": "unsupported_action"})
		return
	}
	if strings.TrimSpace(session.Session.User.Email) == "" {
		writeJSONAny(w, http.StatusForbidden, map[string]string{"error": "missing_user_email"})
		return
	}

	target, err := s.resolveBotTarget(r.Context(), session, botID)
	if err != nil {
		writeWorkerActionUpstreamError(w, err)
		return
	}
	if target.CloudID == "" || target.Region == "" {
		writeJSONAny(w, http.StatusBadGateway, map[string]string{"error": "bot_target_unresolved"})
		return
	}

	if action == workerActionHermesImportUpload {
		upload, err := s.buildHermesImportUpload(req.Params, botID)
		if err != nil {
			writeJSONAny(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		writeJSONAny(w, http.StatusOK, map[string]any{"data": upload})
		return
	}

	startReq, workflowName, regionCandidates, err := s.buildWorkerActionStartRequest(action, req.Params, target, session.Session.User.Email)
	if err != nil {
		writeJSONAny(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	workflowID := buildWorkerActionWorkflowID(botID, action)
	taskQueue := s.taskQueueForAction(action)
	run, err := s.backend.StartWorkflow(r.Context(), taskQueue, workflowID, workflowName, startReq, rescueTencentConfig{RegionCandidates: regionCandidates})
	if err != nil {
		if started, ok := workflowAlreadyStartedRun(err); ok {
			writeJSONAny(w, http.StatusConflict, map[string]any{
				"error": "action_already_running",
				"data": workerActionResponse{
					ActionRunID: workflowID,
					WorkflowID:  workflowID,
					RunID:       started.RunID,
					Action:      action,
					BotID:       botID,
					Status:      "already_running",
				},
			})
			return
		}
		slog.Warn("worker action start workflow failed",
			"action", action,
			"bot_id", botID,
			"workflow_id", workflowID,
			"task_queue", taskQueue,
			"temporal_address_configured", strings.TrimSpace(s.cfg.Temporal.Address) != "",
			"error", err,
		)
		writeJSONAny(w, http.StatusBadGateway, map[string]string{"error": "start_workflow_failed"})
		return
	}
	writeJSONAny(w, http.StatusAccepted, map[string]any{"data": workerActionResponse{
		ActionRunID: run.WorkflowID,
		WorkflowID:  run.WorkflowID,
		RunID:       run.RunID,
		Action:      action,
		BotID:       botID,
		Status:      "accepted",
	}})
}

func (s *workerActionService) handleCurrent(w http.ResponseWriter, r *http.Request, session *sessionEnvelope) {
	botID := strings.TrimSpace(r.URL.Query().Get("bot_id"))
	if botID == "" {
		writeJSONAny(w, http.StatusBadRequest, map[string]string{"error": "bot_id_required"})
		return
	}
	action := strings.TrimSpace(r.URL.Query().Get("action"))
	if action == "" {
		action = workerActionRescueExport
	}
	if action != workerActionRescueExport && action != workerActionHermesImport {
		writeJSONAny(w, http.StatusBadRequest, map[string]string{"error": "unsupported_action"})
		return
	}
	if _, err := s.resolveBotTarget(r.Context(), session, botID); err != nil {
		writeWorkerActionUpstreamError(w, err)
		return
	}
	workflowID := buildWorkerActionWorkflowID(botID, action)
	status, err := s.backend.QueryWorkflow(r.Context(), workflowID, "", workerActionStatusQueryName)
	if err != nil {
		if workflowNotFound(err) {
			writeJSONAny(w, http.StatusOK, map[string]any{"data": map[string]any{
				"WorkflowID": workflowID,
				"Phase":      "not_found",
				"Logs":       []any{},
			}})
			return
		}
		writeJSONAny(w, http.StatusBadGateway, map[string]string{"error": "query_workflow_failed"})
		return
	}
	writeJSONAny(w, http.StatusOK, map[string]any{"data": status})
}

func (s *workerActionService) handleQuery(w http.ResponseWriter, r *http.Request, session *sessionEnvelope, actionRunID string) {
	botID := strings.TrimSpace(r.URL.Query().Get("bot_id"))
	if botID == "" {
		writeJSONAny(w, http.StatusBadRequest, map[string]string{"error": "bot_id_required"})
		return
	}
	if !workerActionRunBelongsToBot(actionRunID, botID) {
		writeJSONAny(w, http.StatusForbidden, map[string]string{"error": "action_run_forbidden"})
		return
	}
	if _, err := s.resolveBotTarget(r.Context(), session, botID); err != nil {
		writeWorkerActionUpstreamError(w, err)
		return
	}
	status, err := s.backend.QueryWorkflow(r.Context(), actionRunID, r.URL.Query().Get("run_id"), workerActionStatusQueryName)
	if err != nil {
		writeJSONAny(w, http.StatusBadGateway, map[string]string{"error": "query_workflow_failed"})
		return
	}
	writeJSONAny(w, http.StatusOK, map[string]any{"data": status})
}

func (s *workerActionService) handleCancel(w http.ResponseWriter, r *http.Request, session *sessionEnvelope, actionRunID string) {
	botID := strings.TrimSpace(r.URL.Query().Get("bot_id"))
	if botID == "" && r.Body != nil {
		var req workerActionCancelRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		botID = strings.TrimSpace(req.BotID)
	}
	if botID == "" {
		writeJSONAny(w, http.StatusBadRequest, map[string]string{"error": "bot_id_required"})
		return
	}
	if !workerActionRunBelongsToBot(actionRunID, botID) {
		writeJSONAny(w, http.StatusForbidden, map[string]string{"error": "action_run_forbidden"})
		return
	}
	if _, err := s.resolveBotTarget(r.Context(), session, botID); err != nil {
		writeWorkerActionUpstreamError(w, err)
		return
	}
	if err := s.backend.CancelWorkflow(r.Context(), actionRunID, r.URL.Query().Get("run_id")); err != nil {
		writeJSONAny(w, http.StatusBadGateway, map[string]string{"error": "cancel_workflow_failed"})
		return
	}
	writeJSONAny(w, http.StatusAccepted, map[string]any{"data": map[string]string{
		"action_run_id": actionRunID,
		"status":        "cancel_requested",
	}})
}

type resolvedBotTarget struct {
	BotID     string
	SandboxID string
	CloudID   string
	Region    string
	Status    string
}

func (s *workerActionService) resolveBotTarget(ctx context.Context, session *sessionEnvelope, botID string) (resolvedBotTarget, error) {
	instanceReq, err := http.NewRequestWithContext(ctx, http.MethodGet, s.ctlBaseURL+"/v1/instances/"+url.PathEscape(botID), nil)
	if err != nil {
		return resolvedBotTarget{}, err
	}
	injectIdentityHeaders(instanceReq.Header, session)
	instanceResp, err := s.client.Do(instanceReq)
	if err != nil {
		return resolvedBotTarget{}, err
	}
	defer instanceResp.Body.Close()
	if instanceResp.StatusCode != http.StatusOK {
		return resolvedBotTarget{}, workerActionHTTPError{StatusCode: instanceResp.StatusCode, Err: "resolve_bot_failed"}
	}
	var envelope ctlInstanceEnvelope
	if err := json.NewDecoder(instanceResp.Body).Decode(&envelope); err != nil {
		return resolvedBotTarget{}, err
	}
	if envelope.Code != "OK" || strings.TrimSpace(envelope.Data.SandboxID) == "" {
		return resolvedBotTarget{}, workerActionHTTPError{StatusCode: http.StatusBadGateway, Err: "bot_sandbox_unresolved"}
	}
	if envelope.Data.Status != "Running" && envelope.Data.Status != "Paused" {
		return resolvedBotTarget{}, workerActionHTTPError{StatusCode: http.StatusConflict, Err: "bot_status_invalid"}
	}

	sandboxReq, err := http.NewRequestWithContext(ctx, http.MethodGet, s.sandboxBaseURL+"/sandboxes/"+url.PathEscape(envelope.Data.SandboxID), nil)
	if err != nil {
		return resolvedBotTarget{}, err
	}
	injectIdentityHeaders(sandboxReq.Header, session)
	sandboxResp, err := s.client.Do(sandboxReq)
	if err != nil {
		return resolvedBotTarget{}, err
	}
	defer sandboxResp.Body.Close()
	if sandboxResp.StatusCode != http.StatusOK {
		return resolvedBotTarget{}, workerActionHTTPError{StatusCode: sandboxResp.StatusCode, Err: "resolve_sandbox_failed"}
	}
	var detail sandboxDetail
	if err := json.NewDecoder(sandboxResp.Body).Decode(&detail); err != nil {
		return resolvedBotTarget{}, err
	}
	return resolvedBotTarget{
		BotID:     envelope.Data.InstanceID,
		SandboxID: envelope.Data.SandboxID,
		CloudID:   strings.TrimSpace(detail.CloudID),
		Region:    strings.TrimSpace(detail.Region),
		Status:    envelope.Data.Status,
	}, nil
}

func (s *workerActionService) buildWorkerActionStartRequest(action string, raw json.RawMessage, target resolvedBotTarget, notifyEmail string) (any, string, []string, error) {
	switch action {
	case workerActionRescueExport:
		startReq, err := s.buildRescueExportRequest(raw, target, notifyEmail)
		return startReq, workerActionWorkflowName, startReq.RegionCandidates, err
	case workerActionHermesImport:
		startReq, err := s.buildHermesImportRequest(raw, target)
		return startReq, workerActionImportWorkflowName, startReq.RegionCandidates, err
	default:
		return nil, "", nil, errors.New("unsupported_action")
	}
}

func (s *workerActionService) buildHermesImportUpload(raw json.RawMessage, botID string) (workerActionUploadResponse, error) {
	var params hermesImportUploadParams
	if len(bytes.TrimSpace(raw)) > 0 {
		if err := json.Unmarshal(raw, &params); err != nil {
			return workerActionUploadResponse{}, errors.New("invalid_params")
		}
	}
	fileName := strings.TrimSpace(params.FileName)
	if fileName == "" {
		fileName = "hermes-backup.zip"
	}
	if !strings.HasSuffix(strings.ToLower(fileName), ".zip") {
		return workerActionUploadResponse{}, errors.New("hermes_import_zip_required")
	}
	if params.ByteSize < 0 {
		return workerActionUploadResponse{}, errors.New("invalid_file_size")
	}
	if strings.TrimSpace(s.cfg.RescueExport.COSUploadBucket) == "" {
		return workerActionUploadResponse{}, errors.New("cos_upload_bucket_not_configured")
	}
	objectKey, err := s.buildHermesImportObjectKey(botID, fileName)
	if err != nil {
		return workerActionUploadResponse{}, err
	}
	target, err := s.generateWorkerActionCOSTarget(objectKey, http.MethodPut, s.importUploadTTLSeconds())
	if err != nil {
		return workerActionUploadResponse{}, err
	}
	return workerActionUploadResponse{
		Action:    workerActionHermesImportUpload,
		BotID:     botID,
		ObjectKey: target.ObjectKey,
		ObjectURL: target.ObjectURL,
		UploadURL: target.SignedURL,
		ExpiresAt: target.ExpiresAt.Format(time.RFC3339),
		Status:    "upload_url_created",
	}, nil
}

func (s *workerActionService) buildHermesImportRequest(raw json.RawMessage, target resolvedBotTarget) (hermesImportStartRequest, error) {
	var params hermesImportActionParams
	if len(bytes.TrimSpace(raw)) > 0 {
		if err := json.Unmarshal(raw, &params); err != nil {
			return hermesImportStartRequest{}, errors.New("invalid_params")
		}
	}
	objectKey := strings.TrimSpace(params.ObjectKey)
	if objectKey == "" {
		return hermesImportStartRequest{}, errors.New("object_key_required")
	}
	if !s.isHermesImportObjectKey(objectKey) {
		return hermesImportStartRequest{}, errors.New("invalid_import_object_key")
	}
	if strings.TrimSpace(s.cfg.RescueExport.COSUploadBucket) == "" {
		return hermesImportStartRequest{}, errors.New("cos_upload_bucket_not_configured")
	}
	objectURL := strings.TrimSpace(params.ObjectURL)
	if objectURL == "" {
		objectURL = strings.TrimRight(s.cfg.RescueExport.COSUploadBucket, "/") + "/" + escapeWorkerActionCOSPath(objectKey)
	}
	return hermesImportStartRequest{
		BotID:                  target.BotID,
		InstanceID:             target.CloudID,
		Region:                 target.Region,
		RegionCandidates:       s.cfg.RescueExport.RegionCandidates,
		ImportObjectKey:        objectKey,
		ImportObjectURL:        objectURL,
		COSUploadBucket:        strings.TrimSpace(s.cfg.RescueExport.COSUploadBucket),
		COSUploadRegion:        s.cfg.RescueExport.COSUploadRegion,
		COSUploadKeyPrefix:     s.importUploadKeyPrefix(),
		COSUploadURLTTLSeconds: s.importUploadTTLSeconds(),
		TATUsername:            "agentuser",
		TATWorkingDirectory:    "/home/agentuser",
		TATWaitTimeoutSeconds:  180,
		Execute:                true,
		WaitTimeoutSeconds:     90,
		CommandTimeoutSeconds:  1800,
	}, nil
}

func (s *workerActionService) taskQueueForAction(action string) string {
	switch action {
	case workerActionHermesImport:
		if queue := strings.TrimSpace(s.cfg.HermesImport.TaskQueue); queue != "" {
			return queue
		}
	case workerActionRescueExport:
		if queue := strings.TrimSpace(s.cfg.RescueExport.TaskQueue); queue != "" {
			return queue
		}
	}
	return strings.TrimSpace(s.cfg.Temporal.TaskQueue)
}

func (s *workerActionService) buildRescueExportRequest(raw json.RawMessage, target resolvedBotTarget, notifyEmail string) (rescueExportStartRequest, error) {
	var params rescueExportActionParams
	if len(bytes.TrimSpace(raw)) > 0 {
		if err := json.Unmarshal(raw, &params); err != nil {
			return rescueExportStartRequest{}, errors.New("invalid_params")
		}
	}
	archiveMode := normalizeRescueArchiveMode(params.ArchiveMode)
	if archiveMode != rescueArchiveModeHermes && archiveMode != rescueArchiveModeGeneric {
		return rescueExportStartRequest{}, errors.New("invalid_archive_mode")
	}
	remotePaths := normalizeWorkerActionRemotePaths(params.RemotePaths)
	if len(remotePaths) == 0 && archiveMode == rescueArchiveModeHermes {
		remotePaths = []string{defaultHermesRemotePath}
	}
	if len(remotePaths) == 0 && archiveMode == rescueArchiveModeGeneric {
		return rescueExportStartRequest{}, errors.New("remote_paths_required")
	}
	if archiveMode == rescueArchiveModeHermes && len(remotePaths) != 1 {
		return rescueExportStartRequest{}, errors.New("hermes_remote_path_must_be_single")
	}
	if strings.TrimSpace(s.cfg.RescueExport.COSUploadBucket) == "" {
		return rescueExportStartRequest{}, errors.New("cos_upload_bucket_not_configured")
	}
	return rescueExportStartRequest{
		BotID:                  target.BotID,
		InstanceID:             target.CloudID,
		Region:                 target.Region,
		RegionCandidates:       s.cfg.RescueExport.RegionCandidates,
		NotificationEmail:      notifyEmail,
		NotifyEmail:            notifyEmail,
		RescueUsername:         "root",
		RescuePasswordEnv:      "RESCUE_PASSWORD",
		StopType:               "SOFT_FIRST",
		DeviceGlobs:            []string{"/dev/vda*", "/dev/vdb*"},
		RemotePaths:            remotePaths,
		ArchiveMode:            archiveMode,
		MountRoot:              "/mnt/rescue-root",
		RemoteWorkDir:          "/root",
		LocalOutputDir:         "./exports",
		CommandTransport:       "tat",
		TATUsername:            "root",
		TATWorkingDirectory:    "/root",
		TATWaitTimeoutSeconds:  180,
		COSUploadBucket:        strings.TrimSpace(s.cfg.RescueExport.COSUploadBucket),
		COSUploadRegion:        s.cfg.RescueExport.COSUploadRegion,
		COSUploadKeyPrefix:     s.cfg.RescueExport.COSUploadKeyPrefix,
		COSUploadURLTTLSeconds: s.cfg.RescueExport.COSUploadURLTTLSeconds,
		Execute:                true,
		Confirmed:              true,
		WaitTimeoutSeconds:     90,
		CommandTimeoutSeconds:  1800,
	}, nil
}

type workerActionCOSTarget struct {
	ObjectKey string
	ObjectURL string
	SignedURL string
	ExpiresAt time.Time
}

func (s *workerActionService) buildHermesImportObjectKey(botID string, fileName string) (string, error) {
	random := make([]byte, 12)
	if _, err := rand.Read(random); err != nil {
		return "", err
	}
	name := safeWorkerActionIDPart(strings.TrimSuffix(path.Base(fileName), path.Ext(fileName)))
	if name == "" || name == "unknown" {
		name = "hermes-backup"
	}
	return path.Join(strings.Trim(s.importUploadKeyPrefix(), "/"), safeWorkerActionIDPart(botID), fmt.Sprintf("%d-%s-%s.zip", time.Now().Unix(), hex.EncodeToString(random), name)), nil
}

func (s *workerActionService) isHermesImportObjectKey(objectKey string) bool {
	prefix := strings.Trim(s.importUploadKeyPrefix(), "/")
	if prefix == "" {
		return false
	}
	objectKey = strings.Trim(objectKey, "/")
	return objectKey == prefix || strings.HasPrefix(objectKey, prefix+"/")
}

func (s *workerActionService) importUploadKeyPrefix() string {
	if prefix := strings.TrimSpace(s.cfg.HermesImport.UploadKeyPrefix); prefix != "" {
		return prefix
	}
	if prefix := strings.TrimSpace(s.cfg.RescueExport.ImportUploadKeyPrefix); prefix != "" {
		return prefix
	}
	return "rescue-imports"
}

func (s *workerActionService) importUploadTTLSeconds() int {
	if s.cfg.HermesImport.UploadURLTTLSeconds > 0 {
		return s.cfg.HermesImport.UploadURLTTLSeconds
	}
	if s.cfg.RescueExport.ImportUploadURLTTLSeconds > 0 {
		return s.cfg.RescueExport.ImportUploadURLTTLSeconds
	}
	return defaultImportUploadTTLSeconds
}

func (s *workerActionService) generateWorkerActionCOSTarget(objectKey string, method string, ttlSeconds int) (workerActionCOSTarget, error) {
	secretID, secretKey := strings.TrimSpace(os.Getenv("TENCENTCLOUD_SECRET_ID")), strings.TrimSpace(os.Getenv("TENCENTCLOUD_SECRET_KEY"))
	if secretID == "" || secretKey == "" {
		return workerActionCOSTarget{}, errors.New("cos_credentials_not_configured")
	}
	bucketURL := strings.TrimRight(s.cfg.RescueExport.COSUploadBucket, "/")
	parsed, err := url.Parse(bucketURL)
	if err != nil {
		return workerActionCOSTarget{}, errors.New("invalid_cos_upload_bucket")
	}
	if parsed.Scheme != "https" || parsed.Host == "" {
		return workerActionCOSTarget{}, errors.New("invalid_cos_upload_bucket")
	}
	if region := strings.TrimSpace(s.cfg.RescueExport.COSUploadRegion); region != "" && !strings.Contains(parsed.Host, ".cos."+region+".") {
		return workerActionCOSTarget{}, errors.New("cos_upload_bucket_region_mismatch")
	}
	if ttlSeconds <= 0 {
		ttlSeconds = defaultImportUploadTTLSeconds
	}
	escapedPath := "/" + escapeWorkerActionCOSPath(objectKey)
	return workerActionCOSTarget{
		ObjectKey: objectKey,
		ObjectURL: bucketURL + escapedPath,
		SignedURL: signWorkerActionCOSURL(secretID, secretKey, parsed.Host, escapedPath, ttlSeconds, method),
		ExpiresAt: time.Now().Add(time.Duration(ttlSeconds) * time.Second),
	}, nil
}

func normalizeRescueArchiveMode(mode string) string {
	mode = strings.ToLower(strings.TrimSpace(mode))
	if mode == "" {
		return rescueArchiveModeHermes
	}
	return mode
}

func normalizeWorkerActionRemotePaths(paths []string) []string {
	out := make([]string, 0, len(paths))
	seen := map[string]bool{}
	for _, path := range paths {
		path = strings.TrimSpace(path)
		if path == "" || seen[path] {
			continue
		}
		seen[path] = true
		out = append(out, path)
	}
	return out
}

func buildWorkerActionWorkflowID(botID string, action string) string {
	return fmt.Sprintf("worker-action-%s-%s", safeWorkerActionIDPart(botID), safeWorkerActionIDPart(action))
}

func workerActionRunBelongsToBot(actionRunID string, botID string) bool {
	return strings.HasPrefix(actionRunID, "worker-action-"+safeWorkerActionIDPart(botID)+"-")
}

func safeWorkerActionIDPart(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return "unknown"
	}
	value = workerActionIDSafePattern.ReplaceAllString(value, "-")
	value = strings.Trim(value, "-_")
	if value == "" {
		return "unknown"
	}
	return value
}

type workerActionHTTPError struct {
	StatusCode int
	Err        string
}

func (e workerActionHTTPError) Error() string {
	return e.Err
}

func writeWorkerActionUpstreamError(w http.ResponseWriter, err error) {
	var httpErr workerActionHTTPError
	if errors.As(err, &httpErr) {
		writeJSONAny(w, httpErr.StatusCode, map[string]string{"error": httpErr.Err})
		return
	}
	writeJSONAny(w, http.StatusBadGateway, map[string]string{"error": "worker_action_upstream_failed"})
}

func workflowAlreadyStartedRun(err error) (workerActionWorkflowRun, bool) {
	var alreadyStarted *serviceerror.WorkflowExecutionAlreadyStarted
	if !errors.As(err, &alreadyStarted) {
		return workerActionWorkflowRun{}, false
	}
	return workerActionWorkflowRun{RunID: alreadyStarted.RunId}, true
}

func workflowNotFound(err error) bool {
	var notFound *serviceerror.NotFound
	return errors.As(err, &notFound)
}

func writeJSONAny(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func (b temporalWorkerActionBackend) StartWorkflow(ctx context.Context, taskQueue string, workflowID string, workflowName string, args ...any) (workerActionWorkflowRun, error) {
	tc, err := dialWorkerActionTemporal(b.cfg)
	if err != nil {
		return workerActionWorkflowRun{}, err
	}
	defer tc.Close()
	run, err := tc.ExecuteWorkflow(ctx, client.StartWorkflowOptions{
		ID:                                       workflowID,
		TaskQueue:                                strings.TrimSpace(taskQueue),
		WorkflowIDConflictPolicy:                 enumspb.WORKFLOW_ID_CONFLICT_POLICY_FAIL,
		WorkflowIDReusePolicy:                    enumspb.WORKFLOW_ID_REUSE_POLICY_ALLOW_DUPLICATE,
		WorkflowExecutionErrorWhenAlreadyStarted: true,
	}, workflowName, args...)
	if err != nil {
		return workerActionWorkflowRun{}, err
	}
	return workerActionWorkflowRun{WorkflowID: run.GetID(), RunID: run.GetRunID()}, nil
}

func (b temporalWorkerActionBackend) QueryWorkflow(ctx context.Context, workflowID string, runID string, queryType string) (map[string]any, error) {
	tc, err := dialWorkerActionTemporal(b.cfg)
	if err != nil {
		return nil, err
	}
	defer tc.Close()
	encoded, err := tc.QueryWorkflow(ctx, workflowID, runID, queryType)
	if err != nil {
		return nil, err
	}
	var status map[string]any
	if err := encoded.Get(&status); err != nil {
		return nil, err
	}
	return status, nil
}

func (b temporalWorkerActionBackend) CancelWorkflow(ctx context.Context, workflowID string, runID string) error {
	tc, err := dialWorkerActionTemporal(b.cfg)
	if err != nil {
		return err
	}
	defer tc.Close()
	return tc.CancelWorkflow(ctx, workflowID, runID)
}

func dialWorkerActionTemporal(cfg WorkerActionTemporalConfig) (client.Client, error) {
	if strings.TrimSpace(cfg.Address) == "" {
		return nil, errors.New("temporal address is not configured")
	}
	namespace := strings.TrimSpace(cfg.Namespace)
	if namespace == "" {
		namespace = "default"
	}
	options := client.Options{
		HostPort:  strings.TrimSpace(cfg.Address),
		Namespace: namespace,
		Logger:    sdklog.NewStructuredLogger(slog.New(slog.NewTextHandler(os.Stderr, nil))),
	}
	useTLS := true
	if cfg.TLS != nil {
		useTLS = *cfg.TLS
	}
	if useTLS {
		serverName := strings.TrimSpace(cfg.ServerName)
		if serverName == "" {
			serverName = strings.Split(options.HostPort, ":")[0]
		}
		options.ConnectionOptions.TLS = &tls.Config{ServerName: serverName}
	}
	if timeout := strings.TrimSpace(cfg.Timeout); timeout != "" {
		parsed, err := time.ParseDuration(timeout)
		if err != nil {
			return nil, fmt.Errorf("parse temporal timeout: %w", err)
		}
		options.ConnectionOptions.GetSystemInfoTimeout = parsed
	} else {
		options.ConnectionOptions.GetSystemInfoTimeout = 10 * time.Second
	}
	if tokenEnv := strings.TrimSpace(cfg.TokenEnv); tokenEnv != "" {
		if token := strings.TrimSpace(os.Getenv(tokenEnv)); token != "" {
			options.HeadersProvider = workerActionBearerHeadersProvider{token: token}
		}
	}
	return client.Dial(options)
}

type workerActionBearerHeadersProvider struct {
	token string
}

func (p workerActionBearerHeadersProvider) GetHeaders(context.Context) (map[string]string, error) {
	return map[string]string{"authorization": "Bearer " + p.token}, nil
}

func signWorkerActionCOSURL(secretID, secretKey, host, uri string, ttlSeconds int, method string) string {
	method = strings.ToLower(method)
	now := time.Now().Unix()
	keyTime := fmt.Sprintf("%d;%d", now, now+int64(ttlSeconds))
	headerList := "host"
	urlParamList := ""
	headerString := "host=" + workerActionCOSEncode(strings.ToLower(host))
	httpString := strings.Join([]string{method, uri, "", headerString}, "\n") + "\n"
	stringToSign := strings.Join([]string{"sha1", keyTime, workerActionSHA1Hex([]byte(httpString)), ""}, "\n")
	signKey := workerActionHMACSHA1Hex([]byte(secretKey), []byte(keyTime))
	signature := workerActionHMACSHA1Hex([]byte(signKey), []byte(stringToSign))
	query := map[string]string{
		"q-sign-algorithm": "sha1",
		"q-ak":             secretID,
		"q-sign-time":      keyTime,
		"q-key-time":       keyTime,
		"q-header-list":    headerList,
		"q-url-param-list": urlParamList,
		"q-signature":      signature,
	}
	keys := make([]string, 0, len(query))
	for key := range query {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, key := range keys {
		parts = append(parts, workerActionCOSEncode(key)+"="+workerActionCOSEncode(query[key]))
	}
	return "https://" + host + uri + "?" + strings.Join(parts, "&")
}

func escapeWorkerActionCOSPath(value string) string {
	parts := strings.Split(value, "/")
	for i, part := range parts {
		parts[i] = workerActionCOSEncode(part)
	}
	return strings.Join(parts, "/")
}

func workerActionCOSEncode(value string) string {
	return strings.ReplaceAll(url.QueryEscape(value), "+", "%20")
}

func workerActionSHA1Hex(data []byte) string {
	sum := sha1.Sum(data)
	return hex.EncodeToString(sum[:])
}

func workerActionHMACSHA1Hex(key, data []byte) string {
	mac := hmac.New(sha1.New, key)
	mac.Write(data)
	return hex.EncodeToString(mac.Sum(nil))
}
