package runtime

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gorilla/websocket"

	"wisp/internal/config"
)

type RuntimeStatus struct {
	Name              string `json:"name"`
	RemoteBackend     string `json:"remote_backend"`
	StateRoot         string `json:"state_root"`
	ContainerID       string `json:"container_id"`
	Running           bool   `json:"running"`
	PID               string `json:"pid,omitempty"`
	RootFSMount       string `json:"rootfs_mount"`
	LoopDevice        string `json:"loop_device,omitempty"`
	CrunRoot          string `json:"crun_root"`
	AdminSocket       string `json:"admin_socket"`
	AdminListenAddr   string `json:"admin_listen_addr"`
	EnvSocket         string `json:"env_socket"`
	CgroupParent      string `json:"cgroup_parent"`
	CgroupChild       string `json:"cgroup_child"`
	JFSRoot           string `json:"jfs_root"`
	JFSRootMountpoint string `json:"jfs_root_mountpoint,omitempty"`
	JFSRootFSType     string `json:"jfs_root_fs_type,omitempty"`
	COSEnabled        bool   `json:"cos_enabled"`
	ObjectStoreBacked bool   `json:"object_store_backed"`
	SingleInstance    bool   `json:"single_instance"`
	DaemonPID         int    `json:"daemon_pid"`
	DaemonLockFile    string `json:"daemon_lock_file"`
}

type RuntimeInfo struct {
	Name        string            `json:"name"`
	Version     string            `json:"version"`
	RootFSMount string            `json:"rootfs_mount"`
	ContainerID string            `json:"container_id"`
	PID1        string            `json:"pid1"`
	Env         map[string]string `json:"env"`
}

type runtimeRequest struct {
	Name string `json:"name"`
}

type backendBindRequest struct {
	Name            string `json:"name"`
	RemoteBackend   string `json:"remote_backend"`
	SMHLibraryID    string `json:"smh_library_id"`
	SMHAccessDomain string `json:"smh_access_domain"`
	SMHSpaceID      string `json:"smh_space_id"`
	SMHAccessToken  string `json:"smh_access_token"`
	JFSPrefix       string `json:"jfs_prefix"`
}

type ContainerRecord struct {
	Name          string `json:"name"`
	OverlayConfig string `json:"overlay_config"`
	StateRoot     string `json:"state_root"`
	RuntimeRoot   string `json:"runtime_root"`
	Running       bool   `json:"running"`
}

type apiError struct {
	Status  int
	Code    string
	Message string
	Details map[string]any
}

func (e *apiError) Error() string {
	if e == nil {
		return ""
	}
	return e.Message
}

type Daemon struct {
	rt *Runtime

	mu           sync.Mutex
	wispMu       sync.Mutex
	wispLocks    map[string]*sync.Mutex
	backendMu    sync.RWMutex
	backendToken map[string]string
	adminLn      net.Listener
	adminTCPLn   net.Listener
	envLn        net.Listener
	adminServer  *http.Server
	adminTCP     *http.Server
	envServer    *http.Server
	lockFile     *os.File
}

func NewDaemon(rt *Runtime) *Daemon {
	return &Daemon{
		rt:           rt,
		wispLocks:    make(map[string]*sync.Mutex),
		backendToken: make(map[string]string),
	}
}

func (d *Daemon) logf(format string, args ...any) {
	fmt.Printf("[wisp/daemon] "+format+"\n", args...)
}

func (d *Daemon) logRequestStart(action, name string) time.Time {
	started := time.Now()
	if strings.TrimSpace(name) == "" {
		d.logf("request start action=%s", action)
	} else {
		d.logf("request start action=%s name=%s", action, name)
	}
	return started
}

func (d *Daemon) logRequestDone(action, name string, started time.Time, err error) {
	dur := time.Since(started)
	if err != nil {
		if strings.TrimSpace(name) == "" {
			d.logf("request fail action=%s duration=%s err=%v", action, dur, err)
		} else {
			d.logf("request fail action=%s name=%s duration=%s err=%v", action, name, dur, err)
		}
		return
	}
	if strings.TrimSpace(name) == "" {
		d.logf("request ok action=%s duration=%s", action, dur)
	} else {
		d.logf("request ok action=%s name=%s duration=%s", action, name, dur)
	}
}

func (d *Daemon) lockWisp(name string) func() {
	name = strings.TrimSpace(name)
	if name == "" {
		return func() {}
	}
	d.wispMu.Lock()
	mu := d.wispLocks[name]
	if mu == nil {
		mu = &sync.Mutex{}
		d.wispLocks[name] = mu
	}
	d.wispMu.Unlock()

	mu.Lock()
	return mu.Unlock
}

func (d *Daemon) currentConfigPaths() (configFile string, lockFile string) {
	return d.rt.cfg.ConfigFile, d.rt.cfg.DaemonLockFile
}

func (d *Daemon) Serve(ctx context.Context) error {
	if err := requireRoot(); err != nil {
		return err
	}
	if err := d.acquireSingleInstanceLock(); err != nil {
		return err
	}

	adminLn, err := listenUnix(d.rt.cfg.AdminSocketPath, 0o600)
	if err != nil {
		_ = d.releaseSingleInstanceLock()
		return err
	}
	d.adminLn = adminLn
	d.adminServer = &http.Server{Handler: d.adminMux()}
	if strings.TrimSpace(d.rt.cfg.AdminListenAddr) != "" {
		tcpLn, err := net.Listen("tcp", d.rt.cfg.AdminListenAddr)
		if err != nil {
			_ = adminLn.Close()
			_ = d.releaseSingleInstanceLock()
			return err
		}
		d.adminTCPLn = tcpLn
		d.adminTCP = &http.Server{Handler: d.adminMux()}
	}

	go func() {
		<-ctx.Done()
		d.shutdown(context.Background())
	}()

	go func() {
		_ = d.adminServer.Serve(adminLn)
	}()
	if d.adminTCP != nil && d.adminTCPLn != nil {
		go func() {
			_ = d.adminTCP.Serve(d.adminTCPLn)
		}()
	}

	d.mu.Lock()
	_ = d.ensureEnvListenerLocked()
	d.mu.Unlock()

	<-ctx.Done()
	return nil
}

func (d *Daemon) shutdown(ctx context.Context) {
	d.mu.Lock()
	defer d.mu.Unlock()

	if d.envServer != nil {
		_ = d.envServer.Shutdown(ctx)
	}
	if d.envLn != nil {
		_ = d.envLn.Close()
	}
	if d.adminServer != nil {
		_ = d.adminServer.Shutdown(ctx)
	}
	if d.adminLn != nil {
		_ = d.adminLn.Close()
	}
	if d.adminTCP != nil {
		_ = d.adminTCP.Shutdown(ctx)
	}
	if d.adminTCPLn != nil {
		_ = d.adminTCPLn.Close()
	}
	_ = d.releaseSingleInstanceLock()
	_ = os.Remove(d.rt.cfg.EnvSocketHostPath)
	_ = os.Remove(d.rt.cfg.AdminSocketPath)
}

func (d *Daemon) adminMux() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/runtime/containers", d.handleAdminListContainers)
	mux.HandleFunc("POST /v1/runtime/create", d.handleAdminCreate)
	mux.HandleFunc("GET /v1/runtime/status", d.handleAdminStatus)
	mux.HandleFunc("POST /v1/runtime/backend", d.handleRuntimeBackendBind)
	mux.HandleFunc("POST /v1/runtime/bootstrap", d.handleAdminBootstrap)
	mux.HandleFunc("POST /v1/runtime/start", d.handleAdminStart)
	mux.HandleFunc("POST /v1/runtime/stop", d.handleAdminStop)
	mux.HandleFunc("POST /v1/runtime/destroy", d.handleAdminDestroy)
	mux.HandleFunc("GET /v1/runtime/exec", d.handleAdminExecWS)
	mux.HandleFunc("GET /v1/wisps", d.handleWispsList)
	mux.HandleFunc("POST /v1/wisps", d.handleWispCreate)
	mux.HandleFunc("GET /v1/wisps/{wisp}", d.handleWispGet)
	mux.HandleFunc("POST /v1/wisps/{wisp}/backend", d.handleWispBackendBind)
	mux.HandleFunc("POST /v1/wisps/{wisp}/start", d.handleWispStart)
	mux.HandleFunc("POST /v1/wisps/{wisp}/stop", d.handleWispStop)
	mux.HandleFunc("DELETE /v1/wisps/{wisp}", d.handleWispDestroy)
	mux.HandleFunc("POST /v1/wisps/{wisp}/exec", d.handleWispExec)
	mux.HandleFunc("GET /v1/wisps/{wisp}/exec/ws", d.handleWispExecWS)
	mux.HandleFunc("GET /v1/wisps/{wisp}/checkpoints", d.handleWispCheckpointList)
	mux.HandleFunc("POST /v1/wisps/{wisp}/checkpoints", d.handleWispCheckpointCreate)
	mux.HandleFunc("GET /v1/wisps/{wisp}/checkpoints/{checkpoint}", d.handleWispCheckpointGet)
	mux.HandleFunc("DELETE /v1/wisps/{wisp}/checkpoints/{checkpoint}", d.handleWispCheckpointDelete)
	mux.HandleFunc("POST /v1/wisps/{wisp}/checkpoints/{checkpoint}/restore", d.handleWispCheckpointRestore)
	mux.HandleFunc("GET /v1/wisps/{wisp}/filesystem", d.handleWispFilesystemList)
	mux.HandleFunc("GET /v1/wisps/{wisp}/filesystem/content", d.handleWispFilesystemRead)
	mux.HandleFunc("PUT /v1/wisps/{wisp}/filesystem/content", d.handleWispFilesystemWrite)
	mux.HandleFunc("POST /v1/wisps/{wisp}/filesystem/fetch", d.handleWispFilesystemFetch)
	mux.HandleFunc("POST /v1/wisps/{wisp}/filesystem/mkdir", d.handleWispFilesystemMkdir)
	mux.HandleFunc("POST /v1/wisps/{wisp}/filesystem/rename", d.handleWispFilesystemRename)
	mux.HandleFunc("DELETE /v1/wisps/{wisp}/filesystem", d.handleWispFilesystemDelete)
	mux.HandleFunc("GET /v1/wisps/{wisp}/filesystem/stat", d.handleWispFilesystemStat)
	return mux
}

func (d *Daemon) envMux() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /info", d.handleEnvInfo)
	mux.HandleFunc("GET /checkpoints", d.handleEnvCheckpointList)
	mux.HandleFunc("POST /checkpoints", d.handleEnvCheckpointCreate)
	mux.HandleFunc("GET /checkpoints/{checkpoint}", d.handleEnvCheckpointGet)
	mux.HandleFunc("POST /checkpoints/{checkpoint}/restore", d.handleEnvCheckpointRestore)
	mux.HandleFunc("DELETE /checkpoints/{checkpoint}", d.handleEnvCheckpointDelete)
	return mux
}

func (d *Daemon) ensureEnvListenerLocked() error {
	if d.envLn != nil {
		if info, err := os.Stat(d.rt.cfg.EnvSocketHostPath); err == nil && info.Mode()&os.ModeSocket != 0 {
			return nil
		}
		if err := d.closeEnvListenerLocked(); err != nil {
			return err
		}
	}

	ln, err := listenUnix(d.rt.cfg.EnvSocketHostPath, 0o666)
	if err != nil {
		return err
	}
	d.envLn = ln
	d.envServer = &http.Server{Handler: d.envMux()}
	go func() {
		_ = d.envServer.Serve(ln)
	}()
	return nil
}

func (d *Daemon) closeEnvListenerLocked() error {
	if d.envServer != nil {
		_ = d.envServer.Close()
		d.envServer = nil
	}
	if d.envLn != nil {
		_ = d.envLn.Close()
		d.envLn = nil
	}
	_ = os.Remove(d.rt.cfg.EnvSocketHostPath)
	return nil
}

func (d *Daemon) handleAdminStatus(w http.ResponseWriter, r *http.Request) {
	d.mu.Lock()
	defer d.mu.Unlock()
	rt, err := d.runtimeForRequestLocked(r)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, rt.runtimeStatus(r.Context()))
}

func (d *Daemon) handleAdminCreate(w http.ResponseWriter, r *http.Request) {
	var (
		name    string
		reqErr  error
		started = d.logRequestStart("admin.create", "")
	)
	defer func() { d.logRequestDone("admin.create", name, started, reqErr) }()
	d.mu.Lock()
	defer d.mu.Unlock()

	req, err := decodeRuntimeRequest(r)
	if err != nil {
		reqErr = err
		writeError(w, err)
		return
	}
	name = strings.TrimSpace(req.Name)
	if name == "" {
		reqErr = badRequest("container name is required", map[string]any{"operation": "create"})
		writeError(w, reqErr)
		return
	}
	baseCfg, err := config.Load(d.rt.cfg.ConfigFile)
	if err != nil {
		reqErr = err
		writeError(w, err)
		return
	}
	layoutCfg, err := workspaceLayoutConfigForCreate(d.rt.cfg.ConfigFile, baseCfg, name)
	if err != nil {
		reqErr = err
		writeError(w, err)
		return
	}
	if err := config.SetWorkspaceLayout(d.rt.cfg.ConfigFile, layoutCfg, name); err != nil {
		reqErr = err
		writeError(w, err)
		return
	}
	if baseCfg, err = config.LoadContainer(d.rt.cfg.ConfigFile, name); err != nil {
		reqErr = err
		writeError(w, err)
		return
	}
	if baseCfg, err = ensureWorkspaceBackendProvisioned(r.Context(), d.rt.cfg.ConfigFile, baseCfg, name); err != nil {
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
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":             true,
		"message":        "container created",
		"name":           rt.cfg.WispName,
		"overlay_config": rt.cfg.OverlayConfigFile,
		"state_root":     rt.cfg.StateRoot,
		"runtime_root":   rt.cfg.RuntimeRoot,
		"temp_root":      rt.cfg.TempRoot,
	})
}

func workspaceLayoutConfigForCreate(configFile string, baseCfg config.Config, name string) (config.Config, error) {
	overlayPath := config.ContainerOverlayPath(configFile, name)
	if _, err := os.Stat(overlayPath); err != nil {
		if os.IsNotExist(err) {
			return baseCfg, nil
		}
		return config.Config{}, fmt.Errorf("stat container overlay %s: %w", overlayPath, err)
	}
	return config.LoadContainer(configFile, name)
}

func (d *Daemon) handleRuntimeBackendBind(w http.ResponseWriter, r *http.Request) {
	var (
		name    string
		reqErr  error
		started = d.logRequestStart("runtime.backend_bind", "")
	)
	defer func() { d.logRequestDone("runtime.backend_bind", name, started, reqErr) }()
	req, err := decodeBackendBindRequest(r, "")
	if err != nil {
		reqErr = err
		writeError(w, err)
		return
	}
	name = strings.TrimSpace(req.Name)
	if name == "" {
		reqErr = badRequest("container name is required", map[string]any{"operation": "bind_backend"})
		writeError(w, reqErr)
		return
	}
	if err := d.bindWorkspaceBackend(r.Context(), req); err != nil {
		reqErr = err
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "message": "backend bound", "name": name, "remote_backend": normalizeRemoteBackend(req.RemoteBackend)})
}

func (d *Daemon) handleAdminBootstrap(w http.ResponseWriter, r *http.Request) {
	var (
		name    string
		reqErr  error
		started = d.logRequestStart("admin.bootstrap", "")
	)
	defer func() { d.logRequestDone("admin.bootstrap", name, started, reqErr) }()
	d.mu.Lock()
	defer d.mu.Unlock()
	req, err := decodeRuntimeRequest(r)
	if err != nil {
		reqErr = err
		writeError(w, err)
		return
	}
	name = strings.TrimSpace(req.Name)
	if name == "" {
		if err := d.rt.BootstrapGlobal(r.Context()); err != nil {
			reqErr = err
			writeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "message": "global bootstrap complete"})
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
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "message": "workspace bootstrap complete"})
}

func (d *Daemon) handleAdminStart(w http.ResponseWriter, r *http.Request) {
	d.mu.Lock()
	defer d.mu.Unlock()
	rt, err := d.runtimeForRequestLocked(r)
	if err != nil {
		writeError(w, err)
		return
	}
	d.rt = rt
	_ = d.closeEnvListenerLocked()
	if err := d.ensureEnvListenerLocked(); err != nil {
		writeError(w, err)
		return
	}
	if err := rt.Start(r.Context()); err != nil {
		_ = d.closeEnvListenerLocked()
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "message": "runtime started"})
}

func (d *Daemon) handleAdminStop(w http.ResponseWriter, r *http.Request) {
	d.mu.Lock()
	defer d.mu.Unlock()
	rt, err := d.runtimeForRequestLocked(r)
	if err != nil {
		writeError(w, err)
		return
	}
	if err := rt.Stop(r.Context()); err != nil {
		writeError(w, err)
		return
	}
	d.rt = rt
	_ = d.closeEnvListenerLocked()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "message": "runtime stopped"})
}

func (d *Daemon) handleAdminDestroy(w http.ResponseWriter, r *http.Request) {
	d.mu.Lock()
	defer d.mu.Unlock()
	req, err := decodeRuntimeRequest(r)
	if err != nil {
		writeError(w, err)
		return
	}
	if strings.TrimSpace(req.Name) == "" {
		writeError(w, badRequest("container name is required", map[string]any{"operation": "destroy"}))
		return
	}
	rt, err := d.runtimeForNameLocked(req.Name)
	if err != nil {
		writeError(w, err)
		return
	}
	if err := rt.Destroy(r.Context()); err != nil {
		writeError(w, err)
		return
	}
	d.rt = rt
	_ = d.closeEnvListenerLocked()
	if err := config.RemoveContainerOverlay(d.rt.cfg.ConfigFile, req.Name); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "message": "runtime destroyed"})
}

func (d *Daemon) handleAdminExecWS(w http.ResponseWriter, r *http.Request) {
	d.mu.Lock()
	rt, err := d.runtimeForRequestLocked(r)
	d.mu.Unlock()
	if err != nil {
		writeError(w, err)
		return
	}

	upgrader := websocket.Upgrader{
		CheckOrigin: func(r *http.Request) bool { return true },
	}
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

func (d *Daemon) handleAdminListContainers(w http.ResponseWriter, r *http.Request) {
	d.mu.Lock()
	defer d.mu.Unlock()
	names, err := config.ListContainerNames(d.rt.cfg.ConfigFile)
	if err != nil {
		writeError(w, err)
		return
	}
	var items []ContainerRecord
	for _, name := range names {
		rt, err := d.runtimeForNameLocked(name)
		if err != nil {
			writeError(w, err)
			return
		}
		status := rt.runtimeStatus(r.Context())
		items = append(items, ContainerRecord{
			Name:          name,
			OverlayConfig: rt.cfg.OverlayConfigFile,
			StateRoot:     rt.cfg.StateRoot,
			RuntimeRoot:   rt.cfg.RuntimeRoot,
			Running:       status.Running,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "containers": items})
}

func (d *Daemon) handleEnvInfo(w http.ResponseWriter, r *http.Request) {
	d.mu.Lock()
	defer d.mu.Unlock()
	info, err := d.rt.runtimeInfo(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, info)
}

func (d *Daemon) handleEnvCheckpointList(w http.ResponseWriter, r *http.Request) {
	d.mu.Lock()
	defer d.mu.Unlock()
	checkpoints, err := d.rt.ListCheckpoints(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "checkpoints": checkpoints})
}

func (d *Daemon) handleEnvCheckpointCreate(w http.ResponseWriter, r *http.Request) {
	d.mu.Lock()
	defer d.mu.Unlock()
	req, err := decodeCheckpointRequest(r)
	if err != nil {
		writeError(w, err)
		return
	}
	if err := d.rt.CreateCheckpoint(r.Context(), req.Checkpoint); err != nil {
		writeError(w, err)
		return
	}
	meta, err := d.rt.GetCheckpoint(r.Context(), req.Checkpoint)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "checkpoint": meta})
}

func (d *Daemon) handleEnvCheckpointGet(w http.ResponseWriter, r *http.Request) {
	d.mu.Lock()
	defer d.mu.Unlock()
	checkpointID := strings.TrimSpace(r.PathValue("checkpoint"))
	meta, err := d.rt.GetCheckpoint(r.Context(), checkpointID)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "checkpoint": meta})
}

func (d *Daemon) handleEnvCheckpointRestore(w http.ResponseWriter, r *http.Request) {
	d.mu.Lock()
	checkpointID := strings.TrimSpace(r.PathValue("checkpoint"))
	if checkpointID == "" {
		d.mu.Unlock()
		writeError(w, badRequest("checkpoint id is required", nil))
		return
	}
	rt := d.rt
	d.mu.Unlock()

	go func() {
		restoreCtx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
		defer cancel()
		if err := rt.RestoreCheckpoint(restoreCtx, checkpointID); err != nil {
			rt.log("Async env restore failed checkpoint=%s: %v", checkpointID, err)
			return
		}
		rt.log("Async env restore complete checkpoint=%s", checkpointID)
	}()

	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "checkpoint": checkpointID, "accepted": true})
}

func (d *Daemon) handleEnvCheckpointDelete(w http.ResponseWriter, r *http.Request) {
	d.mu.Lock()
	defer d.mu.Unlock()
	checkpointID := strings.TrimSpace(r.PathValue("checkpoint"))
	if checkpointID == "" {
		writeError(w, badRequest("checkpoint id is required", nil))
		return
	}
	if err := d.rt.DeleteCheckpoint(r.Context(), checkpointID); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "checkpoint": checkpointID, "deleted": true})
}

func (d *Daemon) reloadRuntimeLocked() error {
	cfg, err := config.Load(d.rt.cfg.ConfigFile)
	if err != nil {
		return err
	}
	cfg.DaemonLockFile = d.rt.cfg.DaemonLockFile
	d.rt = New(cfg)
	return nil
}

func (d *Daemon) runtimeForRequestLocked(r *http.Request) (*Runtime, error) {
	req, err := decodeRuntimeRequest(r)
	if err != nil {
		return nil, err
	}
	return d.runtimeForNameLocked(req.Name)
}

func (d *Daemon) runtimeForNameLocked(name string) (*Runtime, error) {
	var (
		cfg config.Config
		err error
	)
	configFile, lockFile := d.currentConfigPaths()
	if strings.TrimSpace(name) == "" {
		cfg, err = config.Load(configFile)
	} else {
		cfg, err = config.LoadContainer(configFile, name)
	}
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(name) != "" {
		d.backendMu.RLock()
		token := d.backendToken[name]
		d.backendMu.RUnlock()
		if strings.TrimSpace(token) != "" {
			cfg.SMHAccessToken = token
		}
	}
	cfg.DaemonLockFile = lockFile
	return New(cfg), nil
}

func decodeRuntimeRequest(r *http.Request) (runtimeRequest, error) {
	name := strings.TrimSpace(r.URL.Query().Get("name"))
	if r.Method == http.MethodGet || r.Body == nil {
		return runtimeRequest{Name: name}, nil
	}
	defer r.Body.Close()
	body, err := io.ReadAll(r.Body)
	if err != nil {
		return runtimeRequest{}, badRequest("could not read request body", nil)
	}
	if len(bytes.TrimSpace(body)) == 0 {
		return runtimeRequest{Name: name}, nil
	}
	var req runtimeRequest
	if err := json.Unmarshal(body, &req); err != nil {
		return runtimeRequest{}, badRequest("invalid JSON request body", nil)
	}
	if strings.TrimSpace(req.Name) == "" {
		req.Name = name
	}
	return req, nil
}

func decodeBackendBindRequest(r *http.Request, nameFromPath string) (backendBindRequest, error) {
	defer r.Body.Close()
	body, err := io.ReadAll(r.Body)
	if err != nil {
		return backendBindRequest{}, badRequest("could not read request body", nil)
	}
	if len(bytes.TrimSpace(body)) == 0 {
		return backendBindRequest{}, badRequest("backend bind request body is required", nil)
	}
	var req backendBindRequest
	if err := json.Unmarshal(body, &req); err != nil {
		return backendBindRequest{}, badRequest("invalid JSON request body", nil)
	}
	if strings.TrimSpace(req.Name) == "" {
		req.Name = strings.TrimSpace(nameFromPath)
	}
	req.RemoteBackend = normalizeRemoteBackend(req.RemoteBackend)
	if req.RemoteBackend == "" {
		req.RemoteBackend = remoteBackendSMH
	}
	if req.RemoteBackend != remoteBackendSMH {
		return backendBindRequest{}, badRequest("only REMOTE_BACKEND=smh can be bound dynamically", map[string]any{"remote_backend": req.RemoteBackend})
	}
	if strings.TrimSpace(req.SMHLibraryID) == "" {
		return backendBindRequest{}, badRequest("smh_library_id is required", map[string]any{"operation": "bind_backend"})
	}
	if strings.TrimSpace(req.SMHAccessDomain) == "" {
		return backendBindRequest{}, badRequest("smh_access_domain is required", map[string]any{"operation": "bind_backend"})
	}
	if strings.TrimSpace(req.SMHSpaceID) == "" {
		return backendBindRequest{}, badRequest("smh_space_id is required", map[string]any{"operation": "bind_backend"})
	}
	return req, nil
}

func (d *Daemon) bindWorkspaceBackend(ctx context.Context, req backendBindRequest) error {
	name := strings.TrimSpace(req.Name)
	unlock := d.lockWisp(name)
	defer unlock()

	configFile, _ := d.currentConfigPaths()
	baseCfg, err := config.Load(configFile)
	if err != nil {
		return err
	}
	if err := config.SetWorkspaceLayout(configFile, baseCfg, name); err != nil {
		return err
	}
	updates := map[string]string{
		"REMOTE_BACKEND":    remoteBackendSMH,
		"SMH_ENABLED":       "true",
		"SMH_LIBRARY_ID":    strings.TrimSpace(req.SMHLibraryID),
		"SMH_ACCESS_DOMAIN": strings.TrimSpace(req.SMHAccessDomain),
		"SMH_SPACE_ID":      strings.TrimSpace(req.SMHSpaceID),
	}
	if prefix := strings.TrimSpace(req.JFSPrefix); prefix != "" {
		updates["JFS_PREFIX"] = prefix
	}
	for key, value := range updates {
		if err := config.SetContainerEnvValue(configFile, name, key, value); err != nil {
			return err
		}
	}
	if token := strings.TrimSpace(req.SMHAccessToken); token != "" {
		d.backendMu.Lock()
		d.backendToken[name] = token
		d.backendMu.Unlock()
	}
	_, err = ensureWorkspaceBackendProvisioned(ctx, configFile, config.Config{
		RemoteBackend:   remoteBackendSMH,
		SMHLibraryID:    strings.TrimSpace(req.SMHLibraryID),
		SMHAccessDomain: strings.TrimSpace(req.SMHAccessDomain),
		SMHSpaceID:      strings.TrimSpace(req.SMHSpaceID),
		SMHAccessToken:  strings.TrimSpace(req.SMHAccessToken),
	}, name)
	return err
}

type checkpointRequest struct {
	Checkpoint string `json:"checkpoint"`
}

func decodeCheckpointRequest(r *http.Request) (checkpointRequest, error) {
	defer r.Body.Close()
	body, err := io.ReadAll(r.Body)
	if err != nil {
		return checkpointRequest{}, badRequest("could not read request body", nil)
	}
	if len(bytes.TrimSpace(body)) == 0 {
		return checkpointRequest{}, badRequest("checkpoint id is required", nil)
	}
	var req checkpointRequest
	if err := json.Unmarshal(body, &req); err != nil {
		return checkpointRequest{}, badRequest("invalid JSON request body", nil)
	}
	req.Checkpoint = strings.TrimSpace(req.Checkpoint)
	if req.Checkpoint == "" {
		return checkpointRequest{}, badRequest("checkpoint id is required", nil)
	}
	return req, nil
}

func (r *Runtime) runtimeStatus(ctx context.Context) RuntimeStatus {
	status := RuntimeStatus{
		Name:            r.cfg.WispName,
		RemoteBackend:   normalizeRemoteBackend(r.cfg.RemoteBackend),
		StateRoot:       r.cfg.StateRoot,
		ContainerID:     r.cfg.ContainerID,
		RootFSMount:     r.cfg.RootFSMount,
		CrunRoot:        r.cfg.CrunStateRoot,
		AdminSocket:     r.cfg.AdminSocketPath,
		AdminListenAddr: r.cfg.AdminListenAddr,
		EnvSocket:       r.cfg.EnvSocketPath,
		CgroupParent:    r.cfg.CgroupUserParent,
		CgroupChild:     r.cfg.CgroupUserContainer,
		JFSRoot:         r.cfg.JFSRoot,
		COSEnabled:      r.cfg.COSEnabled,
		SingleInstance:  true,
		DaemonPID:       os.Getpid(),
		DaemonLockFile:  r.cfg.DaemonLockFile,
	}
	if mountpoint, fsType, ok := r.mountInfoForPath(r.cfg.JFSRoot); ok {
		status.JFSRootMountpoint = mountpoint
		status.JFSRootFSType = fsType
		status.ObjectStoreBacked = isJuiceFSFSType(fsType)
	}
	status.LoopDevice = strings.TrimSpace(string(readFileBestEffort(r.cfg.LoopDeviceFile)))
	if exists, _ := r.containerExists(ctx); exists {
		status.Running = true
		if pid, err := r.containerPID(ctx); err == nil {
			status.PID = pid
		}
	}
	return status
}

func (r *Runtime) runtimeInfo(ctx context.Context) (RuntimeInfo, error) {
	info := RuntimeInfo{
		Name:        r.cfg.WispName,
		Version:     "dev",
		RootFSMount: r.cfg.RootFSMount,
		ContainerID: r.cfg.ContainerID,
		Env: map[string]string{
			"HOME":            "/home/" + r.cfg.WispUser,
			"LANG":            r.cfg.WispLang,
			"BROWSER":         r.cfg.WispBrowser,
			"DEBIAN_FRONTEND": r.cfg.WispDebianFrontend,
			"PATH":            r.cfg.WispPath,
		},
	}
	if data, err := os.ReadFile(filepath.Join(r.cfg.RootFSMount, ".wisp", "version.txt")); err == nil {
		info.Version = strings.TrimSpace(string(data))
	}
	exists, err := r.containerExists(ctx)
	if err != nil {
		return RuntimeInfo{}, err
	}
	if !exists {
		return RuntimeInfo{}, errors.New("runtime is not started")
	}
	pid1, err := r.output(ctx, r.cfg.CrunBinaryPath, "--root", r.cfg.CrunStateRoot, "exec", r.cfg.ContainerID, "/usr/bin/sh", "-lc", "cat /proc/1/comm")
	if err != nil {
		return RuntimeInfo{}, err
	}
	info.PID1 = strings.TrimSpace(pid1)
	return info, nil
}

func CallUnixJSON(ctx context.Context, socketPath, method, urlPath string, body any, out any) error {
	if !strings.HasPrefix(urlPath, "/") {
		urlPath = "/" + urlPath
	}
	var reader io.Reader
	if body != nil {
		buf, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(buf)
	}
	req, err := http.NewRequestWithContext(ctx, method, "http://wisp"+urlPath, reader)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	client := &http.Client{
		Timeout: 10 * time.Minute,
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
				var d net.Dialer
				return d.DialContext(ctx, "unix", socketPath)
			},
		},
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		data, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("http %d: %s", resp.StatusCode, strings.TrimSpace(string(data)))
	}
	if out == nil {
		_, _ = io.Copy(io.Discard, resp.Body)
		return nil
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

func listenUnix(path string, mode os.FileMode) (net.Listener, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	_ = os.Remove(path)
	ln, err := net.Listen("unix", path)
	if err != nil {
		return nil, err
	}
	if err := os.Chmod(path, mode); err != nil {
		_ = ln.Close()
		return nil, err
	}
	return ln, nil
}

func (d *Daemon) acquireSingleInstanceLock() error {
	path := d.rt.cfg.DaemonLockFile
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		pid := readPIDFile(f)
		_ = f.Close()
		if pid > 0 {
			return fmt.Errorf("wisp daemon already running (pid %d)", pid)
		}
		return errors.New("wisp daemon already running")
	}
	if err := f.Truncate(0); err != nil {
		_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
		_ = f.Close()
		return err
	}
	if _, err := f.Seek(0, 0); err != nil {
		_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
		_ = f.Close()
		return err
	}
	if _, err := fmt.Fprintf(f, "%d\n", os.Getpid()); err != nil {
		_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
		_ = f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
		_ = f.Close()
		return err
	}
	d.lockFile = f
	return nil
}

func (d *Daemon) releaseSingleInstanceLock() error {
	if d.lockFile == nil {
		return nil
	}
	path := d.rt.cfg.DaemonLockFile
	f := d.lockFile
	d.lockFile = nil
	_ = f.Truncate(0)
	_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
	_ = f.Close()
	_ = os.Remove(path)
	return nil
}

func readPIDFile(f *os.File) int {
	data, err := io.ReadAll(f)
	if err != nil {
		return 0
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil {
		return 0
	}
	return pid
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, err error) {
	apiErr := classifyError(err)
	resp := map[string]any{
		"ok":    false,
		"code":  apiErr.Code,
		"error": apiErr.Message,
	}
	if len(apiErr.Details) > 0 {
		resp["details"] = apiErr.Details
	}
	writeJSON(w, apiErr.Status, resp)
}

func classifyError(err error) *apiError {
	if err == nil {
		return &apiError{Status: http.StatusInternalServerError, Code: "internal_error", Message: "unknown error"}
	}
	var apiErr *apiError
	if errors.As(err, &apiErr) {
		return apiErr
	}

	msg := strings.TrimSpace(err.Error())
	lower := strings.ToLower(msg)

	switch {
	case errors.Is(err, context.Canceled):
		return &apiError{Status: 499, Code: "request_canceled", Message: msg}
	case errors.Is(err, context.DeadlineExceeded):
		return &apiError{Status: http.StatusGatewayTimeout, Code: "deadline_exceeded", Message: msg}
	case strings.Contains(lower, "container ") && strings.Contains(lower, " not found"):
		return &apiError{Status: http.StatusNotFound, Code: "container_not_found", Message: msg}
	case strings.Contains(lower, "requires a container name"),
		strings.Contains(lower, "container name is required"),
		strings.Contains(lower, "workspace name must not be empty"),
		strings.Contains(lower, "invalid json request body"):
		return &apiError{Status: http.StatusBadRequest, Code: "invalid_request", Message: msg}
	case strings.Contains(lower, "runtime is not started"),
		strings.Contains(lower, "run start first"),
		strings.Contains(lower, "container is not started"):
		return &apiError{Status: http.StatusConflict, Code: "runtime_not_running", Message: msg}
	case strings.Contains(lower, "run bootstrap first"),
		strings.Contains(lower, "not bootstrapped"):
		return &apiError{Status: http.StatusPreconditionFailed, Code: "bootstrap_required", Message: msg}
	case strings.Contains(lower, "could not prepare crun"),
		strings.Contains(lower, "configure crun_binary"),
		strings.Contains(lower, "missing juicefs helper script"),
		strings.Contains(lower, "cos_enabled is set but juicefs_repo_root is empty"),
		strings.Contains(lower, "configure base_rootfs_dir"):
		return &apiError{Status: http.StatusFailedDependency, Code: "dependency_missing", Message: msg}
	case strings.Contains(lower, "permission denied"),
		strings.Contains(lower, "operation not permitted"),
		strings.Contains(lower, "requires root"):
		return &apiError{Status: http.StatusForbidden, Code: "permission_denied", Message: msg}
	case strings.Contains(lower, "already running"):
		return &apiError{Status: http.StatusConflict, Code: "already_running", Message: msg}
	case strings.Contains(lower, "invalid argument"),
		strings.Contains(lower, "no such file or directory"):
		return &apiError{Status: http.StatusUnprocessableEntity, Code: "invalid_environment", Message: msg}
	default:
		return &apiError{Status: http.StatusInternalServerError, Code: "runtime_error", Message: msg}
	}
}

func badRequest(message string, details map[string]any) error {
	return &apiError{
		Status:  http.StatusBadRequest,
		Code:    "invalid_request",
		Message: message,
		Details: details,
	}
}
