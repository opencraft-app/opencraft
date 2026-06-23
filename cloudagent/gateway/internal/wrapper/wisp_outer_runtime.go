package wrapper

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"strings"
	"time"
)

const (
	defaultWispOuterAdminAddr = "http://127.0.0.1:8520"
	defaultWispPackageURL     = "https://cloudagent-sidecar-shanghai-1388575217.cos.ap-shanghai.myqcloud.com/workspace/releases/wisp-linux-amd64-20260622T065610Z-6ec59c76cb2e.erofs"
)

func wispAdminAddr(ACPSessionRuntime) string {
	return defaultWispOuterAdminAddr
}

func wispInstallDirFromClient(clientPath string) string {
	clientPath = strings.TrimSpace(clientPath)
	if clientPath == "" {
		return ""
	}
	return path.Dir(path.Dir(clientPath))
}

type agentWispSMHSpace struct {
	SpaceID     string
	AccessToken string
	Owned       bool
}

func normalizeOuterRuntime(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "":
		return outerRuntimeWisp
	case outerRuntimeAGS:
		return outerRuntimeAGS
	case outerRuntimeWisp:
		return outerRuntimeWisp
	default:
		return strings.ToLower(strings.TrimSpace(value))
	}
}

func (w *AgentSidecarWorker) prepareWispOuterRuntime(ctx context.Context, host RuntimeHost, sb RuntimeHostTarget, runtime ACPSessionRuntime, req ACPSessionRuntimeStartRequest) (ACPSessionRuntime, error) {
	if w.wispSMHLibraryID == "" || w.wispSMHAccessDomain == "" || w.wispSMHLibrarySecret == "" {
		return ACPSessionRuntime{}, errors.New("GATEWAY_WISP_SMH_LIBRARY_ID, GATEWAY_WISP_SMH_ACCESS_DOMAIN, and GATEWAY_WISP_SMH_LIBRARY_SECRET are required for wisp outer runtime")
	}
	space, err := w.prepareWispSMHSpace(ctx)
	if err != nil {
		return ACPSessionRuntime{}, err
	}
	cleanupSpace := space.Owned
	defer func() {
		if cleanupSpace {
			cleanupCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			_ = w.deleteWispSMHSpace(cleanupCtx, space.SpaceID)
		}
	}()
	runtime, err = w.prepareWispOuterRuntimeWithSpace(ctx, host, sb, runtime, req, space)
	if err != nil {
		return ACPSessionRuntime{}, err
	}
	cleanupSpace = false
	return runtime, nil
}

func (w *AgentSidecarWorker) prepareWispOuterRuntimeWithSpace(ctx context.Context, host RuntimeHost, sb RuntimeHostTarget, runtime ACPSessionRuntime, req ACPSessionRuntimeStartRequest, space agentWispSMHSpace) (ACPSessionRuntime, error) {
	return w.prepareWispRuntimeWithSpace(ctx, host, sb, runtime, req, space, "outer", true)
}

func (w *AgentSidecarWorker) resolveWispRuntimeForSpace(ctx context.Context, runtime ACPSessionRuntime, req ACPSessionRuntimeStartRequest, space agentWispSMHSpace, acquireLease bool) (ACPSessionRuntime, error) {
	runtime.WispName = firstNonEmpty(runtime.WispName, wispNameFromRuntime(runtimeWorkspaceIdentity(req)))
	runtime.WispWorkspaceID = firstNonEmpty(runtime.WispWorkspaceID, space.SpaceID)
	runtime.WispSMHSpaceID = space.SpaceID
	runtime.WispOwnsSMHSpace = runtime.WispOwnsSMHSpace || space.Owned
	runtime.WispPackageURL = firstNonEmpty(runtime.WispPackageURL, w.wispPackageURL)
	runtime.WispJFSPrefix = firstNonEmpty(runtime.WispJFSPrefix, w.wispJFSPrefix)
	runtime.WispRootUpperSize = firstNonEmpty(runtime.WispRootUpperSize, w.wispRootUpperSize)
	runtime.WispInstallDir = firstNonEmpty(runtime.WispInstallDir, path.Join("/tmp/cloudagent-wisp", req.SessionID, "install"))
	runtime.WispClientPath = firstNonEmpty(runtime.WispClientPath, path.Join(runtime.WispInstallDir, "bin", "wispclient"))
	if !acquireLease {
		return runtime, nil
	}
	return w.acquireWispWorkspaceLease(ctx, runtime)
}

func (w *AgentSidecarWorker) prepareWispRuntimeWithSpace(ctx context.Context, host RuntimeHost, sb RuntimeHostTarget, runtime ACPSessionRuntime, req ACPSessionRuntimeStartRequest, space agentWispSMHSpace, target string, acquireLease bool) (ACPSessionRuntime, error) {
	var err error
	runtime, err = w.resolveWispRuntimeForSpace(ctx, runtime, req, space, acquireLease)
	if err != nil {
		return ACPSessionRuntime{}, err
	}
	if err := w.requireWispMountLeaseHeld(ctx, runtime); err != nil {
		return ACPSessionRuntime{}, err
	}
	releaseLease := false
	if acquireLease {
		releaseLease = true
		defer func() {
			if releaseLease {
				releaseCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				defer cancel()
				_ = w.releaseWispWorkspaceLease(releaseCtx, runtime)
			}
		}()
	}
	env := map[string]string{
		"WISP_PACKAGE_URL":                    runtime.WispPackageURL,
		"WISP_PACKAGE_SHA256":                 firstEnv("GATEWAY_WISP_PACKAGE_SHA256", "WISP_PACKAGE_SHA256"),
		"WISP_PACKAGE_FORMAT":                 firstEnv("GATEWAY_WISP_PACKAGE_FORMAT", "WISP_PACKAGE_FORMAT"),
		"WISP_INSTALL_DIR":                    runtime.WispInstallDir,
		"WISP_NAME":                           runtime.WispName,
		"SMH_LIBRARY_ID":                      w.wispSMHLibraryID,
		"SMH_ACCESS_DOMAIN":                   w.wispSMHAccessDomain,
		"SMH_SPACE_ID":                        space.SpaceID,
		"SMH_ACCESS_TOKEN":                    space.AccessToken,
		"JFS_PREFIX":                          runtime.WispJFSPrefix,
		"ROOT_UPPER_SIZE":                     runtime.WispRootUpperSize,
		"JFS_MOUNT_WRITEBACK":                 firstNonEmpty(firstEnv("GATEWAY_WISP_MOUNT_WRITEBACK", "JFS_MOUNT_WRITEBACK"), "1"),
		"JFS_MOUNT_UPLOAD_DELAY":              firstNonEmpty(firstEnv("GATEWAY_WISP_MOUNT_UPLOAD_DELAY", "JFS_MOUNT_UPLOAD_DELAY"), "10s"),
		"JFS_MOUNT_MAX_UPLOADS":               firstNonEmpty(firstEnv("GATEWAY_WISP_MOUNT_MAX_UPLOADS", "JFS_MOUNT_MAX_UPLOADS"), "20"),
		"JFS_MOUNT_CACHE_SIZE":                firstNonEmpty(firstEnv("GATEWAY_WISP_MOUNT_CACHE_SIZE", "JFS_MOUNT_CACHE_SIZE"), "64M"),
		"JFS_MOUNT_MIN_FREE_BYTES":            firstNonEmpty(firstEnv("GATEWAY_WISP_MOUNT_MIN_FREE_BYTES", "JFS_MOUNT_MIN_FREE_BYTES"), "200M"),
		"JFS_WRITEBACK_BARRIER_POLL_INTERVAL": firstNonEmpty(firstEnv("GATEWAY_WISP_WRITEBACK_BARRIER_POLL_INTERVAL", "JFS_WRITEBACK_BARRIER_POLL_INTERVAL"), "30ms"),
		"SMH_HTTP_TRACE":                      firstEnv("GATEWAY_WISP_SMH_HTTP_TRACE", "SMH_HTTP_TRACE"),
		"JFS_LITESTREAM_TRACE":                firstEnv("GATEWAY_WISP_LITESTREAM_TRACE", "JFS_LITESTREAM_TRACE"),
		"WISP_ADMIN_LISTEN_ADDR":              strings.TrimPrefix(wispAdminAddr(runtime), "http://"),
		"WISP_PACKAGE_ARCH":                   firstEnv("GATEWAY_WISP_PACKAGE_ARCH", "WISP_PACKAGE_ARCH"),
		"WISP_USE_HOST_E2FSPROGS":             firstEnv("GATEWAY_WISP_USE_HOST_E2FSPROGS", "WISP_USE_HOST_E2FSPROGS"),
		"WISP_USE_HOST_CRUN":                  firstEnv("GATEWAY_WISP_USE_HOST_CRUN", "WISP_USE_HOST_CRUN"),
	}
	w.logWispMountEvent("acp_runtime_wisp_mount_start", req, runtime, sb, space, target, "")
	result, err := host.RunCommand(ctx, sb, wispOuterPrepareScript(), env, nil, func(text string) error {
		logRemoteStderr(time.Now(), workerJob{JobID: "wisp_outer_prepare", ResponseID: req.SessionID}, text)
		return nil
	})
	if err != nil {
		w.logWispMountEvent("acp_runtime_wisp_mount_failed", req, runtime, sb, space, target, wispCommandFailureDetail(err, result))
		return ACPSessionRuntime{}, fmt.Errorf(
			"prepare wisp outer runtime session_id=%s outer_sandbox_id=%s wisp_name=%s smh_space_id=%s package_url=%s: %s",
			req.SessionID,
			sb.ID,
			runtime.WispName,
			space.SpaceID,
			runtime.WispPackageURL,
			wispCommandFailureDetail(err, result),
		)
	}
	if result.ExitCode != 0 || !strings.Contains(result.Stdout, "WISP_OUTER_READY") {
		w.logWispMountEvent("acp_runtime_wisp_mount_failed", req, runtime, sb, space, target, wispCommandFailureDetail(nil, result))
		return ACPSessionRuntime{}, fmt.Errorf(
			"prepare wisp outer runtime failed session_id=%s outer_sandbox_id=%s wisp_name=%s smh_space_id=%s package_url=%s: %s",
			req.SessionID,
			sb.ID,
			runtime.WispName,
			space.SpaceID,
			runtime.WispPackageURL,
			wispCommandFailureDetail(nil, result),
		)
	}
	if acquireLease {
		releaseLease = false
	}
	w.logWispMountEvent("acp_runtime_wisp_mount_done", req, runtime, sb, space, target, "")
	return runtime, nil
}

func (w *AgentSidecarWorker) prepareWispHostOnly(ctx context.Context, host RuntimeHost, sb RuntimeHostTarget, installDir string, packageURL string, jobID string) (string, error) {
	installDir = firstNonEmpty(strings.TrimSpace(installDir), path.Join("/tmp/cloudagent-warm-runtime", randomHex(8), "install"))
	packageURL = firstNonEmpty(strings.TrimSpace(packageURL), w.wispPackageURL)
	env := map[string]string{
		"WISP_HOST_ONLY":                      "1",
		"WISP_PACKAGE_URL":                    packageURL,
		"WISP_PACKAGE_SHA256":                 firstEnv("GATEWAY_WISP_PACKAGE_SHA256", "WISP_PACKAGE_SHA256"),
		"WISP_PACKAGE_FORMAT":                 firstEnv("GATEWAY_WISP_PACKAGE_FORMAT", "WISP_PACKAGE_FORMAT"),
		"WISP_INSTALL_DIR":                    installDir,
		"WISP_NAME":                           "warm-host-only",
		"SMH_LIBRARY_ID":                      w.wispSMHLibraryID,
		"SMH_ACCESS_DOMAIN":                   w.wispSMHAccessDomain,
		"SMH_SPACE_ID":                        "warm-host-only",
		"SMH_ACCESS_TOKEN":                    "warm-host-only",
		"JFS_PREFIX":                          "warm-host-only",
		"ROOT_UPPER_SIZE":                     w.wispRootUpperSize,
		"JFS_MOUNT_WRITEBACK":                 firstNonEmpty(firstEnv("GATEWAY_WISP_MOUNT_WRITEBACK", "JFS_MOUNT_WRITEBACK"), "1"),
		"JFS_MOUNT_UPLOAD_DELAY":              firstNonEmpty(firstEnv("GATEWAY_WISP_MOUNT_UPLOAD_DELAY", "JFS_MOUNT_UPLOAD_DELAY"), "10s"),
		"JFS_MOUNT_MAX_UPLOADS":               firstNonEmpty(firstEnv("GATEWAY_WISP_MOUNT_MAX_UPLOADS", "JFS_MOUNT_MAX_UPLOADS"), "20"),
		"JFS_MOUNT_CACHE_SIZE":                firstNonEmpty(firstEnv("GATEWAY_WISP_MOUNT_CACHE_SIZE", "JFS_MOUNT_CACHE_SIZE"), "64M"),
		"JFS_MOUNT_MIN_FREE_BYTES":            firstNonEmpty(firstEnv("GATEWAY_WISP_MOUNT_MIN_FREE_BYTES", "JFS_MOUNT_MIN_FREE_BYTES"), "200M"),
		"JFS_WRITEBACK_BARRIER_POLL_INTERVAL": firstNonEmpty(firstEnv("GATEWAY_WISP_WRITEBACK_BARRIER_POLL_INTERVAL", "JFS_WRITEBACK_BARRIER_POLL_INTERVAL"), "30ms"),
		"WISP_PACKAGE_ARCH":                   firstEnv("GATEWAY_WISP_PACKAGE_ARCH", "WISP_PACKAGE_ARCH"),
		"WISP_USE_HOST_E2FSPROGS":             firstEnv("GATEWAY_WISP_USE_HOST_E2FSPROGS", "WISP_USE_HOST_E2FSPROGS"),
		"WISP_USE_HOST_CRUN":                  firstEnv("GATEWAY_WISP_USE_HOST_CRUN", "WISP_USE_HOST_CRUN"),
	}
	result, err := host.RunCommand(ctx, sb, wispOuterPrepareScript(), env, nil, func(text string) error {
		logRemoteStderr(time.Now(), workerJob{JobID: firstNonEmpty(jobID, "wisp_host_prepare"), ResponseID: sb.ID}, text)
		return nil
	})
	if strings.Contains(result.Stdout, "WISP_HOST_READY") {
		return path.Join(installDir, "bin", "wispclient"), nil
	}
	if err != nil {
		return "", fmt.Errorf("prepare warm wisp host sandbox_id=%s install_dir=%s package_url=%s: %s", sb.ID, installDir, packageURL, wispCommandFailureDetail(err, result))
	}
	if result.ExitCode != 0 || !strings.Contains(result.Stdout, "WISP_HOST_READY") {
		return "", fmt.Errorf("prepare warm wisp host failed sandbox_id=%s install_dir=%s package_url=%s: %s", sb.ID, installDir, packageURL, wispCommandFailureDetail(nil, result))
	}
	return path.Join(installDir, "bin", "wispclient"), nil
}

func (w *AgentSidecarWorker) requireWispMountLeaseHeld(ctx context.Context, runtime ACPSessionRuntime) error {
	if runtime.WispLeaseID == "" {
		return fmt.Errorf("wisp mount rejected: missing lease runtime_id=%s wisp_name=%s workspace_id=%s", runtime.RuntimeID, runtime.WispName, firstNonEmpty(runtime.WispSMHSpaceID, runtime.WispWorkspaceID))
	}
	if w.workspaceService == nil {
		return errors.New("workspace service is required to verify wisp mount lease")
	}
	// The lease is always acquired against the SMH space ID (the outer
	// runtime's canonical workspace). For inner workspace wisps,
	// WispWorkspaceID is overridden to "workspace_session_XXX" which differs
	// from the stored lease key. Prefer WispSMHSpaceID for lookup.
	workspaceID := firstNonEmpty(runtime.WispSMHSpaceID, runtime.WispWorkspaceID)
	if strings.TrimSpace(workspaceID) == "" {
		return errors.New("wisp workspace id is required to verify mount lease")
	}
	lease, ok, err := w.workspaceService.GetLease(ctx, workspaceID)
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("wisp mount rejected: no active lease record workspace_id=%s runtime_id=%s wisp_name=%s", workspaceID, runtime.RuntimeID, runtime.WispName)
	}
	if lease.LeaseID != runtime.WispLeaseID ||
		lease.FencingToken != runtime.WispLeaseFence ||
		lease.State != "active" ||
		!lease.ExpiresAt.After(time.Now().UTC()) {
		return fmt.Errorf(
			"wisp mount rejected: lease mismatch workspace_id=%s wisp_name=%s expected_lease=%s expected_fence=%d actual_lease=%s actual_runtime=%s actual_fence=%d actual_state=%s actual_until=%s",
			workspaceID,
			runtime.WispName,
			runtime.WispLeaseID,
			runtime.WispLeaseFence,
			lease.LeaseID,
			lease.RuntimeID,
			lease.FencingToken,
			lease.State,
			lease.ExpiresAt.Format(time.RFC3339Nano),
		)
	}
	return nil
}

func (w *AgentSidecarWorker) logWispMountEvent(event string, req ACPSessionRuntimeStartRequest, runtime ACPSessionRuntime, sb RuntimeHostTarget, space agentWispSMHSpace, target string, errText string) {
	workspaceRuntimeID := runtime.WorkspaceRuntimeID
	if target == "inner" {
		workspaceRuntimeID = firstNonEmpty(workspaceRuntimeID, runtime.RuntimeID)
	}
	fields := []string{
		"timeline source=go",
		"event=" + event,
		"session_id=" + req.SessionID,
		fmt.Sprintf("generation=%d", req.Generation),
		"target=" + quoteServerField(target),
		"runtime_id=" + runtime.RuntimeID,
		"workspace_runtime_id=" + quoteServerField(workspaceRuntimeID),
		"sandbox_id=" + sb.ID,
		"wisp_name=" + quoteServerField(runtime.WispName),
		"smh_space_id=" + quoteServerField(space.SpaceID),
		"lease_id=" + quoteServerField(runtime.WispLeaseID),
		fmt.Sprintf("fence=%d", runtime.WispLeaseFence),
		"lease_until=" + quoteServerField(formatOptionalTime(runtime.WispLeaseUntil)),
	}
	if errText != "" {
		fields = append(fields, "error="+quoteServerField(errText))
	}
	fmt.Fprintln(os.Stderr, strings.Join(fields, " "))
}

func (w *AgentSidecarWorker) acquireWispWorkspaceLease(ctx context.Context, runtime ACPSessionRuntime) (ACPSessionRuntime, error) {
	if w.workspaceService == nil {
		return ACPSessionRuntime{}, errors.New("workspace service is required for wisp outer runtime")
	}
	workspaceID := firstNonEmpty(runtime.WispWorkspaceID, runtime.WispSMHSpaceID)
	if strings.TrimSpace(workspaceID) == "" {
		return ACPSessionRuntime{}, errors.New("wisp workspace id is required for lease")
	}
	if strings.TrimSpace(runtime.RuntimeID) == "" {
		return ACPSessionRuntime{}, errors.New("runtime id is required for workspace lease")
	}
	if err := w.workspaceService.EnsureWorkspace(ctx, WorkspaceRecord{
		WorkspaceID:         workspaceID,
		Backend:             "smh",
		ProviderWorkspaceID: runtime.WispSMHSpaceID,
		State:               "active",
	}); err != nil {
		return ACPSessionRuntime{}, err
	}
	lease, err := w.workspaceService.AcquireLease(ctx, WorkspaceLeaseRequest{
		WorkspaceID: workspaceID,
		RuntimeID:   runtime.RuntimeID,
		Provider:    runtime.SandboxBackend,
		TTL:         w.workspaceLeaseTTL,
	})
	if err != nil {
		return ACPSessionRuntime{}, err
	}
	runtime.WispWorkspaceID = workspaceID
	runtime.WispLeaseID = lease.LeaseID
	runtime.WispLeaseFence = lease.FencingToken
	runtime.WispLeaseUntil = lease.ExpiresAt
	return runtime, nil
}

func (w *AgentSidecarWorker) releaseWispWorkspaceLease(ctx context.Context, runtime ACPSessionRuntime) error {
	if w.workspaceService == nil || runtime.WispLeaseID == "" {
		return nil
	}
	return w.workspaceService.ReleaseLease(ctx, WorkspaceLease{
		WorkspaceID:  runtime.WispWorkspaceID,
		RuntimeID:    runtime.RuntimeID,
		LeaseID:      runtime.WispLeaseID,
		FencingToken: runtime.WispLeaseFence,
		ExpiresAt:    runtime.WispLeaseUntil,
	})
}

func (w *AgentSidecarWorker) prepareWispSMHSpace(ctx context.Context) (agentWispSMHSpace, error) {
	if w.wispSMHSpaceID != "" {
		token, err := w.issueWispSMHToken(ctx, w.wispSMHSpaceID, "admin")
		if err != nil {
			return agentWispSMHSpace{}, err
		}
		return agentWispSMHSpace{SpaceID: w.wispSMHSpaceID, AccessToken: token}, nil
	}
	createToken, err := w.issueWispSMHToken(ctx, "", "create_space,admin")
	if err != nil {
		return agentWispSMHSpace{}, err
	}
	body, _ := json.Marshal(map[string]string{"spaceTag": fmt.Sprintf("cloudagent-agent-%d", time.Now().UnixNano())})
	endpoint := fmt.Sprintf("%s/api/v1/space/%s?access_token=%s", w.wispSMHAccessDomain, url.PathEscape(w.wispSMHLibraryID), url.QueryEscape(createToken))
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return agentWispSMHSpace{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return agentWispSMHSpace{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return agentWispSMHSpace{}, fmt.Errorf("SMH create space http %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	var out struct {
		SpaceID string `json:"spaceId"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return agentWispSMHSpace{}, err
	}
	if strings.TrimSpace(out.SpaceID) == "" {
		return agentWispSMHSpace{}, errors.New("SMH create space returned empty spaceId")
	}
	token, err := w.issueWispSMHToken(ctx, out.SpaceID, "admin")
	if err != nil {
		return agentWispSMHSpace{}, err
	}
	return agentWispSMHSpace{SpaceID: out.SpaceID, AccessToken: token, Owned: true}, nil
}

func (w *AgentSidecarWorker) issueWispSMHToken(ctx context.Context, spaceID, grant string) (string, error) {
	q := url.Values{}
	q.Set("library_id", w.wispSMHLibraryID)
	q.Set("library_secret", w.wispSMHLibrarySecret)
	if strings.TrimSpace(spaceID) != "" {
		q.Set("space_id", spaceID)
	}
	q.Set("grant", grant)
	q.Set("period", "3600")
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, w.wispSMHAccessDomain+"/api/v1/token?"+q.Encode(), nil)
	if err != nil {
		return "", err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return "", fmt.Errorf("SMH issue token http %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	var out struct {
		AccessToken string `json:"accessToken"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", err
	}
	if strings.TrimSpace(out.AccessToken) == "" {
		return "", errors.New("SMH issue token returned empty accessToken")
	}
	return out.AccessToken, nil
}

func (w *AgentSidecarWorker) deleteWispSMHSpace(ctx context.Context, spaceID string) error {
	spaceID = strings.TrimSpace(spaceID)
	if spaceID == "" {
		return nil
	}
	token, err := w.issueWispSMHToken(ctx, "", "admin,delete_space")
	if err != nil {
		return err
	}
	q := url.Values{}
	q.Set("access_token", token)
	q.Set("force", "1")
	endpoint := fmt.Sprintf("%s/api/v1/space/%s/%s?%s", w.wispSMHAccessDomain, url.PathEscape(w.wispSMHLibraryID), url.PathEscape(spaceID), q.Encode())
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, endpoint, nil)
	if err != nil {
		return err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNoContent || resp.StatusCode == http.StatusNotFound {
		return nil
	}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
	return fmt.Errorf("SMH delete space http %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
}

func (w *AgentSidecarWorker) runOuterCommand(ctx context.Context, host RuntimeHost, sb RuntimeHostTarget, runtime ACPSessionRuntime, command string, env map[string]string, onStdout func(string) error, onStderr func(string) error) (CommandResult, error) {
	if runtime.isWispOuterRuntime() {
		command = runtime.wrapWispShellCommand(command, env)
		env = nil
	}
	return host.RunCommand(ctx, sb, command, env, onStdout, onStderr)
}

func (w *AgentSidecarWorker) runOuterControlCommand(ctx context.Context, host RuntimeHost, sb RuntimeHostTarget, runtime ACPSessionRuntime, command string, env map[string]string) (CommandResult, error) {
	if runtime.isWispOuterRuntime() {
		command = runtime.wrapWispShellCommandBuffered(command, env)
		env = nil
	}
	return host.RunCommand(ctx, sb, command, env, nil, nil)
}

func (w *AgentSidecarWorker) stopWispOuterRuntime(ctx context.Context, host RuntimeHost, sb RuntimeHostTarget, runtime ACPSessionRuntime) error {
	if !runtime.isWispOuterRuntime() || strings.TrimSpace(runtime.WispName) == "" {
		return nil
	}
	result, err := w.runWispStopCommandWithRetry(ctx, host, sb, runtime, "outer", runtime.WispName, wispOuterStopCommand(runtime), workerJob{JobID: "wisp_stop", ResponseID: runtime.RuntimeID})
	if err != nil {
		return fmt.Errorf("wisp stop failed runtime_id=%s outer_sandbox_id=%s wisp_name=%s: %s", runtime.RuntimeID, sb.ID, runtime.WispName, wispCommandFailureDetail(err, result))
	}
	if result.ExitCode != 0 || !strings.Contains(result.Stdout, "CLOUDAGENT_WISP_STOPPED") {
		return fmt.Errorf("wisp stop failed runtime_id=%s outer_sandbox_id=%s wisp_name=%s: %s", runtime.RuntimeID, sb.ID, runtime.WispName, wispCommandFailureDetail(nil, result))
	}
	return nil
}

func (w *AgentSidecarWorker) stopWispWorkspaceRuntime(ctx context.Context, host RuntimeHost, sb RuntimeHostTarget, runtime ACPSessionRuntime) error {
	if !runtime.isWispOuterRuntime() || strings.TrimSpace(runtime.WorkspaceWispName) == "" {
		return nil
	}
	workspaceRuntime := runtime
	workspaceRuntime.WispName = runtime.WorkspaceWispName
	workspaceRuntime.WispClientPath = runtime.WorkspaceWispClient
	if workspaceRuntime.WispClientPath != "" {
		workspaceRuntime.WispInstallDir = path.Dir(path.Dir(workspaceRuntime.WispClientPath))
	}
	result, err := w.runWispStopCommandWithRetry(ctx, host, sb, runtime, "inner", runtime.WorkspaceWispName, wispWorkspaceStopCommand(workspaceRuntime), workerJob{JobID: "wisp_workspace_stop", ResponseID: runtime.RuntimeID})
	if err != nil {
		return fmt.Errorf("workspace wisp stop failed runtime_id=%s inner_sandbox_id=%s wisp_name=%s: %s", runtime.RuntimeID, sb.ID, runtime.WorkspaceWispName, wispCommandFailureDetail(err, result))
	}
	if result.ExitCode != 0 || !strings.Contains(result.Stdout, "CLOUDAGENT_WISP_STOPPED") {
		return fmt.Errorf("workspace wisp stop failed runtime_id=%s inner_sandbox_id=%s wisp_name=%s: %s", runtime.RuntimeID, sb.ID, runtime.WorkspaceWispName, wispCommandFailureDetail(nil, result))
	}
	return nil
}

func (w *AgentSidecarWorker) runWispStopCommandWithRetry(ctx context.Context, host RuntimeHost, sb RuntimeHostTarget, runtime ACPSessionRuntime, target string, wispName string, command string, job workerJob) (CommandResult, error) {
	var result CommandResult
	var err error
	for attempt := 1; attempt <= 3; attempt++ {
		result, err = host.RunCommand(ctx, sb, command, nil, nil, func(text string) error {
			logRemoteStderr(time.Now(), job, text)
			return nil
		})
		if err == nil {
			return result, nil
		}
		if !isRuntimeHostRunCommandNotFoundError(err) || attempt == 3 {
			return result, err
		}
		probe, probeErr := runtimeHostProbeSandbox(ctx, host, sb.ID)
		fmt.Fprintf(os.Stderr, "timeline source=go event=acp_runtime_wisp_stop_retry target=%s runtime_id=%s workspace_runtime_id=%s sandbox_id=%s wisp_name=%s attempt=%d probe_exists=%t probe_status=%s probe_error=%s error=%s\n",
			quoteTimelineField(target),
			quoteTimelineField(runtime.RuntimeID),
			quoteTimelineField(runtime.WorkspaceRuntimeID),
			quoteTimelineField(sb.ID),
			quoteTimelineField(wispName),
			attempt,
			probe.Exists,
			quoteTimelineField(probe.Status),
			quoteTimelineField(errorString(probeErr)),
			quoteTimelineField(err.Error()),
		)
		if probeErr != nil || !probe.Exists {
			return result, err
		}
		select {
		case <-ctx.Done():
			return result, ctx.Err()
		case <-time.After(time.Duration(attempt) * time.Second):
		}
	}
	return result, err
}

func isRuntimeHostRunCommandNotFoundError(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "op=run_command") &&
		(strings.Contains(message, "ags http 404") ||
			(strings.Contains(message, "http 404") && strings.Contains(message, "requested resource does not exist")))
}

func errorString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func wispOuterStopCommand(runtime ACPSessionRuntime) string {
	return wispStopCommand(runtime)
}

func wispWorkspaceStopCommand(runtime ACPSessionRuntime) string {
	return wispStopCommand(runtime)
}

func wispStopCommand(runtime ACPSessionRuntime) string {
	clientPath := runtime.WispClientPath
	if strings.TrimSpace(clientPath) == "" && runtime.WispInstallDir != "" {
		clientPath = path.Join(runtime.WispInstallDir, "bin", "wispclient")
	}
	hostLog := ""
	if strings.TrimSpace(runtime.WispInstallDir) != "" {
		hostLog = path.Join(path.Dir(runtime.WispInstallDir), "daemon.log")
	} else if strings.TrimSpace(runtime.RemoteBinary) != "" {
		hostLog = path.Join(path.Dir(runtime.RemoteBinary), "wispclient-daemon.log")
	}
	return "set -euo pipefail\n" +
		"client=" + shellQuote(clientPath) + "\n" +
		"name=" + shellQuote(runtime.WispName) + "\n" +
		"server=" + shellQuote(wispAdminAddr(runtime)) + "\n" +
		"log=" + shellQuote(hostLog) + "\n" +
		"redact_line() {\n" +
		"  sed -E \"s/(SMH_ACCESS_TOKEN=)[^[:space:]]+/\\1<redacted>/Ig; s/(access[_-]?token=)[^[:space:]]+/\\1<redacted>/Ig; s/(api[_-]?key=)[^[:space:]]+/\\1<redacted>/Ig; s/(library[_-]?secret=)[^[:space:]]+/\\1<redacted>/Ig; s/(secret[_-]?key=)[^[:space:]]+/\\1<redacted>/Ig\"\n" +
		"}\n" +
		"tail_safe_log() {\n" +
		"  grep -aE 'timeline source=hermes_sidecar|runtime_host_event|workspace_runtime_shutdown|inner_shutdown|filesystem_write_committed|restore_checkpoint|request (start|ok|fail) action=(admin|wisp)\\.stop|runtime.stop|runtime.stop_state|stop step=|stop_container|runtime.create_stop_checkpoint|runtime.promote_stop_checkpoint|create_checkpoint source_stat|create_checkpoint clone_start|create_checkpoint clone_done|active_fsync_(start|done)|stop_checkpoint_promote|reset_runtime|sync_checkpoint_source|Checkpoint created|checkpoint_manifest_durable|writeback_cut_barrier|meta_barrier|SUMMARY stop|litestream .*barrier|litestream checkpoint|checkpoint cut|sqlite_litestream_trace|smh_http |ERROR|WARN|error=|event=' \"$log\" 2>/dev/null | tail -n 340 | redact_line || true\n" +
		"}\n" +
		"tail_juicefs_log() {\n" +
		"  local assert_log=/tmp/juicefs-assertmount.log\n" +
		"  if [[ -f \"$assert_log\" ]]; then\n" +
		"    grep -aE 'checkpoint cut|litestream .*barrier|litestream checkpoint|sqlite_litestream_trace|smh_http |cos_http |writeback barrier|file barrier|ERROR|WARN|error' \"$assert_log\" 2>/dev/null | tail -n 260 | redact_line || true\n" +
		"  fi\n" +
		"}\n" +
		"if [[ -z \"$client\" || ! -x \"$client\" ]]; then\n" +
		"  client=\"$(ls -1 /tmp/cloudagent-wisp/*/install/bin/wispclient 2>/dev/null | head -1 || true)\"\n" +
		"fi\n" +
		"if [[ -z \"$client\" || ! -x \"$client\" ]]; then echo \"wispclient missing\" >&2; exit 127; fi\n" +
		"jfs=\"$(dirname \"$client\")/juicefs-smount\"\n" +
		"echo \"wisp stop_preflight diag client=$client jfs=$jfs name=$name server=$server mnt_ns=$(readlink /proc/self/ns/mnt 2>/dev/null || true)\" >&2\n" +
		"echo \"wisp stop_preflight diag statfs /mnt/cloudagent-wisp:\" >&2\n" +
		"stat -f -c 'type=%T id=%i namelen=%l bsize=%s' /mnt/cloudagent-wisp 2>&1 | redact_line >&2 || true\n" +
		"echo \"wisp stop_preflight diag findmnt:\" >&2\n" +
		"findmnt -T /mnt/cloudagent-wisp -o TARGET,SOURCE,FSTYPE,OPTIONS 2>&1 | redact_line >&2 || true\n" +
		"echo \"wisp stop_preflight diag mount:\" >&2\n" +
		"mount | grep -aE 'cloudagent-wisp|juicefs|/mnt/cloudagent-wisp' | redact_line >&2 || true\n" +
		"if [[ -x \"$jfs\" ]]; then\n" +
		"  echo \"wisp stop_preflight diag jfs-version:\" >&2\n" +
		"  \"$jfs\" version 2>&1 | head -20 | redact_line >&2 || true\n" +
		"else\n" +
		"  echo \"wisp stop_preflight diag jfs-version: missing path=$jfs\" >&2\n" +
		"fi\n" +
		"stop_stdout=\"$(mktemp)\"\n" +
		"stop_stderr=\"$(mktemp)\"\n" +
		"trap 'rm -f \"$stop_stdout\" \"$stop_stderr\"' EXIT\n" +
		"echo \"wisp stop_delegate_start name=$name\" >&2\n" +
		"echo \"wisp umount_start name=$name\" >&2\n" +
		"set +e\n" +
		"\"$client\" -server \"$server\" stop \"$name\" >\"$stop_stdout\" 2>\"$stop_stderr\"\n" +
		"code=$?\n" +
		"set -e\n" +
		"if [[ \"$code\" != 0 ]]; then\n" +
		"  echo \"wispclient stop failed exit=$code\" >&2\n" +
		"  echo \"wispclient stop stderr:\" >&2\n" +
		"  tail -n 120 \"$stop_stderr\" | redact_line >&2 || true\n" +
		"  echo \"wispclient stop stdout:\" >&2\n" +
		"  tail -n 80 \"$stop_stdout\" | redact_line >&2 || true\n" +
		"  echo \"wisp stop diagnostics: mount\" >&2\n" +
		"  mount | grep -aE 'cloudagent-wisp|juicefs|/mnt/cloudagent-wisp' | redact_line >&2 || true\n" +
		"  echo \"wisp stop diagnostics: df\" >&2\n" +
		"  df -h /mnt/cloudagent-wisp /tmp 2>&1 | redact_line >&2 || true\n" +
		"  echo \"wisp stop diagnostics: process\" >&2\n" +
		"  ps -ef | grep -aE 'wisp|juicefs|smount' | grep -av grep | redact_line >&2 || true\n" +
		"  if [[ -n \"$log\" && -f \"$log\" ]]; then tail_safe_log >&2 || true; fi\n" +
		"  tail_juicefs_log >&2 || true\n" +
		"  exit \"$code\"\n" +
		"fi\n" +
		"cat \"$stop_stdout\" || true\n" +
		"if [[ -n \"$log\" && -f \"$log\" ]]; then\n" +
		"  echo \"wisp stop_daemon_log:\" >&2\n" +
		"  tail_safe_log >&2 || true\n" +
		"fi\n" +
		"tail_juicefs_log >&2 || true\n" +
		"echo \"wisp umount_done name=$name\" >&2\n" +
		"echo CLOUDAGENT_WISP_STOPPED\n"
}

func (runtime ACPSessionRuntime) wrapWispShellCommand(command string, env map[string]string) string {
	return runtime.wrapWispShellCommandWithStream(command, env, true)
}

func (runtime ACPSessionRuntime) wrapWispShellCommandBuffered(command string, env map[string]string) string {
	return runtime.wrapWispShellCommandWithStream(command, env, false)
}

func (runtime ACPSessionRuntime) wrapWispShellCommandWithStream(command string, env map[string]string, stream bool) string {
	clientPath := runtime.WispClientPath
	if strings.TrimSpace(clientPath) == "" && runtime.WispInstallDir != "" {
		clientPath = path.Join(runtime.WispInstallDir, "bin", "wispclient")
	}
	if strings.TrimSpace(clientPath) == "" {
		clientPath = "/tmp/cloudagent-wisp/*/install/bin/wispclient"
	}
	inner := shellEnvPrefix(env) + command
	args := shellQuote(clientPath) +
		" -server " + shellQuote(wispAdminAddr(runtime)) +
		" exec "
	if stream {
		args += "--stream "
	}
	return args + shellQuote(runtime.WispName) +
		" -- /bin/sh -lc " + shellQuote(inner)
}

func shellEnvPrefix(env map[string]string) string {
	if len(env) == 0 {
		return ""
	}
	keys := make([]string, 0, len(env))
	for key := range env {
		if isShellEnvName(key) {
			keys = append(keys, key)
		}
	}
	if len(keys) == 0 {
		return ""
	}
	sortStrings(keys)
	var b strings.Builder
	for _, key := range keys {
		b.WriteString("export ")
		b.WriteString(key)
		b.WriteString("=")
		b.WriteString(shellQuote(env[key]))
		b.WriteString("; ")
	}
	return b.String()
}

func isShellEnvName(value string) bool {
	if value == "" {
		return false
	}
	for i, r := range value {
		if r == '_' || r >= 'A' && r <= 'Z' || r >= 'a' && r <= 'z' || i > 0 && r >= '0' && r <= '9' {
			continue
		}
		return false
	}
	return true
}

func sortStrings(values []string) {
	for i := 1; i < len(values); i++ {
		for j := i; j > 0 && values[j] < values[j-1]; j-- {
			values[j], values[j-1] = values[j-1], values[j]
		}
	}
}

func wispNameFromRuntime(sessionID string) string {
	name := strings.TrimSpace(sessionID)
	if name == "" {
		name = "session-" + randomHex(6)
	}
	var b strings.Builder
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == '-' || r == '_' || r == '.':
			b.WriteRune(r)
		default:
			b.WriteByte('-')
		}
	}
	out := strings.Trim(b.String(), "-_.")
	if out == "" {
		out = randomHex(6)
	}
	if len(out) > 48 {
		out = out[:48]
	}
	return "agent-" + out
}

func workspaceWispNameFromSession(sessionID string) string {
	trimmed := strings.TrimSpace(sessionID)
	if trimmed == "" {
		trimmed = "session-" + randomHex(6)
	}
	return fmt.Sprintf("workspace-%08x", crc32.ChecksumIEEE([]byte(trimmed)))
}

func workspaceWispNameForRuntime(sessionID string, _ ACPSessionRuntime) string {
	return workspaceWispNameFromSession(sessionID)
}

func workspaceWispJFSPrefix(base, workspaceID string) string {
	normalizedBase := strings.Trim(strings.TrimSpace(base), "/")
	if normalizedBase == "" {
		normalizedBase = "cloudagent-agent"
	}
	if strings.Contains(normalizedBase, "/workspace/") {
		return normalizedBase
	}
	workspaceSegment := sanitizeWispPrefixSegment(workspaceID)
	if workspaceSegment == "" {
		workspaceSegment = "default"
	}
	return normalizedBase + "/workspace/" + workspaceSegment
}

func sanitizeWispPrefixSegment(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	var b strings.Builder
	prevDash := false
	for _, r := range value {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
			prevDash = false
		default:
			if !prevDash {
				b.WriteByte('-')
				prevDash = true
			}
		}
	}
	return strings.Trim(b.String(), "-")
}

func wispOuterPrepareScript() string {
	return `
	set -euo pipefail
	ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
	now_ms() { date +%s%3N; }
	step() { echo "TIMELINE $(ts) $*" >&2; }
	step_start() {
	  eval "__step_${1}_start=$(now_ms)"
	  step "$1_start" "${@:2}"
	}
	step_done() {
	  local name="$1"
	  local started_var="__step_${name}_start"
	  local started="${!started_var:-}"
	  local duration_arg=""
	  if [[ -n "$started" ]]; then
	    duration_arg="duration_ms=$(( $(now_ms) - started ))"
	  fi
	  step "${name}_done" "$duration_arg" "${@:2}"
	}
	redact_line() {
	  sed -E 's/(access_token=)[^&[:space:]"]+/\1<redacted>/g; s/(library_secret=)[^&[:space:]"]+/\1<redacted>/g; s/(SMH_ACCESS_TOKEN=)[^[:space:]"]+/\1<redacted>/g'
	}
	daemon_log_line=1
	flush_daemon_log() {
	  local label="$1"
	  if [[ ! -f "$log" ]]; then
	    return 0
	  fi
	  local total
	  total="$(wc -l <"$log" | tr -d ' ')"
	  if [[ "$total" -ge "$daemon_log_line" ]]; then
		    sed -n "${daemon_log_line},${total}p" "$log" \
		      | grep -aE 'request (start|ok|fail) action=(admin|wisp)\\.(create|backend_bind|start|stop)|bound_config|bootstrap-global|bootstrap step=|ensure_cos_root (skip|assertmount|wait_mount|usable_check|mounted|already_mounted)|ensure_workspace_ready|pre_start_recovery|active_image_valid|restore_checkpoint|filesystem_write_committed|Restored active image|ensure_active_image|start step=|start_container step=|runtime.stop|runtime.stop_state|stop step=|stop_container|runtime.create_stop_checkpoint|runtime.promote_stop_checkpoint|create_checkpoint source_stat|create_checkpoint clone_start|create_checkpoint clone_done|active_fsync_(start|done)|stop_checkpoint_promote|reset_runtime|sync_checkpoint_source|checkpoint retention|Checkpoint created|checkpoint_manifest_durable|writeback_cut_barrier|meta_barrier|mount_runtime|runtime.start_container|runtime.start.crun_run|crun container|SUMMARY (bootstrap|bootstrap-global|ensure_workspace_ready|ensure_active_image|mount_runtime|start|stop)|HUMAN (bootstrap|start|stop)|assertmount_detail |mount_target_timing |litestream .*barrier|litestream checkpoint|checkpoint cut|file barrier|writeback barrier|smh_http |cos_http |sqlite_litestream_trace |s3_litestream_trace ' \
	      | redact_line \
	      | sed "s/^/DAEMON_TRACE label=$label /" >&2 || true
	    daemon_log_line=$((total + 1))
	  fi
	}

	follow_daemon_log_until_stopped() {
	  local label="$1"
	  while true; do
	    flush_daemon_log "$label"
	    sleep 2
	  done
	}

	start_daemon_log_follower() {
	  local label="$1"
	  follow_daemon_log_until_stopped "$label" >/dev/null &
	  echo "$!"
	}

	stop_daemon_log_follower() {
	  local pid="${1:-}"
	  local label="$2"
	  if [[ -n "$pid" ]]; then
	    kill "$pid" >/dev/null 2>&1 || true
	    wait "$pid" >/dev/null 2>&1 || true
	  fi
	  flush_daemon_log "$label"
	}
	
	install="$WISP_INSTALL_DIR"
	work="$(dirname "$install")"
	log="$work/daemon.log"
	config_file="$work/config/config.jsonnet"
	jfs_root="/mnt/cloudagent-wisp"
	admin_listen="${WISP_ADMIN_LISTEN_ADDR:-127.0.0.1:8520}"
	admin_server="$admin_listen"
	case "$admin_server" in
	  http://*|https://*) ;;
	  *) admin_server="http://$admin_server" ;;
	esac
	pkg_format="${WISP_PACKAGE_FORMAT:-}"
	case "$WISP_PACKAGE_URL" in
	  *.erofs) pkg_format="${pkg_format:-erofs}" ;;
	  *) pkg_format="${pkg_format:-tar.gz}" ;;
	esac
case "$pkg_format" in
  erofs|erofs-extract) pkg="$work/wisp-package.erofs" ;;
  tar.gz|tgz) pkg="$work/wisp-package.tar.gz" ;;
  *) echo "unsupported WISP_PACKAGE_FORMAT: $pkg_format" >&2; exit 2 ;;
esac
	
	mkdir -p "$install"
	if [[ ! -x "$install/bin/wispclient" ]]; then
	  step_start wisp_package_download url="$WISP_PACKAGE_URL"
	  curl -fsSL --retry 3 --retry-delay 1 --connect-timeout 10 "$WISP_PACKAGE_URL" -o "$pkg"
	  step_done wisp_package_download bytes="$(wc -c <"$pkg" | tr -d ' ')"
  if [[ "$pkg_format" == "erofs" ]]; then
    rmdir "$install" 2>/dev/null || true
    mkdir -p "$install"
    step_start wisp_package_mount format=erofs
    sudo -n mount -t erofs -o loop,ro,exec "$pkg" "$install"
    step_done wisp_package_mount format=erofs
  elif [[ "$pkg_format" == "erofs-extract" ]]; then
    rmdir "$install" 2>/dev/null || true
    mkdir -p "$install"
    step_start wisp_package_extract format=erofs
    fsck.erofs --extract="$install" --force --overwrite "$pkg" >/dev/null
    step_done wisp_package_extract format=erofs
  else
    step_start wisp_package_extract format=tar.gz
    tar -xzf "$pkg" -C "$install" --strip-components=1
	    step_done wisp_package_extract format=tar.gz
	    step_start wisp_package_install format="$pkg_format"
	    "$install/scripts/install.sh" "$install" >/dev/null
	    step_done wisp_package_install format="$pkg_format"
	  fi
	else
	  step wisp_package_cache_hit install="$install"
	fi
	
	pkg_arch="${WISP_PACKAGE_ARCH:-}"
	if [[ -z "$pkg_arch" ]]; then
	  case "$(uname -m)" in
	    x86_64|amd64) pkg_arch=amd64 ;;
	    aarch64|arm64) pkg_arch=arm64 ;;
	    *) pkg_arch="$(uname -m)" ;;
	  esac
	fi
	if [[ ! -x "$install/assets/bin/crun/crun-$pkg_arch" && -x "$install/assets/bin/crun/crun-amd64" ]]; then
	  pkg_arch=amd64
	fi
	if [[ "${WISP_USE_HOST_CRUN:-0}" == "1" ]]; then
	  crun_binary="$(command -v crun || true)"
	  if [[ -z "$crun_binary" ]]; then
	    echo "WISP_USE_HOST_CRUN=1 but host crun is not installed" >&2
	    exit 2
	  fi
	  crun_binary_path="$crun_binary"
	else
	  crun_binary="$install/assets/bin/crun/crun-$pkg_arch"
	  if [[ ! -e "$crun_binary" ]]; then
	    echo "packaged crun missing diagnostics begin" >&2
	    echo "package_url=${WISP_PACKAGE_URL:-}" >&2
	    echo "package_format=$pkg_format install=$install pkg=$pkg" >&2
	    echo "expected_package_sha256=${WISP_PACKAGE_SHA256:-}" >&2
	    (sha256sum "$pkg" 2>/dev/null || shasum -a 256 "$pkg" 2>/dev/null || true) >&2
	    mount | grep -F " $install " >&2 || true
	    ls -ld "$install" "$install/assets" "$install/assets/bin" "$install/assets/bin/crun" >&2 || true
	    find "$install" -maxdepth 4 -mindepth 1 2>/dev/null | sort | sed -n '1,80p' >&2 || true
	    echo "packaged crun missing diagnostics end" >&2
	    echo "missing packaged crun for arch=$pkg_arch path=$crun_binary" >&2
	    exit 2
	  fi
	  if [[ ! -x "$crun_binary" ]]; then
	    ls -ld "$install" "$install/assets" "$install/assets/bin" "$install/assets/bin/crun" "$crun_binary" >&2 || true
	    mount | grep -F " $install " >&2 || true
	    echo "packaged crun is not executable for arch=$pkg_arch path=$crun_binary; check permissions or noexec mount options" >&2
	    exit 2
	  fi
	  crun_binary_path="/var/lib/wisp/shared/tools/crun"
	fi
	blank_root_upper_sparse="$install/assets/rootfs/blank-ext4/root-upper-default.sparse"
		if [[ ! -f "$blank_root_upper_sparse" ]]; then
		  blank_root_upper_sparse=""
		fi

		step_start wisp_host_preflight
		sudo -n chmod 666 /dev/fuse || true
		if [[ "${WISP_USE_HOST_E2FSPROGS:-0}" != "1" ]]; then
		  export PATH="$install/assets/bin/e2fsprogs/bin:$PATH"
		  export LD_LIBRARY_PATH="$install/assets/bin/e2fsprogs/lib:${LD_LIBRARY_PATH:-}"
		else
		  export LD_LIBRARY_PATH="${LD_LIBRARY_PATH:-}"
		fi
		step wisp_host_preflight_detail use_host_e2fsprogs="${WISP_USE_HOST_E2FSPROGS:-0}" mke2fs_path="$(command -v mke2fs || true)" e2fsck_path="$(command -v e2fsck || true)" root_upper_size="$ROOT_UPPER_SIZE" blank_root_upper_sparse="$blank_root_upper_sparse"
		if [[ ! -e /sys/fs/cgroup/cgroup.controllers ]]; then
		  sudo -n mount -t cgroup2 cgroup2 /sys/fs/cgroup || true
		fi
		step_done wisp_host_preflight

		step_start wisp_config_write
	mkdir -p "$(dirname "$config_file")"
	cat >"$config_file" <<-EOF
local projectRoot = "$install";
{
  WISP_NAME: "default",
  REMOTE_BACKEND: "cos",
  COS_ENABLED: false,
  COS_WORKSPACE: "default",
  JFS_ROOT: "$jfs_root",
  SMH_TOKEN_TTL_SECONDS: 3600,
  JFS_LOCAL_ROOT: "$work/jfs-local",
  JFS_PREFIX: "host",
  JFS_BIN: projectRoot + "/bin/juicefs-smount",
  JFS_BUILD: "0",
  JFS_SMOUNT_SCRIPT: projectRoot + "/juicefs/hack/smount.sh",
  JFS_SFORMAT_SCRIPT: projectRoot + "/juicefs/hack/sformat.sh",
  LOWER_SYSTEM_BASE: projectRoot + "/assets/rootfs/rootfs",
  BASE_ROOTFS_DIR: projectRoot + "/assets/rootfs/rootfs",
  BASE_ROOTFS_IMG: "",
  CRUN_BINARY: "$crun_binary",
  CRUN_BINARY_PATH: "$crun_binary_path",
  WISPENV_BINARY: projectRoot + "/bin/wispenv",
  WISP_FS_AGENT_BINARY: projectRoot + "/bin/wisp-fs-agent",
  TINI_BINARY: projectRoot + "/assets/bin/tini/tini",
  WISP_USER: "root",
  WISP_UID: 0,
  WISP_GID: 0,
  ROOT_UPPER_SIZE: "$ROOT_UPPER_SIZE",
  BLANK_ROOT_UPPER_SPARSE: "$blank_root_upper_sparse",
  ADMIN_LISTEN_ADDR: "$admin_listen",
	}
	EOF
	step_done wisp_config_write
	
	export WISP_CONFIG="$config_file"
export JFS_ROOT="$jfs_root"
export JFS_LOCAL_ROOT="$work/jfs-local"
export JFS_BIN="$install/bin/juicefs-smount"
export JFS_BUILD=0
export JFS_SMOUNT_SCRIPT="$install/juicefs/hack/smount.sh"
export JFS_SFORMAT_SCRIPT="$install/juicefs/hack/sformat.sh"
export BASE_ROOTFS_DIR="$install/assets/rootfs/rootfs"
export BASE_ROOTFS_IMG=""
export CRUN_BINARY="$crun_binary"
export CRUN_BINARY_PATH="$crun_binary_path"
export WISPENV_BINARY="$install/bin/wispenv"
export WISP_FS_AGENT_BINARY="$install/bin/wisp-fs-agent"
export TINI_BINARY="$install/assets/bin/tini/tini"
export BLANK_ROOT_UPPER_SPARSE="$blank_root_upper_sparse"
export ADMIN_LISTEN_ADDR="$admin_listen"
export JFS_LITESTREAM_TRACE="${JFS_LITESTREAM_TRACE:-}"

	if "$install/bin/wispclient" -server "$admin_server" ls >/dev/null 2>&1; then
	  step wisp_daemon_already_ready
	else
	  step_start wisp_daemon_spawn
	  nohup sudo -n env \
  WISP_CONFIG="$WISP_CONFIG" \
  JFS_ROOT="$JFS_ROOT" \
  JFS_LOCAL_ROOT="$JFS_LOCAL_ROOT" \
  JFS_BIN="$JFS_BIN" \
  JFS_BUILD="$JFS_BUILD" \
  JFS_SMOUNT_SCRIPT="$JFS_SMOUNT_SCRIPT" \
  JFS_SFORMAT_SCRIPT="$JFS_SFORMAT_SCRIPT" \
  BASE_ROOTFS_DIR="$BASE_ROOTFS_DIR" \
  BASE_ROOTFS_IMG="$BASE_ROOTFS_IMG" \
  CRUN_BINARY="$CRUN_BINARY" \
  CRUN_BINARY_PATH="$CRUN_BINARY_PATH" \
  WISPENV_BINARY="$WISPENV_BINARY" \
  WISP_FS_AGENT_BINARY="$WISP_FS_AGENT_BINARY" \
  TINI_BINARY="$TINI_BINARY" \
  BLANK_ROOT_UPPER_SPARSE="$BLANK_ROOT_UPPER_SPARSE" \
  WISP_USER=root \
  WISP_UID=0 \
  WISP_GID=0 \
  PATH="$PATH" \
  LD_LIBRARY_PATH="$LD_LIBRARY_PATH" \
  WISP_USE_HOST_E2FSPROGS="${WISP_USE_HOST_E2FSPROGS:-0}" \
  ROOT_UPPER_SIZE="$ROOT_UPPER_SIZE" \
  ADMIN_LISTEN_ADDR="$ADMIN_LISTEN_ADDR" \
  JFS_LITESTREAM_TRACE="$JFS_LITESTREAM_TRACE" \
  JFS_MOUNT_WRITEBACK="$JFS_MOUNT_WRITEBACK" \
  JFS_MOUNT_UPLOAD_DELAY="$JFS_MOUNT_UPLOAD_DELAY" \
  JFS_MOUNT_MAX_UPLOADS="$JFS_MOUNT_MAX_UPLOADS" \
  JFS_MOUNT_CACHE_SIZE="$JFS_MOUNT_CACHE_SIZE" \
  JFS_MOUNT_MIN_FREE_BYTES="$JFS_MOUNT_MIN_FREE_BYTES" \
	  JFS_WRITEBACK_BARRIER_POLL_INTERVAL="$JFS_WRITEBACK_BARRIER_POLL_INTERVAL" \
  "$install/bin/wisp" daemon run --config "$WISP_CONFIG" >>"$log" 2>&1 </dev/null &
	  step_done wisp_daemon_spawn
	fi
	
	step_start wisp_daemon_ready_wait
	for i in $(seq 1 30); do
	  if "$install/bin/wispclient" -server "$admin_server" ls >/dev/null 2>&1; then
	    break
	  fi
	  sleep 0.5
	done
	"$install/bin/wispclient" -server "$admin_server" ls >/dev/null || { echo "wisp daemon did not become ready" >&2; cat "$log" >&2 || true; exit 1; }
	step_done wisp_daemon_ready_wait
	flush_daemon_log daemon_ready
	
	step_start wisp_bootstrap
	"$install/bin/wispclient" -server "$admin_server" bootstrap || { echo "daemon log after bootstrap failure:" >&2; cat "$log" >&2 || true; exit 1; }
	step_done wisp_bootstrap
	flush_daemon_log bootstrap

	if [[ "${WISP_HOST_ONLY:-}" == "1" ]]; then
	  echo "WISP_HOST_DAEMON_READY install=$install"
	  echo "WISP_HOST_READY install=$install"
	  exit 0
	fi

	step_start wisp_bind_backend
	"$install/bin/wispclient" -server "$admin_server" bind-backend \
	  -remote-backend smh \
	  -smh-library-id "$SMH_LIBRARY_ID" \
	  -smh-access-domain "$SMH_ACCESS_DOMAIN" \
	  -smh-space-id "$SMH_SPACE_ID" \
	  -smh-access-token "$SMH_ACCESS_TOKEN" \
	  -jfs-prefix "$JFS_PREFIX" \
	  "$WISP_NAME" || { echo "daemon log after backend bind failure:" >&2; cat "$log" >&2 || true; exit 1; }
	step_done wisp_bind_backend
	flush_daemon_log bind_backend
	
	step_start wisp_create
	"$install/bin/wispclient" -server "$admin_server" create "$WISP_NAME" || { echo "daemon log after create failure:" >&2; cat "$log" >&2 || true; exit 1; }
	step_done wisp_create
	flush_daemon_log create
	
	step_start wisp_start
	start_log_follower_pid="$(start_daemon_log_follower start_live)"
	start_rc=0
	"$install/bin/wispclient" -server "$admin_server" start "$WISP_NAME" || start_rc=$?
	stop_daemon_log_follower "$start_log_follower_pid" start
	if [[ "$start_rc" -ne 0 ]]; then
	  echo "daemon log after start failure:" >&2
	  cat "$log" >&2 || true
	  exit "$start_rc"
	fi
	step_done wisp_start
	flush_daemon_log start
	echo "WISP_OUTER_READY name=$WISP_NAME space=$SMH_SPACE_ID"
	`
}

func redactWispOuterSecrets(text string) string {
	return redactCommandOutput(text)
}

func wispCommandFailureDetail(err error, result CommandResult) string {
	parts := []string{
		fmt.Sprintf("exit=%d", result.ExitCode),
		fmt.Sprintf("exited=%t", result.Exited),
		fmt.Sprintf("stdout_bytes=%d", len(result.Stdout)),
		fmt.Sprintf("stderr_bytes=%d", len(result.Stderr)),
	}
	if strings.TrimSpace(result.Status) != "" {
		parts = append(parts, "status="+fmt.Sprintf("%q", result.Status))
	}
	if err != nil {
		parts = append(parts, "error="+fmt.Sprintf("%q", redactCommandOutput(redactWispOuterSecrets(err.Error()))))
	}
	if stderrHead := commandOutputHead(result.Stderr, 1500); stderrHead != "" && len(strings.TrimSpace(result.Stderr)) > 3000 {
		parts = append(parts, "stderr_head="+fmt.Sprintf("%q", redactCommandOutput(redactWispOuterSecrets(stderrHead))))
	}
	if stderrTail := commandOutputTail(result.Stderr, 3000); stderrTail != "" {
		parts = append(parts, "stderr_tail="+fmt.Sprintf("%q", redactCommandOutput(redactWispOuterSecrets(stderrTail))))
	}
	if stdout := commandOutputTail(result.Stdout, 1500); stdout != "" {
		parts = append(parts, "stdout_tail="+fmt.Sprintf("%q", redactCommandOutput(redactWispOuterSecrets(stdout))))
	}
	return strings.Join(parts, " ")
}

func commandOutputHead(value string, limit int) string {
	value = strings.TrimSpace(value)
	if value == "" || limit <= 0 {
		return ""
	}
	if len(value) <= limit {
		return value
	}
	return value[:limit] + "\n...[truncated]"
}

func base64DecodeToFileCommand(targetPath string, content []byte) string {
	return "mkdir -p " + shellQuote(path.Dir(targetPath)) +
		" && base64 -d > " + shellQuote(targetPath) +
		" <<'CLOUDAGENT_FILE_B64'\n" +
		base64.StdEncoding.EncodeToString(content) +
		"\nCLOUDAGENT_FILE_B64"
}

func (w *AgentSidecarWorker) stageSidecarBinaryIntoWisp(ctx context.Context, host RuntimeHost, sb RuntimeHostTarget, runtime ACPSessionRuntime, artifact agentSidecarArtifact) error {
	command := "set -euo pipefail\n" +
		"client=" + shellQuote(runtime.WispClientPath) + "\n" +
		"name=" + shellQuote(runtime.WispName) + "\n" +
		"target=" + shellQuote(runtime.RemoteBinary) + "\n" +
		"\"$client\" -server " + shellQuote(wispAdminAddr(runtime)) +
		" fetch \"$name\" " + shellQuote(artifact.URL) + " \"$target\" --mode 0755 --max-bytes 52428800 --allow-private" + fetchSHAArg(artifact.SHA256) + " >&2\n" +
		"\"$client\" -server " + shellQuote(wispAdminAddr(runtime)) + " exec \"$name\" -- /bin/sh -lc 'wc -c \"$1\" >&2; if command -v sha256sum >/dev/null 2>&1; then sha256sum \"$1\" >&2; fi' sh \"$target\" >/dev/null\n" +
		"\"$client\" -server " + shellQuote(wispAdminAddr(runtime)) + " exec \"$name\" -- /bin/sh -lc 'set +e; \"$1\" client --addr http://127.0.0.1:1 health >/tmp/cloudagent-sidecar-preflight.log 2>&1; code=$?; cat /tmp/cloudagent-sidecar-preflight.log >&2 || true; if [ \"$code\" = 139 ]; then exit 139; fi; exit 0' sh \"$target\" >/dev/null\n" +
		"echo CLOUDAGENT_WISP_SIDECAR_STAGED\n"
	result, err := host.RunCommand(ctx, sb, command, nil, nil, func(text string) error {
		logRemoteStderr(time.Now(), workerJob{JobID: "wisp_sidecar_stage", ResponseID: runtime.RuntimeID}, text)
		return nil
	})
	if err != nil {
		return fmt.Errorf("stage sidecar into wisp outer runtime session_runtime=%s outer_sandbox_id=%s %s: %w", runtime.RuntimeID, sb.ID, wispCommandFailureDetail(err, result), err)
	}
	if result.ExitCode != 0 || !strings.Contains(result.Stdout, "CLOUDAGENT_WISP_SIDECAR_STAGED") {
		return fmt.Errorf("stage sidecar into wisp outer runtime failed session_runtime=%s outer_sandbox_id=%s %s", runtime.RuntimeID, sb.ID, wispCommandFailureDetail(nil, result))
	}
	return nil
}

func fetchSHAArg(sha string) string {
	if strings.TrimSpace(sha) == "" {
		return ""
	}
	return " --sha256 " + shellQuote(strings.TrimSpace(sha))
}

func wispSessionDaemonHostCommand(runtime ACPSessionRuntime, daemonArgs []string, workspace, memoryDir, logPath string, env map[string]string) string {
	hostLog := path.Join(path.Dir(runtime.RemoteBinary), "wispclient-daemon.log")
	hostPID := path.Join(path.Dir(runtime.RemoteBinary), "wispclient-daemon.pid")
	daemonPID := path.Join(path.Dir(runtime.RemoteBinary), "daemon.pid")
	innerDaemon := "cd " + shellQuote(workspace) + "\n" +
		"mkdir -p " + shellQuote(path.Dir(daemonPID)) + "\n" +
		"echo $$ > " + shellQuote(daemonPID) + "\n" +
		"trap 'rm -f " + shellQuote(daemonPID) + "' EXIT\n" +
		shellEnvPrefix(env) + "exec " + sidecarPlainCommand(runtime.RemoteBinary, daemonArgs...)
	return "set -euo pipefail\n" +
		"client=" + shellQuote(runtime.WispClientPath) + "\n" +
		"name=" + shellQuote(runtime.WispName) + "\n" +
		"host_log=" + shellQuote(hostLog) + "\n" +
		"host_pid=" + shellQuote(hostPID) + "\n" +
		"mkdir -p \"$(dirname \"$host_log\")\"\n" +
		"\"$client\" -server " + shellQuote(wispAdminAddr(runtime)) + " exec \"$name\" -- /bin/sh -lc " + shellQuote("mkdir -p "+shellQuote(workspace)+" "+shellQuote(memoryDir)+" "+shellQuote(path.Dir(logPath))) + " >/dev/null\n" +
		"( printf '%s\\n' " + shellQuote(innerDaemon) + " | \"$client\" -server " + shellQuote(wispAdminAddr(runtime)) + " shell \"$name\" >\"$host_log\" 2>&1 & echo $! >\"$host_pid\" )\n" +
		"echo CLOUDAGENT_WISP_DAEMON_ATTACHED\n"
}

type wispHermesBootstrapManifest struct {
	Version       int    `json:"version"`
	SessionID     string `json:"session_id"`
	AgentVersion  string `json:"agent_version"`
	SidecarURL    string `json:"sidecar_url,omitempty"`
	SidecarSHA256 string `json:"sidecar_sha256,omitempty"`
}

func wispHermesBootstrapManifestFor(runtime ACPSessionRuntime, req ACPSessionRuntimeStartRequest) wispHermesBootstrapManifest {
	return wispHermesBootstrapManifest{
		Version:       1,
		SessionID:     req.SessionID,
		AgentVersion:  normalizeRuntimeVersion(runtime.AgentVersion, defaultAgentVersion),
		SidecarURL:    strings.TrimSpace(runtime.SidecarURL),
		SidecarSHA256: normalizeSHA256(runtime.SidecarSHA256),
	}
}

func (m wispHermesBootstrapManifest) matches(runtime ACPSessionRuntime, req ACPSessionRuntimeStartRequest) bool {
	want := wispHermesBootstrapManifestFor(runtime, req)
	return m.Version == want.Version &&
		m.SessionID == want.SessionID &&
		m.AgentVersion == want.AgentVersion &&
		m.SidecarURL == want.SidecarURL &&
		normalizeSHA256(m.SidecarSHA256) == want.SidecarSHA256
}

func wispHermesBootstrapManifestPath(sessionID string) string {
	return path.Join(acpRuntimeCWD, ".cloudagent", "sessions", sessionID, "hermes", ".cloudagent-bootstrap.json")
}

func (w *AgentSidecarWorker) wispHermesBootstrapManifestValid(ctx context.Context, host RuntimeHost, sb RuntimeHostTarget, runtime ACPSessionRuntime, req ACPSessionRuntimeStartRequest) bool {
	manifestPath := wispHermesBootstrapManifestPath(req.SessionID)
	command := "set -euo pipefail\n" +
		"client=" + shellQuote(runtime.WispClientPath) + "\n" +
		"name=" + shellQuote(runtime.WispName) + "\n" +
		"\"$client\" -server " + shellQuote(wispAdminAddr(runtime)) +
		" exec \"$name\" -- /bin/sh -lc " + shellQuote("cat "+shellQuote(manifestPath)) + "\n"
	checkCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	result, err := host.RunCommand(checkCtx, sb, command, nil, nil, nil)
	if err != nil || result.ExitCode != 0 {
		return false
	}
	var manifest wispHermesBootstrapManifest
	if err := json.Unmarshal([]byte(strings.TrimSpace(result.Stdout)), &manifest); err != nil {
		return false
	}
	return manifest.matches(runtime, req)
}

func (w *AgentSidecarWorker) writeWispHermesBootstrapManifest(ctx context.Context, host RuntimeHost, sb RuntimeHostTarget, runtime ACPSessionRuntime, req ACPSessionRuntimeStartRequest) error {
	manifestPath := wispHermesBootstrapManifestPath(req.SessionID)
	payload, err := json.Marshal(wispHermesBootstrapManifestFor(runtime, req))
	if err != nil {
		return err
	}
	writeScript := "mkdir -p " + shellQuote(path.Dir(manifestPath)) +
		" && printf '%s' " + shellQuote(string(payload)) + " > " + shellQuote(manifestPath)
	command := "set -euo pipefail\n" +
		"client=" + shellQuote(runtime.WispClientPath) + "\n" +
		"name=" + shellQuote(runtime.WispName) + "\n" +
		"\"$client\" -server " + shellQuote(wispAdminAddr(runtime)) +
		" exec \"$name\" -- /bin/sh -lc " + shellQuote(writeScript) + "\n"
	_, err = host.RunCommand(ctx, sb, command, nil, nil, nil)
	return err
}
