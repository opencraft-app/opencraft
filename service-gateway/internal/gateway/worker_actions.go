package gateway

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"go.temporal.io/sdk/client"
	sdklog "go.temporal.io/sdk/log"
)

const (
	workerActionRouteName       = "worker-actions"
	workerActionPathPrefix      = "/api/worker-actions"
	workerActionRescueExport    = "rescue_export"
	workerActionWorkflowName    = "ExportWorkflow"
	workerActionStatusQueryName = "status"
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
	SkipBackup  bool     `json:"skip_backup,omitempty"`
}

type workerActionResponse struct {
	ActionRunID string `json:"action_run_id"`
	WorkflowID  string `json:"workflow_id"`
	RunID       string `json:"run_id,omitempty"`
	Action      string `json:"action"`
	BotID       string `json:"bot_id"`
	Status      string `json:"status"`
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
	InstanceID             string
	Region                 string
	RegionCandidates       []string
	NotificationEmail      string
	NotifyEmail            string
	RescueUsername         string
	RescuePasswordEnv      string
	StopType               string
	SkipBackup             bool
	DeviceGlobs            []string
	RemotePaths            []string
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
	if strings.TrimSpace(cfg.Temporal.Namespace) == "" {
		cfg.Temporal.Namespace = "default"
	}
	if strings.TrimSpace(cfg.Temporal.TaskQueue) == "" {
		cfg.Temporal.TaskQueue = "tencent-cvm-rescue-export"
	}
	if strings.TrimSpace(cfg.Temporal.TokenEnv) == "" {
		cfg.Temporal.TokenEnv = "TEMPORAL_BEARER_TOKEN"
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
	if action != workerActionRescueExport {
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

	startReq, err := s.buildRescueExportRequest(req.Params, target, session.Session.User.Email)
	if err != nil {
		writeJSONAny(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	workflowID := buildWorkerActionWorkflowID(botID, action)
	run, err := s.backend.StartWorkflow(r.Context(), s.cfg.Temporal.TaskQueue, workflowID, workerActionWorkflowName, startReq, rescueTencentConfig{RegionCandidates: startReq.RegionCandidates})
	if err != nil {
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

func (s *workerActionService) buildRescueExportRequest(raw json.RawMessage, target resolvedBotTarget, notifyEmail string) (rescueExportStartRequest, error) {
	var params rescueExportActionParams
	if len(bytes.TrimSpace(raw)) > 0 {
		if err := json.Unmarshal(raw, &params); err != nil {
			return rescueExportStartRequest{}, errors.New("invalid_params")
		}
	}
	remotePaths := normalizeWorkerActionRemotePaths(params.RemotePaths)
	if len(remotePaths) == 0 {
		return rescueExportStartRequest{}, errors.New("remote_paths_required")
	}
	if strings.TrimSpace(s.cfg.RescueExport.COSUploadBucket) == "" {
		return rescueExportStartRequest{}, errors.New("cos_upload_bucket_not_configured")
	}
	return rescueExportStartRequest{
		InstanceID:             target.CloudID,
		Region:                 target.Region,
		RegionCandidates:       s.cfg.RescueExport.RegionCandidates,
		NotificationEmail:      notifyEmail,
		NotifyEmail:            notifyEmail,
		RescueUsername:         "root",
		RescuePasswordEnv:      "RESCUE_PASSWORD",
		StopType:               "SOFT_FIRST",
		SkipBackup:             params.SkipBackup,
		DeviceGlobs:            []string{"/dev/vda*", "/dev/vdb*"},
		RemotePaths:            remotePaths,
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
	return fmt.Sprintf("worker-action-%s-%s-%d", safeWorkerActionIDPart(botID), safeWorkerActionIDPart(action), time.Now().UnixNano())
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
		ID:        workflowID,
		TaskQueue: strings.TrimSpace(taskQueue),
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
