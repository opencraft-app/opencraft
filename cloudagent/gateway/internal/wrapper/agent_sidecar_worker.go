package wrapper

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"hash/crc32"
	"net/url"
	"os"
	"path"
	"regexp"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

const defaultTalosTemplateID = "498c6c11-74d7-426e-bdb1-13d8aa73997e"

const (
	defaultAgentVersion     = "builtin.v1"
	defaultWorkspaceVersion = "builtin.v1"
	defaultSigningKeyID     = "cloudagent-agent-release-v1"
)

type AgentSidecarWorkerConfig struct {
	Client                *AGSClient
	OuterTemplateID       string
	InnerTemplateID       string
	AdditionalBackends    []AgentSidecarBackendConfig
	SidecarBinaryPath     string
	SidecarURL            string
	SidecarSHA256         string
	AgentLoaderPath       string
	SandboxHostURL        string
	SandboxHostSHA256     string
	TokenHubAPIKey        string
	TokenHubModel         string
	ForceInnerCommand     string
	SandboxTimeoutSeconds int
	DeleteSandbox         bool
}

type AgentSidecarBackendConfig struct {
	Name            string
	Client          *AGSClient
	OuterTemplateID string
	InnerTemplateID string
}

type agentSidecarBackend struct {
	name            string
	client          *AGSClient
	outerTemplateID string
	innerTemplateID string
}

type AgentSidecarWorker struct {
	client                *AGSClient
	outerTemplateID       string
	innerTemplateID       string
	backends              map[string]agentSidecarBackend
	defaultBackendName    string
	sidecarBinaryPath     string
	sidecarURL            string
	sidecarSHA256         string
	agentLoaderPath       string
	sandboxHostURL        string
	sandboxHostSHA256     string
	tokenHubAPIKey        string
	tokenHubModel         string
	forceInnerCommand     string
	sandboxTimeoutSeconds int
	deleteSandbox         bool
	artifactPath          string
}

func NewAgentSidecarWorker(cfg AgentSidecarWorkerConfig) (*AgentSidecarWorker, error) {
	if cfg.Client == nil {
		return nil, fmt.Errorf("ags client is required")
	}
	if strings.TrimSpace(cfg.OuterTemplateID) == "" {
		return nil, fmt.Errorf("outer sandbox template is required")
	}
	if strings.TrimSpace(cfg.InnerTemplateID) == "" {
		return nil, fmt.Errorf("inner sandbox template is required")
	}
	if strings.TrimSpace(cfg.SidecarBinaryPath) == "" && strings.TrimSpace(cfg.SidecarURL) == "" {
		return nil, fmt.Errorf("agent sidecar binary path or URL is required")
	}
	if strings.TrimSpace(cfg.TokenHubAPIKey) == "" {
		return nil, fmt.Errorf("tokenhub api key is required")
	}
	defaultBackend := agentSidecarBackend{
		name:            "ags",
		client:          cfg.Client,
		outerTemplateID: strings.TrimSpace(cfg.OuterTemplateID),
		innerTemplateID: strings.TrimSpace(cfg.InnerTemplateID),
	}
	backends := map[string]agentSidecarBackend{defaultBackend.name: defaultBackend}
	for _, backendCfg := range cfg.AdditionalBackends {
		name := strings.ToLower(strings.TrimSpace(backendCfg.Name))
		if name == "" {
			return nil, fmt.Errorf("additional sandbox backend name is required")
		}
		if backendCfg.Client == nil {
			return nil, fmt.Errorf("additional sandbox backend %s client is required", name)
		}
		outerTemplateID := strings.TrimSpace(backendCfg.OuterTemplateID)
		if outerTemplateID == "" {
			return nil, fmt.Errorf("additional sandbox backend %s outer template is required", name)
		}
		innerTemplateID := strings.TrimSpace(backendCfg.InnerTemplateID)
		if innerTemplateID == "" {
			innerTemplateID = outerTemplateID
		}
		backends[name] = agentSidecarBackend{
			name:            name,
			client:          backendCfg.Client,
			outerTemplateID: outerTemplateID,
			innerTemplateID: innerTemplateID,
		}
	}
	timeout := cfg.SandboxTimeoutSeconds
	if timeout == 0 {
		timeout = 300
	}
	model := cfg.TokenHubModel
	if model == "" {
		model = "minimax-m2.7"
	}
	return &AgentSidecarWorker{
		client:                cfg.Client,
		outerTemplateID:       cfg.OuterTemplateID,
		innerTemplateID:       cfg.InnerTemplateID,
		backends:              backends,
		defaultBackendName:    defaultBackend.name,
		sidecarBinaryPath:     cfg.SidecarBinaryPath,
		sidecarURL:            cfg.SidecarURL,
		sidecarSHA256:         cfg.SidecarSHA256,
		agentLoaderPath:       firstNonEmpty(cfg.AgentLoaderPath, "/usr/local/bin/cloudagent-agent-loader"),
		sandboxHostURL:        strings.TrimSpace(cfg.SandboxHostURL),
		sandboxHostSHA256:     strings.TrimSpace(cfg.SandboxHostSHA256),
		tokenHubAPIKey:        cfg.TokenHubAPIKey,
		tokenHubModel:         model,
		forceInnerCommand:     cfg.ForceInnerCommand,
		sandboxTimeoutSeconds: timeout,
		deleteSandbox:         cfg.DeleteSandbox,
		artifactPath:          "/tmp/gateway-output.txt",
	}, nil
}

func NewAgentSidecarWorkerFromEnv() (*AgentSidecarWorker, error) {
	client, err := NewAGSClient(AGSClientConfig{
		APIKey:         firstEnv("GATEWAY_AGS_API_KEY", "E2B_API_KEY"),
		Domain:         firstEnv("GATEWAY_AGS_DOMAIN", "E2B_DOMAIN"),
		APIURL:         firstEnv("GATEWAY_AGS_API_URL", "E2B_API_URL"),
		RequestTimeout: envDurationSeconds("GATEWAY_AGS_REQUEST_TIMEOUT_SECONDS", 300),
	})
	if err != nil {
		return nil, err
	}
	var additionalBackends []AgentSidecarBackendConfig
	if talosAPIKey := firstEnv("GATEWAY_TALOS_API_KEY", "TALOS_API_KEY"); talosAPIKey != "" {
		talosClient, err := NewAGSClient(AGSClientConfig{
			APIKey:         talosAPIKey,
			Domain:         firstNonEmpty(firstEnv("GATEWAY_TALOS_DOMAIN", "TALOS_DOMAIN"), "api.talos.ren"),
			APIURL:         firstNonEmpty(firstEnv("GATEWAY_TALOS_API_URL", "TALOS_API_URL"), "https://api.talos.ren"),
			RequestTimeout: envDurationSeconds("GATEWAY_TALOS_REQUEST_TIMEOUT_SECONDS", envDurationSeconds("GATEWAY_AGS_REQUEST_TIMEOUT_SECONDS", 300)),
		})
		if err != nil {
			return nil, err
		}
		talosTemplate := firstNonEmpty(firstEnv("GATEWAY_TALOS_TEMPLATE", "TALOS_TEMPLATE"), defaultTalosTemplateID)
		additionalBackends = append(additionalBackends, AgentSidecarBackendConfig{
			Name:            "talos",
			Client:          talosClient,
			OuterTemplateID: talosTemplate,
			InnerTemplateID: firstNonEmpty(firstEnv("GATEWAY_TALOS_INNER_TEMPLATE", "TALOS_INNER_TEMPLATE"), talosTemplate),
		})
	}
	return NewAgentSidecarWorker(AgentSidecarWorkerConfig{
		Client:                client,
		OuterTemplateID:       firstEnv("GATEWAY_AGENT_SIDECAR_OUTER_TEMPLATE", "GATEWAY_AGS_TEMPLATE", "OUTER_SANDBOX_TEMPLATE"),
		InnerTemplateID:       firstEnv("GATEWAY_AGENT_SIDECAR_INNER_TEMPLATE", "INNER_SANDBOX_TEMPLATE"),
		AdditionalBackends:    additionalBackends,
		SidecarBinaryPath:     firstEnv("GATEWAY_AGENT_SIDECAR_BINARY", "AGENT_SIDECAR_BINARY"),
		SidecarURL:            firstEnv("GATEWAY_AGENT_SIDECAR_URL", "AGENT_SIDECAR_URL"),
		SidecarSHA256:         firstEnv("GATEWAY_AGENT_SIDECAR_SHA256", "AGENT_SIDECAR_SHA256"),
		AgentLoaderPath:       firstEnv("GATEWAY_AGENT_LOADER_PATH", "AGENT_LOADER_PATH"),
		SandboxHostURL:        firstEnv("GATEWAY_SANDBOX_HOST_URL", "HERMES_SANDBOX_HOST_URL", "SANDBOX_HOST_URL"),
		SandboxHostSHA256:     firstEnv("GATEWAY_SANDBOX_HOST_SHA256", "HERMES_SANDBOX_HOST_SHA256", "SANDBOX_HOST_SHA256"),
		TokenHubAPIKey:        firstEnv("GATEWAY_TOKENHUB_API_KEY", "TOKENHUB_API_KEY"),
		TokenHubModel:         firstEnv("GATEWAY_TOKENHUB_MODEL", "TOKENHUB_MODEL"),
		ForceInnerCommand:     os.Getenv("GATEWAY_AGENT_FORCE_COMMAND"),
		SandboxTimeoutSeconds: envInt("GATEWAY_AGENT_SIDECAR_OUTER_TIMEOUT_SECONDS", 300),
		DeleteSandbox:         true,
	})
}

func (w *AgentSidecarWorker) backendForName(name string) (agentSidecarBackend, bool) {
	normalized := strings.ToLower(strings.TrimSpace(name))
	if normalized == "" {
		normalized = w.defaultBackendName
	}
	backend, ok := w.backends[normalized]
	return backend, ok
}

func (w *AgentSidecarWorker) backendForJob(job workerJob) (agentSidecarBackend, error) {
	if explicit := strings.TrimSpace(os.Getenv("GATEWAY_SANDBOX_BACKEND")); explicit != "" {
		if backend, ok := w.backendForName(explicit); ok {
			return backend, nil
		}
		return agentSidecarBackend{}, workerError("sandbox_backend_unavailable", fmt.Sprintf("sandbox backend %q is not configured", explicit))
	}
	model := strings.ToLower(strings.TrimSpace(job.Model))
	if strings.Contains(model, "talos") {
		if backend, ok := w.backendForName("talos"); ok {
			return backend, nil
		}
		return agentSidecarBackend{}, workerError("sandbox_backend_unavailable", "model requested talos backend, but GATEWAY_TALOS_API_KEY is not configured")
	}
	backend, ok := w.backendForName("")
	if !ok {
		return agentSidecarBackend{}, workerError("sandbox_backend_unavailable", "default sandbox backend is not configured")
	}
	return backend, nil
}

func (w *AgentSidecarWorker) backendForRuntime(runtime ACPSessionRuntime) (agentSidecarBackend, error) {
	if runtime.SandboxBackend != "" {
		if backend, ok := w.backendForName(runtime.SandboxBackend); ok {
			return backend, nil
		}
		return agentSidecarBackend{}, fmt.Errorf("sandbox backend %q is not configured", runtime.SandboxBackend)
	}
	backend, ok := w.backendForName("")
	if !ok {
		return agentSidecarBackend{}, fmt.Errorf("default sandbox backend is not configured")
	}
	return backend, nil
}

func (w *AgentSidecarWorker) StartSessionRuntime(ctx context.Context, req ACPSessionRuntimeStartRequest) (ACPSessionRuntime, error) {
	start := time.Now()
	backendName := firstNonEmpty(req.SandboxBackend, firstEnv("GATEWAY_ACP_SANDBOX_BACKEND", "GATEWAY_SANDBOX_BACKEND"))
	backend, ok := w.backendForName(backendName)
	if !ok {
		if strings.TrimSpace(backendName) != "" {
			return ACPSessionRuntime{}, fmt.Errorf("sandbox backend %q is not configured", backendName)
		}
		return ACPSessionRuntime{}, fmt.Errorf("default sandbox backend is not configured")
	}
	agentVersion := normalizeRuntimeVersion(req.AgentVersion, defaultAgentVersion)
	agentPlugin, err := agentBehaviorPluginFor(agentVersion)
	if err != nil {
		return ACPSessionRuntime{}, err
	}
	sidecarArtifact, err := validatedSidecarArtifact("session sidecar_artifact", req.SidecarArtifact)
	if err != nil {
		return ACPSessionRuntime{}, err
	}
	req.SidecarArtifact = sidecarArtifact
	workspaceVersion := normalizeRuntimeVersion(req.WorkspaceVersion, defaultWorkspaceVersion)
	workspaceSpec, err := workspaceRuntimeSpecFor(workspaceVersion)
	if err != nil {
		return ACPSessionRuntime{}, err
	}
	if templateID := strings.TrimSpace(agentPlugin.templateID); templateID != "" {
		backend.outerTemplateID = templateID
	}
	if templateID := strings.TrimSpace(workspaceSpec.templateID); templateID != "" {
		backend.innerTemplateID = templateID
	}
	timeline := func(event string, fields ...string) {
		all := []string{
			fmt.Sprintf("timeline source=go t=%.3fs", time.Since(start).Seconds()),
			"event=" + event,
			"mode=acp_session_runtime",
			"session_id=" + req.SessionID,
			fmt.Sprintf("generation=%d", req.Generation),
		}
		all = append(all, fields...)
		fmt.Fprintln(os.Stderr, strings.Join(all, " "))
	}
	timeline("acp_runtime_outer_create_start", "backend="+backend.name, "template="+backend.outerTemplateID, "agent_version="+agentVersion, "workspace_template="+backend.innerTemplateID, "workspace_version="+workspaceVersion)
	sb, err := backend.client.CreateSandbox(ctx, CreateSandboxOptions{
		TemplateID:          backend.outerTemplateID,
		TimeoutSeconds:      w.sandboxTimeoutSeconds,
		Secure:              true,
		AllowInternetAccess: true,
		Metadata: map[string]string{
			"session_id": req.SessionID,
			"mode":       "acp-session-runtime",
			"tenant_id":  req.Scope.TenantID,
			"project_id": req.Scope.ProjectID,
		},
	})
	if err != nil {
		timeline("acp_runtime_outer_create_failed", "error="+quoteTimelineField(err.Error()))
		return ACPSessionRuntime{}, err
	}
	timeline("acp_runtime_outer_create_done", "sandbox_id="+sb.SandboxID)
	runtime := ACPSessionRuntime{
		RuntimeID:            fmt.Sprintf("rt_%s_%d", req.SessionID, req.Generation),
		SandboxBackend:       backend.name,
		AgentVersion:         agentVersion,
		AgentTemplateID:      backend.outerTemplateID,
		WorkspaceVersion:     workspaceVersion,
		WorkspaceTemplateID:  backend.innerTemplateID,
		OuterSandboxID:       sb.SandboxID,
		OuterSandboxDomain:   sb.Domain,
		OuterEnvdAccessToken: sb.EnvdAccessToken,
		OuterTrafficToken:    sb.TrafficAccessToken,
		DaemonAddr:           acpDaemonAddr(req.SessionID),
		RemoteBinary:         path.Join("/tmp/gateway/sessions", req.SessionID, "hermes-sidecar"),
	}
	if err := w.bootSessionDaemon(ctx, sb, runtime, req); err != nil {
		timeline("acp_runtime_daemon_failed", "error="+quoteTimelineField(err.Error()))
		deleteCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		_ = backend.client.DeleteSandbox(deleteCtx, sb.SandboxID)
		return ACPSessionRuntime{}, err
	}
	timeline("acp_runtime_daemon_done", "sandbox_id="+sb.SandboxID, "addr="+quoteTimelineField(runtime.DaemonAddr))
	if len(req.History) > 0 {
		if err := w.bootstrapSessionDaemon(ctx, sb, runtime, req); err != nil {
			timeline("acp_runtime_bootstrap_failed", "error="+quoteTimelineField(err.Error()))
			deleteCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			_ = backend.client.DeleteSandbox(deleteCtx, sb.SandboxID)
			return ACPSessionRuntime{}, err
		}
		timeline("acp_runtime_bootstrap_done")
	}
	return runtime, nil
}

func (w *AgentSidecarWorker) ReattachSessionRuntime(ctx context.Context, runtime ACPSessionRuntime) (ACPSessionRuntime, error) {
	if runtime.OuterSandboxID == "" || runtime.OuterEnvdAccessToken == "" || runtime.RemoteBinary == "" || runtime.DaemonAddr == "" {
		return ACPSessionRuntime{}, fmt.Errorf("runtime identity is incomplete")
	}
	backend, err := w.backendForRuntime(runtime)
	if err != nil {
		return ACPSessionRuntime{}, err
	}
	sb := runtimeOuterSandbox(runtime)
	check := "curl -fsS " + shellQuote(runtime.DaemonAddr+"/health") + " 2>/dev/null | grep -q hermes-sidecar"
	if _, err := backend.client.RunCommand(ctx, sb, check, nil, nil, nil); err != nil {
		return ACPSessionRuntime{}, err
	}
	return runtime, nil
}

func (w *AgentSidecarWorker) runACPSessionPrompt(ctx context.Context, job workerJob, emit func(workerEvent) error) (workerResult, error) {
	start := time.Now()
	runtime := job.ACPSessionRuntime
	backend, err := w.backendForRuntime(runtime)
	if err != nil {
		return workerResult{}, err
	}
	sb := runtimeOuterSandbox(runtime)
	if len(job.InputFiles) > 0 {
		if err := w.stageSessionFiles(ctx, backend.client, sb, runtime, job); err != nil {
			return workerResult{}, err
		}
	}
	promptCommand := fmt.Sprintf(
		"%s client --addr %s prompt --prompt-b64 %s --job-id %s --response-id %s --cwd-b64 %s",
		shellQuote(runtime.RemoteBinary),
		shellQuote(runtime.DaemonAddr),
		shellQuote(base64.StdEncoding.EncodeToString([]byte(job.Instruction))),
		shellQuote(job.JobID),
		shellQuote(job.ResponseID),
		shellQuote(base64.StdEncoding.EncodeToString([]byte(job.CWD))),
	)
	cancelCommand := fmt.Sprintf(
		"%s client --addr %s cancel --job-id %s >/dev/null 2>&1 || true",
		shellQuote(runtime.RemoteBinary),
		shellQuote(runtime.DaemonAddr),
		shellQuote(job.JobID),
	)
	command := "trap " + shellQuote(cancelCommand) + " TERM INT; " + promptCommand
	var deltaSeq int64
	var eventSeq int64
	var streamedOutput strings.Builder
	stdoutParser := &sidecarStdoutParser{}
	emitStdoutEvents := func(events []sidecarStdoutEvent) error {
		for _, event := range events {
			workerEvent, textDelta := workerEventFromSidecarEvent(job.JobID, atomic.AddInt64(&eventSeq, 1), event)
			if workerEvent.Kind == "" {
				continue
			}
			if textDelta {
				atomic.AddInt64(&deltaSeq, 1)
				streamedOutput.WriteString(event.Delta)
			}
			if emit == nil {
				continue
			}
			fmt.Fprintf(os.Stderr, "timeline source=go t=%.3fs event=acp_runtime_stream_delta mode=acp_session_runtime session_id=%s generation=%d outer_sandbox_id=%s job_id=%s kind=%s seq=%d delta_bytes=%d\n", time.Since(start).Seconds(), job.ACPSessionID, job.ACPSessionGeneration, runtime.OuterSandboxID, job.JobID, workerEvent.Kind, workerEvent.Sequence, len(event.Delta))
			if err := emit(workerEvent); err != nil {
				fmt.Fprintf(os.Stderr, "timeline source=go t=%.3fs event=acp_runtime_stream_emit_failed mode=acp_session_runtime session_id=%s generation=%d outer_sandbox_id=%s job_id=%s kind=%s seq=%d delta_bytes=%d error=%q\n", time.Since(start).Seconds(), job.ACPSessionID, job.ACPSessionGeneration, runtime.OuterSandboxID, job.JobID, workerEvent.Kind, workerEvent.Sequence, len(event.Delta), err.Error())
				return err
			}
			fmt.Fprintf(os.Stderr, "timeline source=go t=%.3fs event=acp_runtime_stream_emit_done mode=acp_session_runtime session_id=%s generation=%d outer_sandbox_id=%s job_id=%s kind=%s seq=%d delta_bytes=%d\n", time.Since(start).Seconds(), job.ACPSessionID, job.ACPSessionGeneration, runtime.OuterSandboxID, job.JobID, workerEvent.Kind, workerEvent.Sequence, len(event.Delta))
		}
		return nil
	}
	fmt.Fprintf(os.Stderr, "timeline source=go t=%.3fs event=acp_runtime_prompt_start mode=acp_session_runtime session_id=%s generation=%d outer_sandbox_id=%s\n", time.Since(start).Seconds(), job.ACPSessionID, job.ACPSessionGeneration, runtime.OuterSandboxID)
	result, err := backend.client.RunCommand(ctx, sb, command, nil, func(text string) error {
		return emitStdoutEvents(stdoutParser.Feed(text))
	}, func(text string) error {
		logRemoteStderr(start, workerJob{JobID: job.JobID, ResponseID: job.ResponseID}, text)
		return nil
	})
	if err != nil {
		if runErr, ok := parseAgentRunErrorEnvelope(result.Stdout); ok {
			fmt.Fprintf(os.Stderr, "timeline source=go t=%.3fs event=acp_runtime_prompt_agent_error mode=acp_session_runtime session_id=%s generation=%d outer_sandbox_id=%s job_id=%s code=%s message=%s\n", time.Since(start).Seconds(), job.ACPSessionID, job.ACPSessionGeneration, runtime.OuterSandboxID, job.JobID, runErr.Code, quoteTimelineField(runErr.Message))
			return workerResult{}, workerFailureFromAgentRunError(runErr)
		}
		fmt.Fprintf(os.Stderr, "timeline source=go t=%.3fs event=acp_runtime_prompt_failed mode=acp_session_runtime session_id=%s generation=%d outer_sandbox_id=%s job_id=%s error=%s\n", time.Since(start).Seconds(), job.ACPSessionID, job.ACPSessionGeneration, runtime.OuterSandboxID, job.JobID, quoteTimelineField(err.Error()))
		return workerResult{}, fmt.Errorf("acp prompt sidecar client session_id=%s generation=%d job_id=%s outer_sandbox_id=%s: %w", job.ACPSessionID, job.ACPSessionGeneration, job.JobID, runtime.OuterSandboxID, err)
	}
	if err := emitStdoutEvents(stdoutParser.Finish()); err != nil {
		return workerResult{}, err
	}
	envelope, sawEnvelope := parseAgentRunEnvelope(result.Stdout)
	if runErr, ok := parseAgentRunErrorEnvelope(result.Stdout); ok {
		fmt.Fprintf(os.Stderr, "timeline source=go t=%.3fs event=acp_runtime_result_error mode=acp_session_runtime session_id=%s generation=%d outer_sandbox_id=%s job_id=%s code=%s message=%s stdout_bytes=%d\n", time.Since(start).Seconds(), job.ACPSessionID, job.ACPSessionGeneration, runtime.OuterSandboxID, job.JobID, runErr.Code, quoteTimelineField(runErr.Message), len(result.Stdout))
		return workerResult{}, workerFailureFromAgentRunError(runErr)
	}
	output := envelope.OutputText
	if output == "" && !sawEnvelope {
		output = parseAgentOutput(result.Stdout)
	}
	if output == "" && streamedOutput.Len() > 0 {
		output = streamedOutput.String()
	}
	fmt.Fprintf(os.Stderr, "timeline source=go t=%.3fs event=acp_runtime_result_envelope mode=acp_session_runtime session_id=%s generation=%d outer_sandbox_id=%s job_id=%s saw_result=%t stdout_bytes=%d streamed_bytes=%d output_bytes=%d inner_sandbox_id=%s\n", time.Since(start).Seconds(), job.ACPSessionID, job.ACPSessionGeneration, runtime.OuterSandboxID, job.JobID, sawEnvelope, len(result.Stdout), streamedOutput.Len(), len(output), envelope.InnerSandboxID)
	if output == "" && sawEnvelope {
		return workerResult{}, workerError("agent_empty_output", fmt.Sprintf("sidecar returned WRAPPER_RESULT_JSON with empty output_text session_id=%s generation=%d job_id=%s outer_sandbox_id=%s inner_sandbox_id=%s stdout_bytes=%d", job.ACPSessionID, job.ACPSessionGeneration, job.JobID, runtime.OuterSandboxID, envelope.InnerSandboxID, len(result.Stdout)))
	}
	if output == "" {
		output = stripWrapperControlLines(result.Stdout)
	}
	if output == "" {
		return workerResult{}, workerError("agent_empty_output", fmt.Sprintf("sidecar returned empty output session_id=%s generation=%d job_id=%s outer_sandbox_id=%s stdout_bytes=%d", job.ACPSessionID, job.ACPSessionGeneration, job.JobID, runtime.OuterSandboxID, len(result.Stdout)))
	}
	if emit != nil && output != "" && atomic.LoadInt64(&deltaSeq) == 0 {
		if err := emit(workerEvent{
			WorkerContractVersion: WorkerContractVersion,
			EventID:               "evt_" + job.JobID + "_acp_session_final",
			JobID:                 job.JobID,
			Sequence:              1,
			Kind:                  "output_text_delta",
			Timestamp:             time.Now().UTC().Unix(),
			Delta:                 output,
		}); err != nil {
			return workerResult{}, err
		}
	} else if emit != nil && output != "" {
		if delta := missingFinalDelta(output, streamedOutput.String()); delta != "" {
			seq := atomic.AddInt64(&deltaSeq, 1)
			if err := emit(workerEvent{
				WorkerContractVersion: WorkerContractVersion,
				EventID:               "evt_" + job.JobID + "_acp_session_final_tail",
				JobID:                 job.JobID,
				Sequence:              seq,
				Kind:                  "output_text_delta",
				Timestamp:             time.Now().UTC().Unix(),
				Delta:                 delta,
			}); err != nil {
				return workerResult{}, err
			}
		}
	}
	fmt.Fprintf(os.Stderr, "timeline source=go t=%.3fs event=acp_runtime_prompt_done mode=acp_session_runtime session_id=%s generation=%d outer_sandbox_id=%s inner_sandbox_id=%s\n", time.Since(start).Seconds(), job.ACPSessionID, job.ACPSessionGeneration, runtime.OuterSandboxID, envelope.InnerSandboxID)
	return workerResult{
		WorkerContractVersion: WorkerContractVersion,
		JobID:                 job.JobID,
		Status:                "completed",
		OutputText:            output,
		RuntimeUpdate: ACPSessionRuntimeUpdate{
			InnerSandboxID:       envelope.InnerSandboxID,
			InnerSandboxDomain:   envelope.InnerSandboxDomain,
			InnerEnvdAccessToken: envelope.InnerEnvdAccessToken,
		},
	}, nil
}

type sidecarEnsureInnerResponse struct {
	InnerSandboxID       string `json:"inner_sandbox_id"`
	InnerSandboxDomain   string `json:"inner_sandbox_domain"`
	InnerEnvdAccessToken string `json:"inner_envd_access_token"`
}

func (w *AgentSidecarWorker) EnsureSessionEnvdRuntime(ctx context.Context, runtime ACPSessionRuntime, req ACPSessionRuntimeEnsureRequest) (ACPSessionRuntimeUpdate, error) {
	backend, err := w.backendForRuntime(runtime)
	if err != nil {
		return ACPSessionRuntimeUpdate{}, err
	}
	sb := runtimeOuterSandbox(runtime)
	command := w.ensureInnerCommand(runtime, req.Force)
	fmt.Fprintf(os.Stderr, "timeline source=go event=ensure_inner_envd_command_start mode=acp_session_runtime session_id=%s generation=%d outer_sandbox_id=%s force=%t has_inner_target=%t daemon_addr=%s\n", req.SessionID, req.Generation, runtime.OuterSandboxID, req.Force, runtime.hasInnerEnvdTarget(), quoteTimelineField(runtime.DaemonAddr))
	result, err := backend.client.RunCommand(ctx, sb, command, nil, nil, func(text string) error {
		logRemoteStderr(time.Now(), workerJob{JobID: "acp_ensure_inner", ResponseID: req.SessionID}, text)
		return nil
	})
	if err != nil {
		detail := commandFailureDetail(err, result)
		fmt.Fprintf(os.Stderr, "timeline source=go event=ensure_inner_envd_command_failed mode=acp_session_runtime session_id=%s generation=%d outer_sandbox_id=%s stdout_bytes=%d stderr_bytes=%d error=%s\n", req.SessionID, req.Generation, runtime.OuterSandboxID, len(result.Stdout), len(result.Stderr), quoteTimelineField(detail))
		return ACPSessionRuntimeUpdate{}, fmt.Errorf("ensure inner envd session_id=%s generation=%d outer_sandbox_id=%s: %s", req.SessionID, req.Generation, runtime.OuterSandboxID, detail)
	}
	var response sidecarEnsureInnerResponse
	if err := json.Unmarshal([]byte(strings.TrimSpace(result.Stdout)), &response); err != nil {
		fmt.Fprintf(os.Stderr, "timeline source=go event=ensure_inner_envd_parse_failed mode=acp_session_runtime session_id=%s generation=%d outer_sandbox_id=%s stdout_bytes=%d stderr_bytes=%d error=%s\n", req.SessionID, req.Generation, runtime.OuterSandboxID, len(result.Stdout), len(result.Stderr), quoteTimelineField(err.Error()))
		return ACPSessionRuntimeUpdate{}, fmt.Errorf("parse ensure inner envd response session_id=%s generation=%d: %w stdout_bytes=%d", req.SessionID, req.Generation, err, len(result.Stdout))
	}
	if response.InnerSandboxID == "" || response.InnerSandboxDomain == "" || response.InnerEnvdAccessToken == "" {
		fmt.Fprintf(os.Stderr, "timeline source=go event=ensure_inner_envd_incomplete mode=acp_session_runtime session_id=%s generation=%d outer_sandbox_id=%s inner_sandbox_id=%s domain_set=%t token_set=%t\n", req.SessionID, req.Generation, runtime.OuterSandboxID, quoteTimelineField(response.InnerSandboxID), response.InnerSandboxDomain != "", response.InnerEnvdAccessToken != "")
		return ACPSessionRuntimeUpdate{}, fmt.Errorf("ensure inner envd returned incomplete identity session_id=%s generation=%d inner_sandbox_id=%q domain_set=%t token_set=%t", req.SessionID, req.Generation, response.InnerSandboxID, response.InnerSandboxDomain != "", response.InnerEnvdAccessToken != "")
	}
	fmt.Fprintf(os.Stderr, "timeline source=go event=ensure_inner_envd_command_done mode=acp_session_runtime session_id=%s generation=%d outer_sandbox_id=%s inner_sandbox_id=%s stdout_bytes=%d stderr_bytes=%d\n", req.SessionID, req.Generation, runtime.OuterSandboxID, response.InnerSandboxID, len(result.Stdout), len(result.Stderr))
	return ACPSessionRuntimeUpdate{
		InnerSandboxID:       response.InnerSandboxID,
		InnerSandboxDomain:   response.InnerSandboxDomain,
		InnerEnvdAccessToken: response.InnerEnvdAccessToken,
	}, nil
}

func (w *AgentSidecarWorker) ensureInnerCommand(runtime ACPSessionRuntime, force bool) string {
	command := shellQuote(runtime.RemoteBinary) + " client --addr " + shellQuote(runtime.DaemonAddr) + " ensure-inner"
	if force || !runtime.hasInnerEnvdTarget() {
		command += " --force"
	}
	return command
}

func (w *AgentSidecarWorker) stageSessionFiles(ctx context.Context, client *AGSClient, sb AGSSandbox, runtime ACPSessionRuntime, job workerJob) error {
	manifest := sidecarStageFilesManifest{
		SessionID:     job.ACPSessionID,
		Generation:    job.ACPSessionGeneration,
		WorkspaceRoot: acpRuntimeCWD,
		Files:         make([]sidecarStageFileEntry, 0, len(job.InputFiles)),
	}
	for _, file := range job.InputFiles {
		workspacePath := strings.TrimSpace(file.WorkspacePath)
		if workspacePath == "" {
			return fmt.Errorf("input file %s missing workspace path", file.FileID)
		}
		relativePath := strings.TrimPrefix(workspacePath, "./")
		if strings.HasPrefix(relativePath, "/") || strings.HasPrefix(relativePath, "../") {
			return fmt.Errorf("input file %s has unsafe workspace path %q", file.FileID, workspacePath)
		}
		content, err := os.ReadFile(file.Path)
		if err != nil {
			return fmt.Errorf("read input file %s: %w", file.FileID, err)
		}
		outerPath := path.Join(acpRuntimeCWD, relativePath)
		if err := client.UploadFile(ctx, sb, outerPath, file.Filename, content); err != nil {
			return fmt.Errorf("stage input file %s to outer sandbox: %w", file.FileID, err)
		}
		manifest.Files = append(manifest.Files, sidecarStageFileEntry{
			FileID:        file.FileID,
			Name:          file.Filename,
			MimeType:      file.ContentType,
			Bytes:         file.Bytes,
			SHA256:        file.SHA256,
			OuterPath:     outerPath,
			WorkspacePath: workspacePath,
		})
	}
	payload, err := json.Marshal(manifest)
	if err != nil {
		return err
	}
	command := shellQuote(runtime.RemoteBinary) +
		" client --addr " + shellQuote(runtime.DaemonAddr) +
		" stage-files --manifest-b64 " + shellQuote(base64.StdEncoding.EncodeToString(payload))
	_, err = client.RunCommand(ctx, sb, command, nil, nil, func(text string) error {
		logRemoteStderr(time.Now(), workerJob{JobID: job.JobID, ResponseID: job.ResponseID}, text)
		return nil
	})
	if err != nil {
		return fmt.Errorf("stage input files session_id=%s generation=%d outer_sandbox_id=%s: %w", job.ACPSessionID, job.ACPSessionGeneration, sb.SandboxID, err)
	}
	return nil
}

type sidecarStageFilesManifest struct {
	SessionID     string                  `json:"session_id"`
	Generation    int64                   `json:"generation"`
	WorkspaceRoot string                  `json:"workspace_root"`
	Files         []sidecarStageFileEntry `json:"files"`
}

type sidecarStageFileEntry struct {
	FileID        string `json:"file_id"`
	Name          string `json:"name"`
	MimeType      string `json:"mime_type"`
	Bytes         int64  `json:"bytes"`
	SHA256        string `json:"sha256"`
	OuterPath     string `json:"outer_path"`
	WorkspacePath string `json:"workspace_path"`
}

func (w *AgentSidecarWorker) CloseSessionRuntime(ctx context.Context, runtime ACPSessionRuntime) error {
	backend, err := w.backendForRuntime(runtime)
	if err != nil {
		return err
	}
	var cleanupErr error
	if runtime.InnerSandboxID != "" {
		if err := backend.client.DeleteSandbox(ctx, runtime.InnerSandboxID); err != nil {
			cleanupErr = errors.Join(cleanupErr, fmt.Errorf("delete inner sandbox %s: %w", runtime.InnerSandboxID, err))
		}
	}
	if runtime.OuterSandboxID == "" {
		return cleanupErr
	}
	if runtime.RemoteBinary != "" && runtime.DaemonAddr != "" {
		sb := runtimeOuterSandbox(runtime)
		cancelCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
		_, _ = backend.client.RunCommand(cancelCtx, sb, shellQuote(runtime.RemoteBinary)+" client --addr "+shellQuote(runtime.DaemonAddr)+" cancel", nil, nil, nil)
		cancel()
		shutdownCtx, shutdownCancel := context.WithTimeout(ctx, 3*time.Second)
		_, _ = backend.client.RunCommand(shutdownCtx, sb, shellQuote(runtime.RemoteBinary)+" client --addr "+shellQuote(runtime.DaemonAddr)+" shutdown", nil, nil, nil)
		shutdownCancel()
	}
	if err := backend.client.DeleteSandbox(ctx, runtime.OuterSandboxID); err != nil {
		cleanupErr = errors.Join(cleanupErr, fmt.Errorf("delete outer sandbox %s: %w", runtime.OuterSandboxID, err))
	}
	return cleanupErr
}

func (w *AgentSidecarWorker) CancelSessionRuntime(ctx context.Context, runtime ACPSessionRuntime, jobID string) error {
	if runtime.OuterSandboxID == "" || runtime.RemoteBinary == "" || runtime.DaemonAddr == "" {
		return nil
	}
	backend, err := w.backendForRuntime(runtime)
	if err != nil {
		return err
	}
	sb := runtimeOuterSandbox(runtime)
	command := shellQuote(runtime.RemoteBinary) + " client --addr " + shellQuote(runtime.DaemonAddr) + " cancel"
	if jobID != "" {
		command += " --job-id " + shellQuote(jobID)
	}
	_, err = backend.client.RunCommand(ctx, sb, command, nil, nil, nil)
	return err
}

type agentBehaviorPlugin struct {
	version         string
	templateID      string
	sidecarURL      string
	sidecarSHA256   string
	sidecarSigURL   string
	signingKeyID    string
	buildInitScript func(agentInitScriptContext) string
}

type workspaceRuntimeSpec struct {
	version    string
	templateID string
}

type agentBehaviorRegistryEntry struct {
	TemplateID    string `json:"template_id"`
	SidecarURL    string `json:"sidecar_url"`
	SidecarSHA256 string `json:"sidecar_sha256"`
	SidecarSigURL string `json:"sidecar_sig_url"`
	SigningKeyID  string `json:"signing_key_id"`
}

type agentSidecarArtifact struct {
	URL          string
	SHA256       string
	SigURL       string
	SigningKeyID string
}

type agentInitScriptContext struct {
	Prepare        string
	Workspace      string
	WorkspaceOwner string
	Runtime        ACPSessionRuntime
	SessionID      string
	ListenAddr     string
	MemoryDir      string
	LogPath        string
	PIDPath        string
	DaemonCommand  string
}

func agentBehaviorPluginFor(version string) (agentBehaviorPlugin, error) {
	version = normalizeRuntimeVersion(version, defaultAgentVersion)
	switch version {
	case "builtin.v1", "default":
		return agentBehaviorPlugin{version: version, buildInitScript: buildBuiltinAgentInitScript}, nil
	}
	if plugin, ok, err := agentBehaviorPluginFromEnvRegistry(version); err != nil {
		return agentBehaviorPlugin{}, err
	} else if ok {
		return plugin, nil
	}
	return agentBehaviorPlugin{}, fmt.Errorf("agent version %q is not registered", version)
}

func workspaceRuntimeSpecFor(version string) (workspaceRuntimeSpec, error) {
	version = normalizeRuntimeVersion(version, defaultWorkspaceVersion)
	switch version {
	case "builtin.v1", "default":
		return workspaceRuntimeSpec{version: version}, nil
	default:
		return workspaceRuntimeSpec{}, fmt.Errorf("workspace version %q is not registered", version)
	}
}

func normalizeRuntimeVersion(version, fallback string) string {
	version = strings.TrimSpace(version)
	if version == "" {
		return fallback
	}
	return version
}

func agentBehaviorPluginFromEnvRegistry(version string) (agentBehaviorPlugin, bool, error) {
	raw := firstEnv("GATEWAY_AGENT_VERSION_REGISTRY_JSON", "AGENT_VERSION_REGISTRY_JSON")
	if raw == "" {
		return agentBehaviorPlugin{}, false, nil
	}
	var registry map[string]agentBehaviorRegistryEntry
	if err := json.Unmarshal([]byte(raw), &registry); err != nil {
		return agentBehaviorPlugin{}, false, fmt.Errorf("agent version registry is invalid: %w", err)
	}
	entry, ok := registry[version]
	if !ok {
		return agentBehaviorPlugin{}, false, nil
	}
	plugin := agentBehaviorPlugin{
		version:         version,
		templateID:      strings.TrimSpace(entry.TemplateID),
		sidecarURL:      strings.TrimSpace(entry.SidecarURL),
		sidecarSHA256:   normalizeSHA256(entry.SidecarSHA256),
		sidecarSigURL:   strings.TrimSpace(entry.SidecarSigURL),
		signingKeyID:    strings.TrimSpace(entry.SigningKeyID),
		buildInitScript: buildBuiltinAgentInitScript,
	}
	artifact, err := validatedSidecarArtifact("agent version "+strconv.Quote(version), agentSidecarArtifact{
		URL:          plugin.sidecarURL,
		SHA256:       plugin.sidecarSHA256,
		SigURL:       plugin.sidecarSigURL,
		SigningKeyID: plugin.signingKeyID,
	})
	if err != nil {
		return agentBehaviorPlugin{}, false, err
	}
	if artifact.URL == "" {
		return plugin, true, nil
	}
	plugin.sidecarURL = artifact.URL
	plugin.sidecarSHA256 = artifact.SHA256
	plugin.sidecarSigURL = artifact.SigURL
	plugin.signingKeyID = artifact.SigningKeyID
	return plugin, true, nil
}

func normalizeSHA256(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

func isSHA256Hex(value string) bool {
	if len(value) != 64 {
		return false
	}
	for _, ch := range value {
		if (ch < '0' || ch > '9') && (ch < 'a' || ch > 'f') {
			return false
		}
	}
	return true
}

func isAllowedSidecarURL(value string) bool {
	return strings.HasPrefix(value, "https://") || strings.HasPrefix(value, "http://")
}

func validatedSidecarArtifact(source string, artifact agentSidecarArtifact) (agentSidecarArtifact, error) {
	artifact.URL = strings.TrimSpace(artifact.URL)
	artifact.SHA256 = normalizeSHA256(artifact.SHA256)
	artifact.SigURL = strings.TrimSpace(artifact.SigURL)
	artifact.SigningKeyID = strings.TrimSpace(artifact.SigningKeyID)
	if artifact.URL == "" {
		if artifact.SHA256 != "" || artifact.SigURL != "" || artifact.SigningKeyID != "" {
			return agentSidecarArtifact{}, fmt.Errorf("%s sidecar_url is required when sidecar artifact fields are set", source)
		}
		return agentSidecarArtifact{}, nil
	}
	if !isAllowedSidecarURL(artifact.URL) {
		return agentSidecarArtifact{}, fmt.Errorf("%s sidecar_url must be an http(s) URL", source)
	}
	if artifact.SHA256 != "" && !isSHA256Hex(artifact.SHA256) {
		return agentSidecarArtifact{}, fmt.Errorf("%s sidecar_sha256 is invalid", source)
	}
	if artifact.SigURL == "" {
		artifact.SigURL = derivedSidecarSignatureURL(artifact.URL)
	}
	if !isAllowedSidecarURL(artifact.SigURL) {
		return agentSidecarArtifact{}, fmt.Errorf("%s sidecar_sig_url must be an http(s) URL", source)
	}
	if artifact.SigningKeyID == "" {
		artifact.SigningKeyID = defaultSigningKeyID
	}
	return artifact, nil
}

func derivedSidecarSignatureURL(sidecarURL string) string {
	parsed, err := url.Parse(sidecarURL)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return sidecarURL + ".sig"
	}
	parsed.Path += ".sig"
	return parsed.String()
}

func (w *AgentSidecarWorker) defaultSidecarArtifact() agentSidecarArtifact {
	return agentSidecarArtifact{
		URL:    strings.TrimSpace(w.sidecarURL),
		SHA256: normalizeSHA256(w.sidecarSHA256),
	}
}

func resolvedSidecarArtifact(requested agentSidecarArtifact, plugin agentBehaviorPlugin, fallback agentSidecarArtifact) agentSidecarArtifact {
	if requested.URL != "" {
		return requested
	}
	if plugin.sidecarURL != "" {
		return agentSidecarArtifact{
			URL:          plugin.sidecarURL,
			SHA256:       plugin.sidecarSHA256,
			SigURL:       plugin.sidecarSigURL,
			SigningKeyID: plugin.signingKeyID,
		}
	}
	return fallback
}

func (artifact agentSidecarArtifact) signed() bool {
	return artifact.URL != "" && artifact.SigURL != "" && artifact.SigningKeyID != ""
}

func sidecarDownloadCommand(remoteBinary string, artifact agentSidecarArtifact) string {
	download := "mkdir -p " + shellQuote(path.Dir(remoteBinary)) +
		" && curl -fsSL --show-error --retry 3 --retry-delay 1 --connect-timeout 10 --max-time 180 -o " + shellQuote(remoteBinary) + " " + shellQuote(artifact.URL)
	if artifact.SHA256 != "" {
		download += " && printf '%s  %s\\n' " + shellQuote(artifact.SHA256) + " " + shellQuote(remoteBinary) + " | sha256sum -c -"
	}
	return download
}

func sidecarLoaderCommand(loaderPath, remoteBinary string, artifact agentSidecarArtifact, args ...string) string {
	parts := []string{
		shellQuote(loaderPath),
		"--url", shellQuote(artifact.URL),
		"--output", shellQuote(remoteBinary),
		"--sig-url", shellQuote(artifact.SigURL),
		"--key-id", shellQuote(artifact.SigningKeyID),
	}
	if artifact.SHA256 != "" {
		parts = append(parts, "--sha256", shellQuote(artifact.SHA256))
	}
	parts = append(parts, "--")
	for _, arg := range args {
		parts = append(parts, shellQuote(arg))
	}
	return strings.Join(parts, " ")
}

func sidecarPlainCommand(remoteBinary string, args ...string) string {
	parts := []string{shellQuote(remoteBinary)}
	for _, arg := range args {
		parts = append(parts, shellQuote(arg))
	}
	return strings.Join(parts, " ")
}

func buildBuiltinAgentInitScript(ctx agentInitScriptContext) string {
	daemonCommand := ctx.DaemonCommand
	if daemonCommand == "" {
		daemonCommand = shellQuote(ctx.Runtime.RemoteBinary)
	}
	return ctx.Prepare +
		" && sudo -n mkdir -p " + shellQuote(ctx.Workspace) +
		" && sudo -n chown " + shellQuote(ctx.WorkspaceOwner+":"+ctx.WorkspaceOwner) + " " + shellQuote(ctx.Workspace) +
		" && mkdir -p " + shellQuote(ctx.MemoryDir) +
		" && printf '%s\\n' " + shellQuote("timeline source=daemon_launcher event=start workspace="+ctx.Workspace+" argv="+ctx.Runtime.RemoteBinary+" daemon --addr "+ctx.ListenAddr+" --session-id "+ctx.SessionID) + " >> " + shellQuote(ctx.LogPath) +
		" && ( nohup " + daemonCommand +
		" > " + shellQuote(ctx.LogPath) + " 2>&1 < /dev/null & echo $! > " + shellQuote(ctx.PIDPath) + " )"
}

func (w *AgentSidecarWorker) bootSessionDaemon(ctx context.Context, sb AGSSandbox, runtime ACPSessionRuntime, req ACPSessionRuntimeStartRequest) error {
	backend, err := w.backendForRuntime(runtime)
	if err != nil {
		return err
	}
	sessionRoot := path.Dir(runtime.RemoteBinary)
	workspace := acpRuntimeCWD
	memoryDir := path.Join(sessionRoot, "memory")
	logPath := path.Join(sessionRoot, "daemon.log")
	pidPath := path.Join(sessionRoot, "daemon.pid")
	listenAddr := strings.TrimPrefix(runtime.DaemonAddr, "http://")
	listenAddr = strings.TrimPrefix(listenAddr, "https://")
	plugin, err := agentBehaviorPluginFor(runtime.AgentVersion)
	if err != nil {
		return err
	}
	artifact := resolvedSidecarArtifact(req.SidecarArtifact, plugin, w.defaultSidecarArtifact())
	var prepare string
	var daemonCommand string
	daemonArgs := []string{
		"daemon",
		"--addr", listenAddr,
		"--session-id", req.SessionID,
		"--workspace", workspace,
		"--memory-dir", memoryDir,
	}
	if artifact.signed() {
		prepare = "mkdir -p " + shellQuote(sessionRoot)
		daemonCommand = sidecarLoaderCommand(w.agentLoaderPath, runtime.RemoteBinary, artifact, daemonArgs...)
	} else if artifact.URL != "" {
		prepare = sidecarDownloadCommand(runtime.RemoteBinary, artifact)
		prepare += " && chmod +x " + shellQuote(runtime.RemoteBinary)
		daemonCommand = sidecarPlainCommand(runtime.RemoteBinary, daemonArgs...)
	} else {
		binary, err := os.ReadFile(w.sidecarBinaryPath)
		if err != nil {
			return err
		}
		if err := backend.client.UploadFile(ctx, sb, runtime.RemoteBinary, "hermes-sidecar", binary); err != nil {
			return err
		}
		prepare = "mkdir -p " + shellQuote(sessionRoot)
		prepare += " && chmod +x " + shellQuote(runtime.RemoteBinary)
		daemonCommand = sidecarPlainCommand(runtime.RemoteBinary, daemonArgs...)
	}
	env := map[string]string{
		"TOKENHUB_API_KEY":              w.tokenHubAPIKey,
		"TOKENHUB_MODEL":                w.tokenHubModel,
		"E2B_API_KEY":                   backend.client.apiKey,
		"E2B_API_URL":                   backend.client.apiURL,
		"E2B_DOMAIN":                    backend.client.domain,
		"INNER_SANDBOX_TEMPLATE":        firstNonEmpty(runtime.WorkspaceTemplateID, backend.innerTemplateID),
		"INNER_SANDBOX_COMMAND":         w.forceInnerCommand,
		"INNER_SANDBOX_TIMEOUT":         "300",
		"CLOUDAGENT_AGENT_VERSION":      runtime.AgentVersion,
		"CLOUDAGENT_AGENT_TEMPLATE_ID":  runtime.AgentTemplateID,
		"CLOUDAGENT_WORKSPACE_VERSION":  runtime.WorkspaceVersion,
		"CLOUDAGENT_WORKSPACE_TEMPLATE": runtime.WorkspaceTemplateID,
		"OPENAI_AGENTS_DISABLE_TRACING": "1",
	}
	w.addSandboxHostEnv(env)
	for key, value := range runtimeClockEnv(time.Now()) {
		env[key] = value
	}
	workspaceOwner := backend.client.envdUser
	if workspaceOwner == "" {
		workspaceOwner = "user"
	}
	command := plugin.buildInitScript(agentInitScriptContext{
		Prepare:        prepare,
		Workspace:      workspace,
		WorkspaceOwner: workspaceOwner,
		Runtime:        runtime,
		SessionID:      req.SessionID,
		ListenAddr:     listenAddr,
		MemoryDir:      memoryDir,
		LogPath:        logPath,
		PIDPath:        pidPath,
		DaemonCommand:  daemonCommand,
	})
	command = w.sandboxHostEnvPrefix() + command
	if _, err := backend.client.RunCommand(ctx, sb, command, env, nil, func(text string) error {
		logRemoteStderr(time.Now(), workerJob{JobID: "acp_daemon_start", ResponseID: req.SessionID}, text)
		return nil
	}); err != nil {
		return fmt.Errorf("acp daemon start session_id=%s generation=%d outer_sandbox_id=%s: %w", req.SessionID, req.Generation, sb.SandboxID, err)
	}
	health := "for i in $(seq 1 240); do curl -fsS " + shellQuote(runtime.DaemonAddr+"/health") + " 2>/dev/null | grep -q hermes-sidecar && exit 0; sleep 0.5; done; cat " + shellQuote(logPath) + " >&2; exit 1"
	_, err = backend.client.RunCommand(ctx, sb, health, nil, nil, func(text string) error {
		logRemoteStderr(time.Now(), workerJob{JobID: "acp_daemon_health", ResponseID: req.SessionID}, text)
		return nil
	})
	if err != nil {
		return fmt.Errorf("acp daemon health session_id=%s generation=%d outer_sandbox_id=%s: %w", req.SessionID, req.Generation, sb.SandboxID, err)
	}
	return nil
}

func runtimeOuterSandbox(runtime ACPSessionRuntime) AGSSandbox {
	return AGSSandbox{
		SandboxID:          runtime.OuterSandboxID,
		Domain:             runtime.OuterSandboxDomain,
		EnvdAccessToken:    runtime.OuterEnvdAccessToken,
		TrafficAccessToken: runtime.OuterTrafficToken,
	}
}

func acpDaemonAddr(sessionID string) string {
	port := 38000 + int(crc32.ChecksumIEEE([]byte(sessionID))%9000)
	return fmt.Sprintf("http://127.0.0.1:%d", port)
}

func (w *AgentSidecarWorker) bootstrapSessionDaemon(ctx context.Context, sb AGSSandbox, runtime ACPSessionRuntime, req ACPSessionRuntimeStartRequest) error {
	backend, err := w.backendForRuntime(runtime)
	if err != nil {
		return err
	}
	history := make([]sidecarHistoryEntry, 0, len(req.History))
	for _, entry := range req.History {
		if entry.Text == "" {
			continue
		}
		history = append(history, sidecarHistoryEntry{
			Role: entry.Role,
			Text: entry.Text,
		})
	}
	payload, err := json.Marshal(history)
	if err != nil {
		return err
	}
	command := shellQuote(runtime.RemoteBinary) +
		" client --addr " + shellQuote(runtime.DaemonAddr) + " bootstrap" +
		" --history-b64 " + shellQuote(base64.StdEncoding.EncodeToString(payload)) +
		" --cwd-b64 " + shellQuote(base64.StdEncoding.EncodeToString([]byte(req.CWD)))
	_, err = backend.client.RunCommand(ctx, sb, command, nil, nil, func(text string) error {
		logRemoteStderr(time.Now(), workerJob{JobID: "acp_daemon_bootstrap", ResponseID: req.SessionID}, text)
		return nil
	})
	return err
}

type sidecarHistoryEntry struct {
	Role string `json:"role"`
	Text string `json:"text"`
}

func parseAgentRunEnvelope(stdout string) (agentRunEnvelope, bool) {
	for _, line := range strings.Split(stdout, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "WRAPPER_RESULT_JSON=") {
			continue
		}
		raw := strings.TrimPrefix(line, "WRAPPER_RESULT_JSON=")
		var envelope agentRunEnvelope
		if err := json.Unmarshal([]byte(raw), &envelope); err == nil {
			return envelope, true
		}
	}
	return agentRunEnvelope{}, false
}

type agentRunErrorEnvelope struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func parseAgentRunErrorEnvelope(stdout string) (agentRunErrorEnvelope, bool) {
	for _, line := range strings.Split(stdout, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "WRAPPER_ERROR_JSON=") {
			continue
		}
		raw := strings.TrimPrefix(line, "WRAPPER_ERROR_JSON=")
		var envelope agentRunErrorEnvelope
		if err := json.Unmarshal([]byte(raw), &envelope); err == nil && envelope.Message != "" {
			if envelope.Code == "" {
				envelope.Code = "agent_runtime_error"
			}
			return envelope, true
		}
	}
	return agentRunErrorEnvelope{}, false
}

func workerFailureFromAgentRunError(envelope agentRunErrorEnvelope) error {
	switch envelope.Code {
	case "max_iterations_exceeded":
		return workerStop(envelope.Code, envelope.Message, "max_turn_requests")
	default:
		return workerError(envelope.Code, envelope.Message)
	}
}

func stripWrapperControlLines(stdout string) string {
	var lines []string
	for _, line := range strings.Split(stdout, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "WRAPPER_RESULT_JSON=") || strings.HasPrefix(trimmed, "WRAPPER_EVENT_JSON=") || strings.HasPrefix(trimmed, "WRAPPER_ERROR_JSON=") {
			continue
		}
		if trimmed == "" {
			continue
		}
		lines = append(lines, line)
	}
	return strings.TrimSpace(strings.Join(lines, "\n"))
}

func commandFailureDetail(err error, result CommandResult) string {
	if err == nil {
		return ""
	}
	parts := []string{err.Error()}
	if stderr := commandOutputTail(result.Stderr, 2000); stderr != "" {
		parts = append(parts, "stderr="+fmt.Sprintf("%q", redactCommandOutput(stderr)))
	}
	if stdout := commandOutputTail(result.Stdout, 2000); stdout != "" {
		parts = append(parts, "stdout="+fmt.Sprintf("%q", redactCommandOutput(stdout)))
	}
	return strings.Join(parts, " ")
}

func commandOutputTail(value string, limit int) string {
	value = strings.TrimSpace(value)
	if value == "" || limit <= 0 {
		return ""
	}
	if len(value) <= limit {
		return value
	}
	return "...[truncated]\n" + value[len(value)-limit:]
}

var commandOutputSensitivePattern = regexp.MustCompile(`(?i)(envd_access_token|traffic_access_token|api[_-]?key|access[_-]?token)(["'=:\s]+)([^"',\s}]+)`)

func redactCommandOutput(value string) string {
	return commandOutputSensitivePattern.ReplaceAllString(value, `$1$2<redacted>`)
}

func (w *AgentSidecarWorker) Run(ctx context.Context, job workerJob, emit func(workerEvent) error) (workerResult, error) {
	if job.isACPSessionPrompt() {
		return w.runACPSessionPrompt(ctx, job, emit)
	}

	start := time.Now()
	backend, err := w.backendForJob(job)
	if err != nil {
		return workerResult{}, err
	}
	timeline := func(event string, fields ...string) {
		all := []string{
			fmt.Sprintf("timeline source=go t=%.3fs", time.Since(start).Seconds()),
			"event=" + event,
			"mode=agent_injected",
			"job_id=" + job.JobID,
			"response_id=" + job.ResponseID,
		}
		all = append(all, fields...)
		fmt.Fprintln(os.Stderr, strings.Join(all, " "))
	}
	timeline("outer_create_start", "backend="+backend.name, "template="+backend.outerTemplateID)
	sb, err := backend.client.CreateSandbox(ctx, CreateSandboxOptions{
		TemplateID:          backend.outerTemplateID,
		TimeoutSeconds:      w.sandboxTimeoutSeconds,
		Secure:              true,
		AllowInternetAccess: true,
		Metadata: map[string]string{
			"response_id": job.ResponseID,
			"job_id":      job.JobID,
			"mode":        "agent-sidecar",
		},
	})
	if err != nil {
		timeline("outer_create_failed", "error="+quoteTimelineField(err.Error()))
		return workerResult{}, err
	}
	timeline("outer_create_done", "sandbox_id="+sb.SandboxID)
	if w.deleteSandbox {
		defer func() {
			timeline("outer_delete_start", "sandbox_id="+sb.SandboxID)
			deleteCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			if err := backend.client.DeleteSandbox(deleteCtx, sb.SandboxID); err != nil {
				timeline("outer_delete_failed", "error="+quoteTimelineField(err.Error()))
				return
			}
			timeline("outer_delete_done", "sandbox_id="+sb.SandboxID)
		}()
	}

	remoteBinary := path.Join("/tmp/gateway", job.JobID, "agent-sidecar")
	artifact := w.defaultSidecarArtifact()
	if artifact.URL != "" {
		timeline("sidecar_download_configured", "url="+quoteTimelineField(redactURL(artifact.URL)))
		timeline("sidecar_download_start")
	} else {
		binary, err := os.ReadFile(w.sidecarBinaryPath)
		if err != nil {
			return workerResult{}, err
		}
		timeline("sidecar_upload_start", fmt.Sprintf("bytes=%d", len(binary)))
		if err := backend.client.UploadFile(ctx, sb, remoteBinary, "agent-sidecar", binary); err != nil {
			timeline("sidecar_upload_failed", "error="+quoteTimelineField(err.Error()))
			return workerResult{}, err
		}
		timeline("sidecar_upload_done")
	}

	timeline("upload_inputs_start", fmt.Sprintf("count=%d", len(job.InputFiles)))
	remoteInputs, err := uploadWorkerInputs(ctx, backend.client, sb, job)
	if err != nil {
		timeline("upload_inputs_failed", "error="+quoteTimelineField(err.Error()))
		return workerResult{}, err
	}
	timeline("upload_inputs_done", fmt.Sprintf("count=%d", len(remoteInputs)))
	inputsJSON, err := marshalInputManifest(remoteInputs)
	if err != nil {
		return workerResult{}, err
	}

	env := map[string]string{
		"TOKENHUB_API_KEY":                w.tokenHubAPIKey,
		"TOKENHUB_MODEL":                  w.tokenHubModel,
		"E2B_API_KEY":                     backend.client.apiKey,
		"E2B_API_URL":                     backend.client.apiURL,
		"E2B_DOMAIN":                      backend.client.domain,
		"INNER_SANDBOX_TEMPLATE":          backend.innerTemplateID,
		"INNER_SANDBOX_COMMAND":           w.forceInnerCommand,
		"INNER_SANDBOX_TIMEOUT":           "300",
		"GATEWAY_INSTRUCTION":             job.Instruction,
		"GATEWAY_INSTRUCTION_B64":         base64.StdEncoding.EncodeToString([]byte(job.Instruction)),
		"GATEWAY_ARTIFACT_PATH":           w.artifactPath,
		"GATEWAY_INPUT_FILES_JSON":        inputsJSON,
		"GATEWAY_TIMELINE_START_UNIX_NS":  fmt.Sprintf("%d", start.UnixNano()),
		"GATEWAY_WORKER_CONTRACT_VERSION": WorkerContractVersion,
		"GATEWAY_JOB_ID":                  job.JobID,
		"GATEWAY_RESPONSE_ID":             job.ResponseID,
		"OPENAI_AGENTS_DISABLE_TRACING":   "1",
	}
	w.addSandboxHostEnv(env)
	for key, value := range runtimeClockEnv(time.Now()) {
		env[key] = value
	}
	timeline("sandbox_host_configured", fmt.Sprintf("url_set=%t", w.sandboxHostURL != ""))
	command := w.sandboxHostEnvPrefix() + w.sidecarCommand(remoteBinary)
	timeline("sidecar_command_start")
	var deltaSeq int64
	var eventSeq int64
	var streamedOutput strings.Builder
	stdoutParser := &sidecarStdoutParser{}
	emitStdoutEvents := func(events []sidecarStdoutEvent) error {
		for _, event := range events {
			workerEvent, textDelta := workerEventFromSidecarEvent(job.JobID, atomic.AddInt64(&eventSeq, 1), event)
			if workerEvent.Kind == "" {
				continue
			}
			if textDelta {
				atomic.AddInt64(&deltaSeq, 1)
				streamedOutput.WriteString(event.Delta)
			}
			if emit == nil {
				continue
			}
			timeline("sidecar_stream_delta", fmt.Sprintf("job_id=%s", job.JobID), "kind="+workerEvent.Kind, fmt.Sprintf("seq=%d", workerEvent.Sequence), fmt.Sprintf("delta_bytes=%d", len(event.Delta)))
			if err := emit(workerEvent); err != nil {
				timeline("sidecar_stream_emit_failed", fmt.Sprintf("job_id=%s", job.JobID), "kind="+workerEvent.Kind, fmt.Sprintf("seq=%d", workerEvent.Sequence), fmt.Sprintf("delta_bytes=%d", len(event.Delta)), "error="+quoteTimelineField(err.Error()))
				return err
			}
			timeline("sidecar_stream_emit_done", fmt.Sprintf("job_id=%s", job.JobID), "kind="+workerEvent.Kind, fmt.Sprintf("seq=%d", workerEvent.Sequence), fmt.Sprintf("delta_bytes=%d", len(event.Delta)))
		}
		return nil
	}
	result, err := backend.client.RunCommand(ctx, sb, command, env, func(text string) error {
		return emitStdoutEvents(stdoutParser.Feed(text))
	}, func(text string) error {
		logRemoteStderr(start, job, text)
		return nil
	})
	if err != nil {
		if runErr, ok := parseAgentRunErrorEnvelope(result.Stdout); ok {
			timeline("sidecar_agent_error", "code="+runErr.Code, "message="+quoteTimelineField(runErr.Message))
			return workerResult{}, workerFailureFromAgentRunError(runErr)
		}
		timeline("sidecar_command_failed", "error="+quoteTimelineField(err.Error()))
		return workerResult{}, fmt.Errorf("agent sidecar command job_id=%s response_id=%s outer_sandbox_id=%s: %w", job.JobID, job.ResponseID, sb.SandboxID, err)
	}
	if err := emitStdoutEvents(stdoutParser.Finish()); err != nil {
		return workerResult{}, err
	}
	if artifact.URL != "" {
		timeline("sidecar_download_done")
	}
	timeline("sidecar_command_done", fmt.Sprintf("stdout_bytes=%d", len(result.Stdout)), fmt.Sprintf("stderr_bytes=%d", len(result.Stderr)))
	envelope, sawEnvelope := parseAgentRunEnvelope(result.Stdout)
	if runErr, ok := parseAgentRunErrorEnvelope(result.Stdout); ok {
		timeline("sidecar_result_error", "code="+runErr.Code, "message="+quoteTimelineField(runErr.Message), fmt.Sprintf("stdout_bytes=%d", len(result.Stdout)))
		return workerResult{}, workerFailureFromAgentRunError(runErr)
	}
	output := envelope.OutputText
	if output == "" && !sawEnvelope {
		output = parseAgentOutput(result.Stdout)
	}
	if output == "" && streamedOutput.Len() > 0 {
		output = streamedOutput.String()
	}
	timeline("sidecar_result_envelope", fmt.Sprintf("saw_result=%t", sawEnvelope), fmt.Sprintf("stdout_bytes=%d", len(result.Stdout)), fmt.Sprintf("streamed_bytes=%d", streamedOutput.Len()), fmt.Sprintf("output_bytes=%d", len(output)), "inner_sandbox_id="+quoteTimelineField(envelope.InnerSandboxID))
	if output == "" && sawEnvelope {
		return workerResult{}, workerError("agent_empty_output", fmt.Sprintf("sidecar returned WRAPPER_RESULT_JSON with empty output_text job_id=%s response_id=%s outer_sandbox_id=%s inner_sandbox_id=%s stdout_bytes=%d", job.JobID, job.ResponseID, sb.SandboxID, envelope.InnerSandboxID, len(result.Stdout)))
	}
	if output == "" {
		output = stripWrapperControlLines(result.Stdout)
	}
	if output == "" {
		return workerResult{}, workerError("agent_empty_output", fmt.Sprintf("sidecar returned empty output job_id=%s response_id=%s outer_sandbox_id=%s stdout_bytes=%d", job.JobID, job.ResponseID, sb.SandboxID, len(result.Stdout)))
	}
	if emit != nil && output != "" && atomic.LoadInt64(&deltaSeq) == 0 {
		if err := emit(workerEvent{
			WorkerContractVersion: WorkerContractVersion,
			EventID:               "evt_" + job.JobID + "_agent_sidecar_final",
			JobID:                 job.JobID,
			Sequence:              1,
			Kind:                  "output_text_delta",
			Timestamp:             time.Now().UTC().Unix(),
			Delta:                 output,
		}); err != nil {
			return workerResult{}, err
		}
	} else if emit != nil && output != "" {
		if delta := missingFinalDelta(output, streamedOutput.String()); delta != "" {
			seq := atomic.AddInt64(&deltaSeq, 1)
			if err := emit(workerEvent{
				WorkerContractVersion: WorkerContractVersion,
				EventID:               "evt_" + job.JobID + "_agent_sidecar_final_tail",
				JobID:                 job.JobID,
				Sequence:              seq,
				Kind:                  "output_text_delta",
				Timestamp:             time.Now().UTC().Unix(),
				Delta:                 delta,
			}); err != nil {
				return workerResult{}, err
			}
		}
	}
	timeline("artifact_collect_start")
	content, err := backend.client.DownloadFile(ctx, sb, w.artifactPath)
	if err != nil {
		content = []byte(output + "\n")
	}
	handle, err := writeWorkerArtifact(content)
	if err != nil {
		return workerResult{}, err
	}
	timeline("artifact_collect_done")
	return workerResult{
		WorkerContractVersion: WorkerContractVersion,
		JobID:                 job.JobID,
		Status:                "completed",
		OutputText:            output,
		Artifacts: []artifactDescriptor{{
			WorkerContractVersion: WorkerContractVersion,
			LogicalFilename:       "result.txt",
			ContentType:           "text/plain; charset=utf-8",
			RetrievalHandle:       handle,
			ChecksumSHA256:        artifactChecksum(content),
			SizeBytes:             int64(len(content)),
			Provenance: map[string]string{
				"worker":      "agent-sidecar",
				"sandbox_id":  sb.SandboxID,
				"template_id": backend.outerTemplateID,
				"backend":     backend.name,
			},
		}},
	}, nil
}

func (w *AgentSidecarWorker) FetchArtifact(ctx context.Context, job workerJob, artifact artifactDescriptor) ([]byte, error) {
	if artifact.RetrievalHandle == "" {
		return nil, workerError("artifact_descriptor_invalid", "artifact retrieval handle is required")
	}
	return os.ReadFile(artifact.RetrievalHandle)
}

func (w *AgentSidecarWorker) sidecarCommand(remoteBinary string) string {
	run := shellQuote(remoteBinary)
	artifact := w.defaultSidecarArtifact()
	if artifact.URL == "" {
		return "printf '%s\\n' 'timeline source=sidecar_boot event=exec_start' >&2 && chmod +x " + shellQuote(remoteBinary) + " && " + run
	}
	if artifact.signed() {
		loader := sidecarLoaderCommand(w.agentLoaderPath, remoteBinary, artifact)
		return "printf '%s\\n' 'timeline source=sidecar_boot event=loader_exec_start' >&2 && " + loader
	}
	download := "printf '%s\\n' 'timeline source=sidecar_boot event=download_start' >&2" +
		" && " + sidecarDownloadCommand(remoteBinary, artifact)
	download += " && printf '%s\\n' 'timeline source=sidecar_boot event=download_done' >&2"
	return download + " && printf '%s\\n' 'timeline source=sidecar_boot event=exec_start' >&2 && chmod +x " + shellQuote(remoteBinary) + " && " + run
}

func (w *AgentSidecarWorker) addSandboxHostEnv(env map[string]string) {
	if w.sandboxHostURL != "" {
		env["HERMES_SANDBOX_HOST_URL"] = w.sandboxHostURL
	}
}

func (w *AgentSidecarWorker) sandboxHostEnvPrefix() string {
	var exports []string
	if w.sandboxHostURL != "" {
		exports = append(exports, "export HERMES_SANDBOX_HOST_URL="+shellQuote(w.sandboxHostURL))
	}
	if len(exports) == 0 {
		return ""
	}
	return strings.Join(exports, " && ") + " && "
}

var sensitiveQueryPattern = regexp.MustCompile(`(?i)(q-ak|sign|signature|token|key|secret|x-cos-security-token)=([^&]+)`)

func redactURL(value string) string {
	return sensitiveQueryPattern.ReplaceAllString(value, `$1=<redacted>`)
}

type sidecarStdoutEvent struct {
	Type       string          `json:"type"`
	Delta      string          `json:"delta"`
	ToolCallID string          `json:"tool_call_id"`
	Name       string          `json:"name"`
	Status     string          `json:"status"`
	Error      string          `json:"error"`
	Content    string          `json:"content"`
	RawInput   json.RawMessage `json:"raw_input"`
	RawOutput  json.RawMessage `json:"raw_output"`
}

func workerEventFromSidecarEvent(jobID string, sequence int64, event sidecarStdoutEvent) (workerEvent, bool) {
	ev := workerEvent{
		WorkerContractVersion: WorkerContractVersion,
		EventID:               fmt.Sprintf("evt_%s_%s_%d", jobID, event.Type, sequence),
		JobID:                 jobID,
		Sequence:              sequence,
		Timestamp:             time.Now().UTC().Unix(),
	}
	switch event.Type {
	case "output_text_delta":
		if event.Delta == "" {
			return workerEvent{}, false
		}
		ev.Kind = "output_text_delta"
		ev.Delta = event.Delta
		return ev, true
	case "reasoning_delta":
		if event.Delta == "" {
			return workerEvent{}, false
		}
		ev.Kind = "reasoning_delta"
		ev.Delta = event.Delta
		return ev, false
	case "tool_call", "tool_call_update":
		ev.Kind = event.Type
		ev.ToolCallID = event.ToolCallID
		ev.ToolName = event.Name
		ev.ToolStatus = event.Status
		ev.ToolError = event.Error
		ev.ToolContent = event.Content
		ev.ToolRawInput = cloneRawMessage(event.RawInput)
		ev.ToolRawOutput = cloneRawMessage(event.RawOutput)
		return ev, false
	default:
		return workerEvent{}, false
	}
}

func cloneRawMessage(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	out := make([]byte, len(raw))
	copy(out, raw)
	return out
}

type sidecarStdoutParser struct {
	pending string
}

func (p *sidecarStdoutParser) Feed(text string) []sidecarStdoutEvent {
	if text == "" {
		return nil
	}
	p.pending += text
	return p.drain(false)
}

func (p *sidecarStdoutParser) Finish() []sidecarStdoutEvent {
	return p.drain(true)
}

func (p *sidecarStdoutParser) drain(flush bool) []sidecarStdoutEvent {
	if p.pending == "" {
		return nil
	}
	lines := strings.Split(p.pending, "\n")
	if !flush && !strings.HasSuffix(p.pending, "\n") {
		p.pending = lines[len(lines)-1]
		lines = lines[:len(lines)-1]
	} else {
		p.pending = ""
	}
	return parseSidecarStdoutEvents(lines)
}

func parseSidecarStdoutEvents(lines []string) []sidecarStdoutEvent {
	var events []sidecarStdoutEvent
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "WRAPPER_EVENT_JSON=") {
			continue
		}
		raw := strings.TrimPrefix(line, "WRAPPER_EVENT_JSON=")
		var event sidecarStdoutEvent
		if err := json.Unmarshal([]byte(raw), &event); err == nil {
			events = append(events, event)
		}
	}
	return events
}

func missingFinalDelta(output, streamed string) string {
	if output == "" || streamed == "" || output == streamed {
		return ""
	}
	if strings.HasPrefix(output, streamed) {
		return strings.TrimPrefix(output, streamed)
	}
	return ""
}

func runtimeClockEnv(now time.Time) map[string]string {
	location, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		location = time.FixedZone("Asia/Shanghai", 8*60*60)
	}
	local := now.In(location)
	return map[string]string{
		"HERMES_CURRENT_UNIX_SECONDS": fmt.Sprintf("%d", now.Unix()),
		"HERMES_CURRENT_TIME_NOTE": fmt.Sprintf(
			"Current date and time in Asia/Shanghai is %s (%s). Use this for relative date questions unless the user specifies another timezone.",
			local.Format("2006-01-02 15:04:05 MST"),
			local.Weekday().String(),
		),
	}
}
