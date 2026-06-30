package wrapper

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

func TestLiveACPWispOuterSession(t *testing.T) {
	if os.Getenv("RUN_LIVE_ACP_WISP_OUTER") != "1" {
		t.Skip("set RUN_LIVE_ACP_WISP_OUTER=1 to run live Shanghai AGS + SMH + Wisp outer ACP session")
	}

	scope := Scope{TenantID: "tenant-live", ProjectID: "project-live"}
	requestTimeout := liveDurationEnv("LIVE_ACP_WISP_OUTER_TIMEOUT", 20*time.Minute)
	ctx, cancel := context.WithTimeout(context.Background(), requestTimeout)
	defer cancel()

	client, worker := newLiveWispWorker(t, requestTimeout)

	sessionID := "session_live_wisp_" + randomHex(8)
	runtime, err := worker.StartSessionRuntime(ctx, ACPSessionRuntimeStartRequest{
		SessionID:        sessionID,
		Scope:            scope,
		CWD:              acpRuntimeCWD,
		Generation:       1,
		SandboxBackend:   "ags",
		AgentVersion:     defaultAgentVersion,
		WorkspaceVersion: defaultWorkspaceVersion,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("runtime ready session=%s outer=%s wisp=%s smh_space=%s", sessionID, runtime.OuterSandboxID, runtime.WispName, runtime.WispSMHSpaceID)
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cleanupCancel()
		if err := worker.DeleteSessionRuntime(cleanupCtx, runtime); err != nil {
			t.Logf("cleanup runtime outer=%s smh_space=%s: %v", runtime.OuterSandboxID, runtime.WispSMHSpaceID, err)
		}
	})

	chatResult := runLiveWispPrompt(t, ctx, worker, runtime, scope, sessionID, "chat", "请只输出 WISP_CHAT_OK，不要调用工具。", nil)
	if !strings.Contains(chatResult.OutputText, "WISP_CHAT_OK") {
		t.Fatalf("pure chat output=%q, want WISP_CHAT_OK", chatResult.OutputText)
	}
	t.Logf("pure chat ok output=%q", chatResult.OutputText)

	fileContent := []byte("WISP_FILE_OK\nthis file was staged into the Wisp outer runtime\n")
	inputPath := t.TempDir() + "/wisp-probe.txt"
	if err := os.WriteFile(inputPath, fileContent, 0o600); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(fileContent)
	staged := materializedFile{
		FileID:        "file_live_wisp_probe",
		Filename:      "wisp-probe.txt",
		ContentType:   "text/plain",
		Bytes:         int64(len(fileContent)),
		SHA256:        hex.EncodeToString(sum[:]),
		Path:          inputPath,
		WorkspacePath: "wisp-probe.txt",
	}
	fileResult := runLiveWispPrompt(t, ctx, worker, runtime, scope, sessionID, "file", "请读取 /workspace/wisp-probe.txt，并只输出文件里的第一行。", []materializedFile{staged})
	if !strings.Contains(fileResult.OutputText, "WISP_FILE_OK") {
		t.Fatalf("file staging output=%q, want WISP_FILE_OK", fileResult.OutputText)
	}
	t.Logf("file staging ok output=%q", fileResult.OutputText)

	oldOuterID := runtime.OuterSandboxID
	if err := client.DeleteSandbox(ctx, oldOuterID); err != nil {
		t.Fatalf("delete old outer sandbox before restore: %v", err)
	}
	restored, err := worker.EnsureSessionRuntime(ctx, runtime, ACPSessionRuntimeStartRequest{
		SessionID:        sessionID,
		Scope:            scope,
		CWD:              acpRuntimeCWD,
		Generation:       2,
		SandboxBackend:   "ags",
		OuterRuntime:     outerRuntimeWisp,
		RuntimeRecovery:  runtimeRecoveryReattachOrRecreate,
		AgentVersion:     defaultAgentVersion,
		WorkspaceVersion: defaultWorkspaceVersion,
	})
	if err != nil {
		t.Fatalf("restore wisp runtime after deleting outer %s: %v", oldOuterID, err)
	}
	runtime = restored
	if runtime.OuterSandboxID == oldOuterID {
		t.Fatalf("restore reused deleted outer sandbox id %s", oldOuterID)
	}
	restoreResult := runLiveWispPrompt(t, ctx, worker, runtime, scope, sessionID, "restore", "请读取 /workspace/wisp-probe.txt，并只输出文件里的第一行。", nil)
	if !strings.Contains(restoreResult.OutputText, "WISP_FILE_OK") {
		t.Fatalf("restored runtime output=%q, want WISP_FILE_OK", restoreResult.OutputText)
	}
	t.Logf("restore ok old_outer=%s new_outer=%s output=%q", oldOuterID, runtime.OuterSandboxID, restoreResult.OutputText)

	update, err := worker.EnsureSessionEnvdRuntime(ctx, runtime, ACPSessionRuntimeEnsureRequest{
		SessionID:  sessionID,
		Scope:      scope,
		Generation: 1,
		Force:      true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if update.InnerSandboxID == "" || update.InnerSandboxDomain == "" || update.InnerEnvdAccessToken == "" {
		t.Fatalf("inner sandbox identity incomplete: %#v", update)
	}
	t.Logf("inner sandbox ok inner=%s domain=%s", update.InnerSandboxID, update.InnerSandboxDomain)
}

func TestLiveACPWispACPChatSmoke(t *testing.T) {
	if os.Getenv("RUN_LIVE_ACP_WISP_OUTER") != "1" {
		t.Skip("set RUN_LIVE_ACP_WISP_OUTER=1 to run live ACP websocket + Shanghai AGS + Wisp outer session")
	}

	requestTimeout := liveDurationEnv("LIVE_ACP_WISP_OUTER_TIMEOUT", 20*time.Minute)
	_, worker := newLiveWispWorker(t, requestTimeout)
	store, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	srv := NewServer(store, worker)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	client := dialACPWS(t, "ws"+trimHTTPPrefix(ts.URL)+"/acp", map[string]string{"Authorization": "Bearer test-key"})
	defer client.close()
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{}})
	liveWaitForRPCID(t, client, float64(1), 10*time.Second)
	client.writeJSON(t, map[string]any{
		"jsonrpc": "2.0",
		"id":      2,
		"method":  "session/new",
		"params": map[string]any{
			"cwd": "/workspace",
			"_meta": map[string]any{"cloudagent": map[string]any{
				"outer_runtime":    outerRuntimeWisp,
				"sandbox_backend":  "ags",
				"runtime_recovery": runtimeRecoveryReattachOrRecreate,
			}},
		},
	})
	newResp := liveWaitForRPCID(t, client, float64(2), requestTimeout)
	if errObj, ok := newResp["error"].(map[string]any); ok {
		t.Fatalf("session/new failed before chat prompt: %#v", errObj)
	}
	sessionID := newResp["result"].(map[string]any)["sessionId"].(string)

	client.writeJSON(t, map[string]any{
		"jsonrpc": "2.0",
		"id":      3,
		"method":  "session/prompt",
		"params": map[string]any{
			"sessionId": sessionID,
			"prompt":    []any{map[string]any{"type": "text", "text": "请只输出 WISP_CHAT_OK，不要调用工具。"}},
		},
	})
	liveWaitForMethod(t, client, "session/update", requestTimeout)
	promptResp := liveWaitForRPCID(t, client, float64(3), requestTimeout)
	if errObj, ok := promptResp["error"].(map[string]any); ok {
		t.Fatalf("session/prompt failed: %#v", errObj)
	}
}

func liveWaitForRPCID(t *testing.T, client *acpWSClient, id float64, timeout time.Duration) map[string]any {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		msg := liveReadACPJSON(t, client, time.Until(deadline))
		if got, ok := msg["id"].(float64); ok && got == id {
			return msg
		}
	}
	t.Fatalf("timed out waiting for rpc response id=%v", id)
	return nil
}

func liveWaitForMethod(t *testing.T, client *acpWSClient, method string, timeout time.Duration) map[string]any {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		msg := liveReadACPJSON(t, client, time.Until(deadline))
		if got, ok := msg["method"].(string); ok && got == method {
			return msg
		}
	}
	t.Fatalf("timed out waiting for method %s", method)
	return nil
}

func liveReadACPJSON(t *testing.T, client *acpWSClient, timeout time.Duration) map[string]any {
	t.Helper()
	if timeout <= 0 {
		timeout = time.Second
	}
	_ = client.conn.SetReadDeadline(time.Now().Add(timeout))
	header := make([]byte, 2)
	if _, err := io.ReadFull(client.br, header); err != nil {
		t.Fatal(err)
	}
	opcode := header[0] & 0x0F
	if opcode == 0x8 {
		t.Fatal("websocket closed")
	}
	length := int(header[1] & 0x7F)
	switch length {
	case 126:
		var ext [2]byte
		if _, err := io.ReadFull(client.br, ext[:]); err != nil {
			t.Fatal(err)
		}
		length = int(binary.BigEndian.Uint16(ext[:]))
	case 127:
		t.Fatal("unexpected large websocket frame")
	}
	payload := make([]byte, length)
	if _, err := io.ReadFull(client.br, payload); err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	if err := json.Unmarshal(payload, &out); err != nil {
		t.Fatalf("invalid json payload %s: %v", string(payload), err)
	}
	return out
}

func TestLiveACPWispOuterCloseCheckpoints(t *testing.T) {
	if os.Getenv("RUN_LIVE_ACP_WISP_OUTER") != "1" {
		t.Skip("set RUN_LIVE_ACP_WISP_OUTER=1 to run live Shanghai AGS + SMH + Wisp outer ACP session")
	}

	scope := Scope{TenantID: "tenant-live", ProjectID: "project-live"}
	requestTimeout := liveDurationEnv("LIVE_ACP_WISP_OUTER_TIMEOUT", 20*time.Minute)
	ctx, cancel := context.WithTimeout(context.Background(), requestTimeout)
	defer cancel()

	_, worker := newLiveWispWorker(t, requestTimeout)
	sessionID := "session_live_wisp_close_" + randomHex(8)
	runtime, err := worker.StartSessionRuntime(ctx, ACPSessionRuntimeStartRequest{
		SessionID:        sessionID,
		Scope:            scope,
		CWD:              acpRuntimeCWD,
		Generation:       1,
		SandboxBackend:   "ags",
		AgentVersion:     defaultAgentVersion,
		WorkspaceVersion: defaultWorkspaceVersion,
	})
	if err != nil {
		t.Fatal(err)
	}
	closed := false
	closeAttempted := false
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cleanupCancel()
		if closed || closeAttempted {
			if runtime.WispOwnsSMHSpace && runtime.WispSMHSpaceID != "" {
				if err := worker.deleteWispSMHSpace(cleanupCtx, runtime.WispSMHSpaceID); err != nil {
					t.Logf("cleanup wisp SMH space %s: %v", runtime.WispSMHSpaceID, err)
				}
			}
			return
		}
		if err := worker.DeleteSessionRuntime(cleanupCtx, runtime); err != nil {
			t.Logf("cleanup runtime outer=%s smh_space=%s: %v", runtime.OuterSandboxID, runtime.WispSMHSpaceID, err)
		}
	})
	if runtime.WorkspaceRuntimeID == "" || runtime.InnerSandboxID == "" {
		t.Fatalf("workspace Wisp runtime was not bound: workspace_runtime_id=%q inner_sandbox_id=%q", runtime.WorkspaceRuntimeID, runtime.InnerSandboxID)
	}

	closeCtx, closeCancel := context.WithTimeout(ctx, liveDurationEnv("LIVE_ACP_WISP_CLOSE_TIMEOUT", 3*time.Minute))
	defer closeCancel()
	closeAttempted = true
	if err := worker.DeleteSessionRuntime(closeCtx, runtime); err != nil {
		if strings.Contains(err.Error(), "checkpoint cut failed") || strings.Contains(err.Error(), "meta-barrier") {
			t.Fatalf("wisp close checkpoint failed: %v", err)
		}
		t.Fatalf("wisp close failed before checkpoint well-done: %v", err)
	}
	closed = true
	t.Logf("wisp close checkpoint ok session=%s outer=%s inner=%s smh_space=%s", sessionID, runtime.OuterSandboxID, runtime.InnerSandboxID, runtime.WispSMHSpaceID)
}

func TestLiveLocalDockerWispSMHRuntime(t *testing.T) {
	if os.Getenv("RUN_LIVE_LOCAL_DOCKER_WISP_SMH") != "1" && os.Getenv("RUN_LIVE_LOCAL_WISP_SMH") != "1" {
		t.Skip("set RUN_LIVE_LOCAL_WISP_SMH=1 to run live Shanghai SMH + Wisp on a local Linux RuntimeHost")
	}
	if strings.TrimSpace(os.Getenv("GATEWAY_RUNTIME_HOST")) != runtimeHostTypeLocalWisp {
		t.Skip("GATEWAY_RUNTIME_HOST=local_wisp is required")
	}
	if strings.TrimSpace(os.Getenv("GATEWAY_LOCAL_RUNTIME_COMMAND_PREFIX")) == "" {
		t.Skip("GATEWAY_LOCAL_RUNTIME_COMMAND_PREFIX is required")
	}
	if strings.TrimSpace(os.Getenv("GATEWAY_LOCAL_RUNTIME_ROOT")) == "" {
		t.Skip("GATEWAY_LOCAL_RUNTIME_ROOT is required")
	}
	if strings.TrimSpace(firstEnv("GATEWAY_WISP_SMH_LIBRARY_SECRET", "SMH_LIBRARY_SECRET")) == "" {
		t.Skip("GATEWAY_WISP_SMH_LIBRARY_SECRET or SMH_LIBRARY_SECRET is required")
	}
	if strings.TrimSpace(firstEnv("GATEWAY_AGENT_SIDECAR_URL", "AGENT_SIDECAR_URL")) == "" {
		t.Skip("GATEWAY_AGENT_SIDECAR_URL or AGENT_SIDECAR_URL is required")
	}

	scope := Scope{TenantID: "tenant-local-docker", ProjectID: "project-local-docker"}
	requestTimeout := liveDurationEnv("LIVE_LOCAL_DOCKER_WISP_SMH_TIMEOUT", 12*time.Minute)
	ctx, cancel := context.WithTimeout(context.Background(), requestTimeout)
	defer cancel()

	store, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	worker, err := NewAgentSidecarWorkerFromEnvWithWorkspaceService(store)
	if err != nil {
		t.Fatal(err)
	}
	sessionID := "session_local_docker_wisp_" + randomHex(8)
	runtime, err := worker.StartSessionRuntime(ctx, ACPSessionRuntimeStartRequest{
		SessionID:        sessionID,
		Scope:            scope,
		CWD:              acpRuntimeCWD,
		Generation:       1,
		SandboxBackend:   runtimeHostTypeLocalWisp,
		OuterRuntime:     outerRuntimeWisp,
		RuntimeRecovery:  runtimeRecoveryReattachOrRecreate,
		AgentVersion:     defaultAgentVersion,
		WorkspaceVersion: defaultWorkspaceVersion,
		OwnerID:          "local-docker-e2e",
	})
	if err != nil {
		t.Fatal(err)
	}
	closed := false
	t.Cleanup(func() {
		if closed {
			return
		}
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 3*time.Minute)
		defer cleanupCancel()
		if err := worker.DeleteSessionRuntime(cleanupCtx, runtime); err != nil {
			t.Logf("cleanup local docker wisp runtime session=%s outer=%s inner=%s: %v", sessionID, runtime.OuterSandboxID, runtime.InnerSandboxID, err)
		}
	})
	if runtime.SandboxBackend != runtimeHostTypeLocalWisp {
		t.Fatalf("sandbox backend=%q, want local_wisp", runtime.SandboxBackend)
	}
	if runtime.OuterSandboxID == "" || runtime.OuterSandboxDomain != runtimeHostTypeLocalWisp {
		t.Fatalf("outer local runtime identity incomplete: %#v", runtime)
	}
	if runtime.InnerSandboxID == "" || runtime.InnerSandboxDomain != runtimeHostTypeLocalWisp {
		t.Fatalf("inner local runtime identity incomplete: %#v", runtime)
	}
	if runtime.WispSMHSpaceID == "" || runtime.WispName == "" || runtime.WorkspaceWispName == "" || runtime.WorkspaceRuntimeID == "" {
		t.Fatalf("wisp runtime identity incomplete: %#v", runtime)
	}
	localHost := requireLocalRuntimeHost(t, worker, runtime)
	outerHandleBefore := requireLocalRuntimeHandle(t, localHost, runtime.OuterSandboxID)
	innerHandleBefore := requireLocalRuntimeHandle(t, localHost, runtime.InnerSandboxID)
	if outerHandleBefore.TemplateID != worker.outerTemplateID {
		t.Fatalf("unexpected outer local template: %+v", outerHandleBefore)
	}
	if innerHandleBefore.TemplateID != worker.innerTemplateID {
		t.Fatalf("unexpected inner local template: %+v", innerHandleBefore)
	}
	status, err := worker.SessionRuntimeStatus(ctx, runtime, sessionID)
	if err != nil {
		t.Fatalf("local wisp runtime status should be readable: %v", err)
	}
	if status.SessionID != "" && status.SessionID != sessionID {
		t.Fatalf("runtime status session mismatch: status=%+v session=%s", status, sessionID)
	}
	update, err := worker.EnsureSessionEnvdRuntime(ctx, runtime, ACPSessionRuntimeEnsureRequest{
		SessionID:  sessionID,
		Scope:      scope,
		Generation: 1,
		Force:      false,
	})
	if err != nil {
		t.Fatalf("ensure existing local workspace runtime: %v", err)
	}
	if update.InnerSandboxID != runtime.InnerSandboxID || update.InnerSandboxDomain != runtime.InnerSandboxDomain || update.InnerEnvdAccessToken == "" {
		t.Fatalf("ensure existing workspace returned different identity: update=%+v runtime=%+v", update, runtime)
	}
	if err := worker.RefreshSessionRuntime(ctx, runtime, sessionID); err != nil {
		t.Fatalf("refresh local docker runtime: %v", err)
	}
	if err := worker.RefreshSessionRuntime(ctx, runtime, sessionID); err != nil {
		t.Fatalf("second refresh local docker runtime: %v", err)
	}
	outerHandleAfter := requireLocalRuntimeHandle(t, localHost, runtime.OuterSandboxID)
	innerHandleAfter := requireLocalRuntimeHandle(t, localHost, runtime.InnerSandboxID)
	if !outerHandleAfter.ExpiresAt.After(outerHandleBefore.ExpiresAt) {
		t.Fatalf("outer refresh did not extend local handle expiry: before=%s after=%s", outerHandleBefore.ExpiresAt, outerHandleAfter.ExpiresAt)
	}
	if !innerHandleAfter.ExpiresAt.After(innerHandleBefore.ExpiresAt) {
		t.Fatalf("inner refresh did not extend local handle expiry: before=%s after=%s", innerHandleBefore.ExpiresAt, innerHandleAfter.ExpiresAt)
	}
	closeCtx, closeCancel := context.WithTimeout(ctx, liveDurationEnv("LIVE_LOCAL_DOCKER_WISP_CLOSE_TIMEOUT", 10*time.Minute))
	defer closeCancel()
	if err := worker.DeleteSessionRuntime(closeCtx, runtime); err != nil {
		t.Fatalf("close local docker wisp runtime: %v", err)
	}
	closed = true
	assertLocalRuntimeHandleMissing(t, localHost, runtime.OuterSandboxID)
	assertLocalRuntimeHandleMissing(t, localHost, runtime.InnerSandboxID)
	if err := worker.RefreshSessionRuntime(ctx, runtime, sessionID); err == nil {
		t.Fatal("refresh should fail after local runtime handles are deleted")
	}
	t.Logf("local docker wisp runtime ok session=%s outer=%s inner=%s smh_space=%s outer_wisp=%s inner_wisp=%s", sessionID, runtime.OuterSandboxID, runtime.InnerSandboxID, runtime.WispSMHSpaceID, runtime.WispName, runtime.WorkspaceWispName)
}

func requireLocalRuntimeHost(t *testing.T, worker *AgentSidecarWorker, runtime ACPSessionRuntime) *LocalRuntimeHost {
	t.Helper()
	backend, err := worker.backendForRuntime(runtime)
	if err != nil {
		t.Fatal(err)
	}
	localHost, ok := backend.host.(*LocalRuntimeHost)
	if !ok {
		t.Fatalf("runtime backend host is %T, want *LocalRuntimeHost", backend.host)
	}
	return localHost
}

func requireLocalRuntimeHandle(t *testing.T, host *LocalRuntimeHost, id string) localRuntimeHostHandle {
	t.Helper()
	handle, err := host.readHandle(id)
	if err != nil {
		t.Fatalf("read local runtime handle %s: %v", id, err)
	}
	return handle
}

func assertLocalRuntimeHandleMissing(t *testing.T, host *LocalRuntimeHost, id string) {
	t.Helper()
	if _, err := host.readHandle(id); err == nil {
		t.Fatalf("local runtime handle %s still exists after close", id)
	}
}

func newLiveWispWorker(t *testing.T, requestTimeout time.Duration) (*AGSClient, *AgentSidecarWorker) {
	t.Helper()
	apiKey := firstEnv("GATEWAY_AGS_API_KEY", "E2B_API_KEY")
	tokenHubAPIKey := firstEnv("GATEWAY_TOKENHUB_API_KEY", "TOKENHUB_API_KEY")
	smhSecret := firstEnv("GATEWAY_WISP_SMH_LIBRARY_SECRET", "SMH_LIBRARY_SECRET")
	if apiKey == "" || tokenHubAPIKey == "" || smhSecret == "" {
		t.Skip("GATEWAY_AGS_API_KEY/E2B_API_KEY, TOKENHUB_API_KEY, and SMH_LIBRARY_SECRET are required")
	}

	sidecarURL := firstNonEmpty(firstEnv("GATEWAY_AGENT_SIDECAR_URL", "AGENT_SIDECAR_URL"), readTrimmedTestFile("/tmp/agent-sidecar-url.clean"))
	if sidecarURL == "" {
		t.Skip("GATEWAY_AGENT_SIDECAR_URL or /tmp/agent-sidecar-url.clean is required")
	}
	sidecarSHA256 := firstNonEmpty(firstEnv("GATEWAY_AGENT_SIDECAR_SHA256", "AGENT_SIDECAR_SHA256"), readTrimmedTestFile("/tmp/agent-sidecar-sha256.clean"))

	templateID := firstNonEmpty(
		firstEnv("GATEWAY_AGENT_SIDECAR_OUTER_TEMPLATE", "GATEWAY_AGS_TEMPLATE", "OUTER_SANDBOX_TEMPLATE"),
		"sdt-hwd907s8",
	)
	innerTemplateID := firstNonEmpty(firstEnv("GATEWAY_AGENT_SIDECAR_INNER_TEMPLATE", "INNER_SANDBOX_TEMPLATE"), templateID)
	client, err := NewAGSClient(AGSClientConfig{
		APIKey:         apiKey,
		Domain:         firstNonEmpty(firstEnv("GATEWAY_AGS_DOMAIN", "E2B_DOMAIN"), "ap-shanghai.tencentags.com"),
		APIURL:         firstNonEmpty(firstEnv("GATEWAY_AGS_API_URL", "E2B_API_URL"), "https://api.ap-shanghai.tencentags.com"),
		RequestTimeout: requestTimeout,
	})
	if err != nil {
		t.Fatal(err)
	}
	store, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	worker, err := NewAgentSidecarWorker(AgentSidecarWorkerConfig{
		Client:                client,
		OuterTemplateID:       templateID,
		InnerTemplateID:       innerTemplateID,
		SidecarURL:            sidecarURL,
		SidecarSHA256:         sidecarSHA256,
		SandboxHostURL:        firstEnv("GATEWAY_SANDBOX_HOST_URL", "HERMES_SANDBOX_HOST_URL", "SANDBOX_HOST_URL"),
		SandboxHostSHA256:     firstEnv("GATEWAY_SANDBOX_HOST_SHA256", "HERMES_SANDBOX_HOST_SHA256", "SANDBOX_HOST_SHA256"),
		TokenHubAPIKey:        tokenHubAPIKey,
		TokenHubModel:         firstEnv("GATEWAY_TOKENHUB_MODEL", "TOKENHUB_MODEL"),
		SandboxTimeoutSeconds: envInt("GATEWAY_AGENT_SIDECAR_OUTER_TIMEOUT_SECONDS", 900),
		DeleteSandbox:         true,
		OuterRuntime:          outerRuntimeWisp,
		WispPackageURL:        firstNonEmpty(firstEnv("GATEWAY_WISP_PACKAGE_URL", "WISP_SDK_PACKAGE_URL", "WISP_FAST_PACKAGE_URL", "WISP_PACKAGE_URL"), defaultLiveWispFastPackageURL),
		WispRootUpperSize:     firstEnv("GATEWAY_WISP_ROOT_UPPER_SIZE", "WISP_ROOT_UPPER_SIZE", "ROOT_UPPER_SIZE"),
		WispJFSPrefix:         firstNonEmpty(firstEnv("GATEWAY_WISP_JFS_PREFIX", "WISP_JFS_PREFIX", "JFS_PREFIX"), "cloudagent-agent-live"),
		WispSMHLibraryID:      firstNonEmpty(firstEnv("GATEWAY_WISP_SMH_LIBRARY_ID", "SMH_LIBRARY_ID"), "smh37laghvp09llc"),
		WispSMHAccessDomain:   firstNonEmpty(firstEnv("GATEWAY_WISP_SMH_ACCESS_DOMAIN", "SMH_ACCESS_DOMAIN"), "https://smh37laghvp09llc.ap-shanghai.api.tencentsmh.cn"),
		WispSMHLibrarySecret:  smhSecret,
		WorkspaceService:      store,
	})
	if err != nil {
		t.Fatal(err)
	}
	return client, worker
}

func runLiveWispPrompt(t *testing.T, ctx context.Context, worker *AgentSidecarWorker, runtime ACPSessionRuntime, scope Scope, sessionID, label, instruction string, files []materializedFile) workerResult {
	t.Helper()
	jobID := "job_live_wisp_" + label + "_" + randomHex(6)
	result, err := worker.Run(ctx, workerJob{
		WorkerContractVersion: WorkerContractVersion,
		JobID:                 jobID,
		ResponseID:            "resp_" + jobID,
		Model:                 "agent-sidecar-wisp-live",
		Scope:                 scope,
		CWD:                   acpRuntimeCWD,
		Instruction:           instruction,
		InputFiles:            files,
		TimeoutSeconds:        240,
		ACPSessionID:          sessionID,
		ACPSessionGeneration:  1,
		ACPSessionRuntime:     runtime,
	}, func(event workerEvent) error {
		if event.Kind == "tool_call" || event.Kind == "tool_result" || event.Kind == "reasoning_delta" {
			t.Logf("event kind=%s tool=%s status=%s delta_bytes=%d", event.Kind, event.ToolName, event.ToolStatus, len(event.Delta))
		}
		return nil
	})
	if err != nil {
		t.Fatalf("%s prompt failed: %v", label, err)
	}
	if strings.TrimSpace(result.OutputText) == "" {
		t.Fatalf("%s prompt returned empty output", label)
	}
	return result
}

func readTrimmedTestFile(path string) string {
	raw, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(raw))
}
