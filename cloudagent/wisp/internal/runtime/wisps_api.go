package runtime

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	pathpkg "path"
	"strconv"
	"strings"
	"time"

	"github.com/gorilla/websocket"

	"wisp/internal/config"
)

const (
	wispFSAgentPath          = "/.wisp/bin/wisp-fs-agent"
	wispFSAgentTimeout       = 10 * time.Second
	wispFSBodyLimit          = 1 << 20
	wispFetchBodyLimit       = 64 * 1024
	wispFetchMaxBytes        = 512 << 20
	wispFetchDefaultMaxBytes = 64 << 20
)

type WispResource struct {
	Name         string          `json:"name"`
	State        string          `json:"state"`
	Capabilities map[string]bool `json:"capabilities"`
}

type wispExecRequest struct {
	Argv []string `json:"argv"`
}

type wispExecResponse struct {
	Wisp     string `json:"wisp"`
	Mode     string `json:"mode"`
	Status   string `json:"status"`
	ExitCode int    `json:"exit_code"`
	Stdout   string `json:"stdout,omitempty"`
	Stderr   string `json:"stderr,omitempty"`
}

type wispCheckpointCreateRequest struct {
	ID string `json:"id"`
}

type wispFilesystemWriteRequest struct {
	Path     string `json:"path"`
	Content  string `json:"content"`
	Encoding string `json:"encoding,omitempty"`
}

type wispFilesystemFetchRequest struct {
	URL          string `json:"url"`
	Path         string `json:"path"`
	SHA256       string `json:"sha256,omitempty"`
	Mode         string `json:"mode,omitempty"`
	MaxBytes     int64  `json:"max_bytes,omitempty"`
	AllowPrivate bool   `json:"allow_private,omitempty"`
}

type wispFilesystemPathRequest struct {
	Path string `json:"path"`
	Mode string `json:"mode,omitempty"`
}

type wispFilesystemRenameRequest struct {
	Path    string `json:"path"`
	NewPath string `json:"new_path"`
}

type wispFilesystemDeleteRequest struct {
	Path string `json:"path"`
}

type wispFilesystemEntry struct {
	Path string `json:"path"`
	Type string `json:"type"`
	Size int64  `json:"size"`
	Mode string `json:"mode,omitempty"`
}

type wispFilesystemContent struct {
	Path     string `json:"path"`
	Content  string `json:"content"`
	Encoding string `json:"encoding"`
}

type wispFilesystemFetchContent struct {
	Bytes  []byte
	SHA256 string
}

type wispFSAgentResponse struct {
	OK     bool            `json:"ok"`
	Code   string          `json:"code,omitempty"`
	Error  string          `json:"error,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`
}

func (d *Daemon) handleWispsList(w http.ResponseWriter, r *http.Request) {
	configFile, _ := d.currentConfigPaths()
	names, err := config.ListContainerNames(configFile)
	if err != nil {
		writeError(w, err)
		return
	}
	items := make([]WispResource, 0, len(names))
	for _, name := range names {
		rt, err := d.runtimeForNameLocked(name)
		if err != nil {
			writeError(w, err)
			return
		}
		items = append(items, wispResourceFromStatus(rt.cfg.WispName, rt.runtimeStatus(r.Context())))
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "wisps": items})
}

func (d *Daemon) handleWispCreate(w http.ResponseWriter, r *http.Request) {
	var (
		name    string
		reqErr  error
		started = d.logRequestStart("wisp.create", "")
	)
	defer func() { d.logRequestDone("wisp.create", name, started, reqErr) }()
	req, err := decodeRuntimeRequest(r)
	if err != nil {
		reqErr = err
		writeError(w, err)
		return
	}
	name = strings.TrimSpace(req.Name)
	if name == "" {
		reqErr = badRequest("wisp name is required", map[string]any{"operation": "create_wisp"})
		writeError(w, reqErr)
		return
	}
	unlock := d.lockWisp(name)
	defer unlock()

	configFile, _ := d.currentConfigPaths()
	baseCfg, err := config.Load(configFile)
	if err != nil {
		reqErr = err
		writeError(w, err)
		return
	}
	if err := config.SetWorkspaceLayout(configFile, baseCfg, name); err != nil {
		reqErr = err
		writeError(w, err)
		return
	}
	if baseCfg, err = config.LoadContainer(configFile, name); err != nil {
		reqErr = err
		writeError(w, err)
		return
	}
	if baseCfg, err = ensureWorkspaceBackendProvisioned(r.Context(), configFile, baseCfg, name); err != nil {
		reqErr = err
		writeError(w, err)
		return
	}
	rt, err := d.runtimeForNameLocked(name)
	if err != nil {
		reqErr = err
		writeError(w, err)
		return
	}
	if err := rt.EnsureWorkspaceReady(r.Context()); err != nil {
		reqErr = err
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "wisp": wispResourceFromStatus(rt.cfg.WispName, rt.runtimeStatus(r.Context()))})
}

func (d *Daemon) handleWispGet(w http.ResponseWriter, r *http.Request) {
	rt, err := d.runtimeForWispLocked(r.PathValue("wisp"))
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "wisp": wispResourceFromStatus(rt.cfg.WispName, rt.runtimeStatus(r.Context()))})
}

func (d *Daemon) handleWispStart(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("wisp")
	unlock := d.lockWisp(name)
	defer unlock()
	rt, err := d.runtimeForWispLocked(name)
	if err != nil {
		writeError(w, err)
		return
	}
	d.mu.Lock()
	d.rt = rt
	_ = d.closeEnvListenerLocked()
	if err := d.ensureEnvListenerLocked(); err != nil {
		d.mu.Unlock()
		writeError(w, err)
		return
	}
	d.mu.Unlock()
	if err := rt.Start(r.Context()); err != nil {
		d.mu.Lock()
		_ = d.closeEnvListenerLocked()
		d.mu.Unlock()
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "wisp": wispResourceFromStatus(rt.cfg.WispName, rt.runtimeStatus(r.Context()))})
}

func (d *Daemon) handleWispStop(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("wisp")
	unlock := d.lockWisp(name)
	defer unlock()
	rt, err := d.runtimeForWispLocked(name)
	if err != nil {
		writeError(w, err)
		return
	}
	force := parseBoolQuery(r, "force")
	if err := rt.StopWithOptions(r.Context(), StopOptions{Force: force}); err != nil {
		writeError(w, err)
		return
	}
	d.mu.Lock()
	d.rt = rt
	_ = d.closeEnvListenerLocked()
	d.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "force": force, "wisp": wispResourceFromStatus(rt.cfg.WispName, rt.runtimeStatus(r.Context()))})
}

func parseBoolQuery(r *http.Request, key string) bool {
	value := strings.ToLower(strings.TrimSpace(r.URL.Query().Get(key)))
	return value == "1" || value == "true" || value == "yes" || value == "on"
}

func (d *Daemon) handleWispDestroy(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimSpace(r.PathValue("wisp"))
	unlock := d.lockWisp(name)
	defer unlock()
	rt, err := d.runtimeForWispLocked(name)
	if err != nil {
		writeError(w, err)
		return
	}
	if err := rt.Destroy(r.Context()); err != nil {
		writeError(w, err)
		return
	}
	d.mu.Lock()
	d.rt = rt
	_ = d.closeEnvListenerLocked()
	d.mu.Unlock()
	configFile, _ := d.currentConfigPaths()
	if err := config.RemoveContainerOverlay(configFile, name); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "deleted": true, "name": name})
}

func (d *Daemon) handleWispExecWS(w http.ResponseWriter, r *http.Request) {
	rt, err := d.runtimeForWispLocked(r.PathValue("wisp"))
	if err != nil {
		writeError(w, err)
		return
	}

	upgrader := websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return true }}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()

	argv := r.URL.Query()["argv"]
	cols, _ := strconv.ParseUint(strings.TrimSpace(r.URL.Query().Get("cols")), 10, 16)
	rows, _ := strconv.ParseUint(strings.TrimSpace(r.URL.Query().Get("rows")), 10, 16)
	cmd, ptmx, err := rt.execPTY(r.Context(), argv, uint16(cols), uint16(rows))
	if err != nil {
		_ = conn.WriteJSON(map[string]any{"ok": false, "error": err.Error()})
		return
	}
	if err := streamPTYOverWebsocket(r.Context(), conn, ptmx, cmd); err != nil {
		_ = conn.WriteJSON(map[string]any{"ok": false, "error": err.Error()})
	}
}

func (d *Daemon) handleWispExec(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("wisp")
	unlock := d.lockWisp(name)
	defer unlock()
	rt, err := d.runtimeForWispLocked(name)
	if err != nil {
		writeError(w, err)
		return
	}
	var req wispExecRequest
	if err := decodeJSONBody(r, &req, wispFSBodyLimit); err != nil {
		writeError(w, err)
		return
	}
	if len(req.Argv) == 0 {
		writeError(w, badRequest("exec argv is required", map[string]any{"operation": "wisp_exec"}))
		return
	}
	result, err := rt.ExecCommand(r.Context(), req.Argv, nil)
	if err != nil {
		writeError(w, err)
		return
	}
	status := "completed"
	if result.ExitCode != 0 {
		status = "failed"
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "result": wispExecResponse{
		Wisp:     rt.cfg.WispName,
		Mode:     "command",
		Status:   status,
		ExitCode: result.ExitCode,
		Stdout:   result.Stdout,
		Stderr:   result.Stderr,
	}})
}

func (d *Daemon) handleWispCheckpointList(w http.ResponseWriter, r *http.Request) {
	rt, err := d.runtimeForWispLocked(r.PathValue("wisp"))
	if err != nil {
		writeError(w, err)
		return
	}
	items, err := rt.ListCheckpoints(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "checkpoints": items})
}

func (d *Daemon) handleWispCheckpointCreate(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("wisp")
	unlock := d.lockWisp(name)
	defer unlock()
	rt, err := d.runtimeForWispLocked(name)
	if err != nil {
		writeError(w, err)
		return
	}
	var req wispCheckpointCreateRequest
	if err := decodeJSONBody(r, &req, 64*1024); err != nil {
		writeError(w, err)
		return
	}
	id := strings.TrimSpace(req.ID)
	if id == "" {
		id = time.Now().UTC().Format("20060102T150405Z")
	}
	if err := rt.CreateCheckpoint(r.Context(), id); err != nil {
		writeError(w, err)
		return
	}
	item, err := rt.GetCheckpoint(r.Context(), id)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "checkpoint": item})
}

func (d *Daemon) handleWispCheckpointGet(w http.ResponseWriter, r *http.Request) {
	rt, err := d.runtimeForWispLocked(r.PathValue("wisp"))
	if err != nil {
		writeError(w, err)
		return
	}
	item, err := rt.GetCheckpoint(r.Context(), r.PathValue("checkpoint"))
	if err != nil {
		if strings.Contains(err.Error(), "checkpoint not found") {
			writeError(w, notFoundError("checkpoint_not_found", err.Error()))
			return
		}
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "checkpoint": item})
}

func (d *Daemon) handleWispCheckpointRestore(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("wisp")
	unlock := d.lockWisp(name)
	defer unlock()
	rt, err := d.runtimeForWispLocked(name)
	if err != nil {
		writeError(w, err)
		return
	}
	if err := rt.RestoreCheckpoint(r.Context(), r.PathValue("checkpoint")); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "restored": true, "checkpoint": r.PathValue("checkpoint")})
}

func (d *Daemon) handleWispCheckpointDelete(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("wisp")
	unlock := d.lockWisp(name)
	defer unlock()
	rt, err := d.runtimeForWispLocked(name)
	if err != nil {
		writeError(w, err)
		return
	}
	checkpointID := r.PathValue("checkpoint")
	if err := rt.DeleteCheckpoint(r.Context(), checkpointID); err != nil {
		if strings.Contains(err.Error(), "checkpoint not found") {
			writeError(w, notFoundError("checkpoint_not_found", err.Error()))
			return
		}
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "deleted": true, "checkpoint": checkpointID})
}

func (d *Daemon) handleWispFilesystemList(w http.ResponseWriter, r *http.Request) {
	rt, err := d.runtimeForWispLocked(r.PathValue("wisp"))
	if err != nil {
		writeError(w, err)
		return
	}
	target, err := normalizeWispPath(defaultPath(r.URL.Query().Get("path"), "/"))
	if err != nil {
		writeError(w, err)
		return
	}
	var entries []wispFilesystemEntry
	if err := invokeFilesystemAgent(r.Context(), rt, "list", map[string]any{"path": target}, &entries); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "entries": entries})
}

func (d *Daemon) handleWispFilesystemRead(w http.ResponseWriter, r *http.Request) {
	rt, err := d.runtimeForWispLocked(r.PathValue("wisp"))
	if err != nil {
		writeError(w, err)
		return
	}
	target, err := normalizeWispPath(r.URL.Query().Get("path"))
	if err != nil {
		writeError(w, err)
		return
	}
	var content wispFilesystemContent
	if err := invokeFilesystemAgent(r.Context(), rt, "read", map[string]any{"path": target}, &content); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "file": content})
}

func (d *Daemon) handleWispFilesystemWrite(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("wisp")
	unlock := d.lockWisp(name)
	defer unlock()
	rt, err := d.runtimeForWispLocked(name)
	if err != nil {
		writeError(w, err)
		return
	}
	var req wispFilesystemWriteRequest
	if err := decodeJSONBody(r, &req, wispFSBodyLimit); err != nil {
		writeError(w, err)
		return
	}
	target, err := normalizeWispPath(req.Path)
	if err != nil {
		writeError(w, err)
		return
	}
	req.Path = target
	if req.Encoding == "" {
		req.Encoding = "utf-8"
	}
	if req.Encoding != "utf-8" && req.Encoding != "base64" {
		writeError(w, badRequest("filesystem encoding must be utf-8 or base64", nil))
		return
	}
	if req.Encoding == "base64" {
		if _, err := base64.StdEncoding.DecodeString(req.Content); err != nil {
			writeError(w, badRequest("filesystem content is not valid base64", nil))
			return
		}
	}
	if err := invokeFilesystemAgent(r.Context(), rt, "write", req, nil); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "written": true, "path": req.Path})
}

func (d *Daemon) handleWispFilesystemFetch(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("wisp")
	unlock := d.lockWisp(name)
	defer unlock()
	rt, err := d.runtimeForWispLocked(name)
	if err != nil {
		writeError(w, err)
		return
	}
	var req wispFilesystemFetchRequest
	if err := decodeJSONBody(r, &req, wispFetchBodyLimit); err != nil {
		writeError(w, err)
		return
	}
	target, err := normalizeWispPath(req.Path)
	if err != nil {
		writeError(w, err)
		return
	}
	req.Path = target
	if strings.TrimSpace(req.Mode) == "" {
		req.Mode = "0644"
	}
	if _, err := strconv.ParseUint(req.Mode, 8, 32); err != nil {
		writeError(w, badRequest("filesystem fetch mode must be octal", nil))
		return
	}
	content, err := downloadWispFetchContent(r.Context(), req)
	if err != nil {
		writeError(w, err)
		return
	}
	if !rt.runtimeStatus(r.Context()).Running {
		writeError(w, conflictError("wisp_not_running", fmt.Sprintf("wisp %s is not running", rt.cfg.WispName)))
		return
	}
	fsCtx, cancel := context.WithTimeout(r.Context(), wispFSAgentTimeout)
	defer cancel()
	result, err := rt.ExecCommand(fsCtx, []string{wispFSAgentPath, "write-raw", req.Path, req.Mode}, content.Bytes)
	if err != nil {
		writeError(w, err)
		return
	}
	if result.ExitCode != 0 {
		msg := redactStderr(result.Stderr)
		if msg == "" {
			msg = "filesystem fetch write failed"
		}
		writeError(w, &apiError{Status: http.StatusBadGateway, Code: "filesystem_fetch_write_failed", Message: msg})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"fetched": true,
		"path":    req.Path,
		"bytes":   len(content.Bytes),
		"sha256":  content.SHA256,
	})
}

func (d *Daemon) handleWispFilesystemMkdir(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("wisp")
	unlock := d.lockWisp(name)
	defer unlock()
	rt, err := d.runtimeForWispLocked(name)
	if err != nil {
		writeError(w, err)
		return
	}
	var req wispFilesystemPathRequest
	if err := decodeJSONBody(r, &req, 64*1024); err != nil {
		writeError(w, err)
		return
	}
	target, err := normalizeWispPath(req.Path)
	if err != nil {
		writeError(w, err)
		return
	}
	if err := invokeFilesystemAgent(r.Context(), rt, "mkdir", map[string]any{"path": target, "mode": req.Mode}, nil); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "created": true, "path": target})
}

func (d *Daemon) handleWispFilesystemRename(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("wisp")
	unlock := d.lockWisp(name)
	defer unlock()
	rt, err := d.runtimeForWispLocked(name)
	if err != nil {
		writeError(w, err)
		return
	}
	var req wispFilesystemRenameRequest
	if err := decodeJSONBody(r, &req, 64*1024); err != nil {
		writeError(w, err)
		return
	}
	oldPath, err := normalizeWispPath(req.Path)
	if err != nil {
		writeError(w, err)
		return
	}
	newPath, err := normalizeWispPath(req.NewPath)
	if err != nil {
		writeError(w, err)
		return
	}
	if err := invokeFilesystemAgent(r.Context(), rt, "rename", map[string]any{"path": oldPath, "new_path": newPath}, nil); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "renamed": true, "path": oldPath, "new_path": newPath})
}

func (d *Daemon) handleWispFilesystemDelete(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("wisp")
	unlock := d.lockWisp(name)
	defer unlock()
	rt, err := d.runtimeForWispLocked(name)
	if err != nil {
		writeError(w, err)
		return
	}
	target, err := normalizeWispPath(r.URL.Query().Get("path"))
	if err != nil {
		writeError(w, err)
		return
	}
	if err := invokeFilesystemAgent(r.Context(), rt, "delete", wispFilesystemDeleteRequest{Path: target}, nil); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "deleted": true, "path": target})
}

func (d *Daemon) handleWispFilesystemStat(w http.ResponseWriter, r *http.Request) {
	rt, err := d.runtimeForWispLocked(r.PathValue("wisp"))
	if err != nil {
		writeError(w, err)
		return
	}
	target, err := normalizeWispPath(r.URL.Query().Get("path"))
	if err != nil {
		writeError(w, err)
		return
	}
	var entry wispFilesystemEntry
	if err := invokeFilesystemAgent(r.Context(), rt, "stat", map[string]any{"path": target}, &entry); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "entry": entry})
}

func (d *Daemon) runtimeForWispLocked(name string) (*Runtime, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return nil, badRequest("wisp name is required", nil)
	}
	rt, err := d.runtimeForNameLocked(name)
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "not found") {
			return nil, notFoundError("wisp_not_found", fmt.Sprintf("wisp %s not found", name))
		}
		return nil, err
	}
	return rt, nil
}

func wispResourceFromStatus(name string, status RuntimeStatus) WispResource {
	state := "cold"
	if status.Running {
		state = "running"
	}
	return WispResource{
		Name:  name,
		State: state,
		Capabilities: map[string]bool{
			"exec":        true,
			"checkpoints": true,
			"filesystem":  true,
		},
	}
}

func invokeFilesystemAgent(ctx context.Context, rt *Runtime, verb string, payload any, out any) error {
	if !rt.runtimeStatus(ctx).Running {
		return conflictError("wisp_not_running", fmt.Sprintf("wisp %s is not running", rt.cfg.WispName))
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	if len(body) > wispFSBodyLimit {
		return badRequest("filesystem payload exceeds max size", nil)
	}
	fsCtx, cancel := context.WithTimeout(ctx, wispFSAgentTimeout)
	defer cancel()

	result, err := rt.ExecCommand(fsCtx, []string{wispFSAgentPath, verb}, body)
	if err != nil {
		return err
	}
	var envelope wispFSAgentResponse
	if err := json.Unmarshal([]byte(result.Stdout), &envelope); err != nil {
		msg := redactStderr(result.Stderr)
		if msg == "" {
			msg = "filesystem agent returned invalid JSON"
		}
		return &apiError{Status: http.StatusBadGateway, Code: "filesystem_agent_invalid_response", Message: msg}
	}
	if !envelope.OK || result.ExitCode != 0 {
		code := envelope.Code
		if code == "" {
			code = "filesystem_agent_failed"
		}
		msg := envelope.Error
		if msg == "" {
			msg = redactStderr(result.Stderr)
		}
		if msg == "" {
			msg = "filesystem agent failed"
		}
		return &apiError{Status: mapFilesystemAgentStatus(code), Code: code, Message: msg}
	}
	if out == nil || len(envelope.Result) == 0 {
		return nil
	}
	return json.Unmarshal(envelope.Result, out)
}

func downloadWispFetchContent(ctx context.Context, req wispFilesystemFetchRequest) (wispFilesystemFetchContent, error) {
	if err := validateWispFetchURL(req.URL, req.AllowPrivate); err != nil {
		return wispFilesystemFetchContent{}, err
	}
	maxBytes := req.MaxBytes
	if maxBytes <= 0 {
		maxBytes = wispFetchDefaultMaxBytes
	}
	if maxBytes > wispFetchMaxBytes {
		return wispFilesystemFetchContent{}, badRequest("filesystem fetch max_bytes exceeds limit", map[string]any{"limit": wispFetchMaxBytes})
	}
	expectedSHA := strings.ToLower(strings.TrimSpace(req.SHA256))
	if expectedSHA != "" {
		if len(expectedSHA) != sha256.Size*2 {
			return wispFilesystemFetchContent{}, badRequest("filesystem fetch sha256 must be 64 hex characters", nil)
		}
		if _, err := hex.DecodeString(expectedSHA); err != nil {
			return wispFilesystemFetchContent{}, badRequest("filesystem fetch sha256 must be hex", nil)
		}
	}

	client := &http.Client{
		Timeout:       5 * time.Minute,
		Transport:     wispFetchTransport(req.AllowPrivate),
		CheckRedirect: wispFetchRedirectGuard(req.AllowPrivate),
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodGet, req.URL, nil)
	if err != nil {
		return wispFilesystemFetchContent{}, badRequest("filesystem fetch url is invalid", nil)
	}
	resp, err := client.Do(httpReq)
	if err != nil {
		return wispFilesystemFetchContent{}, &apiError{Status: http.StatusBadGateway, Code: "filesystem_fetch_failed", Message: err.Error()}
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return wispFilesystemFetchContent{}, &apiError{Status: http.StatusBadGateway, Code: "filesystem_fetch_http_error", Message: fmt.Sprintf("fetch source returned http %d", resp.StatusCode)}
	}
	if resp.ContentLength > maxBytes {
		return wispFilesystemFetchContent{}, &apiError{Status: http.StatusRequestEntityTooLarge, Code: "filesystem_fetch_too_large", Message: "fetch source exceeds max_bytes"}
	}
	limited := io.LimitReader(resp.Body, maxBytes+1)
	hash := sha256.New()
	var buf bytes.Buffer
	buf.Grow(int(minInt64(maxBytes, 1<<20)))
	n, err := io.Copy(&buf, io.TeeReader(limited, hash))
	if err != nil {
		return wispFilesystemFetchContent{}, &apiError{Status: http.StatusBadGateway, Code: "filesystem_fetch_failed", Message: err.Error()}
	}
	if n > maxBytes {
		return wispFilesystemFetchContent{}, &apiError{Status: http.StatusRequestEntityTooLarge, Code: "filesystem_fetch_too_large", Message: "fetch source exceeds max_bytes"}
	}
	sum := hex.EncodeToString(hash.Sum(nil))
	if expectedSHA != "" && sum != expectedSHA {
		return wispFilesystemFetchContent{}, &apiError{Status: http.StatusBadGateway, Code: "filesystem_fetch_sha256_mismatch", Message: "fetch source sha256 mismatch"}
	}
	return wispFilesystemFetchContent{Bytes: buf.Bytes(), SHA256: sum}, nil
}

func validateWispFetchURL(raw string, allowPrivate bool) error {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u == nil || u.Host == "" {
		return badRequest("filesystem fetch url is invalid", nil)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return badRequest("filesystem fetch only supports http and https urls", nil)
	}
	if u.User != nil {
		return badRequest("filesystem fetch url userinfo is not allowed", nil)
	}
	host := u.Hostname()
	if host == "" {
		return badRequest("filesystem fetch url host is required", nil)
	}
	if ip := net.ParseIP(host); ip != nil {
		if err := validateWispFetchIP(ip, allowPrivate); err != nil {
			return err
		}
	}
	return nil
}

func wispFetchTransport(allowPrivate bool) http.RoundTripper {
	dialer := &net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}
	return &http.Transport{
		DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			host, port, err := net.SplitHostPort(address)
			if err != nil {
				return nil, err
			}
			ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
			if err != nil {
				return nil, err
			}
			if len(ips) == 0 {
				return nil, fmt.Errorf("fetch host resolved no addresses")
			}
			for _, item := range ips {
				if err := validateWispFetchIP(item.IP, allowPrivate); err != nil {
					return nil, err
				}
			}
			return dialer.DialContext(ctx, network, net.JoinHostPort(ips[0].IP.String(), port))
		},
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: 30 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
	}
}

func wispFetchRedirectGuard(allowPrivate bool) func(*http.Request, []*http.Request) error {
	return func(req *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return fmt.Errorf("stopped after %d redirects", len(via))
		}
		return validateWispFetchURL(req.URL.String(), allowPrivate)
	}
}

func validateWispFetchIP(ip net.IP, allowPrivate bool) error {
	if ip == nil {
		return badRequest("filesystem fetch resolved empty address", nil)
	}
	if ip.To4() == nil {
		return badRequest("filesystem fetch ipv6 is not allowed", nil)
	}
	if ip.IsUnspecified() || ip.IsLoopback() || ip.IsMulticast() {
		return badRequest("filesystem fetch resolved address is not allowed", nil)
	}
	if !allowPrivate && (ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast()) {
		return badRequest("filesystem fetch resolved address is not allowed", nil)
	}
	return nil
}

func minInt64(a, b int64) int64 {
	if a < b {
		return a
	}
	return b
}

func decodeJSONBody(r *http.Request, out any, limit int64) error {
	if r.Body == nil {
		return badRequest("request body is required", nil)
	}
	defer r.Body.Close()
	reader := io.LimitReader(r.Body, limit+1)
	body, err := io.ReadAll(reader)
	if err != nil {
		return badRequest("could not read request body", nil)
	}
	if int64(len(body)) > limit {
		return badRequest("request body exceeds max size", nil)
	}
	if len(strings.TrimSpace(string(body))) == 0 {
		return badRequest("request body is required", nil)
	}
	if err := json.Unmarshal(body, out); err != nil {
		return badRequest("invalid JSON request body", nil)
	}
	return nil
}

func normalizeWispPath(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", badRequest("filesystem path is required", nil)
	}
	if !strings.HasPrefix(value, "/") {
		return "", badRequest("filesystem path must be absolute within the wisp root", nil)
	}
	if strings.ContainsRune(value, '\x00') {
		return "", badRequest("filesystem path contains invalid byte", nil)
	}
	for _, part := range strings.Split(value, "/") {
		if part == ".." {
			return "", badRequest("filesystem path traversal is not allowed", nil)
		}
	}
	clean := pathpkg.Clean(value)
	if !strings.HasPrefix(clean, "/") {
		return "", badRequest("filesystem path must stay within the wisp root", nil)
	}
	return clean, nil
}

func mapFilesystemAgentStatus(code string) int {
	switch code {
	case "invalid_path", "invalid_request":
		return http.StatusBadRequest
	case "path_not_found":
		return http.StatusNotFound
	case "already_exists":
		return http.StatusConflict
	case "not_a_directory", "not_a_file":
		return http.StatusUnprocessableEntity
	case "permission_denied":
		return http.StatusForbidden
	default:
		return http.StatusBadGateway
	}
}

func redactStderr(stderr string) string {
	stderr = strings.TrimSpace(stderr)
	if stderr == "" {
		return ""
	}
	if len(stderr) > 256 {
		return stderr[:256]
	}
	return stderr
}

func defaultPath(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

func notFoundError(code, message string) error {
	return &apiError{Status: http.StatusNotFound, Code: code, Message: message}
}

func conflictError(code, message string) error {
	return &apiError{Status: http.StatusConflict, Code: code, Message: message}
}
