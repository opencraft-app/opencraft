package policy

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/creack/pty"
	"hypernode/internal/modelgateway"
	goja "hypernode/internal/policy/jsvm"
	"hypernode/internal/telemetry"
	"hypernode/internal/workspaces"
)

const hostProcessBufferLimit = 16 * 1024 * 1024
const hostTerminalBufferLimit = 2 * 1024 * 1024

type hostRuntime struct {
	root                         *os.Root
	rootPath                     string
	codexBin                     string
	javaScriptBin                string
	javaScriptRuntimeRoot        string
	usersRoot                    string
	dshPersistenceRoot           string
	dshHomeRoot                  string
	enforceUserCredentials       bool
	workspaceAgent               bool
	mu                           sync.Mutex
	processes                    map[string]*hostProcess
	terminals                    map[string]*hostTerminal
	workspaceStdioSessions       map[string]*workspaceStdioSession
	network                      *hostNetwork
	workspaceManager             *workspaces.Manager
	workspaceDriver              string
	workspaceAttachments         map[string]workspaces.Attachment
	workspaceAttachmentPool      *workspaceAttachmentPool
	workspaceAttachmentWatches   map[string]*remoteWorkspaceWatch
	workspaceAttachmentWatchRefs map[string]string
	modelGateway                 *modelgateway.Registry
	modelGatewayBaseURL          string
	telemetry                    *telemetry.Manager
	wakes                        *wakeBroadcaster
	tickWakes                    *wakeBroadcaster
	wakeTimer                    *time.Timer
	wakeDeadline                 time.Time
	wakeGeneration               uint64
	monotonicOrigin              time.Time
	closed                       bool
}

type hostTerminal struct {
	cmd      *exec.Cmd
	pty      *os.File
	cwd      string
	mu       sync.Mutex
	output   []byte
	exited   bool
	exitCode int
	err      string
	notify   func()
}

type hostProcess struct {
	cmd      *exec.Cmd
	stdin    io.WriteCloser
	stdinMu  sync.Mutex
	readers  sync.WaitGroup
	mu       sync.Mutex
	stdout   []string
	stderr   []string
	exited   bool
	exitCode int
	err      string
	notify   func()
	done     chan struct{}
}

func installHostRuntime(vm *goja.Runtime, config RuntimeConfig) (*hostRuntime, error) {
	rootPath := config.LocalhostRoot
	if rootPath == "" {
		var err error
		rootPath, err = os.UserHomeDir()
		if err != nil {
			return nil, fmt.Errorf("resolve deployment user home: %w", err)
		}
	}
	absoluteRoot, err := filepath.Abs(rootPath)
	if err != nil {
		return nil, fmt.Errorf("resolve localhost root: %w", err)
	}
	absoluteRoot, err = filepath.EvalSymlinks(absoluteRoot)
	if err != nil {
		return nil, fmt.Errorf("resolve localhost root symlinks: %w", err)
	}
	root, err := os.OpenRoot(absoluteRoot)
	if err != nil {
		return nil, fmt.Errorf("open localhost root: %w", err)
	}
	usersRoot := config.UsersRoot
	if usersRoot == "" {
		usersRoot = ".runtime/users"
	}
	usersRoot, err = filepath.Abs(usersRoot)
	if err != nil {
		_ = root.Close()
		return nil, fmt.Errorf("resolve users root: %w", err)
	}
	if err := os.MkdirAll(usersRoot, 0o711); err != nil {
		_ = root.Close()
		return nil, fmt.Errorf("create users root: %w", err)
	}
	dshPersistenceRoot := filepath.Join(filepath.Dir(usersRoot), "dsh-sessions")
	if err := os.MkdirAll(dshPersistenceRoot, 0o700); err != nil {
		_ = root.Close()
		return nil, fmt.Errorf("create DSH persistence root: %w", err)
	}
	if err := os.Chmod(dshPersistenceRoot, 0o700); err != nil {
		_ = root.Close()
		return nil, fmt.Errorf("secure DSH persistence root: %w", err)
	}
	dshHomeRoot := filepath.Join(filepath.Dir(usersRoot), "dsh-home")
	if err := os.MkdirAll(dshHomeRoot, 0o700); err != nil {
		_ = root.Close()
		return nil, fmt.Errorf("create DSH home root: %w", err)
	}
	if err := os.Chmod(dshHomeRoot, 0o700); err != nil {
		_ = root.Close()
		return nil, fmt.Errorf("secure DSH home root: %w", err)
	}
	wakes := newWakeBroadcaster()
	tickWakes := newWakeBroadcaster()
	bridge := &hostRuntime{
		root:                   root,
		rootPath:               absoluteRoot,
		codexBin:               config.CodexExecutable,
		javaScriptBin:          config.JavaScriptExecutable,
		javaScriptRuntimeRoot:  config.JavaScriptRuntimeRoot,
		usersRoot:              usersRoot,
		dshPersistenceRoot:     dshPersistenceRoot,
		dshHomeRoot:            dshHomeRoot,
		enforceUserCredentials: config.EnforceUserCredentials,
		workspaceAgent:         config.WorkspaceAgent,
		processes:              make(map[string]*hostProcess),
		terminals:              make(map[string]*hostTerminal),
		workspaceStdioSessions: make(map[string]*workspaceStdioSession),
		telemetry:              config.Telemetry,
		network: newHostNetworkWithTelemetry(config.Telemetry, func() {
			wakes.notify()
			tickWakes.notify()
		}),
		workspaceManager:             config.WorkspaceManager,
		workspaceDriver:              config.WorkspaceDriver,
		workspaceAttachments:         make(map[string]workspaces.Attachment),
		workspaceAttachmentPool:      newWorkspaceAttachmentPool(wakes.notify),
		workspaceAttachmentWatches:   make(map[string]*remoteWorkspaceWatch),
		workspaceAttachmentWatchRefs: make(map[string]string),
		modelGateway:                 config.ModelGateway,
		modelGatewayBaseURL:          strings.TrimRight(config.ModelGatewayBaseURL, "/"),
		wakes:                        wakes,
		tickWakes:                    tickWakes,
		monotonicOrigin:              time.Now(),
	}
	if bridge.codexBin == "" {
		bridge.codexBin = "codex"
	}
	if bridge.javaScriptBin == "" {
		bridge.javaScriptBin = "node"
	}
	if err := bridge.installFilesystem(vm); err != nil {
		_ = root.Close()
		return nil, err
	}
	if err := bridge.installProcess(vm); err != nil {
		_ = root.Close()
		return nil, err
	}
	if err := bridge.installTerminal(vm); err != nil {
		_ = bridge.Close()
		return nil, err
	}
	if err := bridge.installIdentity(vm); err != nil {
		_ = root.Close()
		return nil, err
	}
	if err := bridge.installNetwork(vm); err != nil {
		_ = bridge.Close()
		return nil, err
	}
	if err := bridge.installWorkspaces(vm); err != nil {
		_ = bridge.Close()
		return nil, err
	}
	if err := bridge.installModelGateway(vm); err != nil {
		_ = bridge.Close()
		return nil, err
	}
	if err := bridge.installTelemetry(vm); err != nil {
		_ = bridge.Close()
		return nil, err
	}
	events := vm.NewObject()
	if err := events.Set("notify", bridge.wakes.notify); err != nil {
		_ = bridge.Close()
		return nil, err
	}
	if err := events.Set("wakeAfter", bridge.wakeAfter); err != nil {
		_ = bridge.Close()
		return nil, err
	}
	if err := events.Set("monotonicNowMs", bridge.monotonicNowMs); err != nil {
		_ = bridge.Close()
		return nil, err
	}
	if err := vm.Set("hostEvents", events); err != nil {
		_ = bridge.Close()
		return nil, err
	}
	return bridge, nil
}

func (h *hostRuntime) installTelemetry(vm *goja.Runtime) error {
	manager := h.telemetry
	if manager == nil {
		manager = telemetry.Disabled()
	}
	object := vm.NewObject()
	if err := object.Set("enabled", manager.Enabled()); err != nil {
		return err
	}
	if err := object.Set("startSpan", func(name string, attributes map[string]any, parent string) map[string]any {
		handle, traceparent := manager.StartSpan(name, attributes, parent)
		return map[string]any{
			"enabled":     manager.Enabled(),
			"handle":      handle,
			"traceparent": traceparent,
		}
	}); err != nil {
		return err
	}
	if err := object.Set("addEvent", func(handle, name string, attributes map[string]any) {
		manager.AddEvent(handle, name, attributes)
	}); err != nil {
		return err
	}
	if err := object.Set("endSpan", func(handle, status string) {
		manager.EndSpan(handle, status, nil)
	}); err != nil {
		return err
	}
	return vm.Set("hostTelemetry", object)
}

func (h *hostRuntime) monotonicNowMs() int64 {
	return time.Since(h.monotonicOrigin).Milliseconds()
}

// wakeAfter is a generic policy scheduler primitive. Business state remains in
// JavaScript; the host only wakes policy Tick and open streams at the earliest
// requested deadline. Repeated frame requests coalesce onto one Go timer.
func (h *hostRuntime) wakeAfter(delayMs int64) {
	if delayMs < 0 {
		delayMs = 0
	}
	if delayMs > 60_000 {
		delayMs = 60_000
	}
	deadline := time.Now().Add(time.Duration(delayMs) * time.Millisecond)
	h.mu.Lock()
	if h.closed {
		h.mu.Unlock()
		return
	}
	if h.wakeTimer != nil && !deadline.Before(h.wakeDeadline) {
		h.mu.Unlock()
		return
	}
	if h.wakeTimer != nil {
		h.wakeTimer.Stop()
	}
	h.wakeGeneration++
	generation := h.wakeGeneration
	h.wakeDeadline = deadline
	h.wakeTimer = time.AfterFunc(time.Until(deadline), func() {
		h.mu.Lock()
		if h.closed || generation != h.wakeGeneration {
			h.mu.Unlock()
			return
		}
		h.wakeTimer = nil
		h.wakeDeadline = time.Time{}
		h.mu.Unlock()
		h.tickWakes.notify()
		h.wakes.notify()
	})
	h.mu.Unlock()
}

func userHomeSegment(username string) string {
	return workspaces.PrincipalHomeSegment(username)
}

func nssUsername(username string) string {
	clean := strings.Map(func(r rune) rune {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') ||
			(r >= '0' && r <= '9') || strings.ContainsRune("._-", r) {
			return r
		}
		return '-'
	}, username)
	clean = strings.Trim(clean, "-.")
	if clean == "" {
		return "user"
	}
	return clean
}

func (h *hostRuntime) ensureUser(username string, uid, gid uint32, installationID string) (map[string]any, error) {
	if username == "" || installationID == "" {
		return nil, fmt.Errorf("username and installation id are required")
	}
	if uid < 10000 || gid < 10000 {
		return nil, fmt.Errorf("refusing privileged user identity")
	}
	home := filepath.Join(h.usersRoot, userHomeSegment(username))
	codexHome := filepath.Join(home, ".codex")
	nssHome := filepath.Join(home, ".nss")
	if err := os.MkdirAll(codexHome, 0o700); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(nssHome, 0o700); err != nil {
		return nil, err
	}
	for _, path := range []string{home, codexHome, nssHome} {
		if err := os.Chmod(path, 0o700); err != nil {
			return nil, err
		}
		if err := os.Chown(path, int(uid), int(gid)); err != nil {
			return nil, err
		}
	}
	containerHome := "/run/hypernode-users/" + userHomeSegment(username)
	displayName := nssUsername(username)
	nssFiles := map[string]string{
		filepath.Join(nssHome, "passwd"): fmt.Sprintf(
			"root:x:0:0:root:/root:/bin/bash\n%s:x:%d:20000:%s:%s:/bin/bash\n",
			displayName, uid, displayName, containerHome,
		),
		filepath.Join(nssHome, "group"): fmt.Sprintf(
			"root:x:0:\nhypernode:x:20000:%s\n", displayName,
		),
	}
	for path, content := range nssFiles {
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			return nil, err
		}
		if err := os.Chown(path, int(uid), int(gid)); err != nil {
			return nil, err
		}
	}
	installationPath := filepath.Join(codexHome, "installation_id")
	if _, err := os.Stat(installationPath); errors.Is(err, os.ErrNotExist) {
		if err := os.WriteFile(installationPath, []byte(installationID+"\n"), 0o600); err != nil {
			return nil, err
		}
	}
	if err := os.Chown(installationPath, int(uid), int(gid)); err != nil {
		return nil, err
	}
	// The user's home is an asset namespace, not identity metadata owned by
	// ensureUser. Recursively chowning it makes every login and startup hydration
	// proportional to caches and repositories already stored there. It can also
	// rewrite ownership that another workspace service intentionally assigned.
	// Files created through the host filesystem are chowned at creation time;
	// only the identity paths managed above belong in this reconciliation step.
	authPath := filepath.Join(codexHome, "auth.json")
	authInfo, authErr := os.Lstat(authPath)
	if authErr == nil {
		if !authInfo.Mode().IsRegular() {
			return nil, fmt.Errorf("Codex credential is not a regular file")
		}
		// Workspace Codex runs in a user namespace. A credential written by a
		// host-side login or profile switch as uid 0 is unmapped there, so even
		// container root cannot read the mode-0600 file. Reconcile the active
		// credential with the durable SSH identity before every runtime spawn.
		if err := os.Chown(authPath, int(uid), int(gid)); err != nil {
			return nil, err
		}
	} else if !errors.Is(authErr, os.ErrNotExist) {
		return nil, authErr
	}
	return map[string]any{
		"homePath": home, "codexHome": codexHome, "codexBound": authErr == nil,
	}, nil
}

func (h *hostRuntime) validatedUserRollout(path string) (string, error) {
	path = filepath.Clean(path)
	usersRoot := filepath.Clean(h.usersRoot)
	if path == usersRoot || !strings.HasPrefix(path, usersRoot+string(filepath.Separator)) {
		return "", fmt.Errorf("rollout is outside users root")
	}
	relative, err := filepath.Rel(usersRoot, path)
	if err != nil {
		return "", err
	}
	parts := strings.Split(relative, string(filepath.Separator))
	if len(parts) < 4 || parts[1] != ".codex" || parts[2] != "sessions" || filepath.Ext(path) != ".jsonl" {
		return "", fmt.Errorf("rollout is outside a user's Codex sessions")
	}
	info, err := os.Lstat(path)
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() {
		return "", fmt.Errorf("rollout is not a regular file")
	}
	return path, nil
}

func (h *hostRuntime) findUserRollout(userHome, threadID string) (string, error) {
	userHome = filepath.Clean(userHome)
	usersRoot := filepath.Clean(h.usersRoot)
	if userHome == usersRoot || !strings.HasPrefix(userHome, usersRoot+string(filepath.Separator)) {
		return "", fmt.Errorf("user home is outside users root")
	}
	if threadID == "" || strings.ContainsAny(threadID, `/\\\x00`) || strings.Contains(threadID, "..") {
		return "", fmt.Errorf("invalid rollout thread id")
	}
	root := filepath.Join(userHome, ".codex", "sessions")
	suffix := "-" + threadID + ".jsonl"
	var selected string
	var selectedTime time.Time
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			if errors.Is(walkErr, os.ErrNotExist) && path == root {
				return filepath.SkipDir
			}
			return walkErr
		}
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), suffix) {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if selected == "" || info.ModTime().After(selectedTime) {
			selected = path
			selectedTime = info.ModTime()
		}
		return nil
	})
	if err != nil {
		return "", err
	}
	if selected == "" {
		return "", os.ErrNotExist
	}
	return h.validatedUserRollout(selected)
}

func (h *hostRuntime) readUserRollout(path string) ([]byte, error) {
	path, err := h.validatedUserRollout(path)
	if err != nil {
		return nil, err
	}
	return os.ReadFile(path)
}

func (h *hostRuntime) installIdentity(vm *goja.Runtime) error {
	object := vm.NewObject()
	if err := object.Set("usersRoot", func() string { return h.usersRoot }); err != nil {
		return err
	}
	if err := object.Set("ensureUser", func(username string, uid, gid uint32, installationID string) (map[string]any, error) {
		return h.ensureUser(username, uid, gid, installationID)
	}); err != nil {
		return err
	}
	if err := object.Set("findUserRollout", h.findUserRollout); err != nil {
		return err
	}
	if err := object.Set("readUserRollout", h.readUserRollout); err != nil {
		return err
	}
	if err := object.Set("readCodexAuth", func(username string) ([]byte, error) {
		if strings.TrimSpace(username) == "" {
			return nil, fmt.Errorf("username is required")
		}
		path := filepath.Join(h.usersRoot, userHomeSegment(username), ".codex", "auth.json")
		return os.ReadFile(path)
	}); err != nil {
		return err
	}
	if err := object.Set("readCodexInstallationId", func(username string) (string, error) {
		if strings.TrimSpace(username) == "" {
			return "", fmt.Errorf("username is required")
		}
		path := filepath.Join(h.usersRoot, userHomeSegment(username), ".codex", "installation_id")
		contents, err := os.ReadFile(path)
		if err != nil {
			return "", err
		}
		installationID := strings.TrimSpace(string(contents))
		if installationID == "" {
			return "", fmt.Errorf("Codex installation id is empty")
		}
		return installationID, nil
	}); err != nil {
		return err
	}
	if err := object.Set("readActiveCodexShare", func(username string) (string, error) {
		if strings.TrimSpace(username) == "" {
			return "", fmt.Errorf("username is required")
		}
		path := filepath.Join(h.usersRoot, userHomeSegment(username), ".codex", "hypernode", "active-shared")
		contents, err := os.ReadFile(path)
		if errors.Is(err, os.ErrNotExist) {
			return "", nil
		}
		if err != nil {
			return "", err
		}
		return strings.TrimSpace(string(contents)), nil
	}); err != nil {
		return err
	}
	if err := object.Set("saveCodexAuthProfile", func(username, profileID string) (string, error) {
		return h.saveCodexAuthProfile(username, profileID)
	}); err != nil {
		return err
	}
	if err := object.Set("ensureCodexAuthProfileInstallation", func(username, profileID, installationID string) error {
		return h.ensureCodexAuthProfileInstallation(username, profileID, installationID)
	}); err != nil {
		return err
	}
	if err := object.Set("activateCodexAuthProfile", func(username, profileID string) (string, error) {
		return h.activateCodexAuthProfile(username, profileID)
	}); err != nil {
		return err
	}
	if err := object.Set("activateSharedCodexAuthProfile", func(ownerUsername, profileID, consumerUsername, shareID string) (string, error) {
		return h.activateSharedCodexAuthProfile(ownerUsername, profileID, consumerUsername, shareID)
	}); err != nil {
		return err
	}
	if err := object.Set("syncSharedCodexAuthProfile", func(consumerUsername, ownerUsername, profileID string) error {
		return h.syncSharedCodexAuthProfile(consumerUsername, ownerUsername, profileID)
	}); err != nil {
		return err
	}
	if err := object.Set("clearActiveCodexAuth", func(username string) error {
		return h.clearActiveCodexAuth(username)
	}); err != nil {
		return err
	}
	if err := object.Set("beginCodexAuthLogin", func(username, stagingID, installationID string) (string, error) {
		return h.beginCodexAuthLogin(username, stagingID, installationID)
	}); err != nil {
		return err
	}
	if err := object.Set("commitCodexAuthLogin", func(username, stagingID string) error {
		return h.commitCodexAuthLogin(username, stagingID)
	}); err != nil {
		return err
	}
	if err := object.Set("rollbackCodexAuthLogin", func(username, stagingID string) (string, error) {
		return h.rollbackCodexAuthLogin(username, stagingID)
	}); err != nil {
		return err
	}
	if err := object.Set("removeCodexAuthProfile", func(username, profileID string) error {
		path, err := h.codexAuthProfilePath(username, profileID)
		if err != nil {
			return err
		}
		return os.RemoveAll(filepath.Dir(path))
	}); err != nil {
		return err
	}
	return vm.Set("hostIdentity", object)
}

func validCredentialProfileID(profileID string) bool {
	if profileID == "" || len(profileID) > 96 {
		return false
	}
	for _, character := range profileID {
		if (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') ||
			(character >= '0' && character <= '9') || character == '.' || character == '_' || character == '-' {
			continue
		}
		return false
	}
	return profileID != "." && profileID != ".."
}

func (h *hostRuntime) codexAuthProfilePath(username, profileID string) (string, error) {
	if strings.TrimSpace(username) == "" {
		return "", fmt.Errorf("username is required")
	}
	if !validCredentialProfileID(profileID) {
		return "", fmt.Errorf("invalid Codex credential profile id")
	}
	return filepath.Join(
		h.usersRoot, userHomeSegment(username), ".codex", "hypernode", "accounts", profileID, "auth.json",
	), nil
}

func codexInstallationPathForAuthPath(authPath string) string {
	return filepath.Join(filepath.Dir(authPath), "installation_id")
}

func codexHomeOwner(codexHome string) (fs.FileInfo, error) {
	owner, err := os.Stat(codexHome)
	if err != nil {
		return nil, err
	}
	return owner, nil
}

func ensureOwnedDirectory(path string, owner fs.FileInfo) error {
	if err := os.MkdirAll(path, 0o700); err != nil {
		return err
	}
	if stat, ok := owner.Sys().(*syscall.Stat_t); ok {
		if err := os.Chown(path, int(stat.Uid), int(stat.Gid)); err != nil {
			return err
		}
	}
	return os.Chmod(path, 0o700)
}

func (h *hostRuntime) saveCodexAuthProfile(username, profileID string) (string, error) {
	destination, err := h.codexAuthProfilePath(username, profileID)
	if err != nil {
		return "", err
	}
	codexHome := filepath.Join(h.usersRoot, userHomeSegment(username), ".codex")
	authContents, err := os.ReadFile(filepath.Join(codexHome, "auth.json"))
	if err != nil {
		return "", fmt.Errorf("read active Codex credential: %w", err)
	}
	installationContents, err := os.ReadFile(filepath.Join(codexHome, "installation_id"))
	if err != nil {
		return "", fmt.Errorf("read active Codex installation id: %w", err)
	}
	owner, err := codexHomeOwner(codexHome)
	if err != nil {
		return "", err
	}
	if err := ensureOwnedDirectory(filepath.Dir(destination), owner); err != nil {
		return "", err
	}
	if stat, ok := owner.Sys().(*syscall.Stat_t); ok {
		for directory := filepath.Dir(destination); strings.HasPrefix(directory, filepath.Join(h.usersRoot, userHomeSegment(username))); directory = filepath.Dir(directory) {
			if err := os.Chown(directory, int(stat.Uid), int(stat.Gid)); err != nil {
				return "", err
			}
			if filepath.Base(directory) == ".codex" {
				break
			}
		}
	}
	if err := writeCredentialAtomically(destination, authContents, owner); err != nil {
		return "", err
	}
	if err := writeCredentialAtomically(
		codexInstallationPathForAuthPath(destination), installationContents, owner,
	); err != nil {
		return "", err
	}
	return destination, nil
}

func (h *hostRuntime) ensureCodexAuthProfileInstallation(username, profileID, installationID string) error {
	authPath, err := h.codexAuthProfilePath(username, profileID)
	if err != nil {
		return err
	}
	if strings.TrimSpace(installationID) == "" {
		return fmt.Errorf("installation id is required")
	}
	if _, err := os.Stat(authPath); err != nil {
		return fmt.Errorf("read Codex credential profile: %w", err)
	}
	destination := codexInstallationPathForAuthPath(authPath)
	if _, err := os.Stat(destination); err == nil {
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	codexHome := filepath.Join(h.usersRoot, userHomeSegment(username), ".codex")
	owner, err := codexHomeOwner(codexHome)
	if err != nil {
		return err
	}
	return writeCredentialAtomically(destination, []byte(installationID), owner)
}

func (h *hostRuntime) activateCodexAuthProfile(username, profileID string) (string, error) {
	source, err := h.codexAuthProfilePath(username, profileID)
	if err != nil {
		return "", err
	}
	authContents, err := os.ReadFile(source)
	if err != nil {
		return "", fmt.Errorf("read Codex credential profile: %w", err)
	}
	installationContents, err := os.ReadFile(codexInstallationPathForAuthPath(source))
	if err != nil {
		return "", fmt.Errorf("read Codex profile installation id: %w", err)
	}
	codexHome := filepath.Join(h.usersRoot, userHomeSegment(username), ".codex")
	owner, err := codexHomeOwner(codexHome)
	if err != nil {
		return "", err
	}
	if err := writeCredentialAtomically(filepath.Join(codexHome, "installation_id"), installationContents, owner); err != nil {
		return "", err
	}
	if err := writeCredentialAtomically(filepath.Join(codexHome, "auth.json"), authContents, owner); err != nil {
		return "", err
	}
	if err := removeIfExists(filepath.Join(codexHome, "hypernode", "active-shared")); err != nil {
		return "", err
	}
	return strings.TrimSpace(string(installationContents)), nil
}

func (h *hostRuntime) activateSharedCodexAuthProfile(
	ownerUsername, profileID, consumerUsername, shareID string,
) (string, error) {
	if !validCredentialProfileID(shareID) {
		return "", fmt.Errorf("invalid shared Codex profile id")
	}
	source, err := h.codexAuthProfilePath(ownerUsername, profileID)
	if err != nil {
		return "", err
	}
	authContents, err := os.ReadFile(source)
	if err != nil {
		return "", fmt.Errorf("read shared Codex credential profile: %w", err)
	}
	installationContents, err := os.ReadFile(codexInstallationPathForAuthPath(source))
	if err != nil {
		return "", fmt.Errorf("read shared Codex installation id: %w", err)
	}
	codexHome := filepath.Join(h.usersRoot, userHomeSegment(consumerUsername), ".codex")
	owner, err := codexHomeOwner(codexHome)
	if err != nil {
		return "", err
	}
	markerDir := filepath.Join(codexHome, "hypernode")
	if err := ensureOwnedDirectory(markerDir, owner); err != nil {
		return "", err
	}
	if err := writeCredentialAtomically(filepath.Join(codexHome, "installation_id"), installationContents, owner); err != nil {
		return "", err
	}
	if err := writeCredentialAtomically(filepath.Join(codexHome, "auth.json"), authContents, owner); err != nil {
		return "", err
	}
	if err := writeCredentialAtomically(filepath.Join(markerDir, "active-shared"), []byte(shareID), owner); err != nil {
		return "", err
	}
	return strings.TrimSpace(string(installationContents)), nil
}

func codexAuthAccountID(contents []byte) string {
	var auth struct {
		AuthMode string `json:"auth_mode"`
		Tokens   struct {
			AccountID string `json:"account_id"`
		} `json:"tokens"`
	}
	if json.Unmarshal(contents, &auth) != nil || auth.AuthMode != "chatgpt" {
		return ""
	}
	return strings.TrimSpace(auth.Tokens.AccountID)
}

func (h *hostRuntime) syncSharedCodexAuthProfile(consumerUsername, ownerUsername, profileID string) error {
	destination, err := h.codexAuthProfilePath(ownerUsername, profileID)
	if err != nil {
		return err
	}
	canonicalAuth, err := os.ReadFile(destination)
	if err != nil {
		return fmt.Errorf("read canonical shared Codex credential: %w", err)
	}
	consumerHome := filepath.Join(h.usersRoot, userHomeSegment(consumerUsername), ".codex")
	activeAuth, err := os.ReadFile(filepath.Join(consumerHome, "auth.json"))
	if err != nil {
		return fmt.Errorf("read active shared Codex credential: %w", err)
	}
	canonicalAccountID := codexAuthAccountID(canonicalAuth)
	if canonicalAccountID == "" || codexAuthAccountID(activeAuth) != canonicalAccountID {
		return fmt.Errorf("active shared credential account identity changed")
	}
	activeInstallation, err := os.ReadFile(filepath.Join(consumerHome, "installation_id"))
	if err != nil {
		return fmt.Errorf("read active shared Codex installation id: %w", err)
	}
	ownerHome := filepath.Join(h.usersRoot, userHomeSegment(ownerUsername), ".codex")
	owner, err := codexHomeOwner(ownerHome)
	if err != nil {
		return err
	}
	if err := writeCredentialAtomically(destination, activeAuth, owner); err != nil {
		return err
	}
	return writeCredentialAtomically(
		codexInstallationPathForAuthPath(destination), activeInstallation, owner,
	)
}

func removeIfExists(path string) error {
	err := os.Remove(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func (h *hostRuntime) clearActiveCodexAuth(username string) error {
	if strings.TrimSpace(username) == "" {
		return fmt.Errorf("username is required")
	}
	codexHome := filepath.Join(h.usersRoot, userHomeSegment(username), ".codex")
	if err := removeIfExists(filepath.Join(codexHome, "auth.json")); err != nil {
		return err
	}
	return removeIfExists(filepath.Join(codexHome, "hypernode", "active-shared"))
}

func (h *hostRuntime) codexLoginStagingDir(username, stagingID string) (string, error) {
	if strings.TrimSpace(username) == "" {
		return "", fmt.Errorf("username is required")
	}
	if !validCredentialProfileID(stagingID) {
		return "", fmt.Errorf("invalid Codex login staging id")
	}
	return filepath.Join(
		h.usersRoot, userHomeSegment(username), ".codex", "hypernode", "login-staging", stagingID,
	), nil
}

func (h *hostRuntime) beginCodexAuthLogin(username, stagingID, installationID string) (string, error) {
	if strings.TrimSpace(installationID) == "" {
		return "", fmt.Errorf("installation id is required")
	}
	stagingDir, err := h.codexLoginStagingDir(username, stagingID)
	if err != nil {
		return "", err
	}
	codexHome := filepath.Join(h.usersRoot, userHomeSegment(username), ".codex")
	owner, err := codexHomeOwner(codexHome)
	if err != nil {
		return "", err
	}
	previousInstallation, err := os.ReadFile(filepath.Join(codexHome, "installation_id"))
	if err != nil {
		return "", fmt.Errorf("read active Codex installation id: %w", err)
	}
	if err := ensureOwnedDirectory(stagingDir, owner); err != nil {
		return "", err
	}
	if entries, readErr := os.ReadDir(stagingDir); readErr != nil {
		return "", readErr
	} else if len(entries) != 0 {
		return "", fmt.Errorf("Codex login staging slot already exists")
	}
	if err := writeCredentialAtomically(filepath.Join(stagingDir, "installation_id"), previousInstallation, owner); err != nil {
		return "", err
	}
	activeAuth := filepath.Join(codexHome, "auth.json")
	if authContents, readErr := os.ReadFile(activeAuth); readErr == nil {
		if err := writeCredentialAtomically(filepath.Join(stagingDir, "auth.json"), authContents, owner); err != nil {
			return "", err
		}
	} else if !errors.Is(readErr, os.ErrNotExist) {
		return "", readErr
	}
	activeShared := filepath.Join(codexHome, "hypernode", "active-shared")
	if sharedContents, readErr := os.ReadFile(activeShared); readErr == nil {
		if err := writeCredentialAtomically(filepath.Join(stagingDir, "active-shared"), sharedContents, owner); err != nil {
			return "", err
		}
	} else if !errors.Is(readErr, os.ErrNotExist) {
		return "", readErr
	}
	if err := writeCredentialAtomically(filepath.Join(codexHome, "installation_id"), []byte(installationID), owner); err != nil {
		return "", err
	}
	if err := os.Remove(activeAuth); err != nil && !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	if err := removeIfExists(activeShared); err != nil {
		return "", err
	}
	return strings.TrimSpace(string(previousInstallation)), nil
}

func (h *hostRuntime) commitCodexAuthLogin(username, stagingID string) error {
	stagingDir, err := h.codexLoginStagingDir(username, stagingID)
	if err != nil {
		return err
	}
	return os.RemoveAll(stagingDir)
}

func (h *hostRuntime) rollbackCodexAuthLogin(username, stagingID string) (string, error) {
	stagingDir, err := h.codexLoginStagingDir(username, stagingID)
	if err != nil {
		return "", err
	}
	codexHome := filepath.Join(h.usersRoot, userHomeSegment(username), ".codex")
	owner, err := codexHomeOwner(codexHome)
	if err != nil {
		return "", err
	}
	installationContents, err := os.ReadFile(filepath.Join(stagingDir, "installation_id"))
	if err != nil {
		return "", fmt.Errorf("read staged Codex installation id: %w", err)
	}
	if err := writeCredentialAtomically(filepath.Join(codexHome, "installation_id"), installationContents, owner); err != nil {
		return "", err
	}
	stagedAuth := filepath.Join(stagingDir, "auth.json")
	activeAuth := filepath.Join(codexHome, "auth.json")
	if authContents, readErr := os.ReadFile(stagedAuth); readErr == nil {
		if err := writeCredentialAtomically(activeAuth, authContents, owner); err != nil {
			return "", err
		}
	} else if errors.Is(readErr, os.ErrNotExist) {
		if err := os.Remove(activeAuth); err != nil && !errors.Is(err, os.ErrNotExist) {
			return "", err
		}
	} else {
		return "", readErr
	}
	stagedShared := filepath.Join(stagingDir, "active-shared")
	activeShared := filepath.Join(codexHome, "hypernode", "active-shared")
	if sharedContents, readErr := os.ReadFile(stagedShared); readErr == nil {
		if err := writeCredentialAtomically(activeShared, sharedContents, owner); err != nil {
			return "", err
		}
	} else if errors.Is(readErr, os.ErrNotExist) {
		if err := removeIfExists(activeShared); err != nil {
			return "", err
		}
	} else {
		return "", readErr
	}
	if err := os.RemoveAll(stagingDir); err != nil {
		return "", err
	}
	return strings.TrimSpace(string(installationContents)), nil
}

func writeCredentialAtomically(path string, contents []byte, ownerInfo fs.FileInfo) error {
	temporary, err := os.CreateTemp(filepath.Dir(path), ".auth-*.json")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return err
	}
	if stat, ok := ownerInfo.Sys().(*syscall.Stat_t); ok {
		if err := temporary.Chown(int(stat.Uid), int(stat.Gid)); err != nil {
			temporary.Close()
			return err
		}
	}
	if _, err := temporary.Write(contents); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(temporaryPath, path)
}

func (h *hostRuntime) openUserRoot(username string) (*os.Root, error) {
	if strings.TrimSpace(username) == "" {
		return nil, fmt.Errorf("username is required")
	}
	home := filepath.Join(h.usersRoot, userHomeSegment(username))
	return os.OpenRoot(home)
}

func metadataAt(root *os.Root, name string) (map[string]any, error) {
	clean, err := hostName(name)
	if err != nil {
		return nil, err
	}
	info, err := root.Lstat(clean)
	if err != nil {
		return nil, err
	}
	return fileMetadata(info), nil
}

func readDirectoryAt(root *os.Root, name string) ([]map[string]any, error) {
	clean, err := hostName(name)
	if err != nil {
		return nil, err
	}
	file, err := root.Open(clean)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	entries, err := file.ReadDir(-1)
	if err != nil {
		return nil, err
	}
	result := make([]map[string]any, 0, len(entries))
	for _, entry := range entries {
		result = append(result, map[string]any{
			"fileName": entry.Name(), "isDirectory": entry.IsDir(), "isFile": entry.Type().IsRegular(),
		})
	}
	sort.Slice(result, func(left, right int) bool {
		return result[left]["fileName"].(string) < result[right]["fileName"].(string)
	})
	return result, nil
}

func readFileAt(root *os.Root, name string) ([]byte, error) {
	clean, err := hostName(name)
	if err != nil {
		return nil, err
	}
	file, err := root.Open(clean)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, 32*1024*1024+1))
	if err != nil {
		return nil, err
	}
	if len(data) > 32*1024*1024 {
		return nil, fmt.Errorf("host file read exceeds limit")
	}
	return data, nil
}

func writeFileAt(root *os.Root, name string, values []int) error {
	clean, err := hostName(name)
	if err != nil {
		return err
	}
	if len(values) > 32*1024*1024 {
		return fmt.Errorf("host file write exceeds limit")
	}
	data := make([]byte, len(values))
	for index, value := range values {
		if value < 0 || value > 255 {
			return fmt.Errorf("host file data contains a non-byte value")
		}
		data[index] = byte(value)
	}
	file, err := root.OpenFile(clean, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	defer file.Close()
	_, err = file.Write(data)
	return err
}

func validateVirtualUser(uid, gid uint32) error {
	if uid < 10000 || gid < 10000 {
		return fmt.Errorf("refusing privileged user identity")
	}
	return nil
}

func userOwnedPath(home, name string, uid, gid uint32) error {
	if err := validateVirtualUser(uid, gid); err != nil {
		return err
	}
	clean, err := hostName(name)
	if err != nil {
		return err
	}
	return os.Lchown(filepath.Join(home, filepath.FromSlash(clean)), int(uid), int(gid))
}

func mkdirAllAtOwned(root *os.Root, home, name string, uid, gid uint32) error {
	if err := validateVirtualUser(uid, gid); err != nil {
		return err
	}
	if name == "." {
		return nil
	}
	current := ""
	for _, part := range strings.Split(filepath.ToSlash(name), "/") {
		if current == "" {
			current = part
		} else {
			current += "/" + part
		}
		err := root.Mkdir(current, 0o700)
		if err != nil && !errors.Is(err, fs.ErrExist) {
			return err
		}
		if err == nil {
			if err := userOwnedPath(home, current, uid, gid); err != nil {
				return err
			}
		}
	}
	return nil
}

func (h *hostRuntime) installFilesystem(vm *goja.Runtime) error {
	object := vm.NewObject()
	if err := object.Set("root", func() string { return h.rootPath }); err != nil {
		return err
	}
	if err := object.Set("metadata", func(name string) (map[string]any, error) {
		clean, err := hostName(name)
		if err != nil {
			return nil, err
		}
		info, err := h.root.Stat(clean)
		if err != nil {
			return nil, err
		}
		return fileMetadata(info), nil
	}); err != nil {
		return err
	}
	if err := object.Set("readDirectory", func(name string) ([]map[string]any, error) {
		clean, err := hostName(name)
		if err != nil {
			return nil, err
		}
		file, err := h.root.Open(clean)
		if err != nil {
			return nil, err
		}
		defer file.Close()
		entries, err := file.ReadDir(-1)
		if err != nil {
			return nil, err
		}
		result := make([]map[string]any, 0, len(entries))
		for _, entry := range entries {
			result = append(result, map[string]any{
				"fileName":    entry.Name(),
				"isDirectory": entry.IsDir(),
				"isFile":      entry.Type().IsRegular(),
			})
		}
		sort.Slice(result, func(left, right int) bool {
			return result[left]["fileName"].(string) < result[right]["fileName"].(string)
		})
		return result, nil
	}); err != nil {
		return err
	}
	if err := object.Set("readFile", func(name string) ([]byte, error) {
		clean, err := hostName(name)
		if err != nil {
			return nil, err
		}
		file, err := h.root.Open(clean)
		if err != nil {
			return nil, err
		}
		defer file.Close()
		data, err := io.ReadAll(io.LimitReader(file, 32*1024*1024+1))
		if err != nil {
			return nil, err
		}
		if len(data) > 32*1024*1024 {
			return nil, fmt.Errorf("host file read exceeds limit")
		}
		return data, nil
	}); err != nil {
		return err
	}
	if err := object.Set("writeFile", func(name string, values []int) error {
		clean, err := hostName(name)
		if err != nil {
			return err
		}
		if len(values) > 32*1024*1024 {
			return fmt.Errorf("host file write exceeds limit")
		}
		data := make([]byte, len(values))
		for index, value := range values {
			if value < 0 || value > 255 {
				return fmt.Errorf("host file data contains a non-byte value")
			}
			data[index] = byte(value)
		}
		file, err := h.root.OpenFile(clean, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
		if err != nil {
			return err
		}
		defer file.Close()
		_, err = file.Write(data)
		return err
	}); err != nil {
		return err
	}
	if err := object.Set("createDirectory", func(name string, recursive bool) error {
		clean, err := hostName(name)
		if err != nil {
			return err
		}
		if !recursive {
			return h.root.Mkdir(clean, 0o700)
		}
		return h.mkdirAll(clean)
	}); err != nil {
		return err
	}
	if err := object.Set("remove", func(name string, recursive bool, force bool) error {
		clean, err := hostName(name)
		if err != nil {
			return err
		}
		if clean == "." {
			return fmt.Errorf("cannot remove localhost root")
		}
		if recursive {
			err = h.removeAll(clean)
		} else {
			err = h.root.Remove(clean)
		}
		if force && errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		return err
	}); err != nil {
		return err
	}
	if err := object.Set("metadataForUser", func(username, name string) (map[string]any, error) {
		root, err := h.openUserRoot(username)
		if err != nil {
			return nil, err
		}
		defer root.Close()
		return metadataAt(root, name)
	}); err != nil {
		return err
	}
	if err := object.Set("readDirectoryForUser", func(username, name string) ([]map[string]any, error) {
		root, err := h.openUserRoot(username)
		if err != nil {
			return nil, err
		}
		defer root.Close()
		return readDirectoryAt(root, name)
	}); err != nil {
		return err
	}
	if err := object.Set("readFileForUser", func(username, name string) ([]byte, error) {
		root, err := h.openUserRoot(username)
		if err != nil {
			return nil, err
		}
		defer root.Close()
		return readFileAt(root, name)
	}); err != nil {
		return err
	}
	if err := object.Set("writeFileForUser", func(username, name string, values []int, uid, gid uint32) error {
		root, err := h.openUserRoot(username)
		if err != nil {
			return err
		}
		defer root.Close()
		if err := writeFileAt(root, name, values); err != nil {
			return err
		}
		home := filepath.Join(h.usersRoot, userHomeSegment(username))
		return userOwnedPath(home, name, uid, gid)
	}); err != nil {
		return err
	}
	if err := object.Set("createDirectoryForUser", func(username, name string, recursive bool, uid, gid uint32) error {
		root, err := h.openUserRoot(username)
		if err != nil {
			return err
		}
		defer root.Close()
		clean, err := hostName(name)
		if err != nil {
			return err
		}
		home := filepath.Join(h.usersRoot, userHomeSegment(username))
		if recursive {
			return mkdirAllAtOwned(root, home, clean, uid, gid)
		}
		if err := validateVirtualUser(uid, gid); err != nil {
			return err
		}
		if err := root.Mkdir(clean, 0o700); err != nil {
			return err
		}
		return userOwnedPath(home, clean, uid, gid)
	}); err != nil {
		return err
	}
	if err := object.Set("removeForUser", func(username, name string, recursive bool, force bool) error {
		root, err := h.openUserRoot(username)
		if err != nil {
			return err
		}
		defer root.Close()
		clean, err := hostName(name)
		if err != nil {
			return err
		}
		if clean == "." {
			return fmt.Errorf("cannot remove user root")
		}
		if recursive {
			err = removeAllAt(root, clean)
		} else {
			err = root.Remove(clean)
		}
		if force && errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		return err
	}); err != nil {
		return err
	}
	if err := object.Set("openWorkspaceStdio", h.openWorkspaceStdio); err != nil {
		return err
	}
	if err := object.Set("writeWorkspaceStdio", h.writeWorkspaceStdio); err != nil {
		return err
	}
	if err := object.Set("drainWorkspaceStdio", h.drainWorkspaceStdio); err != nil {
		return err
	}
	if err := object.Set("closeWorkspaceStdio", h.closeWorkspaceStdio); err != nil {
		return err
	}
	return vm.Set("hostFilesystem", object)
}

func (h *hostRuntime) installProcess(vm *goja.Runtime) error {
	object := vm.NewObject()
	if err := object.Set("spawnShell", func(id, cwd, command string, environment map[string]string) error {
		return h.spawnShell(id, cwd, command, environment)
	}); err != nil {
		return err
	}
	if err := object.Set("spawnCodexAppServer", func(id, cwd string) error {
		return h.spawnCodexAppServer(id, cwd)
	}); err != nil {
		return err
	}
	if err := object.Set("spawnCodexAppServerForUser", func(
		id, cwd, username string, uid, gid uint32, installationID, providerID string,
	) error {
		return h.spawnCodexAppServerForUser(id, cwd, username, uid, gid, installationID, providerID)
	}); err != nil {
		return err
	}
	if err := object.Set("spawnDshEngineWorkerForUser", func(
		id, cwd, username string, uid, gid uint32, installationID, providerID string,
	) error {
		return h.spawnDshEngineWorkerForUser(
			id, cwd, username, uid, gid, installationID, providerID,
		)
	}); err != nil {
		return err
	}
	if err := object.Set("write", func(id, text string) error { return h.writeProcess(id, text) }); err != nil {
		return err
	}
	if err := object.Set("drain", func(id string) (map[string]any, error) { return h.drainProcess(id) }); err != nil {
		return err
	}
	if err := object.Set("kill", func(id string) error { return h.killProcess(id) }); err != nil {
		return err
	}
	if err := object.Set("terminate", func(id string, timeoutMs int64) error {
		return h.terminateProcess(id, time.Duration(timeoutMs)*time.Millisecond)
	}); err != nil {
		return err
	}
	return vm.Set("hostProcess", object)
}

// spawnShell is the transport-neutral process primitive used by the isolated
// workspace agent. SSH remains entirely in JavaScript; Go only owns the local
// OS process boundary and bounded stdio queues.
func (h *hostRuntime) spawnShell(id, cwd, command string, environment map[string]string) error {
	if id == "" {
		return fmt.Errorf("process id is required")
	}
	directory, err := h.processCwd(cwd)
	if err != nil {
		return err
	}
	cmd := exec.Command("/bin/bash", "-lc", command)
	cmd.Dir = directory
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if len(environment) > 0 {
		cmd.Env = append([]string(nil), os.Environ()...)
		for key, value := range environment {
			if key == "" || strings.ContainsAny(key, "=\x00") || strings.ContainsRune(value, '\x00') {
				return fmt.Errorf("invalid process environment entry")
			}
			cmd.Env = append(cmd.Env, key+"="+value)
		}
	}
	return h.startProcess(id, cmd)
}

func hostName(name string) (string, error) {
	name = strings.TrimSpace(strings.ReplaceAll(name, "\\", "/"))
	if name == "" || name == "/" || name == "." {
		return ".", nil
	}
	if strings.HasPrefix(name, "/") {
		return "", fmt.Errorf("host path must be relative to /localhost")
	}
	clean := filepath.ToSlash(filepath.Clean(name))
	if clean == ".." || strings.HasPrefix(clean, "../") {
		return "", fmt.Errorf("host path escapes /localhost")
	}
	return clean, nil
}

func fileMetadata(info os.FileInfo) map[string]any {
	modified := info.ModTime().UnixMilli()
	return map[string]any{
		"fileName":     info.Name(),
		"isDirectory":  info.IsDir(),
		"isFile":       info.Mode().IsRegular(),
		"isSymlink":    info.Mode()&os.ModeSymlink != 0,
		"size":         info.Size(),
		"createdAtMs":  modified,
		"modifiedAtMs": modified,
	}
}

func mkdirAllAt(root *os.Root, name string) error {
	if name == "." {
		return nil
	}
	current := ""
	for _, part := range strings.Split(filepath.ToSlash(name), "/") {
		if current == "" {
			current = part
		} else {
			current += "/" + part
		}
		err := root.Mkdir(current, 0o700)
		if err != nil && !errors.Is(err, fs.ErrExist) {
			return err
		}
	}
	return nil
}

func removeAllAt(root *os.Root, name string) error {
	info, err := root.Lstat(name)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return root.Remove(name)
	}
	var paths []string
	err = fs.WalkDir(root.FS(), name, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		paths = append(paths, path)
		return nil
	})
	if err != nil {
		return err
	}
	sort.Slice(paths, func(left, right int) bool { return len(paths[left]) > len(paths[right]) })
	for _, path := range paths {
		if err := root.Remove(path); err != nil {
			return err
		}
	}
	return nil
}

func (h *hostRuntime) mkdirAll(name string) error { return mkdirAllAt(h.root, name) }

func (h *hostRuntime) removeAll(name string) error { return removeAllAt(h.root, name) }

func (h *hostRuntime) processCwd(name string) (string, error) {
	clean, err := hostName(name)
	if err != nil {
		return "", err
	}
	info, err := h.root.Stat(clean)
	if err != nil {
		return "", err
	}
	if !info.IsDir() {
		return "", fmt.Errorf("process cwd is not a directory")
	}
	candidate := filepath.Join(h.rootPath, filepath.FromSlash(clean))
	resolved, err := filepath.EvalSymlinks(candidate)
	if err != nil {
		return "", err
	}
	relative, err := filepath.Rel(h.rootPath, resolved)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("process cwd escapes /localhost")
	}
	return resolved, nil
}

func (h *hostRuntime) spawnCodexAppServer(id, cwd string) error {
	if id == "" {
		return fmt.Errorf("process id is required")
	}
	directory, err := h.processCwd(cwd)
	if err != nil {
		return err
	}
	return h.startCodexAppServer(id, directory, "", nil)
}

type processIdentity struct {
	username  string
	uid       uint32
	gid       uint32
	home      string
	codexHome string
}

func (h *hostRuntime) spawnCodexAppServerForUser(
	id, cwd, username string, uid, gid uint32, installationID, providerID string,
) error {
	paths, err := h.ensureUser(username, uid, gid, installationID)
	if err != nil {
		return err
	}
	home := paths["homePath"].(string)
	clean, err := hostName(cwd)
	if err != nil {
		return err
	}
	directory := filepath.Join(home, filepath.FromSlash(clean))
	info, err := os.Stat(directory)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return fmt.Errorf("process cwd is not a directory")
	}
	return h.startCodexAppServer(id, directory, providerID, &processIdentity{
		username: username, uid: uid, gid: gid, home: home, codexHome: paths["codexHome"].(string),
	})
}

// spawnDshEngineWorkerForUser starts the trusted JavaScript engine worker with
// a process-scoped provider credential. The policy VM receives neither the
// secret nor a filesystem path containing it; Go remains a generic process
// and secret boundary while all DSH semantics stay in JavaScript.
func (h *hostRuntime) spawnDshEngineWorkerForUser(
	id, cwd, username string, uid, gid uint32, installationID, providerID string,
) error {
	if id == "" {
		return fmt.Errorf("process id is required")
	}
	if h.modelGateway == nil {
		return fmt.Errorf("model gateway is unavailable")
	}
	runtime, ok := h.modelGateway.UserRuntimeConfigForProvider(username, providerID)
	if !ok || runtime.APIKey == "" {
		return fmt.Errorf("API key for model provider %s is not loaded for SSH user %s", providerID, username)
	}
	paths, err := h.ensureUser(username, uid, gid, installationID)
	if err != nil {
		return err
	}
	home := paths["homePath"].(string)
	clean, err := hostName(cwd)
	if err != nil {
		return err
	}
	directory := filepath.Join(home, filepath.FromSlash(clean))
	info, err := os.Stat(directory)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return fmt.Errorf("process cwd is not a directory")
	}
	workerPath := filepath.Join(h.javaScriptRuntimeRoot, "scripts", "dsh-engine-worker.mjs")
	if info, err := os.Stat(workerPath); err != nil || !info.Mode().IsRegular() {
		if err == nil {
			err = fmt.Errorf("not a regular file")
		}
		return fmt.Errorf("resolve trusted DSH worker: %w", err)
	}
	cmd := exec.Command(h.javaScriptBin, workerPath)
	cmd.Dir = directory
	environment := make([]string, 0, len(os.Environ())+6)
	for _, entry := range os.Environ() {
		if strings.HasPrefix(entry, "HOME=") || strings.HasPrefix(entry, "USER=") ||
			strings.HasPrefix(entry, "LOGNAME=") || strings.HasPrefix(entry, "HYPERNODE_DSH_API_KEY=") ||
			strings.HasPrefix(entry, "HYPERNODE_DSH_PERSISTENCE_ROOT=") ||
			strings.HasPrefix(entry, "HYPERNODE_DSH_HOME_ROOT=") {
			continue
		}
		environment = append(environment, entry)
	}
	cmd.Env = append(environment,
		"HOME="+home,
		"USER="+username,
		"LOGNAME="+username,
		"HYPERNODE_USER="+username,
		"HYPERNODE_DSH_API_KEY="+runtime.APIKey,
		"HYPERNODE_DSH_PERSISTENCE_ROOT="+h.dshPersistenceRoot,
		"HYPERNODE_DSH_HOME_ROOT="+h.dshHomeRoot,
	)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	// The DSH worker is a trusted platform Runtime, not the user's shell. Model
	// tools reach the isolated workspace through WorkspaceAttachment/SSH, while
	// the engine-native ledger must remain stable when another user executes the
	// next Turn. Running this process as the deployment identity also keeps the
	// shared ledger inaccessible to container users.
	return h.startProcess(id, cmd)
}

func (h *hostRuntime) startCodexAppServer(id, directory, providerID string, identity *processIdentity) error {
	if id == "" {
		return fmt.Errorf("process id is required")
	}
	username := ""
	if identity != nil {
		username = identity.username
	}
	arguments := h.codexAppServerArgumentsForProvider(username, providerID, "")
	arguments = arguments[1:]
	cmd := exec.Command(h.codexBin, arguments...)
	cmd.Dir = directory
	if identity != nil {
		environment := make([]string, 0, len(os.Environ())+4)
		for _, entry := range os.Environ() {
			if strings.HasPrefix(entry, "HOME=") || strings.HasPrefix(entry, "CODEX_HOME=") ||
				strings.HasPrefix(entry, "USER=") || strings.HasPrefix(entry, "LOGNAME=") {
				continue
			}
			environment = append(environment, entry)
		}
		cmd.Env = append(environment,
			"HOME="+identity.home,
			"CODEX_HOME="+identity.codexHome,
			"USER="+identity.username,
			"LOGNAME="+identity.username,
		)
		if h.enforceUserCredentials {
			cmd.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{
				Uid: identity.uid, Gid: identity.gid,
			}}
		}
	}
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Setpgid = true
	return h.startProcess(id, cmd)
}

func (h *hostRuntime) startProcess(id string, cmd *exec.Cmd) error {
	if id == "" {
		return fmt.Errorf("process id is required")
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return fmt.Errorf("host process service is closed")
	}
	if _, exists := h.processes[id]; exists {
		return fmt.Errorf("duplicate host process id")
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	process := &hostProcess{cmd: cmd, stdin: stdin, exitCode: -1, notify: h.wakes.notify, done: make(chan struct{})}
	process.readers.Add(2)
	h.processes[id] = process
	go process.capture(stdout, true)
	go process.capture(stderr, false)
	go process.wait()
	return nil
}

func (p *hostProcess) capture(reader io.Reader, stdout bool) {
	defer p.readers.Done()
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 64*1024), hostProcessBufferLimit)
	for scanner.Scan() {
		line := scanner.Text()
		p.mu.Lock()
		if stdout {
			p.stdout = append(p.stdout, line)
		} else {
			p.stderr = append(p.stderr, line)
		}
		p.mu.Unlock()
		p.notify()
	}
	if err := scanner.Err(); err != nil {
		p.mu.Lock()
		p.err = err.Error()
		p.mu.Unlock()
		p.notify()
	}
}

func (p *hostProcess) wait() {
	// StdoutPipe/StderrPipe require their readers to consume EOF before Wait;
	// Wait is allowed to close both pipes after observing the child exit.
	// Keeping this order also guarantees that `exited` is never published
	// before the final stdout/stderr frame has been captured.
	p.readers.Wait()
	err := p.cmd.Wait()
	defer close(p.done)
	p.mu.Lock()
	p.exited = true
	if err == nil {
		p.exitCode = 0
		p.mu.Unlock()
		p.notify()
		return
	}
	var exitError *exec.ExitError
	if errors.As(err, &exitError) {
		p.exitCode = exitError.ExitCode()
	} else {
		p.err = err.Error()
	}
	p.mu.Unlock()
	p.notify()
}

func (h *hostRuntime) getProcess(id string) (*hostProcess, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	process := h.processes[id]
	if process == nil {
		return nil, fmt.Errorf("unknown host process %q", id)
	}
	return process, nil
}

func (h *hostRuntime) writeProcess(id, text string) error {
	process, err := h.getProcess(id)
	if err != nil {
		return err
	}
	if len(text) > hostProcessBufferLimit {
		return fmt.Errorf("host process write exceeds limit")
	}
	process.stdinMu.Lock()
	defer process.stdinMu.Unlock()
	_, err = io.WriteString(process.stdin, text)
	return err
}

func (h *hostRuntime) drainProcess(id string) (map[string]any, error) {
	process, err := h.getProcess(id)
	if err != nil {
		return nil, err
	}
	process.mu.Lock()
	defer process.mu.Unlock()
	stdout := append([]string(nil), process.stdout...)
	stderr := append([]string(nil), process.stderr...)
	process.stdout = process.stdout[:0]
	process.stderr = process.stderr[:0]
	return map[string]any{
		"stdoutLines": stdout,
		"stderrLines": stderr,
		"exited":      process.exited,
		"exitCode":    process.exitCode,
		"error":       process.err,
	}, nil
}

func (h *hostRuntime) killProcess(id string) error {
	h.mu.Lock()
	process := h.processes[id]
	delete(h.processes, id)
	h.mu.Unlock()
	if process == nil {
		return nil
	}
	_ = process.stdin.Close()
	if process.cmd.Process == nil {
		return nil
	}
	err := process.cmd.Process.Kill()
	if errors.Is(err, os.ErrProcessDone) {
		return nil
	}
	return err
}

func (h *hostRuntime) terminateProcess(id string, timeout time.Duration) error {
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	h.mu.Lock()
	process := h.processes[id]
	h.mu.Unlock()
	if process == nil {
		return nil
	}
	_ = process.stdin.Close()
	if process.cmd.Process != nil {
		var signalErr error
		if process.cmd.SysProcAttr != nil && process.cmd.SysProcAttr.Setpgid {
			signalErr = syscall.Kill(-process.cmd.Process.Pid, syscall.SIGTERM)
		} else {
			signalErr = process.cmd.Process.Signal(syscall.SIGTERM)
		}
		if signalErr != nil && !errors.Is(signalErr, os.ErrProcessDone) && !errors.Is(signalErr, syscall.ESRCH) {
			return signalErr
		}
	}
	select {
	case <-process.done:
	case <-time.After(timeout):
		if process.cmd.Process != nil {
			if process.cmd.SysProcAttr != nil && process.cmd.SysProcAttr.Setpgid {
				_ = syscall.Kill(-process.cmd.Process.Pid, syscall.SIGKILL)
			} else {
				_ = process.cmd.Process.Kill()
			}
		}
		select {
		case <-process.done:
		case <-time.After(time.Second):
			return fmt.Errorf("process %q did not exit after termination", id)
		}
	}
	h.mu.Lock()
	if h.processes[id] == process {
		delete(h.processes, id)
	}
	h.mu.Unlock()
	return nil
}

func (h *hostRuntime) installTerminal(vm *goja.Runtime) error {
	object := vm.NewObject()
	if err := object.Set("spawnForUser", func(id, username, cwd string, uid, gid, cols, rows uint32) (map[string]any, error) {
		return h.spawnTerminalForUser(id, username, cwd, uid, gid, cols, rows)
	}); err != nil {
		return err
	}
	if err := object.Set("write", func(id string, data []byte) error {
		terminal, err := h.getTerminal(id)
		if err != nil {
			return err
		}
		_, err = terminal.pty.Write(data)
		return err
	}); err != nil {
		return err
	}
	if err := object.Set("resize", func(id string, cols, rows uint32) error {
		terminal, err := h.getTerminal(id)
		if err != nil {
			return err
		}
		return pty.Setsize(terminal.pty, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
	}); err != nil {
		return err
	}
	if err := object.Set("drain", func(id string) (map[string]any, error) {
		terminal, err := h.getTerminal(id)
		if err != nil {
			return nil, err
		}
		terminal.mu.Lock()
		defer terminal.mu.Unlock()
		output := append([]byte(nil), terminal.output...)
		terminal.output = terminal.output[:0]
		return map[string]any{
			"outputBytes": output, "exited": terminal.exited, "exitCode": terminal.exitCode,
			"error": terminal.err, "cwd": terminal.cwd,
		}, nil
	}); err != nil {
		return err
	}
	if err := object.Set("kill", func(id string) error { return h.killTerminal(id) }); err != nil {
		return err
	}
	if h.workspaceAgent {
		if err := object.Set("spawnInWorkspace", func(id, cwd string, cols, rows uint32) (map[string]any, error) {
			return h.spawnTerminalInWorkspace(id, cwd, cols, rows)
		}); err != nil {
			return err
		}
	}
	return vm.Set("hostTerminal", object)
}

func (h *hostRuntime) spawnTerminalInWorkspace(id, cwd string, cols, rows uint32) (map[string]any, error) {
	if !h.workspaceAgent {
		return nil, fmt.Errorf("workspace terminal capability is disabled")
	}
	logical, err := workspaceLogicalPath(cwd)
	if err != nil {
		return nil, err
	}
	relative, err := workspaceRelativePath(logical)
	if err != nil {
		return nil, err
	}
	directory := filepath.Join(h.rootPath, filepath.FromSlash(relative))
	info, err := os.Stat(directory)
	if err != nil {
		return nil, fmt.Errorf("resolve workspace terminal cwd: %w", err)
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("workspace terminal cwd is not a directory")
	}
	shell := "/bin/bash"
	if _, err := os.Stat(shell); err != nil {
		shell = "/bin/sh"
	}
	cmd := exec.Command(shell)
	cmd.Dir = directory
	cmd.Env = append(os.Environ(), "HOME=/root", "USER=root", "LOGNAME=root", "SHELL="+shell,
		"TERM=xterm-256color", "COLORTERM=truecolor")
	return h.startTerminalCommand(id, logical, shell, cmd, cols, rows)
}

func (h *hostRuntime) spawnTerminalForUser(id, username, cwd string, uid, gid, cols, rows uint32) (map[string]any, error) {
	if id == "" {
		return nil, fmt.Errorf("terminal id is required")
	}
	if uid < 10000 || gid < 10000 {
		return nil, fmt.Errorf("refusing privileged terminal identity")
	}
	root, err := h.openUserRoot(username)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	clean, err := hostName(cwd)
	if err != nil {
		return nil, err
	}
	info, err := root.Stat(clean)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("terminal cwd is not a directory")
	}
	home := filepath.Join(h.usersRoot, userHomeSegment(username))
	directory := filepath.Join(home, filepath.FromSlash(clean))
	shell := "/bin/bash"
	cmd := exec.Command(shell)
	cmd.Dir = directory
	environment := make([]string, 0, len(os.Environ())+6)
	for _, entry := range os.Environ() {
		if strings.HasPrefix(entry, "HOME=") || strings.HasPrefix(entry, "USER=") ||
			strings.HasPrefix(entry, "LOGNAME=") || strings.HasPrefix(entry, "SHELL=") || strings.HasPrefix(entry, "TERM=") {
			continue
		}
		environment = append(environment, entry)
	}
	cmd.Env = append(environment, "HOME="+home, "USER="+username, "LOGNAME="+username,
		"SHELL="+shell, "TERM=xterm-256color", "COLORTERM=truecolor")
	if h.enforceUserCredentials {
		cmd.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: uid, Gid: gid}}
	}
	if cols == 0 {
		cols = 80
	}
	if rows == 0 {
		rows = 24
	}
	return h.startTerminalCommand(id, directory, shell, cmd, cols, rows)
}

func (h *hostRuntime) startTerminalCommand(id, cwd, shell string, cmd *exec.Cmd, cols, rows uint32) (map[string]any, error) {
	if cols == 0 {
		cols = 80
	}
	if rows == 0 {
		rows = 24
	}
	file, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
	if err != nil {
		return nil, err
	}
	terminal := &hostTerminal{cmd: cmd, pty: file, cwd: cwd, exitCode: -1, notify: h.wakes.notify}
	h.mu.Lock()
	if h.closed || h.terminals[id] != nil {
		h.mu.Unlock()
		_ = file.Close()
		_ = cmd.Process.Kill()
		return nil, fmt.Errorf("duplicate or closed terminal id")
	}
	h.terminals[id] = terminal
	h.mu.Unlock()
	go terminal.capture()
	go terminal.wait()
	return map[string]any{"cwd": cwd, "shell": shell}, nil
}

func (t *hostTerminal) capture() {
	buffer := make([]byte, 32*1024)
	for {
		count, err := t.pty.Read(buffer)
		if count > 0 {
			t.mu.Lock()
			t.output = append(t.output, buffer[:count]...)
			if len(t.output) > hostTerminalBufferLimit {
				t.output = append([]byte(nil), t.output[len(t.output)-hostTerminalBufferLimit:]...)
			}
			t.mu.Unlock()
			t.notify()
		}
		if err != nil {
			return
		}
	}
}

func (t *hostTerminal) wait() {
	err := t.cmd.Wait()
	t.mu.Lock()
	t.exited = true
	if err == nil {
		t.exitCode = 0
		t.mu.Unlock()
		t.notify()
		return
	}
	var exitError *exec.ExitError
	if errors.As(err, &exitError) {
		t.exitCode = exitError.ExitCode()
	} else {
		t.err = err.Error()
	}
	t.mu.Unlock()
	t.notify()
}

func (h *hostRuntime) getTerminal(id string) (*hostTerminal, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	terminal := h.terminals[id]
	if terminal == nil {
		return nil, fmt.Errorf("unknown host terminal %q", id)
	}
	return terminal, nil
}

func (h *hostRuntime) killTerminal(id string) error {
	h.mu.Lock()
	terminal := h.terminals[id]
	delete(h.terminals, id)
	h.mu.Unlock()
	if terminal == nil {
		return nil
	}
	_ = terminal.pty.Close()
	if terminal.cmd.Process == nil {
		return nil
	}
	err := terminal.cmd.Process.Kill()
	if errors.Is(err, os.ErrProcessDone) {
		return nil
	}
	return err
}

func (h *hostRuntime) Close() error {
	h.mu.Lock()
	if h.closed {
		h.mu.Unlock()
		return nil
	}
	h.closed = true
	h.wakeGeneration++
	if h.wakeTimer != nil {
		h.wakeTimer.Stop()
		h.wakeTimer = nil
	}
	ids := make([]string, 0, len(h.processes))
	for id := range h.processes {
		ids = append(ids, id)
	}
	terminalIDs := make([]string, 0, len(h.terminals))
	for id := range h.terminals {
		terminalIDs = append(terminalIDs, id)
	}
	stdioIDs := make([]string, 0, len(h.workspaceStdioSessions))
	for id := range h.workspaceStdioSessions {
		stdioIDs = append(stdioIDs, id)
	}
	attachments := make([]workspaces.Attachment, 0, len(h.workspaceAttachments))
	for id, attachment := range h.workspaceAttachments {
		attachments = append(attachments, attachment)
		delete(h.workspaceAttachments, id)
	}
	attachmentWatchIDs := make([]string, 0, len(h.workspaceAttachmentWatches))
	for id := range h.workspaceAttachmentWatches {
		attachmentWatchIDs = append(attachmentWatchIDs, id)
	}
	h.mu.Unlock()
	for _, id := range ids {
		_ = h.killProcess(id)
	}
	for _, id := range terminalIDs {
		_ = h.killTerminal(id)
	}
	for _, id := range stdioIDs {
		h.closeWorkspaceStdio(id)
	}
	for _, id := range attachmentWatchIDs {
		_ = h.stopWorkspaceAttachmentWatch(id)
	}
	if h.workspaceManager != nil {
		for _, attachment := range attachments {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			_ = h.workspaceManager.Detach(ctx, attachment)
			cancel()
		}
	}
	if h.workspaceAttachmentPool != nil {
		h.workspaceAttachmentPool.Close()
	}
	if h.network != nil {
		h.network.closeAll()
	}
	return h.root.Close()
}
