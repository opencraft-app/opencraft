package wrapper

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
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
		WispRootUpperSize:     firstNonEmpty(firstEnv("GATEWAY_WISP_ROOT_UPPER_SIZE", "WISP_ROOT_UPPER_SIZE", "ROOT_UPPER_SIZE"), "5G"),
		WispJFSPrefix:         firstNonEmpty(firstEnv("GATEWAY_WISP_JFS_PREFIX", "WISP_JFS_PREFIX", "JFS_PREFIX"), "cloudagent-agent-live"),
		WispSMHLibraryID:      firstNonEmpty(firstEnv("GATEWAY_WISP_SMH_LIBRARY_ID", "SMH_LIBRARY_ID"), "smh37laghvp09llc"),
		WispSMHAccessDomain:   firstNonEmpty(firstEnv("GATEWAY_WISP_SMH_ACCESS_DOMAIN", "SMH_ACCESS_DOMAIN"), "https://smh37laghvp09llc.ap-shanghai.api.tencentsmh.cn"),
		WispSMHLibrarySecret:  smhSecret,
		WorkspaceService:      store,
	})
	if err != nil {
		t.Fatal(err)
	}

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
