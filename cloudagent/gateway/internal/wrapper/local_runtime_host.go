package wrapper

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type LocalRuntimeHostConfig struct {
	Root           string
	CommandPrefix  string
	CommandShell   string
	AllowHostPaths bool
}

type LocalRuntimeHost struct {
	root           string
	commandPrefix  string
	commandShell   string
	allowHostPaths bool
	mu             sync.Mutex
	activeMu       sync.Mutex
	activeCancels  map[string]map[uint64]context.CancelFunc
	nextCommandID  uint64
}

type LocalRuntimeHostInfo struct {
	Root           string
	CommandPrefix  string
	CommandShell   string
	AllowHostPaths bool
}

type localRuntimeHostHandle struct {
	ID             string            `json:"id"`
	TemplateID     string            `json:"template_id,omitempty"`
	CreatedAt      time.Time         `json:"created_at"`
	ExpiresAt      time.Time         `json:"expires_at,omitempty"`
	AllowInternet  bool              `json:"allow_internet,omitempty"`
	Secure         bool              `json:"secure,omitempty"`
	Metadata       map[string]string `json:"metadata,omitempty"`
	TargetRoot     string            `json:"target_root"`
	CommandPrefix  string            `json:"command_prefix,omitempty"`
	AllowHostPaths bool              `json:"allow_host_paths,omitempty"`
}

func NewLocalRuntimeHostFromEnv() (*LocalRuntimeHost, error) {
	return NewLocalRuntimeHost(LocalRuntimeHostConfig{
		Root:           firstEnv("GATEWAY_LOCAL_RUNTIME_ROOT", "LOCAL_RUNTIME_ROOT"),
		CommandPrefix:  firstEnv("GATEWAY_LOCAL_RUNTIME_COMMAND_PREFIX", "LOCAL_RUNTIME_COMMAND_PREFIX"),
		CommandShell:   firstNonEmpty(firstEnv("GATEWAY_LOCAL_RUNTIME_SHELL", "LOCAL_RUNTIME_SHELL"), "/bin/sh"),
		AllowHostPaths: envFlagDefault("GATEWAY_LOCAL_RUNTIME_ALLOW_HOST_PATHS", true),
	})
}

func NewLocalRuntimeHost(cfg LocalRuntimeHostConfig) (*LocalRuntimeHost, error) {
	root := strings.TrimSpace(cfg.Root)
	if root == "" {
		return nil, errors.New("GATEWAY_LOCAL_RUNTIME_ROOT is required for local_wisp runtime host")
	}
	root, err := filepath.Abs(root)
	if err != nil {
		return nil, fmt.Errorf("resolve local runtime root: %w", err)
	}
	host := &LocalRuntimeHost{
		root:           root,
		commandPrefix:  strings.TrimSpace(cfg.CommandPrefix),
		commandShell:   firstNonEmpty(strings.TrimSpace(cfg.CommandShell), "/bin/sh"),
		allowHostPaths: cfg.AllowHostPaths,
	}
	if err := os.MkdirAll(host.handlesDir(), 0o755); err != nil {
		return nil, fmt.Errorf("create local runtime handles dir: %w", err)
	}
	return host, nil
}

var _ RuntimeHost = (*LocalRuntimeHost)(nil)

func (h *LocalRuntimeHost) Info() LocalRuntimeHostInfo {
	if h == nil {
		return LocalRuntimeHostInfo{}
	}
	return LocalRuntimeHostInfo{
		Root:           h.root,
		CommandPrefix:  h.commandPrefix,
		CommandShell:   h.commandShell,
		AllowHostPaths: h.allowHostPaths,
	}
}

func (h *LocalRuntimeHost) CreateSandbox(ctx context.Context, opts CreateSandboxOptions) (RuntimeHostTarget, error) {
	if h == nil {
		return RuntimeHostTarget{}, errors.New("local runtime host is nil")
	}
	if err := ctx.Err(); err != nil {
		return RuntimeHostTarget{}, err
	}
	id, err := randomLocalRuntimeID()
	if err != nil {
		return RuntimeHostTarget{}, err
	}
	if _, err := validateLocalRuntimeID(id); err != nil {
		return RuntimeHostTarget{}, err
	}
	targetRoot := h.targetRoot(id)
	if err := os.MkdirAll(targetRoot, 0o755); err != nil {
		return RuntimeHostTarget{}, fmt.Errorf("create local runtime target root: %w", err)
	}
	timeout := opts.TimeoutSeconds
	if timeout <= 0 {
		timeout = 300
	}
	now := time.Now().UTC()
	handle := localRuntimeHostHandle{
		ID:             id,
		TemplateID:     opts.TemplateID,
		CreatedAt:      now,
		ExpiresAt:      now.Add(time.Duration(timeout) * time.Second),
		AllowInternet:  opts.AllowInternetAccess,
		Secure:         opts.Secure,
		Metadata:       cloneStringMap(opts.Metadata),
		TargetRoot:     targetRoot,
		CommandPrefix:  h.commandPrefix,
		AllowHostPaths: h.allowHostPaths,
	}
	if err := h.writeHandle(handle); err != nil {
		_ = os.RemoveAll(targetRoot)
		return RuntimeHostTarget{}, err
	}
	return RuntimeHostTarget{
		ID:                 id,
		HostType:           runtimeHostTypeLocalWisp,
		Domain:             runtimeHostTypeLocalWisp,
		EnvdAccessToken:    localRuntimeHostToken,
		TrafficAccessToken: localRuntimeHostToken,
		Metadata: map[string]string{
			"template_id":      opts.TemplateID,
			"target_root":      targetRoot,
			"runtime_host":     runtimeHostTypeLocalWisp,
			"command_prefix":   h.commandPrefix,
			"allow_host_paths": strconvBool(h.allowHostPaths),
		},
	}, nil
}

func (h *LocalRuntimeHost) DeleteSandbox(ctx context.Context, id string) error {
	if h == nil || strings.TrimSpace(id) == "" {
		return nil
	}
	id, err := validateLocalRuntimeID(id)
	if err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	handlePath := h.handlePath(id)
	targetRoot := h.targetRoot(id)
	if data, err := os.ReadFile(handlePath); err == nil {
		var handle localRuntimeHostHandle
		if json.Unmarshal(data, &handle) == nil && strings.TrimSpace(handle.TargetRoot) != "" {
			if validated, validateErr := h.validateTargetRoot(id, handle.TargetRoot); validateErr == nil {
				targetRoot = validated
			} else {
				return validateErr
			}
		}
	}
	handle := localRuntimeHostHandle{ID: id, TargetRoot: targetRoot}
	h.cancelActiveCommands(id)
	if err := h.cancelTrackedLocalRuntimeCommands(ctx, RuntimeHostTarget{ID: id}, handle); err != nil {
		return err
	}
	if err := os.RemoveAll(targetRoot); err != nil {
		return fmt.Errorf("delete local runtime target root %s: %w", id, err)
	}
	if err := os.Remove(handlePath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("delete local runtime handle %s: %w", id, err)
	}
	return nil
}

func (h *LocalRuntimeHost) RefreshSandboxTimeout(ctx context.Context, id string, timeoutSeconds int) error {
	if h == nil || strings.TrimSpace(id) == "" {
		return nil
	}
	id, err := validateLocalRuntimeID(id)
	if err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	handle, err := h.readHandleLocked(id)
	if err != nil {
		return err
	}
	if timeoutSeconds <= 0 {
		timeoutSeconds = 300
	}
	handle.ExpiresAt = time.Now().UTC().Add(time.Duration(timeoutSeconds) * time.Second)
	return h.writeHandleLocked(handle)
}

func (h *LocalRuntimeHost) RunCommand(ctx context.Context, target RuntimeHostTarget, command string, env map[string]string, onStdout func(string) error, onStderr func(string) error) (CommandResult, error) {
	if h == nil {
		return CommandResult{}, errors.New("local runtime host is nil")
	}
	if strings.TrimSpace(command) == "" {
		return CommandResult{}, errors.New("command is required")
	}
	handle, err := h.readHandle(target.ID)
	if err != nil {
		return CommandResult{}, err
	}
	runID, err := randomLocalRuntimeID()
	if err != nil {
		return CommandResult{}, err
	}
	pidFile := filepath.Join(localRuntimeCommandPIDDir(handle), runID+".pid")
	groupFile := filepath.Join(localRuntimeCommandPIDDir(handle), runID+".pgid")
	commandEnv := map[string]string{
		"CLOUDAGENT_RUNTIME_HOST":       runtimeHostTypeLocalWisp,
		"CLOUDAGENT_LOCAL_RUNTIME_ID":   target.ID,
		"CLOUDAGENT_LOCAL_RUNTIME_ROOT": h.root,
		"CLOUDAGENT_LOCAL_TARGET_ROOT":  handle.TargetRoot,
	}
	for key, value := range env {
		commandEnv[key] = value
	}
	if h.commandPrefix != "" {
		command = h.expandCommandPrefix(target, handle) + " " + shellQuote(shellEnvPrefix(commandEnv)+localRuntimeTrackedCommand(command, pidFile, groupFile, h.commandShell, true))
	} else {
		command = shellEnvPrefix(commandEnv) + localRuntimeTrackedCommand(command, pidFile, groupFile, h.commandShell, false)
	}
	cmdCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	cmd := exec.CommandContext(cmdCtx, "/bin/sh", "-lc", command)
	cmd.Dir = handle.TargetRoot
	cmd.Env = append(os.Environ(),
		"CLOUDAGENT_RUNTIME_HOST="+commandEnv["CLOUDAGENT_RUNTIME_HOST"],
		"CLOUDAGENT_LOCAL_RUNTIME_ID="+commandEnv["CLOUDAGENT_LOCAL_RUNTIME_ID"],
		"CLOUDAGENT_LOCAL_RUNTIME_ROOT="+commandEnv["CLOUDAGENT_LOCAL_RUNTIME_ROOT"],
		"CLOUDAGENT_LOCAL_TARGET_ROOT="+commandEnv["CLOUDAGENT_LOCAL_TARGET_ROOT"],
	)
	for key, value := range env {
		cmd.Env = append(cmd.Env, key+"="+value)
	}
	configureLocalRuntimeCommand(cmd)
	localCancel := cmd.Cancel
	cmd.Cancel = func() error {
		remoteErr := h.cancelTrackedLocalRuntimeCommand(target, handle, pidFile)
		localErr := localCancel()
		if errors.Is(localErr, os.ErrProcessDone) {
			localErr = nil
		}
		return errors.Join(remoteErr, localErr)
	}
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		return CommandResult{}, err
	}
	stderrPipe, err := cmd.StderrPipe()
	if err != nil {
		return CommandResult{}, err
	}
	h.mu.Lock()
	if _, err := os.Stat(h.handlePath(handle.ID)); err != nil {
		h.mu.Unlock()
		return CommandResult{}, fmt.Errorf("read local runtime handle %s: %w", handle.ID, err)
	}
	if err := os.MkdirAll(localRuntimeCommandPIDDir(handle), 0o755); err != nil {
		h.mu.Unlock()
		return CommandResult{}, fmt.Errorf("create local runtime pid dir: %w", err)
	}
	unregister := h.registerActiveCommand(handle.ID, cancel)
	if err := cmd.Start(); err != nil {
		unregister()
		h.mu.Unlock()
		return CommandResult{}, err
	}
	if h.commandPrefix == "" {
		if err := os.WriteFile(pidFile, []byte(fmt.Sprintf("%d\n", cmd.Process.Pid)), 0o644); err != nil {
			unregister()
			cancel()
			h.mu.Unlock()
			return CommandResult{}, fmt.Errorf("write local runtime pid file: %w", err)
		}
		if err := os.WriteFile(groupFile, []byte(fmt.Sprintf("%d\n", cmd.Process.Pid)), 0o644); err != nil {
			unregister()
			cancel()
			h.mu.Unlock()
			return CommandResult{}, fmt.Errorf("write local runtime process group file: %w", err)
		}
	}
	h.mu.Unlock()
	defer unregister()
	var streamWG sync.WaitGroup
	var streamErr error
	var streamMu sync.Mutex
	recordStreamErr := func(err error) {
		if err == nil {
			return
		}
		cancel()
		streamMu.Lock()
		defer streamMu.Unlock()
		streamErr = errors.Join(streamErr, err)
	}
	streamWG.Add(2)
	go func() {
		defer streamWG.Done()
		recordStreamErr(copyRuntimeHostStream(stdoutPipe, &stdout, onStdout))
	}()
	go func() {
		defer streamWG.Done()
		recordStreamErr(copyRuntimeHostStream(stderrPipe, &stderr, onStderr))
	}()
	err = cmd.Wait()
	streamWG.Wait()
	result := CommandResult{
		Stdout: stdout.String(),
		Stderr: stderr.String(),
		Exited: cmd.ProcessState != nil,
	}
	if cmd.ProcessState != nil {
		result.ExitCode = cmd.ProcessState.ExitCode()
	}
	if err == nil && result.Exited && result.ExitCode == 0 {
		result.Status = "completed"
	} else {
		result.Status = "failed"
	}
	if streamErr != nil {
		return result, streamErr
	}
	if err != nil {
		return result, err
	}
	return result, nil
}

func (h *LocalRuntimeHost) expandCommandPrefix(target RuntimeHostTarget, handle localRuntimeHostHandle) string {
	prefix := h.commandPrefix
	replacements := map[string]string{
		"{target_id}":    target.ID,
		"{target_root}":  handle.TargetRoot,
		"{runtime_root}": h.root,
	}
	for marker, value := range replacements {
		prefix = strings.ReplaceAll(prefix, marker, shellQuote(value))
	}
	return prefix
}

func localRuntimeTrackedCommand(command, pidFile, groupFile, shellPath string, setSid bool) string {
	shellPath = firstNonEmpty(strings.TrimSpace(shellPath), "/bin/sh")
	pidDir := filepath.Dir(pidFile)
	inner := "mkdir -p " + shellQuote(pidDir) + "\n" +
		"echo $$ > " + shellQuote(pidFile) + "\n" +
		"echo $$ > " + shellQuote(groupFile) + "\n" +
		"trap 'pids=$(jobs -pr); [ -z \"$pids\" ] || kill $pids 2>/dev/null || true' HUP INT TERM\n" +
		command + "\n" +
		"status=$?\n" +
		"rm -f " + shellQuote(pidFile) + "\n" +
		"exit $status\n"
	if !setSid {
		return inner
	}
	return "if command -v setsid >/dev/null 2>&1 && setsid --help 2>&1 | grep -q -- '--wait'; then exec setsid --wait " + shellQuote(shellPath) + " -lc " + shellQuote(inner) + "; fi\n" +
		"exec " + shellQuote(shellPath) + " -lc " + shellQuote(inner)
}

func (h *LocalRuntimeHost) cancelTrackedLocalRuntimeCommands(ctx context.Context, target RuntimeHostTarget, handle localRuntimeHostHandle) error {
	entries, err := os.ReadDir(localRuntimeCommandPIDDir(handle))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return fmt.Errorf("read local runtime pid dir: %w", err)
	}
	var cancelErr error
	for _, entry := range entries {
		if entry.IsDir() || (!strings.HasSuffix(entry.Name(), ".pid") && !strings.HasSuffix(entry.Name(), ".pgid")) {
			continue
		}
		cancelErr = errors.Join(cancelErr, h.cancelTrackedLocalRuntimeCommandWithContext(ctx, target, handle, filepath.Join(localRuntimeCommandPIDDir(handle), entry.Name())))
	}
	return cancelErr
}

func (h *LocalRuntimeHost) cancelTrackedLocalRuntimeCommand(target RuntimeHostTarget, handle localRuntimeHostHandle, pidFile string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	return h.cancelTrackedLocalRuntimeCommandWithContext(ctx, target, handle, pidFile)
}

func (h *LocalRuntimeHost) cancelTrackedLocalRuntimeCommandWithContext(ctx context.Context, target RuntimeHostTarget, handle localRuntimeHostHandle, pidFile string) error {
	cleanup := "pid=$(cat " + shellQuote(pidFile) + " 2>/dev/null || true)\n" +
		"[ -z \"$pid\" ] && exit 0\n" +
		"kill -TERM -\"$pid\" 2>/dev/null || true\n" +
		"kill -TERM \"$pid\" 2>/dev/null || true\n" +
		"sleep 0.2\n" +
		"kill -KILL -\"$pid\" 2>/dev/null || true\n" +
		"kill -KILL \"$pid\" 2>/dev/null || true\n" +
		"rm -f " + shellQuote(pidFile) + "\n"
	script := cleanup
	if h.commandPrefix != "" {
		script = h.expandCommandPrefix(target, handle) + " " + shellQuote(cleanup)
	}
	cmd := exec.CommandContext(ctx, "/bin/sh", "-lc", script)
	cmd.Dir = handle.TargetRoot
	if output, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("cancel tracked local runtime command: %w output=%q", err, string(output))
	}
	return nil
}

func localRuntimeCommandPIDDir(handle localRuntimeHostHandle) string {
	return filepath.Join(handle.TargetRoot, ".cloudagent-local-runs")
}

func copyRuntimeHostStream(r io.Reader, dst *bytes.Buffer, cb func(string) error) error {
	buf := make([]byte, 32*1024)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			chunk := string(buf[:n])
			dst.WriteString(chunk)
			if cb != nil {
				if cbErr := cb(chunk); cbErr != nil {
					return cbErr
				}
			}
		}
		if errors.Is(err, io.EOF) {
			return nil
		}
		if errors.Is(err, os.ErrClosed) {
			return nil
		}
		if err != nil {
			return err
		}
	}
}

func (h *LocalRuntimeHost) UploadFile(ctx context.Context, target RuntimeHostTarget, remotePath, filename string, content []byte) error {
	if h == nil {
		return errors.New("local runtime host is nil")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	handle, err := h.readHandle(target.ID)
	if err != nil {
		return err
	}
	dest, err := h.resolveTargetPath(handle, remotePath)
	if err != nil {
		return err
	}
	if strings.HasSuffix(remotePath, "/") {
		name := filepath.Base(filename)
		if name == "." || name == ".." || name == string(filepath.Separator) || name == "" {
			return fmt.Errorf("invalid upload filename %q", filename)
		}
		dest = filepath.Join(dest, name)
	}
	if !h.allowHostPaths {
		if err := validateLocalRuntimeTargetFilesystemPath(handle.TargetRoot, dest); err != nil {
			return err
		}
	}
	dir := filepath.Dir(dest)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("create local upload dir: %w", err)
	}
	if !h.allowHostPaths {
		if err := validateLocalRuntimeTargetFilesystemPath(handle.TargetRoot, dest); err != nil {
			return err
		}
	}
	return writeLocalRuntimeFileAtomic(dest, content, 0o644)
}

func (h *LocalRuntimeHost) DownloadFile(ctx context.Context, target RuntimeHostTarget, remotePath string) ([]byte, error) {
	if h == nil {
		return nil, errors.New("local runtime host is nil")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	handle, err := h.readHandle(target.ID)
	if err != nil {
		return nil, err
	}
	path, err := h.resolveTargetPath(handle, remotePath)
	if err != nil {
		return nil, err
	}
	if !h.allowHostPaths {
		if err := validateLocalRuntimeTargetFilesystemPath(handle.TargetRoot, path); err != nil {
			return nil, err
		}
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read local runtime file %s: %w", remotePath, err)
	}
	return data, nil
}

func (h *LocalRuntimeHost) RuntimeHostEnv() RuntimeHostEnv {
	if h == nil {
		return RuntimeHostEnv{}
	}
	return RuntimeHostEnv{Domain: "local_wisp"}
}

func (h *LocalRuntimeHost) KillTargetProcessGroup(ctx context.Context, target RuntimeHostTarget, req RuntimeHostProcessGroupKillRequest) error {
	return runtimeHostRunProcessGroupKill(ctx, h, target, req)
}

func (h *LocalRuntimeHost) handlesDir() string {
	return filepath.Join(h.root, "handles")
}

func (h *LocalRuntimeHost) handlePath(id string) string {
	return filepath.Join(h.handlesDir(), filepath.Base(id)+".json")
}

func (h *LocalRuntimeHost) targetRoot(id string) string {
	return filepath.Join(h.root, "targets", filepath.Base(id))
}

func (h *LocalRuntimeHost) writeHandle(handle localRuntimeHostHandle) error {
	id, err := validateLocalRuntimeID(handle.ID)
	if err != nil {
		return err
	}
	handle.ID = id
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.writeHandleLocked(handle)
}

func (h *LocalRuntimeHost) writeHandleLocked(handle localRuntimeHostHandle) error {
	if err := os.MkdirAll(h.handlesDir(), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(handle, "", "  ")
	if err != nil {
		return fmt.Errorf("encode local runtime handle: %w", err)
	}
	temp, err := os.CreateTemp(h.handlesDir(), handle.ID+".*.tmp")
	if err != nil {
		return fmt.Errorf("create local runtime handle temp file: %w", err)
	}
	tempPath := temp.Name()
	defer func() { _ = os.Remove(tempPath) }()
	if _, err := temp.Write(append(data, '\n')); err != nil {
		_ = temp.Close()
		return fmt.Errorf("write local runtime handle temp file: %w", err)
	}
	if err := temp.Close(); err != nil {
		return fmt.Errorf("close local runtime handle temp file: %w", err)
	}
	if err := os.Rename(tempPath, h.handlePath(handle.ID)); err != nil {
		return fmt.Errorf("replace local runtime handle: %w", err)
	}
	return nil
}

func (h *LocalRuntimeHost) registerActiveCommand(id string, cancel context.CancelFunc) func() {
	h.activeMu.Lock()
	defer h.activeMu.Unlock()
	if h.activeCancels == nil {
		h.activeCancels = make(map[string]map[uint64]context.CancelFunc)
	}
	h.nextCommandID++
	commandID := h.nextCommandID
	if h.activeCancels[id] == nil {
		h.activeCancels[id] = make(map[uint64]context.CancelFunc)
	}
	h.activeCancels[id][commandID] = cancel
	return func() {
		h.activeMu.Lock()
		defer h.activeMu.Unlock()
		if h.activeCancels[id] == nil {
			return
		}
		delete(h.activeCancels[id], commandID)
		if len(h.activeCancels[id]) == 0 {
			delete(h.activeCancels, id)
		}
	}
}

func (h *LocalRuntimeHost) cancelActiveCommands(id string) {
	h.activeMu.Lock()
	var cancels []context.CancelFunc
	for _, cancel := range h.activeCancels[id] {
		cancels = append(cancels, cancel)
	}
	delete(h.activeCancels, id)
	h.activeMu.Unlock()
	for _, cancel := range cancels {
		cancel()
	}
}

func (h *LocalRuntimeHost) readHandle(id string) (localRuntimeHostHandle, error) {
	id, err := validateLocalRuntimeID(id)
	if err != nil {
		return localRuntimeHostHandle{}, err
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.readHandleLocked(id)
}

func (h *LocalRuntimeHost) readHandleLocked(id string) (localRuntimeHostHandle, error) {
	data, err := os.ReadFile(h.handlePath(id))
	if err != nil {
		return localRuntimeHostHandle{}, fmt.Errorf("read local runtime handle %s: %w", id, err)
	}
	var handle localRuntimeHostHandle
	if err := json.Unmarshal(data, &handle); err != nil {
		return localRuntimeHostHandle{}, fmt.Errorf("decode local runtime handle %s: %w", id, err)
	}
	if strings.TrimSpace(handle.ID) != "" && handle.ID != id {
		return localRuntimeHostHandle{}, fmt.Errorf("local runtime handle id mismatch: %s", handle.ID)
	}
	handle.ID = id
	if handle.TargetRoot == "" {
		handle.TargetRoot = h.targetRoot(id)
	}
	targetRoot, err := h.validateTargetRoot(id, handle.TargetRoot)
	if err != nil {
		return localRuntimeHostHandle{}, err
	}
	handle.TargetRoot = targetRoot
	return handle, nil
}

func (h *LocalRuntimeHost) resolveTargetPath(handle localRuntimeHostHandle, value string) (string, error) {
	if strings.TrimSpace(value) == "" {
		return "", errors.New("path is required")
	}
	cleaned := filepath.Clean(value)
	if h.allowHostPaths {
		if filepath.IsAbs(cleaned) {
			return cleaned, nil
		}
		return filepath.Join(handle.TargetRoot, cleaned), nil
	}
	if filepath.IsAbs(cleaned) {
		cleaned = strings.TrimPrefix(cleaned, string(filepath.Separator))
	}
	resolved := filepath.Join(handle.TargetRoot, cleaned)
	rel, err := filepath.Rel(handle.TargetRoot, resolved)
	if err != nil {
		return "", err
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("path escapes local runtime target root: %s", value)
	}
	return resolved, nil
}

func (h *LocalRuntimeHost) validateTargetRoot(id, targetRoot string) (string, error) {
	if h == nil {
		return "", errors.New("local runtime host is nil")
	}
	id, err := validateLocalRuntimeID(id)
	if err != nil {
		return "", err
	}
	targetRoot = strings.TrimSpace(targetRoot)
	if targetRoot == "" {
		targetRoot = h.targetRoot(id)
	}
	absTargetRoot, err := filepath.Abs(targetRoot)
	if err != nil {
		return "", fmt.Errorf("resolve local runtime target root %s: %w", id, err)
	}
	wantRoot, err := filepath.Abs(h.targetRoot(id))
	if err != nil {
		return "", fmt.Errorf("resolve expected local runtime target root %s: %w", id, err)
	}
	if absTargetRoot != wantRoot {
		realTargetRoot, targetErr := filepath.EvalSymlinks(absTargetRoot)
		realWantRoot, wantErr := filepath.EvalSymlinks(wantRoot)
		if targetErr != nil || wantErr != nil {
			return "", fmt.Errorf("local runtime target root does not match target id: %s", targetRoot)
		}
		realTargetRoot, targetErr = filepath.Abs(realTargetRoot)
		realWantRoot, wantErr = filepath.Abs(realWantRoot)
		if targetErr != nil || wantErr != nil || realTargetRoot != realWantRoot {
			return "", fmt.Errorf("local runtime target root does not match target id: %s", targetRoot)
		}
		return wantRoot, nil
	}
	return absTargetRoot, nil
}

func validateLocalRuntimeID(id string) (string, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return "", errors.New("local runtime id is required")
	}
	if filepath.Base(id) != id || strings.ContainsAny(id, `/\`) {
		return "", fmt.Errorf("invalid local runtime id: %s", id)
	}
	if !strings.HasPrefix(id, "local-") {
		return "", fmt.Errorf("invalid local runtime id: %s", id)
	}
	for _, r := range id {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_' {
			continue
		}
		return "", fmt.Errorf("invalid local runtime id: %s", id)
	}
	return id, nil
}

func validateLocalRuntimeTargetFilesystemPath(targetRoot, candidate string) error {
	absTargetRoot, err := filepath.Abs(targetRoot)
	if err != nil {
		return fmt.Errorf("resolve local runtime target root: %w", err)
	}
	realTargetRoot, err := filepath.EvalSymlinks(absTargetRoot)
	if err != nil {
		return fmt.Errorf("resolve local runtime target root symlinks: %w", err)
	}
	realTargetRoot, err = filepath.Abs(realTargetRoot)
	if err != nil {
		return fmt.Errorf("resolve local runtime real target root: %w", err)
	}
	absCandidate, err := filepath.Abs(candidate)
	if err != nil {
		return fmt.Errorf("resolve local runtime path: %w", err)
	}
	if !pathIsUnder(absTargetRoot, absCandidate) {
		return fmt.Errorf("path escapes local runtime target root: %s", candidate)
	}
	existing := absCandidate
	for {
		if _, err := os.Lstat(existing); err == nil {
			break
		} else if errors.Is(err, os.ErrNotExist) {
			parent := filepath.Dir(existing)
			if parent == existing {
				return err
			}
			existing = parent
			continue
		} else {
			return err
		}
	}
	resolved, err := filepath.EvalSymlinks(existing)
	if err != nil {
		return fmt.Errorf("resolve local runtime path symlinks: %w", err)
	}
	resolved, err = filepath.Abs(resolved)
	if err != nil {
		return fmt.Errorf("resolve local runtime real path: %w", err)
	}
	if !pathIsUnder(realTargetRoot, resolved) {
		return fmt.Errorf("path escapes local runtime target root through symlink: %s", candidate)
	}
	return nil
}

func writeLocalRuntimeFileAtomic(path string, content []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	temp, err := os.CreateTemp(dir, filepath.Base(path)+".*.tmp")
	if err != nil {
		return fmt.Errorf("create local runtime temp file: %w", err)
	}
	tempPath := temp.Name()
	defer func() { _ = os.Remove(tempPath) }()
	if _, err := temp.Write(content); err != nil {
		_ = temp.Close()
		return fmt.Errorf("write local runtime temp file: %w", err)
	}
	if err := temp.Chmod(perm); err != nil {
		_ = temp.Close()
		return fmt.Errorf("chmod local runtime temp file: %w", err)
	}
	if err := temp.Close(); err != nil {
		return fmt.Errorf("close local runtime temp file: %w", err)
	}
	if err := os.Rename(tempPath, path); err != nil {
		return fmt.Errorf("replace local runtime file: %w", err)
	}
	return nil
}

func pathIsUnder(root, candidate string) bool {
	if candidate == root {
		return true
	}
	rel, err := filepath.Rel(root, candidate)
	if err != nil {
		return false
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}

func randomLocalRuntimeID() (string, error) {
	var b [8]byte
	if _, err := io.ReadFull(rand.Reader, b[:]); err != nil {
		return "", fmt.Errorf("generate local runtime id: %w", err)
	}
	return "local-" + hex.EncodeToString(b[:]), nil
}

func cloneStringMap(in map[string]string) map[string]string {
	if len(in) == 0 {
		return nil
	}
	out := make(map[string]string, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}

func strconvBool(value bool) string {
	if value {
		return "true"
	}
	return "false"
}
