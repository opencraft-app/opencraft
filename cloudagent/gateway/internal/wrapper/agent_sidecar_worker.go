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

const defaultTalosTemplateID = "tpl-pool-s3h-ivanbgliu-1"

const (
	defaultAgentVersion     = "builtin.v1"
	defaultWorkspaceVersion = "builtin.v1"
	defaultSigningKeyID     = "cloudagent-agent-release-v1"
	outerRuntimeAGS         = "ags"
	outerRuntimeWisp        = "wisp"
)

type AgentSidecarWorkerConfig struct {
	Client                *AGSClient
	RuntimeHost           RuntimeHost
	RuntimeHostName       string
	OuterTemplateID       string
	InnerTemplateID       string
	AdditionalBackends    []AgentSidecarBackendConfig
	SidecarBinaryPath     string
	SidecarURL            string
	SidecarSHA256         string
	AgentLoaderPath       string
	SandboxHostURL        string
	SandboxHostSHA256     string
	SandboxHostTransport  string
	SandboxHostFallback   string
	TokenHubAPIKey        string
	TokenHubModel         string
	ForceInnerCommand     string
	SandboxTimeoutSeconds int
	DeleteSandbox         bool
	OuterRuntime          string
	WispPackageURL        string
	WispRootUpperSize     string
	WispJFSPrefix         string
	WispSMHLibraryID      string
	WispSMHAccessDomain   string
	WispSMHLibrarySecret  string
	WispSMHSpaceID        string
	WorkspaceService      WorkspaceService
	WorkspaceLeaseTTL     time.Duration
	RuntimePool           RuntimePool
}

type AgentSidecarBackendConfig struct {
	Name            string
	Client          *AGSClient
	RuntimeHost     RuntimeHost
	OuterTemplateID string
	InnerTemplateID string
}

type agentSidecarBackend struct {
	name            string
	client          *AGSClient
	host            RuntimeHost
	outerTemplateID string
	innerTemplateID string
}

func (b agentSidecarBackend) runtimeHost() RuntimeHost {
	if b.host != nil {
		return b.host
	}
	if b.client == nil {
		return nil
	}
	return NewAGSRuntimeHost(b.client)
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
	sandboxHostTransport  string
	sandboxHostFallback   string
	tokenHubAPIKey        string
	tokenHubModel         string
	forceInnerCommand     string
	sandboxTimeoutSeconds int
	deleteSandbox         bool
	artifactPath          string
	outerRuntime          string
	wispPackageURL        string
	wispRootUpperSize     string
	wispJFSPrefix         string
	wispSMHLibraryID      string
	wispSMHAccessDomain   string
	wispSMHLibrarySecret  string
	wispSMHSpaceID        string
	workspaceService      WorkspaceService
	workspaceLeaseTTL     time.Duration
	runtimePool           RuntimePool
}

func NewAgentSidecarWorker(cfg AgentSidecarWorkerConfig) (*AgentSidecarWorker, error) {
	defaultHost := cfg.RuntimeHost
	if defaultHost == nil && cfg.Client != nil {
		defaultHost = NewAGSRuntimeHost(cfg.Client)
	}
	if defaultHost == nil {
		return nil, fmt.Errorf("runtime host or ags client is required")
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
	outerRuntime := normalizeOuterRuntime(cfg.OuterRuntime)
	if outerRuntime != outerRuntimeAGS && outerRuntime != outerRuntimeWisp {
		return nil, fmt.Errorf("outer runtime %q is not supported", cfg.OuterRuntime)
	}
	wispPackageURL := firstNonEmpty(strings.TrimSpace(cfg.WispPackageURL), defaultWispPackageURL)
	if outerRuntime == outerRuntimeWisp && wispPackageURL == "" {
		return nil, fmt.Errorf("wisp package URL is required when outer runtime is wisp")
	}
	leaseTTL := cfg.WorkspaceLeaseTTL
	if leaseTTL <= 0 {
		leaseTTL = defaultWorkspaceLeaseTTL
	}
	defaultBackendName := strings.ToLower(strings.TrimSpace(cfg.RuntimeHostName))
	if defaultBackendName == "" {
		defaultBackendName = runtimeHostTypeAGS
	}
	defaultBackend := agentSidecarBackend{
		name:            defaultBackendName,
		client:          cfg.Client,
		host:            defaultHost,
		outerTemplateID: strings.TrimSpace(cfg.OuterTemplateID),
		innerTemplateID: strings.TrimSpace(cfg.InnerTemplateID),
	}
	backends := map[string]agentSidecarBackend{defaultBackend.name: defaultBackend}
	for _, backendCfg := range cfg.AdditionalBackends {
		name := strings.ToLower(strings.TrimSpace(backendCfg.Name))
		if name == "" {
			return nil, fmt.Errorf("additional sandbox backend name is required")
		}
		backendHost := backendCfg.RuntimeHost
		if backendHost == nil && backendCfg.Client != nil {
			backendHost = NewAGSRuntimeHost(backendCfg.Client)
		}
		if backendHost == nil {
			return nil, fmt.Errorf("additional sandbox backend %s runtime host or client is required", name)
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
			host:            backendHost,
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
		sandboxHostTransport:  normalizeSandboxHostTransport(cfg.SandboxHostTransport),
		sandboxHostFallback:   normalizeSandboxHostBool(cfg.SandboxHostFallback),
		tokenHubAPIKey:        cfg.TokenHubAPIKey,
		tokenHubModel:         model,
		forceInnerCommand:     cfg.ForceInnerCommand,
		sandboxTimeoutSeconds: timeout,
		deleteSandbox:         cfg.DeleteSandbox,
		artifactPath:          "/tmp/gateway-output.txt",
		outerRuntime:          outerRuntime,
		wispPackageURL:        wispPackageURL,
		wispRootUpperSize:     strings.TrimSpace(cfg.WispRootUpperSize),
		wispJFSPrefix:         firstNonEmpty(strings.TrimSpace(cfg.WispJFSPrefix), "cloudagent-agent"),
		wispSMHLibraryID:      strings.TrimSpace(cfg.WispSMHLibraryID),
		wispSMHAccessDomain:   strings.TrimRight(strings.TrimSpace(cfg.WispSMHAccessDomain), "/"),
		wispSMHLibrarySecret:  strings.TrimSpace(cfg.WispSMHLibrarySecret),
		wispSMHSpaceID:        strings.TrimSpace(cfg.WispSMHSpaceID),
		workspaceService:      cfg.WorkspaceService,
		workspaceLeaseTTL:     leaseTTL,
		runtimePool:           cfg.RuntimePool,
	}, nil
}

func NewAgentSidecarWorkerFromEnv() (*AgentSidecarWorker, error) {
	return NewAgentSidecarWorkerFromEnvWithWorkspaceService(nil)
}

func NewAgentSidecarWorkerFromEnvWithWorkspaceService(workspaceService WorkspaceService) (*AgentSidecarWorker, error) {
	return NewAgentSidecarWorkerFromEnvWithServices(workspaceService, nil)
}

func NewAgentSidecarWorkerFromEnvWithServices(workspaceService WorkspaceService, runtimePool RuntimePool) (*AgentSidecarWorker, error) {
	runtimeHostName := strings.ToLower(strings.TrimSpace(firstEnv("GATEWAY_RUNTIME_HOST", "CLOUDAGENT_RUNTIME_HOST")))
	if runtimeHostName == runtimeHostTypeLocalWisp {
		localHost, err := NewLocalRuntimeHostFromEnv()
		if err != nil {
			return nil, err
		}
		return NewAgentSidecarWorker(agentSidecarWorkerConfigFromEnv(nil, localHost, runtimeHostTypeLocalWisp, nil, workspaceService, runtimePool))
	}
	client, err := NewAGSClient(AGSClientConfig{
		APIKey:         firstEnv("GATEWAY_AGS_API_KEY", "E2B_API_KEY"),
		Domain:         firstEnv("GATEWAY_AGS_DOMAIN", "E2B_DOMAIN"),
		APIURL:         firstEnv("GATEWAY_AGS_API_URL", "E2B_API_URL"),
		RequestTimeout: envDurationSeconds("GATEWAY_AGS_REQUEST_TIMEOUT_SECONDS", 300*time.Second),
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
			RequestTimeout: envDurationSeconds("GATEWAY_TALOS_REQUEST_TIMEOUT_SECONDS", envDurationSeconds("GATEWAY_AGS_REQUEST_TIMEOUT_SECONDS", 300*time.Second)),
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
	return NewAgentSidecarWorker(agentSidecarWorkerConfigFromEnv(client, nil, runtimeHostTypeAGS, additionalBackends, workspaceService, runtimePool))
}

func agentSidecarWorkerConfigFromEnv(client *AGSClient, runtimeHost RuntimeHost, runtimeHostName string, additionalBackends []AgentSidecarBackendConfig, workspaceService WorkspaceService, runtimePool RuntimePool) AgentSidecarWorkerConfig {
	outerTemplateID := firstEnv("GATEWAY_AGENT_SIDECAR_OUTER_TEMPLATE", "GATEWAY_AGS_TEMPLATE", "OUTER_SANDBOX_TEMPLATE")
	if runtimeHostName == runtimeHostTypeLocalWisp && outerTemplateID == "" {
		outerTemplateID = runtimeHostTypeLocalWisp
	}
	innerTemplateID := firstEnv("GATEWAY_AGENT_SIDECAR_INNER_TEMPLATE", "INNER_SANDBOX_TEMPLATE")
	if runtimeHostName == runtimeHostTypeLocalWisp && innerTemplateID == "" {
		innerTemplateID = outerTemplateID
	}
	if runtimePool == nil && envFlagEnabled("GATEWAY_RUNTIME_WARM_POOL_ENABLED") {
		if pool, ok := workspaceService.(RuntimePool); ok {
			runtimePool = pool
		}
	}
	return AgentSidecarWorkerConfig{
		Client:                client,
		RuntimeHost:           runtimeHost,
		RuntimeHostName:       runtimeHostName,
		OuterTemplateID:       outerTemplateID,
		InnerTemplateID:       innerTemplateID,
		AdditionalBackends:    additionalBackends,
		SidecarBinaryPath:     firstEnv("GATEWAY_AGENT_SIDECAR_BINARY", "AGENT_SIDECAR_BINARY"),
		SidecarURL:            firstEnv("GATEWAY_AGENT_SIDECAR_URL", "AGENT_SIDECAR_URL"),
		SidecarSHA256:         firstEnv("GATEWAY_AGENT_SIDECAR_SHA256", "AGENT_SIDECAR_SHA256"),
		AgentLoaderPath:       firstEnv("GATEWAY_AGENT_LOADER_PATH", "AGENT_LOADER_PATH"),
		SandboxHostURL:        firstEnv("GATEWAY_SANDBOX_HOST_URL", "HERMES_SANDBOX_HOST_URL", "SANDBOX_HOST_URL"),
		SandboxHostSHA256:     firstEnv("GATEWAY_SANDBOX_HOST_SHA256", "HERMES_SANDBOX_HOST_SHA256", "SANDBOX_HOST_SHA256"),
		SandboxHostTransport:  firstEnv("GATEWAY_SANDBOX_HOST_TRANSPORT", "HERMES_SANDBOX_HOST_TRANSPORT", "SANDBOX_HOST_TRANSPORT"),
		SandboxHostFallback:   firstEnv("GATEWAY_SANDBOX_HOST_ALLOW_CLI_FALLBACK", "HERMES_SANDBOX_HOST_ALLOW_CLI_FALLBACK", "SANDBOX_HOST_ALLOW_CLI_FALLBACK"),
		TokenHubAPIKey:        firstEnv("GATEWAY_TOKENHUB_API_KEY", "TOKENHUB_API_KEY"),
		TokenHubModel:         firstEnv("GATEWAY_TOKENHUB_MODEL", "TOKENHUB_MODEL"),
		ForceInnerCommand:     os.Getenv("GATEWAY_AGENT_FORCE_COMMAND"),
		SandboxTimeoutSeconds: envInt("GATEWAY_AGENT_SIDECAR_OUTER_TIMEOUT_SECONDS", 300),
		DeleteSandbox:         true,
		OuterRuntime:          firstEnv("GATEWAY_AGENT_OUTER_RUNTIME", "CLOUDAGENT_OUTER_RUNTIME"),
		WispPackageURL:        firstNonEmpty(firstEnv("GATEWAY_WISP_PACKAGE_URL", "WISP_SDK_PACKAGE_URL", "WISP_FAST_PACKAGE_URL", "WISP_PACKAGE_URL"), defaultWispPackageURL),
		WispRootUpperSize:     firstEnv("GATEWAY_WISP_ROOT_UPPER_SIZE", "WISP_ROOT_UPPER_SIZE", "ROOT_UPPER_SIZE"),
		WispJFSPrefix:         firstEnv("GATEWAY_WISP_JFS_PREFIX", "WISP_JFS_PREFIX", "JFS_PREFIX"),
		WispSMHLibraryID:      firstEnv("GATEWAY_WISP_SMH_LIBRARY_ID", "SMH_LIBRARY_ID"),
		WispSMHAccessDomain:   firstEnv("GATEWAY_WISP_SMH_ACCESS_DOMAIN", "SMH_ACCESS_DOMAIN"),
		WispSMHLibrarySecret:  firstEnv("GATEWAY_WISP_SMH_LIBRARY_SECRET", "SMH_LIBRARY_SECRET"),
		WispSMHSpaceID:        firstEnv("GATEWAY_WISP_SMH_SPACE_ID", "SMH_SPACE_ID"),
		WorkspaceService:      workspaceService,
		WorkspaceLeaseTTL:     time.Duration(envInt("GATEWAY_WISP_WORKSPACE_LEASE_TTL_SECONDS", int(defaultWorkspaceLeaseTTL/time.Second))) * time.Second,
		RuntimePool:           runtimePool,
	}
}

func (w *AgentSidecarWorker) backendForName(name string) (agentSidecarBackend, bool) {
	normalized := strings.ToLower(strings.TrimSpace(name))
	if normalized == "" {
		normalized = w.defaultBackendName
	}
	backend, ok := w.backends[normalized]
	if ok && backend.host == nil {
		backend.host = backend.runtimeHost()
	}
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

type wispSMHSpacePrepareResult struct {
	space agentWispSMHSpace
	err   error
}

type wispSMHSpacePrepare struct {
	cancel context.CancelFunc
	result <-chan wispSMHSpacePrepareResult
}

func (w *AgentSidecarWorker) startWispSMHSpacePrepare(ctx context.Context, timeline func(string, ...string)) *wispSMHSpacePrepare {
	prepareCtx, cancel := context.WithCancel(ctx)
	ch := make(chan wispSMHSpacePrepareResult, 1)
	go func() {
		timeline("acp_runtime_wisp_space_start")
		if w.wispSMHLibraryID == "" || w.wispSMHAccessDomain == "" || w.wispSMHLibrarySecret == "" {
			err := errors.New("GATEWAY_WISP_SMH_LIBRARY_ID, GATEWAY_WISP_SMH_ACCESS_DOMAIN, and GATEWAY_WISP_SMH_LIBRARY_SECRET are required for wisp outer runtime")
			timeline("acp_runtime_wisp_space_failed", "error="+quoteTimelineField(err.Error()))
			ch <- wispSMHSpacePrepareResult{err: err}
			return
		}
		space, err := w.prepareWispSMHSpace(prepareCtx)
		if err != nil {
			timeline("acp_runtime_wisp_space_failed", "error="+quoteTimelineField(err.Error()))
			ch <- wispSMHSpacePrepareResult{err: err}
			return
		}
		timeline("acp_runtime_wisp_space_done", "smh_space_id="+quoteTimelineField(space.SpaceID))
		ch <- wispSMHSpacePrepareResult{space: space}
	}()
	return &wispSMHSpacePrepare{cancel: cancel, result: ch}
}

func (p *wispSMHSpacePrepare) await() (agentWispSMHSpace, error) {
	if p == nil {
		return agentWispSMHSpace{}, errors.New("wisp SMH space prepare was not started")
	}
	res := <-p.result
	return res.space, res.err
}

func (p *wispSMHSpacePrepare) cancelAndCleanup(w *AgentSidecarWorker) {
	if p == nil {
		return
	}
	p.cancel()
	res := <-p.result
	if res.err != nil || !res.space.Owned || res.space.SpaceID == "" {
		return
	}
	cleanupCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	_ = w.deleteWispSMHSpace(cleanupCtx, res.space.SpaceID)
}

type workspaceRuntimePrepareResult struct {
	sandbox             RuntimeHostTarget
	workspaceRuntimeID  string
	workspaceWispName   string
	workspaceWispClient string
	commandPrefix       string
	commandShellPrefix  string
	shutdownCommand     string
	err                 error
}

type workspaceSandboxCreateResult struct {
	sandbox RuntimeHostTarget
	err     error
}

type workspaceSandboxCreate struct {
	cancel context.CancelFunc
	result <-chan workspaceSandboxCreateResult
}

type workspaceRuntimePrepare struct {
	cancel context.CancelFunc
	result <-chan workspaceRuntimePrepareResult
}

func (w *AgentSidecarWorker) runtimeResourceLedger() RuntimeResourceLedger {
	ledger, _ := w.workspaceService.(RuntimeResourceLedger)
	return ledger
}

func runtimeResourceOwnerID(req ACPSessionRuntimeStartRequest) string {
	return firstNonEmpty(req.OwnerID, "gateway_unknown")
}

func defaultWorkspaceID(req ACPSessionRuntimeStartRequest) string {
	return "workspace_" + req.SessionID
}

func (w *AgentSidecarWorker) runtimeResourceExpiresAt() time.Time {
	ttl := w.workspaceLeaseTTL
	if ttl <= 0 {
		ttl = defaultWorkspaceLeaseTTL
	}
	return time.Now().UTC().Add(ttl)
}

func (w *AgentSidecarWorker) upsertRuntimeResource(ctx context.Context, req ACPSessionRuntimeStartRequest, runtimeID string, sandboxBackend string, state string, outerSandboxID string, innerSandboxID string, lastErr string) error {
	ledger := w.runtimeResourceLedger()
	if ledger == nil {
		return nil
	}
	return ledger.UpsertRuntimeResource(ctx, RuntimeResourceRecord{
		SessionID:      req.SessionID,
		Generation:     req.Generation,
		RuntimeID:      runtimeID,
		OwnerID:        runtimeResourceOwnerID(req),
		SandboxBackend: sandboxBackend,
		State:          state,
		OuterSandboxID: outerSandboxID,
		InnerSandboxID: innerSandboxID,
		LastError:      lastErr,
		ExpiresAt:      w.runtimeResourceExpiresAt(),
	})
}

func (w *AgentSidecarWorker) markRuntimeResourceState(ctx context.Context, req ACPSessionRuntimeStartRequest, state string, lastErr string) {
	ledger := w.runtimeResourceLedger()
	if ledger == nil {
		return
	}
	if err := ledger.MarkRuntimeResourceState(ctx, req.SessionID, req.Generation, state, lastErr); err != nil {
		fmt.Fprintf(os.Stderr, "timeline source=go event=acp_runtime_resource_ledger_failed session_id=%s generation=%d state=%s error=%s\n", req.SessionID, req.Generation, state, quoteTimelineField(err.Error()))
	}
}

func (w *AgentSidecarWorker) startWorkspaceSandboxCreate(ctx context.Context, backend agentSidecarBackend, runtime ACPSessionRuntime, req ACPSessionRuntimeStartRequest, workspaceID string, timeline func(string, ...string)) *workspaceSandboxCreate {
	createCtx, cancel := context.WithCancel(ctx)
	ch := make(chan workspaceSandboxCreateResult, 1)
	go func() {
		templateID := firstNonEmpty(runtime.WorkspaceTemplateID, backend.innerTemplateID)
		timeline("acp_runtime_workspace_create_start", "backend="+backend.name, "template="+templateID, "workspace_id="+quoteTimelineField(workspaceID))
		sb, err := backend.host.CreateSandbox(createCtx, CreateSandboxOptions{
			TemplateID:          templateID,
			TimeoutSeconds:      w.sandboxTimeoutSeconds,
			Secure:              true,
			AllowInternetAccess: true,
			Metadata: map[string]string{
				"session_id":   req.SessionID,
				"workspace_id": workspaceID,
				"mode":         "acp-session-workspace-runtime",
				"tenant_id":    req.Scope.TenantID,
				"project_id":   req.Scope.ProjectID,
			},
		})
		if err != nil {
			timeline("acp_runtime_workspace_create_failed", "error="+quoteTimelineField(err.Error()))
			ch <- workspaceSandboxCreateResult{err: err}
			return
		}
		if err := w.upsertRuntimeResource(createCtx, req, runtime.RuntimeID, backend.name, "creating", "", sb.ID, ""); err != nil {
			timeline("acp_runtime_workspace_ledger_failed", "sandbox_id="+sb.ID, "error="+quoteTimelineField(err.Error()))
			cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cleanupCancel()
			_ = backend.host.DeleteSandbox(cleanupCtx, sb.ID)
			ch <- workspaceSandboxCreateResult{err: err}
			return
		}
		timeline("acp_runtime_workspace_create_done", "sandbox_id="+sb.ID, "workspace_id="+quoteTimelineField(workspaceID))
		ch <- workspaceSandboxCreateResult{sandbox: sb}
	}()
	return &workspaceSandboxCreate{cancel: cancel, result: ch}
}

func (c *workspaceSandboxCreate) await() (RuntimeHostTarget, error) {
	if c == nil {
		return RuntimeHostTarget{}, errors.New("workspace sandbox create was not started")
	}
	res := <-c.result
	return res.sandbox, res.err
}

func (c *workspaceSandboxCreate) cancelAndCleanup(host RuntimeHost) {
	if c == nil {
		return
	}
	c.cancel()
	res := <-c.result
	if res.err != nil || res.sandbox.ID == "" {
		return
	}
	cleanupCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	_ = host.DeleteSandbox(cleanupCtx, res.sandbox.ID)
}

func (w *AgentSidecarWorker) startWorkspaceRuntimePrepare(ctx context.Context, backend agentSidecarBackend, runtime ACPSessionRuntime, req ACPSessionRuntimeStartRequest, workspaceID string, create *workspaceSandboxCreate, timeline func(string, ...string)) *workspaceRuntimePrepare {
	prepareCtx, cancel := context.WithCancel(ctx)
	ch := make(chan workspaceRuntimePrepareResult, 1)
	go func() {
		if create == nil {
			create = w.startWorkspaceSandboxCreate(prepareCtx, backend, runtime, req, workspaceID, timeline)
		}
		sb, err := create.await()
		if err != nil {
			ch <- workspaceRuntimePrepareResult{err: err}
			return
		}
		workspaceRuntimeID := workspaceRuntimeIDForRuntime(runtime, req)
		result := workspaceRuntimePrepareResult{
			sandbox:            sb,
			workspaceRuntimeID: workspaceRuntimeID,
		}
		if runtime.isWispOuterRuntime() {
			timeline("acp_runtime_workspace_wisp_prepare_start", "sandbox_id="+sb.ID, "workspace_runtime_id="+quoteTimelineField(workspaceRuntimeID))
			prepared, err := w.prepareInnerWorkspaceWispRuntime(prepareCtx, backend.host, sb, runtime, req, workspaceID, workspaceRuntimeID)
			if err != nil {
				timeline("acp_runtime_workspace_wisp_prepare_failed", "sandbox_id="+sb.ID, "error="+quoteTimelineField(err.Error()))
				cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 30*time.Second)
				defer cleanupCancel()
				_ = backend.host.DeleteSandbox(cleanupCtx, sb.ID)
				ch <- workspaceRuntimePrepareResult{err: err}
				return
			}
			result.workspaceWispName = prepared.workspaceWispName
			result.workspaceWispClient = prepared.workspaceWispClient
			result.commandPrefix = prepared.commandPrefix
			result.commandShellPrefix = prepared.commandShellPrefix
			result.shutdownCommand = prepared.shutdownCommand
			timeline("acp_runtime_workspace_wisp_prepare_done", "sandbox_id="+sb.ID, "workspace_runtime_id="+quoteTimelineField(workspaceRuntimeID), "wisp_name="+quoteTimelineField(prepared.workspaceWispName))
		}
		ch <- result
	}()
	return &workspaceRuntimePrepare{cancel: cancel, result: ch}
}

func (p *workspaceRuntimePrepare) await() (workspaceRuntimePrepareResult, error) {
	if p == nil {
		return workspaceRuntimePrepareResult{}, errors.New("workspace runtime prepare was not started")
	}
	res := <-p.result
	return res, res.err
}

func (p *workspaceRuntimePrepare) cancelAndCleanup(host RuntimeHost) {
	if p == nil {
		return
	}
	p.cancel()
	res := <-p.result
	if res.err != nil || res.sandbox.ID == "" {
		return
	}
	cleanupCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if res.shutdownCommand != "" {
		_, _ = host.RunCommand(cleanupCtx, res.sandbox, res.shutdownCommand+" >/dev/null 2>&1 || true", nil, nil, nil)
	}
	_ = host.DeleteSandbox(cleanupCtx, res.sandbox.ID)
}

func cleanupPreparedWorkspaceRuntime(host RuntimeHost, prepared workspaceRuntimePrepareResult) {
	if prepared.sandbox.ID == "" {
		return
	}
	cleanupCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if prepared.shutdownCommand != "" {
		_, _ = host.RunCommand(cleanupCtx, prepared.sandbox, prepared.shutdownCommand+" >/dev/null 2>&1 || true", nil, nil, nil)
	}
	_ = host.DeleteSandbox(cleanupCtx, prepared.sandbox.ID)
}

func (w *AgentSidecarWorker) CleanupStaleRuntimeResources(ctx context.Context, limit int) error {
	ledger := w.runtimeResourceLedger()
	if ledger == nil {
		return nil
	}
	records, err := ledger.ListStaleRuntimeResources(ctx, time.Now().UTC(), limit)
	if err != nil {
		return err
	}
	for _, rec := range records {
		backend, ok := w.backendForName(rec.SandboxBackend)
		if !ok {
			backend, ok = w.backendForName("")
			if !ok {
				return fmt.Errorf("sandbox backend %q is not configured", rec.SandboxBackend)
			}
		}
		cleanupCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		if rec.InnerSandboxID != "" {
			_ = backend.host.DeleteSandbox(cleanupCtx, rec.InnerSandboxID)
		}
		if rec.OuterSandboxID != "" {
			_ = backend.host.DeleteSandbox(cleanupCtx, rec.OuterSandboxID)
		}
		cancel()
		if err := ledger.MarkRuntimeResourceState(ctx, rec.SessionID, rec.Generation, "cleaned", ""); err != nil {
			return err
		}
		fmt.Fprintf(os.Stderr, "timeline source=go event=acp_runtime_resource_cleanup_done session_id=%s generation=%d outer_sandbox_id=%s inner_sandbox_id=%s\n", rec.SessionID, rec.Generation, rec.OuterSandboxID, rec.InnerSandboxID)
	}
	return nil
}

func (w *AgentSidecarWorker) StartSessionRuntime(ctx context.Context, req ACPSessionRuntimeStartRequest) (ACPSessionRuntime, error) {
	start := time.Now()
	outerRuntime := normalizeOuterRuntime(firstNonEmpty(req.OuterRuntime, w.outerRuntime))
	if outerRuntime != outerRuntimeAGS && outerRuntime != outerRuntimeWisp {
		return ACPSessionRuntime{}, fmt.Errorf("outer runtime %q is not supported", req.OuterRuntime)
	}
	if outerRuntime == outerRuntimeWisp && strings.TrimSpace(w.wispPackageURL) == "" {
		return ACPSessionRuntime{}, fmt.Errorf("wisp package URL is required when outer runtime is wisp")
	}
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
	sidecarArtifact = resolvedSidecarArtifact(sidecarArtifact, agentPlugin, w.defaultSidecarArtifact())
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
	var spacePrepare *wispSMHSpacePrepare
	if outerRuntime == outerRuntimeWisp {
		spacePrepare = w.startWispSMHSpacePrepare(ctx, timeline)
	}
	runtime := ACPSessionRuntime{
		RuntimeID:           newACPSessionRuntimeID(req.SessionID, req.Generation),
		SandboxBackend:      backend.name,
		OuterRuntime:        outerRuntime,
		RuntimeRecovery:     normalizeRuntimeRecovery(req.RuntimeRecovery, outerRuntime),
		AgentVersion:        agentVersion,
		AgentTemplateID:     backend.outerTemplateID,
		SidecarURL:          sidecarArtifact.URL,
		SidecarSHA256:       sidecarArtifact.SHA256,
		SidecarSigURL:       sidecarArtifact.SigURL,
		SigningKeyID:        sidecarArtifact.SigningKeyID,
		WorkspaceVersion:    workspaceVersion,
		WorkspaceTemplateID: backend.innerTemplateID,
		WispPackageURL:      w.wispPackageURL,
		WispRootUpperSize:   w.wispRootUpperSize,
		WispJFSPrefix:       w.wispJFSPrefix,
		WorkspaceID:         defaultWorkspaceID(req),
		DaemonAddr:          acpDaemonAddr(req.SessionID),
		RemoteBinary:        path.Join("/tmp/gateway/sessions", req.SessionID, "hermes-sidecar"),
	}
	if claim, ok := w.tryClaimWarmSessionRuntime(ctx, req, backend, runtime, timeline); ok {
		claimed, err := w.startSessionRuntimeFromWarmClaim(ctx, req, backend, runtime, claim, timeline)
		if err == nil {
			return claimed, nil
		}
		timeline("acp_runtime_pool_claim_fallback_cold", "item_id="+quoteTimelineField(claim.ItemID), "error="+quoteTimelineField(err.Error()))
	}
	workspaceCreate := w.startWorkspaceSandboxCreate(ctx, backend, runtime, req, workspaceIDForRuntime(runtime, req), timeline)
	timeline("acp_runtime_outer_create_start", "backend="+backend.name, "template="+backend.outerTemplateID, "agent_version="+agentVersion, "workspace_template="+backend.innerTemplateID, "workspace_version="+workspaceVersion)
	sb, err := backend.host.CreateSandbox(ctx, CreateSandboxOptions{
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
		workspaceCreate.cancelAndCleanup(backend.host)
		w.markRuntimeResourceState(ctx, req, "failed", err.Error())
		if spacePrepare != nil {
			spacePrepare.cancelAndCleanup(w)
		}
		return ACPSessionRuntime{}, err
	}
	runtime.OuterSandboxID = sb.ID
	runtime.OuterSandboxDomain = sb.Domain
	runtime.OuterEnvdAccessToken = sb.EnvdAccessToken
	runtime.OuterTrafficToken = sb.TrafficAccessToken
	if err := w.upsertRuntimeResource(ctx, req, runtime.RuntimeID, backend.name, "creating", sb.ID, "", ""); err != nil {
		timeline("acp_runtime_outer_ledger_failed", "sandbox_id="+sb.ID, "error="+quoteTimelineField(err.Error()))
		workspaceCreate.cancelAndCleanup(backend.host)
		if spacePrepare != nil {
			spacePrepare.cancelAndCleanup(w)
		}
		deleteCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		_ = backend.host.DeleteSandbox(deleteCtx, sb.ID)
		return ACPSessionRuntime{}, err
	}
	timeline("acp_runtime_outer_create_done", "sandbox_id="+sb.ID)
	var workspacePrepare *workspaceRuntimePrepare
	if runtime.isWispOuterRuntime() {
		space, err := spacePrepare.await()
		if err != nil {
			w.markRuntimeResourceState(ctx, req, "failed", err.Error())
			deleteCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			_ = backend.host.DeleteSandbox(deleteCtx, sb.ID)
			return ACPSessionRuntime{}, err
		}
		cleanupSpace := space.Owned
		runtime, err = w.resolveWispRuntimeForSpace(ctx, runtime, req, space, true)
		if err != nil {
			w.markRuntimeResourceState(ctx, req, "failed", err.Error())
			deleteCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			_ = backend.host.DeleteSandbox(deleteCtx, sb.ID)
			if cleanupSpace {
				cleanupCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
				defer cancel()
				_ = w.deleteWispSMHSpace(cleanupCtx, space.SpaceID)
			}
			return ACPSessionRuntime{}, err
		}
		if !envFlagEnabled("GATEWAY_LOCAL_WISP_SHARED_DAEMON") {
			workspacePrepare = w.startWorkspaceRuntimePrepare(ctx, backend, runtime, req, workspaceIDForRuntime(runtime, req), workspaceCreate, timeline)
		}
		timeline("acp_runtime_wisp_prepare_start")
		prepared, err := w.prepareWispRuntimeWithSpace(ctx, backend.host, sb, runtime, req, space, "outer", false)
		if err != nil {
			timeline("acp_runtime_wisp_prepare_failed", "error="+quoteTimelineField(err.Error()))
			w.markRuntimeResourceState(ctx, req, "failed", err.Error())
			workspacePrepare.cancelAndCleanup(backend.host)
			if runtime.WispLeaseID != "" {
				releaseCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				defer cancel()
				_ = w.releaseWispWorkspaceLease(releaseCtx, runtime)
			}
			deleteCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			_ = backend.host.DeleteSandbox(deleteCtx, sb.ID)
			if cleanupSpace {
				cleanupCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
				defer cancel()
				_ = w.deleteWispSMHSpace(cleanupCtx, space.SpaceID)
			}
			return ACPSessionRuntime{}, err
		}
		runtime = prepared
		cleanupSpace = false
		timeline("acp_runtime_wisp_prepare_done", "wisp_name="+quoteTimelineField(runtime.WispName), "workspace_id="+quoteTimelineField(runtime.WispWorkspaceID), "smh_space_id="+quoteTimelineField(runtime.WispSMHSpaceID))
	}
	if workspacePrepare == nil {
		workspacePrepare = w.startWorkspaceRuntimePrepare(ctx, backend, runtime, req, workspaceIDForRuntime(runtime, req), workspaceCreate, timeline)
	}
	if err := w.bootSessionDaemon(ctx, sb, runtime, req); err != nil {
		timeline("acp_runtime_daemon_failed", "error="+quoteTimelineField(err.Error()))
		w.markRuntimeResourceState(ctx, req, "failed", err.Error())
		workspacePrepare.cancelAndCleanup(backend.host)
		w.cleanupFailedSessionRuntime(backend.host, sb, runtime)
		return ACPSessionRuntime{}, err
	}
	timeline("acp_runtime_daemon_done", "sandbox_id="+sb.ID, "addr="+quoteTimelineField(runtime.DaemonAddr))
	if runtime.isWispOuterRuntime() {
		if err := w.writeWispHermesBootstrapManifest(ctx, backend.host, sb, runtime, req); err != nil {
			timeline("acp_runtime_bootstrap_manifest_failed", "error="+quoteTimelineField(err.Error()))
			w.markRuntimeResourceState(ctx, req, "failed", err.Error())
			workspacePrepare.cancelAndCleanup(backend.host)
			w.cleanupFailedSessionRuntime(backend.host, sb, runtime)
			return ACPSessionRuntime{}, err
		}
	}
	attached, err := w.attachSessionWorkspaceRuntime(ctx, backend, runtime, req, workspacePrepare)
	if err != nil {
		timeline("acp_runtime_workspace_bind_failed", "error="+quoteTimelineField(err.Error()))
		w.markRuntimeResourceState(ctx, req, "failed", err.Error())
		w.cleanupFailedSessionRuntime(backend.host, sb, runtime)
		return ACPSessionRuntime{}, err
	}
	runtime = attached
	w.markRuntimeResourceState(ctx, req, "bound", "")
	timeline("acp_runtime_workspace_bind_done", "workspace_id="+quoteTimelineField(runtime.WorkspaceID), "workspace_runtime_id="+quoteTimelineField(runtime.WorkspaceRuntimeID), "inner_sandbox_id="+quoteTimelineField(runtime.InnerSandboxID))
	return runtime, nil
}

func (w *AgentSidecarWorker) ReattachSessionRuntime(ctx context.Context, runtime ACPSessionRuntime) (ACPSessionRuntime, error) {
	if !runtimeHasOuterHostTarget(runtime) || runtime.RemoteBinary == "" || runtime.DaemonAddr == "" {
		return ACPSessionRuntime{}, fmt.Errorf("runtime identity is incomplete")
	}
	backend, err := w.backendForRuntime(runtime)
	if err != nil {
		return ACPSessionRuntime{}, err
	}
	sb := runtimeOuterSandbox(runtime)
	check := sidecarHealthCommand(runtime.RemoteBinary, runtime.DaemonAddr)
	if _, err := w.runOuterCommand(ctx, backend.host, sb, runtime, check, nil, nil, nil); err != nil {
		return ACPSessionRuntime{}, err
	}
	return runtime, nil
}

func (w *AgentSidecarWorker) RefreshSessionRuntime(ctx context.Context, runtime ACPSessionRuntime, sessionID string) error {
	backend, err := w.backendForRuntime(runtime)
	if err != nil {
		return err
	}
	timeoutSeconds := w.sandboxTimeoutSeconds
	if timeoutSeconds <= 0 {
		timeoutSeconds = 300
	}
	var refreshErr error
	if runtime.OuterSandboxID != "" {
		fmt.Fprintf(os.Stderr, "timeline source=go event=acp_runtime_refresh_outer_start session_id=%s outer_sandbox_id=%s timeout_seconds=%d\n", sessionID, runtime.OuterSandboxID, timeoutSeconds)
		if err := backend.host.RefreshSandboxTimeout(ctx, runtime.OuterSandboxID, timeoutSeconds); err != nil {
			refreshErr = errors.Join(refreshErr, fmt.Errorf("refresh outer sandbox %s: %w", runtime.OuterSandboxID, err))
		} else {
			fmt.Fprintf(os.Stderr, "timeline source=go event=acp_runtime_refresh_outer_done session_id=%s outer_sandbox_id=%s timeout_seconds=%d\n", sessionID, runtime.OuterSandboxID, timeoutSeconds)
		}
	}
	if runtime.InnerSandboxID != "" {
		fmt.Fprintf(os.Stderr, "timeline source=go event=acp_runtime_refresh_inner_start session_id=%s outer_sandbox_id=%s inner_sandbox_id=%s timeout_seconds=%d\n", sessionID, runtime.OuterSandboxID, runtime.InnerSandboxID, timeoutSeconds)
		if err := backend.host.RefreshSandboxTimeout(ctx, runtime.InnerSandboxID, timeoutSeconds); err != nil {
			refreshErr = errors.Join(refreshErr, fmt.Errorf("refresh inner sandbox %s: %w", runtime.InnerSandboxID, err))
		} else {
			fmt.Fprintf(os.Stderr, "timeline source=go event=acp_runtime_refresh_inner_done session_id=%s outer_sandbox_id=%s inner_sandbox_id=%s timeout_seconds=%d\n", sessionID, runtime.OuterSandboxID, runtime.InnerSandboxID, timeoutSeconds)
		}
	}
	return refreshErr
}

func (w *AgentSidecarWorker) EnsureSessionRuntime(ctx context.Context, runtime ACPSessionRuntime, req ACPSessionRuntimeStartRequest) (ACPSessionRuntime, error) {
	if runtimeHasOuterHostTarget(runtime) && runtime.RemoteBinary != "" && runtime.DaemonAddr != "" {
		reattached, err := w.ReattachSessionRuntime(ctx, runtime)
		if err == nil {
			return reattached, nil
		}
		fmt.Fprintf(os.Stderr, "timeline source=go event=acp_runtime_reattach_failed session_id=%s outer_sandbox_id=%s error=%s\n", req.SessionID, runtime.OuterSandboxID, quoteTimelineField(err.Error()))
		restarted, restartErr := w.restartSessionRuntimeDaemon(ctx, runtime, req)
		if restartErr == nil {
			fmt.Fprintf(os.Stderr, "timeline source=go event=acp_runtime_daemon_restart_done session_id=%s outer_sandbox_id=%s\n", req.SessionID, runtime.OuterSandboxID)
			return restarted, nil
		}
		fmt.Fprintf(os.Stderr, "timeline source=go event=acp_runtime_daemon_restart_failed session_id=%s outer_sandbox_id=%s error=%s\n", req.SessionID, runtime.OuterSandboxID, quoteTimelineField(restartErr.Error()))
		if runtimeCanRecreate(runtime) {
			if cleanupErr := w.CloseSessionRuntime(ctx, runtime); cleanupErr != nil {
				if !isNonBlockingCleanupBeforeRecreate(runtime, cleanupErr) {
					return ACPSessionRuntime{}, fmt.Errorf("cleanup stale runtime before recreate: %w", cleanupErr)
				}
				fmt.Fprintf(os.Stderr, "timeline source=go event=acp_runtime_stale_cleanup_ignored session_id=%s outer_sandbox_id=%s error=%s\n", req.SessionID, runtime.OuterSandboxID, quoteTimelineField(cleanupErr.Error()))
			}
			runtime = runtimeAfterStaleCleanup(runtime)
		}
	}
	if !runtimeCanRecreate(runtime) {
		return ACPSessionRuntime{}, fmt.Errorf("runtime is not restorable")
	}
	return w.recreateWispSessionRuntime(ctx, runtime, req)
}

func isNonBlockingCleanupBeforeRecreate(runtime ACPSessionRuntime, err error) bool {
	if runtime.isWispOuterRuntime() {
		return isNonBlockingWispPreMountCleanupError(err)
	}
	return isNonBlockingStaleRuntimeCleanupError(err)
}

func isNonBlockingWispPreMountCleanupError(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	if strings.Contains(message, "ags http 404") ||
		strings.Contains(message, "http 404") && strings.Contains(message, "requested resource does not exist") {
		return true
	}
	return strings.Contains(message, "unsupportedoperation.sandboxinstance") &&
		strings.Contains(message, "stopped state")
}

func isNonBlockingStaleRuntimeCleanupError(err error) bool {
	if err == nil {
		return false
	}
	if isStaleRuntimeDataPlaneAuthError(err) {
		return true
	}
	message := strings.ToLower(err.Error())
	if strings.Contains(message, "ags http 404") ||
		strings.Contains(message, "http 404") && strings.Contains(message, "requested resource does not exist") {
		return true
	}
	return strings.Contains(message, "unsupportedoperation.sandboxinstance") &&
		strings.Contains(message, "stopped state")
}

func isStaleRuntimeDataPlaneAuthError(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	if strings.Contains(message, "checkpoint") ||
		strings.Contains(message, "writeback-cut-barrier") ||
		strings.Contains(message, "metadata-barrier") ||
		strings.Contains(message, "input/output error") {
		return false
	}
	return strings.Contains(message, "ags http 401") &&
		strings.Contains(message, "op=run_command") &&
		strings.Contains(message, "authentication_failed")
}

func (w *AgentSidecarWorker) restartSessionRuntimeDaemon(ctx context.Context, runtime ACPSessionRuntime, req ACPSessionRuntimeStartRequest) (ACPSessionRuntime, error) {
	backend, err := w.backendForRuntime(runtime)
	if err != nil {
		return ACPSessionRuntime{}, err
	}
	if !runtimeHasOuterHostTarget(runtime) || runtime.RemoteBinary == "" || runtime.DaemonAddr == "" {
		return ACPSessionRuntime{}, fmt.Errorf("runtime identity is incomplete")
	}
	fmt.Fprintf(os.Stderr, "timeline source=go event=acp_runtime_daemon_restart_start session_id=%s outer_sandbox_id=%s\n", req.SessionID, runtime.OuterSandboxID)
	if err := w.bootSessionDaemon(ctx, runtimeOuterSandbox(runtime), runtime, req); err != nil {
		return ACPSessionRuntime{}, err
	}
	reattached, err := w.ReattachSessionRuntime(ctx, runtime)
	if err != nil {
		return ACPSessionRuntime{}, err
	}
	reattached.SandboxBackend = firstNonEmpty(reattached.SandboxBackend, backend.name)
	return reattached, nil
}

func (w *AgentSidecarWorker) recreateWispSessionRuntime(ctx context.Context, runtime ACPSessionRuntime, req ACPSessionRuntimeStartRequest) (ACPSessionRuntime, error) {
	start := time.Now()
	backend, err := w.backendForRuntime(runtime)
	if err != nil {
		return ACPSessionRuntime{}, err
	}
	artifact := req.SidecarArtifact
	if artifact.URL == "" {
		artifact = runtimeSidecarArtifact(runtime)
	}
	artifact, err = validatedSidecarArtifact("restored session sidecar_artifact", artifact)
	if err != nil {
		return ACPSessionRuntime{}, err
	}
	req.SidecarArtifact = artifact
	agentVersion := normalizeRuntimeVersion(firstNonEmpty(runtime.AgentVersion, req.AgentVersion), defaultAgentVersion)
	agentPlugin, err := agentBehaviorPluginFor(agentVersion)
	if err != nil {
		return ACPSessionRuntime{}, err
	}
	workspaceVersion := normalizeRuntimeVersion(firstNonEmpty(runtime.WorkspaceVersion, req.WorkspaceVersion), defaultWorkspaceVersion)
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
			"mode=acp_session_runtime_restore",
			"session_id=" + req.SessionID,
			fmt.Sprintf("generation=%d", req.Generation),
		}
		all = append(all, fields...)
		fmt.Fprintln(os.Stderr, strings.Join(all, " "))
	}
	runtime, err = w.cleanupPreviousWispRuntimeBeforeMount(ctx, runtime, req, timeline)
	if err != nil {
		return ACPSessionRuntime{}, err
	}
	restored := runtime
	restored.RuntimeID = newACPSessionRuntimeID(req.SessionID, req.Generation)
	restored.SandboxBackend = backend.name
	restored.OuterRuntime = outerRuntimeWisp
	restored.RuntimeRecovery = normalizeRuntimeRecovery(firstNonEmpty(restored.RuntimeRecovery, req.RuntimeRecovery), outerRuntimeWisp)
	restored.AgentVersion = agentVersion
	restored.AgentTemplateID = backend.outerTemplateID
	restored.SidecarURL = artifact.URL
	restored.SidecarSHA256 = artifact.SHA256
	restored.SidecarSigURL = artifact.SigURL
	restored.SigningKeyID = artifact.SigningKeyID
	restored.WorkspaceVersion = workspaceVersion
	restored.WorkspaceTemplateID = backend.innerTemplateID
	restored.WispPackageURL = firstNonEmpty(restored.WispPackageURL, w.wispPackageURL)
	restored.WispRootUpperSize = firstNonEmpty(restored.WispRootUpperSize, w.wispRootUpperSize)
	restored.WispJFSPrefix = firstNonEmpty(restored.WispJFSPrefix, w.wispJFSPrefix)
	restored.DaemonAddr = acpDaemonAddr(req.SessionID)
	restored.RemoteBinary = path.Join("/tmp/gateway/sessions", req.SessionID, "hermes-sidecar")
	if claim, ok := w.tryClaimWarmSessionRuntime(ctx, req, backend, restored, timeline); ok {
		claimed, err := w.startSessionRuntimeFromWarmClaim(ctx, req, backend, restored, claim, timeline)
		if err == nil {
			timeline("acp_runtime_restore_pool_claim_done", "item_id="+quoteTimelineField(claim.ItemID), "outer_sandbox_id="+quoteTimelineField(claim.Host.OuterSandboxID), "inner_sandbox_id="+quoteTimelineField(claim.Host.InnerSandboxID))
			return claimed, nil
		}
		timeline("acp_runtime_restore_pool_claim_fallback_cold", "item_id="+quoteTimelineField(claim.ItemID), "error="+quoteTimelineField(err.Error()))
	}
	timeline("acp_runtime_restore_outer_create_start", "backend="+backend.name, "template="+backend.outerTemplateID, "smh_space_id="+quoteTimelineField(restored.WispSMHSpaceID))
	sb, err := backend.host.CreateSandbox(ctx, CreateSandboxOptions{
		TemplateID:          backend.outerTemplateID,
		TimeoutSeconds:      w.sandboxTimeoutSeconds,
		Secure:              true,
		AllowInternetAccess: true,
		Metadata: map[string]string{
			"session_id": req.SessionID,
			"mode":       "acp-session-runtime-restore",
			"tenant_id":  req.Scope.TenantID,
			"project_id": req.Scope.ProjectID,
		},
	})
	if err != nil {
		timeline("acp_runtime_restore_outer_create_failed", "error="+quoteTimelineField(err.Error()))
		return ACPSessionRuntime{}, err
	}
	timeline("acp_runtime_restore_outer_create_done", "sandbox_id="+sb.ID)
	restored.OuterSandboxID = sb.ID
	restored.OuterSandboxDomain = sb.Domain
	restored.OuterEnvdAccessToken = sb.EnvdAccessToken
	restored.OuterTrafficToken = sb.TrafficAccessToken
	restored.InnerSandboxID = ""
	restored.InnerSandboxDomain = ""
	restored.InnerEnvdAccessToken = ""
	restored.SessionProxyID = ""
	token, err := w.issueWispSMHToken(ctx, restored.WispSMHSpaceID, "admin")
	if err != nil {
		_ = backend.host.DeleteSandbox(context.Background(), sb.ID)
		return ACPSessionRuntime{}, err
	}
	space := agentWispSMHSpace{SpaceID: restored.WispSMHSpaceID, AccessToken: token, Owned: false}
	restored, err = w.resolveWispRuntimeForSpace(ctx, restored, req, space, true)
	if err != nil {
		_ = backend.host.DeleteSandbox(context.Background(), sb.ID)
		return ACPSessionRuntime{}, err
	}
	workspacePrepare := w.startWorkspaceRuntimePrepare(ctx, backend, restored, req, workspaceIDForRuntime(restored, req), nil, timeline)
	timeline("acp_runtime_restore_wisp_prepare_start", "wisp_name="+quoteTimelineField(restored.WispName))
	prepared, err := w.prepareWispRuntimeWithSpace(ctx, backend.host, sb, restored, req, space, "outer", false)
	if err != nil {
		timeline("acp_runtime_restore_wisp_prepare_failed", "error="+quoteTimelineField(err.Error()))
		workspacePrepare.cancelAndCleanup(backend.host)
		if restored.WispLeaseID != "" {
			releaseCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			_ = w.releaseWispWorkspaceLease(releaseCtx, restored)
		}
		_ = backend.host.DeleteSandbox(context.Background(), sb.ID)
		return ACPSessionRuntime{}, err
	}
	restored = prepared
	timeline("acp_runtime_restore_wisp_prepare_done", "wisp_name="+quoteTimelineField(restored.WispName), "smh_space_id="+quoteTimelineField(restored.WispSMHSpaceID))
	hasHermesState := w.wispHermesBootstrapManifestValid(ctx, backend.host, sb, restored, req)
	if err := w.bootSessionDaemon(ctx, sb, restored, req); err != nil {
		timeline("acp_runtime_restore_daemon_failed", "error="+quoteTimelineField(err.Error()))
		workspacePrepare.cancelAndCleanup(backend.host)
		w.cleanupFailedSessionRuntime(backend.host, sb, restored)
		return ACPSessionRuntime{}, err
	}
	timeline("acp_runtime_restore_daemon_done", "sandbox_id="+sb.ID, "addr="+quoteTimelineField(restored.DaemonAddr))
	if hasHermesState {
		timeline("acp_runtime_restore_bootstrap_skipped", "reason=runtime_store_authoritative")
	}
	if restored.isWispOuterRuntime() {
		if err := w.writeWispHermesBootstrapManifest(ctx, backend.host, sb, restored, req); err != nil {
			timeline("acp_runtime_restore_bootstrap_manifest_failed", "error="+quoteTimelineField(err.Error()))
			workspacePrepare.cancelAndCleanup(backend.host)
			w.cleanupFailedSessionRuntime(backend.host, sb, restored)
			return ACPSessionRuntime{}, err
		}
	}
	attached, err := w.attachSessionWorkspaceRuntime(ctx, backend, restored, req, workspacePrepare)
	if err != nil {
		timeline("acp_runtime_restore_workspace_bind_failed", "error="+quoteTimelineField(err.Error()))
		w.cleanupFailedSessionRuntime(backend.host, sb, restored)
		return ACPSessionRuntime{}, err
	}
	restored = attached
	timeline("acp_runtime_restore_workspace_bind_done", "workspace_id="+quoteTimelineField(restored.WorkspaceID), "workspace_runtime_id="+quoteTimelineField(restored.WorkspaceRuntimeID), "inner_sandbox_id="+quoteTimelineField(restored.InnerSandboxID))
	return restored, nil
}

func (w *AgentSidecarWorker) cleanupPreviousWispRuntimeBeforeMount(ctx context.Context, runtime ACPSessionRuntime, req ACPSessionRuntimeStartRequest, timeline func(string, ...string)) (ACPSessionRuntime, error) {
	if !runtime.isWispOuterRuntime() || !runtimeNeedsCleanup(runtime) {
		return runtime, nil
	}
	if runtime.OuterSandboxID == "" && runtime.InnerSandboxID == "" {
		return runtime, nil
	}
	timeline("acp_runtime_restore_premount_cleanup_start",
		"runtime_id="+quoteTimelineField(runtime.RuntimeID),
		"outer_sandbox_id="+quoteTimelineField(runtime.OuterSandboxID),
		"inner_sandbox_id="+quoteTimelineField(runtime.InnerSandboxID),
		"wisp_name="+quoteTimelineField(runtime.WispName),
		"workspace_wisp_name="+quoteTimelineField(runtime.WorkspaceWispName),
	)
	if err := w.CloseSessionRuntime(ctx, runtime); err != nil {
		if isNonBlockingWispPreMountCleanupError(err) {
			timeline("acp_runtime_restore_premount_cleanup_ignored",
				"runtime_id="+quoteTimelineField(runtime.RuntimeID),
				"outer_sandbox_id="+quoteTimelineField(runtime.OuterSandboxID),
				"inner_sandbox_id="+quoteTimelineField(runtime.InnerSandboxID),
				"error="+quoteTimelineField(err.Error()),
			)
			return runtimeAfterStaleCleanup(runtime), nil
		}
		timeline("acp_runtime_restore_premount_cleanup_failed",
			"runtime_id="+quoteTimelineField(runtime.RuntimeID),
			"outer_sandbox_id="+quoteTimelineField(runtime.OuterSandboxID),
			"inner_sandbox_id="+quoteTimelineField(runtime.InnerSandboxID),
			"error="+quoteTimelineField(err.Error()),
		)
		return ACPSessionRuntime{}, fmt.Errorf("cleanup previous wisp runtime before mount: %w", err)
	}
	timeline("acp_runtime_restore_premount_cleanup_done",
		"runtime_id="+quoteTimelineField(runtime.RuntimeID),
		"outer_sandbox_id="+quoteTimelineField(runtime.OuterSandboxID),
		"inner_sandbox_id="+quoteTimelineField(runtime.InnerSandboxID),
	)
	return runtimeAfterStaleCleanup(runtime), nil
}

func workspaceIDForRuntime(runtime ACPSessionRuntime, req ACPSessionRuntimeStartRequest) string {
	return firstNonEmpty(runtime.WorkspaceID, runtime.WispWorkspaceID, runtime.WispSMHSpaceID, "workspace_"+req.SessionID)
}

func workspaceRuntimeIDForRuntime(runtime ACPSessionRuntime, req ACPSessionRuntimeStartRequest) string {
	return firstNonEmpty(runtime.WorkspaceRuntimeID, "workspace_"+newACPSessionRuntimeID(req.SessionID, req.Generation))
}

type preparedInnerWorkspaceWispRuntime struct {
	workspaceWispName   string
	workspaceWispClient string
	commandPrefix       string
	commandShellPrefix  string
	shutdownCommand     string
}

func (w *AgentSidecarWorker) prepareInnerWorkspaceWispRuntime(ctx context.Context, host RuntimeHost, sb RuntimeHostTarget, runtime ACPSessionRuntime, req ACPSessionRuntimeStartRequest, workspaceID, workspaceRuntimeID string) (preparedInnerWorkspaceWispRuntime, error) {
	token, err := w.issueWispSMHToken(ctx, firstNonEmpty(runtime.WispSMHSpaceID, workspaceID), "admin")
	if err != nil {
		return preparedInnerWorkspaceWispRuntime{}, err
	}
	workspaceWisp := runtime
	workspaceWisp.RuntimeID = workspaceRuntimeID
	workspaceWisp.WispName = workspaceWispNameForRuntime(req.SessionID, runtime)
	workspaceWisp.WispWorkspaceID = workspaceID
	workspaceWisp.WispSMHSpaceID = firstNonEmpty(runtime.WispSMHSpaceID, workspaceID)
	workspaceWisp.WispOwnsSMHSpace = false
	workspaceWisp.WispJFSPrefix = workspaceWispJFSPrefix(runtime.WispJFSPrefix, workspaceID)
	workspaceWisp.WispInstallDir = firstNonEmpty(wispInstallDirFromClient(runtime.WorkspaceWispClient), path.Join("/tmp/cloudagent-workspace-wisp", req.SessionID, "install"))
	workspaceWisp.WispClientPath = path.Join(workspaceWisp.WispInstallDir, "bin", "wispclient")
	prepared, err := w.prepareWispRuntimeWithSpace(ctx, host, sb, workspaceWisp, req, agentWispSMHSpace{
		SpaceID:     workspaceWisp.WispSMHSpaceID,
		AccessToken: token,
		Owned:       false,
	}, "inner", false)
	if err != nil {
		return preparedInnerWorkspaceWispRuntime{}, fmt.Errorf("prepare workspace wisp runtime session_id=%s workspace_sandbox_id=%s: %w", req.SessionID, sb.ID, err)
	}
	return preparedInnerWorkspaceWispRuntime{
		workspaceWispName:   prepared.WispName,
		workspaceWispClient: prepared.WispClientPath,
		commandPrefix: shellQuote(prepared.WispClientPath) +
			" -server " + shellQuote(wispAdminAddr(prepared)) +
			" exec --stream " + shellQuote(prepared.WispName) +
			" -- /bin/sh -lc",
		commandShellPrefix: shellQuote(prepared.WispClientPath) +
			" -server " + shellQuote(wispAdminAddr(prepared)) +
			" shell " + shellQuote(prepared.WispName),
		shutdownCommand: wispWorkspaceStopCommand(prepared),
	}, nil
}

func (w *AgentSidecarWorker) attachSessionWorkspaceRuntime(ctx context.Context, backend agentSidecarBackend, runtime ACPSessionRuntime, req ACPSessionRuntimeStartRequest, workspacePrepare *workspaceRuntimePrepare) (ACPSessionRuntime, error) {
	if runtime.RemoteBinary == "" || runtime.DaemonAddr == "" || runtime.OuterSandboxID == "" {
		return ACPSessionRuntime{}, fmt.Errorf("outer runtime must be ready before binding workspace")
	}
	if runtime.InnerSandboxID != "" && runtime.WorkspaceAttachState == "bound" {
		return runtime, nil
	}
	workspaceID := workspaceIDForRuntime(runtime, req)
	workspaceJFSPrefix := workspaceWispJFSPrefix(runtime.WispJFSPrefix, workspaceID)
	if workspacePrepare == nil {
		workspacePrepare = w.startWorkspaceRuntimePrepare(ctx, backend, runtime, req, workspaceID, nil, func(string, ...string) {})
	}
	if w.workspaceService != nil {
		if err := w.workspaceService.EnsureWorkspace(ctx, WorkspaceRecord{
			WorkspaceID:           workspaceID,
			Backend:               "wisp",
			ProviderWorkspaceID:   firstNonEmpty(runtime.WispSMHSpaceID, workspaceID),
			State:                 "active",
			OwnerSessionID:        req.SessionID,
			WorkspaceVersion:      runtime.WorkspaceVersion,
			WispName:              runtime.WispName,
			WispSMHSpaceID:        runtime.WispSMHSpaceID,
			WispOwnsSMHSpace:      runtime.WispOwnsSMHSpace,
			WispPackageURL:        runtime.WispPackageURL,
			WispJFSPrefix:         workspaceJFSPrefix,
			WispRootUpperSize:     runtime.WispRootUpperSize,
			CleanupState:          "active",
			DeleteState:           "",
			OuterCleanupPending:   false,
			LastOuterCleanupError: "",
		}); err != nil {
			workspacePrepare.cancelAndCleanup(backend.host)
			return ACPSessionRuntime{}, err
		}
	}
	preparedWorkspace, err := workspacePrepare.await()
	if err != nil {
		return ACPSessionRuntime{}, err
	}
	sb := preparedWorkspace.sandbox
	payload, err := json.Marshal(map[string]any{
		"workspace_id":         workspaceID,
		"workspace_runtime_id": preparedWorkspace.workspaceRuntimeID,
		"sandbox_id":           sb.ID,
		"domain":               sb.Domain,
		"envd_access_token":    sb.EnvdAccessToken,
		"traffic_access_token": sb.TrafficAccessToken,
		"workspace_root":       acpRuntimeCWD,
		"command_prefix":       preparedWorkspace.commandPrefix,
		"command_shell_prefix": preparedWorkspace.commandShellPrefix,
		"shutdown_command":     preparedWorkspace.shutdownCommand,
		"replace_existing":     true,
	})
	if err != nil {
		cleanupPreparedWorkspaceRuntime(backend.host, preparedWorkspace)
		return ACPSessionRuntime{}, err
	}
	command := shellQuote(runtime.RemoteBinary) +
		" client --addr " + shellQuote(runtime.DaemonAddr) +
		" workspace-bind --request-b64 " + shellQuote(base64.StdEncoding.EncodeToString(payload))
	result, err := w.runOuterCommand(ctx, backend.host, runtimeOuterSandbox(runtime), runtime, command, nil, nil, func(text string) error {
		logRemoteStderr(time.Now(), workerJob{JobID: "acp_workspace_bind", ResponseID: req.SessionID}, text)
		return nil
	})
	if err != nil {
		cleanupPreparedWorkspaceRuntime(backend.host, preparedWorkspace)
		return ACPSessionRuntime{}, fmt.Errorf("bind workspace runtime session_id=%s generation=%d workspace_sandbox_id=%s: %s", req.SessionID, req.Generation, sb.ID, commandFailureDetail(err, result))
	}
	runtime.WorkspaceID = workspaceID
	runtime.WorkspaceRuntimeID = preparedWorkspace.workspaceRuntimeID
	runtime.WorkspaceWispName = preparedWorkspace.workspaceWispName
	runtime.WorkspaceWispClient = preparedWorkspace.workspaceWispClient
	runtime.WorkspaceAttachState = "bound"
	runtime.InnerSandboxID = sb.ID
	runtime.InnerSandboxDomain = sb.Domain
	runtime.InnerEnvdAccessToken = sb.EnvdAccessToken
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
		if err := w.stageSessionFiles(ctx, backend.host, sb, runtime, job); err != nil {
			return workerResult{}, err
		}
	}
	inboxMode, err := normalizeACPInboxMode(job.ACPInboxMode)
	if err != nil {
		return workerResult{}, err
	}
	historyArg := ""
	if len(job.ACPSessionHistory) > 0 {
		historyJSON, err := json.Marshal(job.ACPSessionHistory)
		if err != nil {
			return workerResult{}, fmt.Errorf("encode ACP session history seed: %w", err)
		}
		historyArg = " --history-b64 " + shellQuote(base64.StdEncoding.EncodeToString(historyJSON))
	}
	promptCommand := fmt.Sprintf(
		"%s client --addr %s session-input --session-id %s --input-id %s --inbox-mode %s --text-b64 %s --cwd-b64 %s%s",
		shellQuote(runtime.RemoteBinary),
		shellQuote(runtime.DaemonAddr),
		shellQuote(job.ACPSessionID),
		shellQuote(job.JobID),
		shellQuote(inboxMode),
		shellQuote(base64.StdEncoding.EncodeToString([]byte(job.Instruction))),
		shellQuote(base64.StdEncoding.EncodeToString([]byte(job.CWD))),
		historyArg,
	)
	cancelCommand := fmt.Sprintf(
		"%s client --addr %s session-abort --session-id %s --run-id %s --reason cancelled >/dev/null 2>&1 || true",
		shellQuote(runtime.RemoteBinary),
		shellQuote(runtime.DaemonAddr),
		shellQuote(job.ACPSessionID),
		shellQuote(job.JobID),
	)
	command := "trap " + shellQuote(cancelCommand) + " TERM INT; " + promptCommand
	var deltaSeq int64
	var eventSeq int64
	var streamedOutput strings.Builder
	stdoutParser := &sidecarStdoutParser{}
	emitStdoutEvents := func(events []sidecarStdoutEvent) error {
		for _, event := range events {
			if event.Type == "runtime_host" {
				fmt.Fprintf(os.Stderr, "timeline source=go t=%.3fs event=runtime_host_event mode=acp_session_runtime session_id=%s generation=%d outer_sandbox_id=%s job_id=%s runtime_event=%s sandbox_id=%s\n", time.Since(start).Seconds(), job.ACPSessionID, job.ACPSessionGeneration, runtime.OuterSandboxID, job.JobID, event.Event, event.SandboxID)
				continue
			}
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
	result, err := w.runOuterCommand(ctx, backend.host, sb, runtime, command, nil, func(text string) error {
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
	if !req.Force && runtime.hasInnerEnvdTarget() {
		token := runtime.InnerEnvdAccessToken
		if token == "" && runtimeHostTypeFromRuntime(runtime) == runtimeHostTypeLocalWisp {
			token = localRuntimeHostToken
		}
		fmt.Fprintf(os.Stderr, "timeline source=go event=ensure_inner_envd_cached mode=acp_session_runtime session_id=%s generation=%d outer_sandbox_id=%s inner_sandbox_id=%s\n", req.SessionID, req.Generation, runtime.OuterSandboxID, runtime.InnerSandboxID)
		return ACPSessionRuntimeUpdate{
			InnerSandboxID:       runtime.InnerSandboxID,
			InnerSandboxDomain:   runtime.InnerSandboxDomain,
			InnerEnvdAccessToken: token,
		}, nil
	}
	backend, err := w.backendForRuntime(runtime)
	if err != nil {
		return ACPSessionRuntimeUpdate{}, err
	}
	sb := runtimeOuterSandbox(runtime)
	command := w.ensureInnerCommand(runtime, req.Force)
	fmt.Fprintf(os.Stderr, "timeline source=go event=ensure_inner_envd_command_start mode=acp_session_runtime session_id=%s generation=%d outer_sandbox_id=%s force=%t has_inner_target=%t daemon_addr=%s\n", req.SessionID, req.Generation, runtime.OuterSandboxID, req.Force, runtime.hasInnerEnvdTarget(), quoteTimelineField(runtime.DaemonAddr))
	result, err := w.runOuterControlCommand(ctx, backend.host, sb, runtime, command, nil)
	if err != nil {
		detail := commandFailureDetail(err, result)
		fmt.Fprintf(os.Stderr, "timeline source=go event=ensure_inner_envd_command_failed mode=acp_session_runtime session_id=%s generation=%d outer_sandbox_id=%s stdout_bytes=%d stderr_bytes=%d error=%s\n", req.SessionID, req.Generation, runtime.OuterSandboxID, len(result.Stdout), len(result.Stderr), quoteTimelineField(detail))
		return ACPSessionRuntimeUpdate{}, fmt.Errorf("ensure inner envd session_id=%s generation=%d outer_sandbox_id=%s: %s", req.SessionID, req.Generation, runtime.OuterSandboxID, detail)
	}
	var response sidecarEnsureInnerResponse
	if err := json.Unmarshal([]byte(lastJSONLine(result.Stdout)), &response); err != nil {
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

func (w *AgentSidecarWorker) stageSessionFiles(ctx context.Context, host RuntimeHost, sb RuntimeHostTarget, runtime ACPSessionRuntime, job workerJob) error {
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
		if runtime.isWispOuterRuntime() {
			if _, err := w.runOuterCommand(ctx, host, sb, runtime, base64DecodeToFileCommand(outerPath, content), nil, nil, nil); err != nil {
				return fmt.Errorf("stage input file %s to wisp outer runtime: %w", file.FileID, err)
			}
			if shouldUseWorkspaceWispTransfer(runtime) {
				workspaceRuntime := runtime
				workspaceRuntime.WispName = runtime.WorkspaceWispName
				workspaceRuntime.WispClientPath = ""
				if err := stageWorkspaceRuntimeContent(ctx, host, workspaceRuntime, outerPath, content); err != nil {
					return fmt.Errorf("stage input file %s to workspace wisp runtime: %w", file.FileID, err)
				}
			}
		} else if err := host.UploadFile(ctx, sb, outerPath, file.Filename, content); err != nil {
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
	_, err = w.runOuterCommand(ctx, host, sb, runtime, command, nil, nil, func(text string) error {
		logRemoteStderr(time.Now(), workerJob{JobID: job.JobID, ResponseID: job.ResponseID}, text)
		return nil
	})
	if err != nil {
		return fmt.Errorf("stage input files session_id=%s generation=%d outer_sandbox_id=%s: %w", job.ACPSessionID, job.ACPSessionGeneration, sb.ID, err)
	}
	return nil
}

func (w *AgentSidecarWorker) stageResponseRuntimeFiles(ctx context.Context, host RuntimeHost, sb RuntimeHostTarget, sessionID string, job workerJob) (sidecarStageFilesManifest, error) {
	manifest := sidecarStageFilesManifest{
		SessionID:     sessionID,
		Generation:    1,
		WorkspaceRoot: acpRuntimeCWD,
		Files:         make([]sidecarStageFileEntry, 0, len(job.InputFiles)),
	}
	for _, file := range job.InputFiles {
		workspacePath := strings.TrimSpace(file.WorkspacePath)
		if workspacePath == "" {
			workspacePath = "./inputs/" + sanitizeRemoteName(file.Filename)
		}
		relativePath := strings.TrimPrefix(workspacePath, "./")
		if strings.HasPrefix(relativePath, "/") || strings.HasPrefix(relativePath, "../") {
			return sidecarStageFilesManifest{}, fmt.Errorf("input file %s has unsafe workspace path %q", file.FileID, workspacePath)
		}
		content, err := os.ReadFile(file.Path)
		if err != nil {
			return sidecarStageFilesManifest{}, fmt.Errorf("read input file %s: %w", file.FileID, err)
		}
		outerPath := path.Join(acpRuntimeCWD, relativePath)
		if err := host.UploadFile(ctx, sb, outerPath, file.Filename, content); err != nil {
			return sidecarStageFilesManifest{}, fmt.Errorf("stage response input file %s to outer sandbox: %w", file.FileID, err)
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
	return manifest, nil
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
	var gracefulStopErr error
	innerDeleteFallback := runtime.InnerSandboxID != ""
	workspaceWispStopped := false
	workspaceWispStopRequired := false
	innerDeletedBySidecar := false
	outerWispStopRequired := false
	outerWispStopped := false
	if runtime.OuterSandboxID != "" && runtime.RemoteBinary != "" && runtime.DaemonAddr != "" {
		sb := runtimeOuterSandbox(runtime)
		shutdownCtx, shutdownCancel := context.WithTimeout(ctx, envDurationSeconds("GATEWAY_SIDECAR_SHUTDOWN_TIMEOUT_SECONDS", 45*time.Second))
		start := time.Now()
		stdoutParser := &sidecarStdoutParser{}
		var runtimeHostShutdownErr error
		logRuntimeHostEvents := func(events []sidecarStdoutEvent) {
			for _, event := range events {
				if event.Type != "runtime_host" {
					continue
				}
				fmt.Fprintf(os.Stderr, "timeline source=go t=%.3fs event=runtime_host_event mode=acp_session_runtime runtime_id=%s outer_sandbox_id=%s runtime_event=%s sandbox_id=%s\n", time.Since(start).Seconds(), runtime.RuntimeID, runtime.OuterSandboxID, event.Event, event.SandboxID)
				if event.Event == "inner_shutdown_failed" || event.Event == "workspace_runtime_shutdown_failed" {
					runtimeHostShutdownErr = fmt.Errorf("runtime host %s sandbox_id=%s error=%s", event.Event, event.SandboxID, event.Error)
					continue
				}
				if event.Event == "workspace_runtime_shutdown_done" {
					workspaceWispStopped = true
				}
				if event.Event == "inner_shutdown_done" {
					innerDeletedBySidecar = true
				}
			}
		}
		_, shutdownErr := w.runOuterCommand(shutdownCtx, backend.host, sb, runtime, shellQuote(runtime.RemoteBinary)+" client --addr "+shellQuote(runtime.DaemonAddr)+" shutdown", nil, func(text string) error {
			logRuntimeHostEvents(stdoutParser.Feed(text))
			return nil
		}, nil)
		logRuntimeHostEvents(stdoutParser.Finish())
		if shutdownErr == nil && runtimeHostShutdownErr == nil {
			innerDeleteFallback = false
		} else {
			if shutdownErr == nil {
				shutdownErr = runtimeHostShutdownErr
			}
			if runtime.isWispOuterRuntime() {
				innerDeleteFallback = false
				gracefulStopErr = errors.Join(gracefulStopErr, fmt.Errorf("shutdown inner workspace runtime: %w", shutdownErr))
			}
			fmt.Fprintf(os.Stderr, "timeline source=go event=acp_runtime_sidecar_shutdown_failed runtime_id=%s outer_sandbox_id=%s error=%s\n", runtime.RuntimeID, runtime.OuterSandboxID, quoteServerField(shutdownErr.Error()))
		}
		shutdownCancel()
	}
	if runtime.InnerSandboxID != "" && runtime.isWispOuterRuntime() && strings.TrimSpace(runtime.WorkspaceWispName) != "" && !workspaceWispStopped && !innerDeletedBySidecar {
		workspaceWispStopRequired = true
		sb := runtimeInnerSandbox(runtime)
		stopCtx, stopCancel := context.WithTimeout(ctx, envDurationSeconds("GATEWAY_WISP_STOP_TIMEOUT_SECONDS", 60*time.Second))
		fmt.Fprintf(os.Stderr, "timeline source=go event=acp_runtime_workspace_wisp_stop_start runtime_id=%s inner_sandbox_id=%s wisp_name=%s lease_id=%s fence=%d\n", runtime.RuntimeID, runtime.InnerSandboxID, quoteServerField(runtime.WorkspaceWispName), quoteServerField(runtime.WispLeaseID), runtime.WispLeaseFence)
		if err := w.stopWispWorkspaceRuntime(stopCtx, backend.host, sb, runtime); err != nil {
			gracefulStopErr = errors.Join(gracefulStopErr, fmt.Errorf("stop workspace wisp runtime %s: %w", runtime.WorkspaceWispName, err))
			fmt.Fprintf(os.Stderr, "timeline source=go event=acp_runtime_workspace_wisp_stop_failed runtime_id=%s inner_sandbox_id=%s wisp_name=%s lease_id=%s fence=%d error=%s\n", runtime.RuntimeID, runtime.InnerSandboxID, quoteServerField(runtime.WorkspaceWispName), quoteServerField(runtime.WispLeaseID), runtime.WispLeaseFence, quoteServerField(err.Error()))
		} else {
			workspaceWispStopped = true
			fmt.Fprintf(os.Stderr, "timeline source=go event=acp_runtime_workspace_wisp_stop_done runtime_id=%s inner_sandbox_id=%s wisp_name=%s lease_id=%s fence=%d\n", runtime.RuntimeID, runtime.InnerSandboxID, quoteServerField(runtime.WorkspaceWispName), quoteServerField(runtime.WispLeaseID), runtime.WispLeaseFence)
		}
		stopCancel()
	}
	if runtime.OuterSandboxID != "" && runtime.isWispOuterRuntime() && runtime.WispName != "" {
		outerWispStopRequired = true
		sb := runtimeOuterSandbox(runtime)
		stopCtx, stopCancel := context.WithTimeout(ctx, envDurationSeconds("GATEWAY_WISP_STOP_TIMEOUT_SECONDS", 60*time.Second))
		fmt.Fprintf(os.Stderr, "timeline source=go event=acp_runtime_wisp_stop_start runtime_id=%s outer_sandbox_id=%s wisp_name=%s lease_id=%s fence=%d\n", runtime.RuntimeID, runtime.OuterSandboxID, quoteServerField(runtime.WispName), quoteServerField(runtime.WispLeaseID), runtime.WispLeaseFence)
		if err := w.stopWispOuterRuntime(stopCtx, backend.host, sb, runtime); err != nil {
			gracefulStopErr = fmt.Errorf("stop wisp outer runtime %s: %w", runtime.WispName, err)
			fmt.Fprintf(os.Stderr, "timeline source=go event=acp_runtime_wisp_stop_failed runtime_id=%s outer_sandbox_id=%s wisp_name=%s lease_id=%s fence=%d error=%s\n", runtime.RuntimeID, runtime.OuterSandboxID, quoteServerField(runtime.WispName), quoteServerField(runtime.WispLeaseID), runtime.WispLeaseFence, quoteServerField(err.Error()))
		} else {
			outerWispStopped = true
			fmt.Fprintf(os.Stderr, "timeline source=go event=acp_runtime_wisp_stop_done runtime_id=%s outer_sandbox_id=%s wisp_name=%s lease_id=%s fence=%d\n", runtime.RuntimeID, runtime.OuterSandboxID, quoteServerField(runtime.WispName), quoteServerField(runtime.WispLeaseID), runtime.WispLeaseFence)
		}
		stopCancel()
	}
	if innerDeleteFallback {
		if err := backend.host.DeleteSandbox(ctx, runtime.InnerSandboxID); err != nil {
			cleanupErr = errors.Join(cleanupErr, fmt.Errorf("delete inner sandbox %s: %w", runtime.InnerSandboxID, err))
		}
	} else if workspaceWispStopped && !innerDeletedBySidecar {
		if err := backend.host.DeleteSandbox(ctx, runtime.InnerSandboxID); err != nil {
			cleanupErr = errors.Join(cleanupErr, fmt.Errorf("delete stopped workspace sandbox %s: %w", runtime.InnerSandboxID, err))
		}
	}
	if runtime.WispLeaseID != "" && shouldReleaseWispLeaseAfterClose(outerWispStopRequired, outerWispStopped, workspaceWispStopRequired, workspaceWispStopped) {
		releaseCtx, releaseCancel := context.WithTimeout(context.Background(), envDurationSeconds("GATEWAY_WISP_LEASE_RELEASE_TIMEOUT_SECONDS", 15*time.Second))
		if err := w.releaseWispWorkspaceLease(releaseCtx, runtime); err != nil {
			cleanupErr = errors.Join(cleanupErr, fmt.Errorf("release wisp workspace lease %s: %w", runtime.WispLeaseID, err))
		}
		releaseCancel()
	} else if runtime.WispLeaseID != "" {
		fmt.Fprintf(os.Stderr, "timeline source=go event=acp_runtime_wisp_lease_release_blocked runtime_id=%s outer_sandbox_id=%s inner_sandbox_id=%s wisp_name=%s workspace_wisp_name=%s lease_id=%s fence=%d reason=stop_not_confirmed\n", runtime.RuntimeID, runtime.OuterSandboxID, runtime.InnerSandboxID, quoteServerField(runtime.WispName), quoteServerField(runtime.WorkspaceWispName), quoteServerField(runtime.WispLeaseID), runtime.WispLeaseFence)
	}
	if runtime.OuterSandboxID != "" {
		outerDeleted := false
		if err := backend.host.DeleteSandbox(ctx, runtime.OuterSandboxID); err != nil {
			cleanupErr = errors.Join(cleanupErr, fmt.Errorf("delete outer sandbox %s: %w", runtime.OuterSandboxID, err))
		} else {
			outerDeleted = true
		}
		if outerDeleted && isStaleRuntimeDataPlaneAuthError(gracefulStopErr) {
			fmt.Fprintf(os.Stderr, "timeline source=go event=acp_runtime_stale_dataplane_auth_deleted runtime_id=%s outer_sandbox_id=%s error=%s\n", runtime.RuntimeID, runtime.OuterSandboxID, quoteServerField(gracefulStopErr.Error()))
			gracefulStopErr = nil
		}
	}
	if gracefulStopErr != nil {
		cleanupErr = errors.Join(cleanupErr, gracefulStopErr)
	}
	return cleanupErr
}

func shouldReleaseWispLeaseAfterClose(outerRequired, outerStopped, workspaceRequired, workspaceStopped bool) bool {
	if outerRequired && !outerStopped {
		return false
	}
	if workspaceRequired && !workspaceStopped {
		return false
	}
	return true
}

func (w *AgentSidecarWorker) DeleteSessionRuntime(ctx context.Context, runtime ACPSessionRuntime) error {
	if err := w.CloseSessionRuntime(ctx, runtime); err != nil {
		return err
	}
	var cleanupErr error
	if runtime.WispOwnsSMHSpace && runtime.WispSMHSpaceID != "" {
		if err := w.deleteWispSMHSpace(ctx, runtime.WispSMHSpaceID); err != nil {
			cleanupErr = errors.Join(cleanupErr, fmt.Errorf("delete wisp SMH space %s: %w", runtime.WispSMHSpaceID, err))
		}
	}
	return cleanupErr
}

func (w *AgentSidecarWorker) CancelSessionRuntime(ctx context.Context, runtime ACPSessionRuntime, sessionID, jobID string) error {
	if runtime.OuterSandboxID == "" || runtime.RemoteBinary == "" || runtime.DaemonAddr == "" {
		return nil
	}
	backend, err := w.backendForRuntime(runtime)
	if err != nil {
		return err
	}
	sb := runtimeOuterSandbox(runtime)
	command := shellQuote(runtime.RemoteBinary) + " client --addr " + shellQuote(runtime.DaemonAddr) + " session-abort --session-id " + shellQuote(sessionID)
	if jobID != "" {
		command += " --run-id " + shellQuote(jobID)
	}
	_, err = w.runOuterCommand(ctx, backend.host, sb, runtime, command, nil, nil, nil)
	return err
}

func (w *AgentSidecarWorker) SessionRuntimeStatus(ctx context.Context, runtime ACPSessionRuntime, sessionID string) (ACPSessionRuntimeStatusSnapshot, error) {
	if runtime.OuterSandboxID == "" || runtime.RemoteBinary == "" || runtime.DaemonAddr == "" {
		return ACPSessionRuntimeStatusSnapshot{}, fmt.Errorf("runtime identity is missing")
	}
	backend, err := w.backendForRuntime(runtime)
	if err != nil {
		return ACPSessionRuntimeStatusSnapshot{}, err
	}
	sb := runtimeOuterSandbox(runtime)
	command := shellQuote(runtime.RemoteBinary) + " client --addr " + shellQuote(runtime.DaemonAddr) + " session-status"
	result, err := w.runOuterControlCommand(ctx, backend.host, sb, runtime, command, nil)
	if err != nil {
		return ACPSessionRuntimeStatusSnapshot{}, err
	}
	var snapshot ACPSessionRuntimeStatusSnapshot
	if err := json.Unmarshal([]byte(lastJSONLine(result.Stdout)), &snapshot); err != nil {
		return ACPSessionRuntimeStatusSnapshot{}, fmt.Errorf("parse runtime status: %w", err)
	}
	if snapshot.SessionID == "" {
		snapshot.SessionID = sessionID
	}
	return snapshot, nil
}

func (w *AgentSidecarWorker) KillSessionRuntimeDaemon(ctx context.Context, runtime ACPSessionRuntime) error {
	if runtime.OuterSandboxID == "" || runtime.RemoteBinary == "" {
		return fmt.Errorf("runtime identity is missing")
	}
	backend, err := w.backendForRuntime(runtime)
	if err != nil {
		return err
	}
	sb := runtimeOuterSandbox(runtime)
	sessionRoot := path.Dir(runtime.RemoteBinary)
	pidPath := path.Join(sessionRoot, "daemon.pid")
	killReq := RuntimeHostProcessGroupKillRequest{
		PIDFile:                  pidPath,
		ProcessPattern:           runtime.RemoteBinary + " daemon",
		AllowProcessNameFallback: envFlagEnabled("GATEWAY_ACP_FAULT_INJECTION_PKILL_FALLBACK"),
	}
	if runtime.isWispOuterRuntime() {
		if runtime.WispClientPath == "" || runtime.WispName == "" {
			return fmt.Errorf("wisp runtime identity is incomplete")
		}
		killCommand, err := runtimeHostProcessGroupKillCommand(killReq)
		if err != nil {
			return err
		}
		command := "set -e; " + shellQuote(runtime.WispClientPath) +
			" -server " + shellQuote(wispAdminAddr(runtime)) +
			" exec " + shellQuote(runtime.WispName) +
			" -- /bin/sh -lc " + shellQuote(killCommand)
		_, err = w.runOuterCommand(ctx, backend.host, sb, runtime, command, nil, nil, nil)
		return err
	}
	return runtimeHostKillTargetProcessGroup(ctx, backend.host, sb, killReq)
}

func (w *AgentSidecarWorker) KillSessionRuntimeOuter(ctx context.Context, runtime ACPSessionRuntime) error {
	if runtime.OuterSandboxID == "" {
		return fmt.Errorf("runtime outer sandbox identity is missing")
	}
	backend, err := w.backendForRuntime(runtime)
	if err != nil {
		return err
	}
	return backend.host.DeleteSandbox(ctx, runtime.OuterSandboxID)
}

func (w *AgentSidecarWorker) KillSessionRuntimeInner(ctx context.Context, runtime ACPSessionRuntime) error {
	if runtime.OuterSandboxID == "" || runtime.RemoteBinary == "" || runtime.DaemonAddr == "" {
		return fmt.Errorf("runtime identity is missing")
	}
	backend, err := w.backendForRuntime(runtime)
	if err != nil {
		return err
	}
	sb := runtimeOuterSandbox(runtime)
	command := shellQuote(runtime.RemoteBinary) + " client --addr " + shellQuote(runtime.DaemonAddr) + " shutdown-inner"
	start := time.Now()
	stdoutParser := &sidecarStdoutParser{}
	logRuntimeHostEvents := func(events []sidecarStdoutEvent) {
		for _, event := range events {
			if event.Type != "runtime_host" {
				continue
			}
			fmt.Fprintf(os.Stderr, "timeline source=go t=%.3fs event=runtime_host_event mode=acp_session_runtime_fault runtime_id=%s outer_sandbox_id=%s runtime_event=%s sandbox_id=%s\n", time.Since(start).Seconds(), runtime.RuntimeID, runtime.OuterSandboxID, event.Event, event.SandboxID)
		}
	}
	_, err = w.runOuterCommand(ctx, backend.host, sb, runtime, command, nil, func(text string) error {
		logRuntimeHostEvents(stdoutParser.Feed(text))
		return nil
	}, nil)
	logRuntimeHostEvents(stdoutParser.Finish())
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
		" && " + downloadURLToFileCommand(artifact.URL, remoteBinary)
	if artifact.SHA256 != "" {
		download += " && printf '%s  %s\\n' " + shellQuote(artifact.SHA256) + " " + shellQuote(remoteBinary) + " | sha256sum -c -"
	}
	return download
}

func downloadURLToFileCommand(rawURL, outputPath string) string {
	quotedURL := shellQuote(rawURL)
	quotedOutput := shellQuote(outputPath)
	return "(if command -v curl >/dev/null 2>&1; then " +
		"curl -fsSL --show-error --retry 3 --retry-delay 1 --connect-timeout 10 --max-time 180 -o " + quotedOutput + " " + quotedURL +
		"; elif command -v python3 >/dev/null 2>&1; then " +
		"python3 - " + quotedURL + " " + quotedOutput + " <<'CLOUDAGENT_DOWNLOAD_PY'\n" +
		"import sys\n" +
		"import urllib.request\n" +
		"url, output = sys.argv[1], sys.argv[2]\n" +
		"with urllib.request.urlopen(url, timeout=180) as response, open(output, 'wb') as fh:\n" +
		"    while True:\n" +
		"        chunk = response.read(1024 * 1024)\n" +
		"        if not chunk:\n" +
		"            break\n" +
		"        fh.write(chunk)\n" +
		"CLOUDAGENT_DOWNLOAD_PY\n" +
		"elif command -v wget >/dev/null 2>&1; then " +
		"wget -q -O " + quotedOutput + " " + quotedURL +
		"; else echo 'missing curl, python3, and wget for download' >&2; exit 127; fi)"
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

func sidecarHealthCommand(remoteBinary, addr string) string {
	return sidecarPlainCommand(remoteBinary, "client", "--addr", addr, "health")
}

func (w *AgentSidecarWorker) responseRuntimeCommand(remoteBinary string, artifact agentSidecarArtifact, backend agentSidecarBackend, job workerJob, manifest sidecarStageFilesManifest) (string, error) {
	host := backend.runtimeHost()
	sessionID := responseRuntimeSessionID(job)
	sessionRoot := path.Dir(remoteBinary)
	workspace := acpRuntimeCWD
	memoryDir := path.Join(sessionRoot, "memory")
	logPath := path.Join(sessionRoot, "daemon.log")
	pidPath := path.Join(sessionRoot, "daemon.pid")
	daemonAddr := acpDaemonAddr(sessionID)
	listenAddr := strings.TrimPrefix(strings.TrimPrefix(daemonAddr, "http://"), "https://")
	runtime := ACPSessionRuntime{
		RemoteBinary:        remoteBinary,
		DaemonAddr:          daemonAddr,
		AgentVersion:        defaultAgentVersion,
		AgentTemplateID:     backend.outerTemplateID,
		WorkspaceVersion:    defaultWorkspaceVersion,
		WorkspaceTemplateID: backend.innerTemplateID,
	}
	daemonArgs := []string{
		"daemon",
		"--addr", listenAddr,
		"--session-id", sessionID,
		"--workspace", workspace,
		"--memory-dir", memoryDir,
	}
	var prepare string
	var daemonCommand string
	if artifact.signed() {
		prepare = "mkdir -p " + shellQuote(sessionRoot)
		daemonCommand = sidecarLoaderCommand(w.agentLoaderPath, remoteBinary, artifact, daemonArgs...)
	} else if artifact.URL != "" {
		prepare = sidecarDownloadCommand(remoteBinary, artifact) + " && chmod +x " + shellQuote(remoteBinary)
		daemonCommand = sidecarPlainCommand(remoteBinary, daemonArgs...)
	} else {
		prepare = "mkdir -p " + shellQuote(sessionRoot) + " && chmod +x " + shellQuote(remoteBinary)
		daemonCommand = sidecarPlainCommand(remoteBinary, daemonArgs...)
	}
	hostEnv := host.RuntimeHostEnv()
	workspaceOwner := hostEnv.EnvdUser
	if workspaceOwner == "" {
		workspaceOwner = "user"
	}
	start := buildBuiltinAgentInitScript(agentInitScriptContext{
		Prepare:        prepare,
		Workspace:      workspace,
		WorkspaceOwner: workspaceOwner,
		Runtime:        runtime,
		SessionID:      sessionID,
		ListenAddr:     listenAddr,
		MemoryDir:      memoryDir,
		LogPath:        logPath,
		PIDPath:        pidPath,
		DaemonCommand:  daemonCommand,
	})
	healthAttempts := envInt("GATEWAY_AGENT_SIDECAR_HEALTH_ATTEMPTS", 240)
	health := sidecarInlineHealthWaitCommand(remoteBinary, daemonAddr, logPath, pidPath, healthAttempts)
	sessionCreate := sidecarPlainCommand(remoteBinary,
		"client", "--addr", daemonAddr, "session-create",
		"--session-id", sessionID,
		"--agent-version", defaultAgentVersion,
		"--workspace-version", defaultWorkspaceVersion,
		"--cwd-b64", base64.StdEncoding.EncodeToString([]byte(acpRuntimeCWD)),
	) + " >/dev/null"
	stage := ""
	if len(manifest.Files) > 0 {
		payload, err := json.Marshal(manifest)
		if err != nil {
			return "", err
		}
		stage = " && " + sidecarPlainCommand(remoteBinary,
			"client", "--addr", daemonAddr, "stage-files",
			"--manifest-b64", base64.StdEncoding.EncodeToString(payload),
		) + " >/dev/null"
	}
	input := sidecarPlainCommand(remoteBinary,
		"client", "--addr", daemonAddr, "session-input",
		"--session-id", sessionID,
		"--input-id", job.JobID,
		"--inbox-mode", "prompt",
		"--text-b64", base64.StdEncoding.EncodeToString([]byte(job.Instruction)),
		"--cwd-b64", base64.StdEncoding.EncodeToString([]byte(acpRuntimeCWD)),
	)
	shutdown := sidecarPlainCommand(remoteBinary, "client", "--addr", daemonAddr, "shutdown") + " 2>/dev/null || true"
	return "trap " + shellQuote(shutdown) + " EXIT; " + start + " && " + health + " && " + sessionCreate + stage + " && " + input, nil
}

func responseRuntimeSessionID(job workerJob) string {
	raw := firstNonEmpty(job.ResponseID, job.JobID, randomHex(8))
	return "response_" + sanitizeRemoteName(raw)
}

func sidecarDaemonDebugCommand(remoteBinary, logPath, pidPath string) string {
	return "{ " +
		"echo CLOUDAGENT_DAEMON_HEALTH_TIMEOUT >&2; " +
		"echo binary=" + shellQuote(remoteBinary) + " >&2; " +
		"ls -l " + shellQuote(remoteBinary) + " >&2 2>/dev/null || true; " +
		"echo pid_file=" + shellQuote(pidPath) + " >&2; " +
		"if [ -f " + shellQuote(pidPath) + " ]; then pid=$(cat " + shellQuote(pidPath) + " 2>/dev/null || true); echo pid=$pid >&2; if [ -n \"$pid\" ] && [ -e /proc/$pid/status ]; then sed -n '1,40p' /proc/$pid/status >&2 2>/dev/null || true; fi; fi; " +
		"echo log_file=" + shellQuote(logPath) + " >&2; " +
		"ls -l " + shellQuote(logPath) + " >&2 2>/dev/null || true; " +
		"sed -n '1,200p' " + shellQuote(logPath) + " >&2 2>/dev/null || true; " +
		"}"
}

func sidecarInlineHealthWaitCommand(remoteBinary, daemonAddr, logPath, pidPath string, attempts int) string {
	if attempts <= 0 {
		attempts = 1
	}
	return "{ " +
		"cloudagent_health_ok=0; " +
		fmt.Sprintf("for i in $(seq 1 %d); do ", attempts) +
		sidecarHealthCommand(remoteBinary, daemonAddr) + " >/dev/null 2>&1 && { cloudagent_health_ok=1; break; }; " +
		"sleep 0.5; " +
		"done; " +
		"if [ \"$cloudagent_health_ok\" = 1 ]; then true; else " +
		sidecarDaemonDebugCommand(remoteBinary, logPath, pidPath) +
		"; exit 1; fi; " +
		"}"
}

func sidecarDaemonTerminateCommand(pidPath, fallbackPattern string) string {
	command, err := runtimeHostProcessGroupKillCommand(RuntimeHostProcessGroupKillRequest{
		PIDFile:                  pidPath,
		ProcessPattern:           fallbackPattern,
		AllowProcessNameFallback: envFlagEnabled("GATEWAY_ACP_FAULT_INJECTION_PKILL_FALLBACK"),
	})
	if err != nil {
		return "echo " + shellQuote(err.Error()) + " >&2\nexit 1\n"
	}
	return command
}

func buildBuiltinAgentInitScript(ctx agentInitScriptContext) string {
	daemonCommand := ctx.DaemonCommand
	if daemonCommand == "" {
		daemonCommand = shellQuote(ctx.Runtime.RemoteBinary)
	}
	mkdirWorkspace := "sudo -n mkdir -p " + shellQuote(ctx.Workspace) +
		" && sudo -n chown " + shellQuote(ctx.WorkspaceOwner+":"+ctx.WorkspaceOwner) + " " + shellQuote(ctx.Workspace)
	if ctx.WorkspaceOwner == "root" {
		mkdirWorkspace = "mkdir -p " + shellQuote(ctx.Workspace) +
			" && chown root:root " + shellQuote(ctx.Workspace)
	}
	return ctx.Prepare +
		" && " + mkdirWorkspace +
		" && mkdir -p " + shellQuote(ctx.MemoryDir) +
		" && printf '%s\\n' " + shellQuote("timeline source=daemon_launcher event=start workspace="+ctx.Workspace+" argv="+ctx.Runtime.RemoteBinary+" daemon --addr "+ctx.ListenAddr+" --session-id "+ctx.SessionID) + " >> " + shellQuote(ctx.LogPath) +
		" && ( ( trap '' HUP; exec " + daemonCommand + " ) > " + shellQuote(ctx.LogPath) + " 2>&1 < /dev/null & echo $! > " + shellQuote(ctx.PIDPath) + " )"
}

func (w *AgentSidecarWorker) bootSessionDaemon(ctx context.Context, sb RuntimeHostTarget, runtime ACPSessionRuntime, req ACPSessionRuntimeStartRequest) error {
	backend, err := w.backendForRuntime(runtime)
	if err != nil {
		return err
	}
	sessionRoot := path.Dir(runtime.RemoteBinary)
	workspace := acpRuntimeCWD
	memoryDir := path.Join(sessionRoot, "memory")
	if runtime.isWispOuterRuntime() {
		memoryDir = path.Join(workspace, ".cloudagent", "sessions", req.SessionID, "hermes")
	}
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
	if runtime.isWispOuterRuntime() && artifact.URL == "" {
		return fmt.Errorf("wisp outer runtime requires sidecar URL; local sidecar upload is not supported")
	}
	if runtime.isWispOuterRuntime() && artifact.URL != "" {
		if err := w.stageSidecarBinaryIntoWisp(ctx, backend.host, sb, runtime, artifact); err != nil {
			return err
		}
		prepare = "mkdir -p " + shellQuote(sessionRoot) + " && chmod +x " + shellQuote(runtime.RemoteBinary)
		daemonCommand = sidecarPlainCommand(runtime.RemoteBinary, daemonArgs...)
	} else if artifact.signed() {
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
		if err := backend.host.UploadFile(ctx, sb, runtime.RemoteBinary, "hermes-sidecar", binary); err != nil {
			return err
		}
		prepare = "mkdir -p " + shellQuote(sessionRoot)
		prepare += " && chmod +x " + shellQuote(runtime.RemoteBinary)
		daemonCommand = sidecarPlainCommand(runtime.RemoteBinary, daemonArgs...)
	}
	hostEnv := backend.host.RuntimeHostEnv()
	env := map[string]string{
		"TOKENHUB_API_KEY":              w.tokenHubAPIKey,
		"TOKENHUB_MODEL":                w.tokenHubModel,
		"E2B_API_KEY":                   hostEnv.APIKey,
		"E2B_API_URL":                   hostEnv.APIURL,
		"E2B_DOMAIN":                    hostEnv.Domain,
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
	addWebSearchEnv(env)
	for key, value := range runtimeClockEnv(time.Now()) {
		env[key] = value
	}
	workspaceOwner := hostEnv.EnvdUser
	if workspaceOwner == "" {
		workspaceOwner = "user"
	}
	if runtime.isWispOuterRuntime() {
		workspaceOwner = "root"
	}
	if runtime.isWispOuterRuntime() {
		command := w.sandboxHostEnvPrefix() + wispSessionDaemonHostCommand(runtime, daemonArgs, workspace, memoryDir, logPath, env)
		if _, err := backend.host.RunCommand(ctx, sb, command, nil, nil, func(text string) error {
			logRemoteStderr(time.Now(), workerJob{JobID: "acp_daemon_start", ResponseID: req.SessionID}, text)
			return nil
		}); err != nil {
			return fmt.Errorf("acp daemon start session_id=%s generation=%d outer_sandbox_id=%s: %w", req.SessionID, req.Generation, sb.ID, err)
		}
		healthAttempts := envInt("GATEWAY_AGENT_SIDECAR_HEALTH_ATTEMPTS", 240)
		health := fmt.Sprintf("for i in $(seq 1 %d); do ", healthAttempts) + sidecarHealthCommand(runtime.RemoteBinary, runtime.DaemonAddr) + " >/dev/null 2>&1 && exit 0; sleep 0.5; done; " + sidecarDaemonDebugCommand(runtime.RemoteBinary, logPath, pidPath) + "; exit 1"
		_, err = w.runOuterCommand(ctx, backend.host, sb, runtime, health, nil, nil, func(text string) error {
			logRemoteStderr(time.Now(), workerJob{JobID: "acp_daemon_health", ResponseID: req.SessionID}, text)
			return nil
		})
		if err != nil {
			hostLog := path.Join(path.Dir(runtime.RemoteBinary), "wispclient-daemon.log")
			_, _ = backend.host.RunCommand(ctx, sb, "cat "+shellQuote(hostLog)+" >&2 || true", nil, nil, func(text string) error {
				logRemoteStderr(time.Now(), workerJob{JobID: "acp_daemon_host_log", ResponseID: req.SessionID}, text)
				return nil
			})
			return fmt.Errorf("acp daemon health session_id=%s generation=%d outer_sandbox_id=%s: %w", req.SessionID, req.Generation, sb.ID, err)
		}
		return w.createSessionDaemonSession(ctx, backend.host, sb, runtime, req)
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
	if _, err := w.runOuterCommand(ctx, backend.host, sb, runtime, command, env, nil, func(text string) error {
		logRemoteStderr(time.Now(), workerJob{JobID: "acp_daemon_start", ResponseID: req.SessionID}, text)
		return nil
	}); err != nil {
		return fmt.Errorf("acp daemon start session_id=%s generation=%d outer_sandbox_id=%s: %w", req.SessionID, req.Generation, sb.ID, err)
	}
	healthAttempts := envInt("GATEWAY_AGENT_SIDECAR_HEALTH_ATTEMPTS", 240)
	health := fmt.Sprintf("for i in $(seq 1 %d); do ", healthAttempts) + sidecarHealthCommand(runtime.RemoteBinary, runtime.DaemonAddr) + " >/dev/null 2>&1 && exit 0; sleep 0.5; done; " + sidecarDaemonDebugCommand(runtime.RemoteBinary, logPath, pidPath) + "; exit 1"
	_, err = w.runOuterCommand(ctx, backend.host, sb, runtime, health, nil, nil, func(text string) error {
		logRemoteStderr(time.Now(), workerJob{JobID: "acp_daemon_health", ResponseID: req.SessionID}, text)
		return nil
	})
	if err != nil {
		return fmt.Errorf("acp daemon health session_id=%s generation=%d outer_sandbox_id=%s: %w", req.SessionID, req.Generation, sb.ID, err)
	}
	return w.createSessionDaemonSession(ctx, backend.host, sb, runtime, req)
}

func (w *AgentSidecarWorker) createSessionDaemonSession(ctx context.Context, host RuntimeHost, sb RuntimeHostTarget, runtime ACPSessionRuntime, req ACPSessionRuntimeStartRequest) error {
	command := shellQuote(runtime.RemoteBinary) +
		" client --addr " + shellQuote(runtime.DaemonAddr) + " session-create" +
		" --session-id " + shellQuote(req.SessionID) +
		" --agent-version " + shellQuote(runtime.AgentVersion) +
		" --workspace-version " + shellQuote(runtime.WorkspaceVersion) +
		" --cwd-b64 " + shellQuote(base64.StdEncoding.EncodeToString([]byte(req.CWD)))
	result, err := w.runOuterCommand(ctx, host, sb, runtime, command, nil, nil, func(text string) error {
		logRemoteStderr(time.Now(), workerJob{JobID: "acp_daemon_session_create", ResponseID: req.SessionID}, text)
		return nil
	})
	if err != nil {
		detail := commandFailureDetail(err, result)
		return fmt.Errorf("acp daemon session-create session_id=%s generation=%d outer_sandbox_id=%s: %s", req.SessionID, req.Generation, runtime.OuterSandboxID, detail)
	}
	return nil
}

func runtimeOuterSandbox(runtime ACPSessionRuntime) RuntimeHostTarget {
	return RuntimeHostTarget{
		ID:                 runtime.OuterSandboxID,
		Domain:             runtime.OuterSandboxDomain,
		EnvdAccessToken:    runtime.OuterEnvdAccessToken,
		TrafficAccessToken: runtime.OuterTrafficToken,
		HostType:           runtimeHostTypeFromRuntime(runtime),
	}
}

func runtimeInnerSandbox(runtime ACPSessionRuntime) RuntimeHostTarget {
	return RuntimeHostTarget{
		ID:              runtime.InnerSandboxID,
		Domain:          runtime.InnerSandboxDomain,
		EnvdAccessToken: runtime.InnerEnvdAccessToken,
		HostType:        runtimeHostTypeFromRuntime(runtime),
	}
}

func runtimeHostTypeFromRuntime(runtime ACPSessionRuntime) string {
	if runtime.SandboxBackend == runtimeHostTypeLocalWisp || runtime.OuterSandboxDomain == runtimeHostTypeLocalWisp {
		return runtimeHostTypeLocalWisp
	}
	return runtimeHostTypeAGS
}

func runtimeHasOuterHostTarget(runtime ACPSessionRuntime) bool {
	if strings.TrimSpace(runtime.OuterSandboxID) == "" {
		return false
	}
	if runtimeHostTypeFromRuntime(runtime) == runtimeHostTypeLocalWisp {
		return true
	}
	return strings.TrimSpace(runtime.OuterEnvdAccessToken) != ""
}

func (w *AgentSidecarWorker) cleanupFailedSessionRuntime(host RuntimeHost, sb RuntimeHostTarget, runtime ACPSessionRuntime) {
	cleanupCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if runtime.WispLeaseID != "" {
		_ = w.releaseWispWorkspaceLease(cleanupCtx, runtime)
	}
	if runtime.isWispOuterRuntime() && runtime.WispOwnsSMHSpace && runtime.WispSMHSpaceID != "" {
		_ = w.deleteWispSMHSpace(cleanupCtx, runtime.WispSMHSpaceID)
	}
	_ = host.DeleteSandbox(cleanupCtx, sb.ID)
}

func acpDaemonAddr(sessionID string) string {
	port := 38000 + int(crc32.ChecksumIEEE([]byte(sessionID))%9000)
	return fmt.Sprintf("http://127.0.0.1:%d", port)
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
	parts := []string{redactCommandOutput(err.Error())}
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

var commandOutputSensitivePattern = regexp.MustCompile(`(?i)(envd_access_token|traffic_access_token|api[_-]?key|access[_-]?token|library[_-]?secret|secret[_-]?id|secret[_-]?key)(["'=:\s]+)([^&"',\s}]+)`)

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
	sb, err := backend.host.CreateSandbox(ctx, CreateSandboxOptions{
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
	timeline("outer_create_done", "sandbox_id="+sb.ID)
	if w.deleteSandbox {
		defer func() {
			timeline("outer_delete_start", "sandbox_id="+sb.ID)
			deleteCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			if err := backend.host.DeleteSandbox(deleteCtx, sb.ID); err != nil {
				timeline("outer_delete_failed", "error="+quoteTimelineField(err.Error()))
				return
			}
			timeline("outer_delete_done", "sandbox_id="+sb.ID)
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
		if err := backend.host.UploadFile(ctx, sb, remoteBinary, "agent-sidecar", binary); err != nil {
			timeline("sidecar_upload_failed", "error="+quoteTimelineField(err.Error()))
			return workerResult{}, err
		}
		timeline("sidecar_upload_done")
	}

	responseSessionID := responseRuntimeSessionID(job)
	timeline("stage_inputs_start", fmt.Sprintf("count=%d", len(job.InputFiles)), "session_id="+responseSessionID)
	stageManifest, err := w.stageResponseRuntimeFiles(ctx, backend.host, sb, responseSessionID, job)
	if err != nil {
		timeline("stage_inputs_failed", "error="+quoteTimelineField(err.Error()))
		return workerResult{}, err
	}
	timeline("stage_inputs_done", fmt.Sprintf("count=%d", len(stageManifest.Files)))

	hostEnv := backend.host.RuntimeHostEnv()
	env := map[string]string{
		"TOKENHUB_API_KEY":                w.tokenHubAPIKey,
		"TOKENHUB_MODEL":                  w.tokenHubModel,
		"E2B_API_KEY":                     hostEnv.APIKey,
		"E2B_API_URL":                     hostEnv.APIURL,
		"E2B_DOMAIN":                      hostEnv.Domain,
		"INNER_SANDBOX_TEMPLATE":          backend.innerTemplateID,
		"INNER_SANDBOX_COMMAND":           w.forceInnerCommand,
		"INNER_SANDBOX_TIMEOUT":           "300",
		"GATEWAY_INSTRUCTION":             job.Instruction,
		"GATEWAY_INSTRUCTION_B64":         base64.StdEncoding.EncodeToString([]byte(job.Instruction)),
		"GATEWAY_ARTIFACT_PATH":           w.artifactPath,
		"GATEWAY_TIMELINE_START_UNIX_NS":  fmt.Sprintf("%d", start.UnixNano()),
		"GATEWAY_WORKER_CONTRACT_VERSION": WorkerContractVersion,
		"GATEWAY_JOB_ID":                  job.JobID,
		"GATEWAY_RESPONSE_ID":             job.ResponseID,
		"CLOUDAGENT_AGENT_VERSION":        defaultAgentVersion,
		"CLOUDAGENT_AGENT_TEMPLATE_ID":    backend.outerTemplateID,
		"CLOUDAGENT_WORKSPACE_VERSION":    defaultWorkspaceVersion,
		"CLOUDAGENT_WORKSPACE_TEMPLATE":   backend.innerTemplateID,
		"OPENAI_AGENTS_DISABLE_TRACING":   "1",
	}
	w.addSandboxHostEnv(env)
	addWebSearchEnv(env)
	for key, value := range runtimeClockEnv(time.Now()) {
		env[key] = value
	}
	timeline("sandbox_host_configured", fmt.Sprintf("url_set=%t", w.sandboxHostURL != ""))
	command, err := w.responseRuntimeCommand(remoteBinary, artifact, backend, job, stageManifest)
	if err != nil {
		return workerResult{}, err
	}
	command = w.sandboxHostEnvPrefix() + command
	timeline("sidecar_command_start")
	var deltaSeq int64
	var eventSeq int64
	var streamedOutput strings.Builder
	stdoutParser := &sidecarStdoutParser{}
	emitStdoutEvents := func(events []sidecarStdoutEvent) error {
		for _, event := range events {
			if event.Type == "runtime_host" {
				timeline("runtime_host_event", "runtime_event="+event.Event, "sandbox_id="+event.SandboxID)
				continue
			}
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
	result, err := backend.host.RunCommand(ctx, sb, command, env, func(text string) error {
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
		return workerResult{}, fmt.Errorf("agent sidecar command job_id=%s response_id=%s outer_sandbox_id=%s: %w", job.JobID, job.ResponseID, sb.ID, err)
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
		return workerResult{}, workerError("agent_empty_output", fmt.Sprintf("sidecar returned WRAPPER_RESULT_JSON with empty output_text job_id=%s response_id=%s outer_sandbox_id=%s inner_sandbox_id=%s stdout_bytes=%d", job.JobID, job.ResponseID, sb.ID, envelope.InnerSandboxID, len(result.Stdout)))
	}
	if output == "" {
		output = stripWrapperControlLines(result.Stdout)
	}
	if output == "" {
		return workerResult{}, workerError("agent_empty_output", fmt.Sprintf("sidecar returned empty output job_id=%s response_id=%s outer_sandbox_id=%s stdout_bytes=%d", job.JobID, job.ResponseID, sb.ID, len(result.Stdout)))
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
	content, err := backend.host.DownloadFile(ctx, sb, w.artifactPath)
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
				"sandbox_id":  sb.ID,
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

func (w *AgentSidecarWorker) addSandboxHostEnv(env map[string]string) {
	if w.sandboxHostURL != "" {
		env["HERMES_SANDBOX_HOST_URL"] = w.sandboxHostURL
	}
	if w.sandboxHostSHA256 != "" {
		env["HERMES_SANDBOX_HOST_SHA256"] = w.sandboxHostSHA256
	}
	if w.sandboxHostURL != "" {
		env["HERMES_SANDBOX_HOST_TRANSPORT"] = w.sandboxHostTransport
		env["HERMES_SANDBOX_HOST_ALLOW_CLI_FALLBACK"] = w.sandboxHostFallback
	}
}

func addWebSearchEnv(env map[string]string) {
	if provider := strings.TrimSpace(firstEnv("CLOUDAGENT_WEB_SEARCH_PROVIDER", "GATEWAY_WEB_SEARCH_PROVIDER")); provider != "" {
		env["CLOUDAGENT_WEB_SEARCH_PROVIDER"] = provider
	}
	if endpoint := strings.TrimSpace(firstEnv("TENCENTCLOUD_WSA_ENDPOINT", "GATEWAY_TENCENTCLOUD_WSA_ENDPOINT")); endpoint != "" {
		env["TENCENTCLOUD_WSA_ENDPOINT"] = endpoint
	}
	if apiKey := strings.TrimSpace(firstEnv("TENCENTCLOUD_WSA_APIKEY", "GATEWAY_TENCENTCLOUD_WSA_APIKEY")); apiKey != "" {
		env["TENCENTCLOUD_WSA_APIKEY"] = apiKey
	}
}

func (w *AgentSidecarWorker) sandboxHostEnvPrefix() string {
	var exports []string
	if w.sandboxHostURL != "" {
		exports = append(exports, "export HERMES_SANDBOX_HOST_URL="+shellQuote(w.sandboxHostURL))
	}
	if w.sandboxHostSHA256 != "" {
		exports = append(exports, "export HERMES_SANDBOX_HOST_SHA256="+shellQuote(w.sandboxHostSHA256))
	}
	if w.sandboxHostURL != "" {
		exports = append(exports, "export HERMES_SANDBOX_HOST_TRANSPORT="+shellQuote(w.sandboxHostTransport))
		exports = append(exports, "export HERMES_SANDBOX_HOST_ALLOW_CLI_FALLBACK="+shellQuote(w.sandboxHostFallback))
	}
	if len(exports) == 0 {
		return ""
	}
	return strings.Join(exports, " && ") + " && "
}

func normalizeSandboxHostTransport(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "":
		return "cli"
	case "http":
		return "http"
	case "cli":
		return "cli"
	default:
		return strings.ToLower(strings.TrimSpace(value))
	}
}

func normalizeSandboxHostBool(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "1", "true", "yes", "on":
		return "true"
	default:
		return "false"
	}
}

var sensitiveQueryPattern = regexp.MustCompile(`(?i)(q-ak|sign|signature|token|key|secret|x-cos-security-token)=([^&]+)`)

func redactURL(value string) string {
	return sensitiveQueryPattern.ReplaceAllString(value, `$1=<redacted>`)
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
