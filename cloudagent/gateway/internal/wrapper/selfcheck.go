package wrapper

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"runtime"
	"strings"
	"time"
)

type selfCheckResponse struct {
	Object      string           `json:"object"`
	OK          bool             `json:"ok"`
	Status      string           `json:"status"`
	GeneratedAt string           `json:"generated_at"`
	Summary     selfCheckSummary `json:"summary"`
	Checks      []selfCheckItem  `json:"checks"`
}

type selfCheckSummary struct {
	WorkerKind               string `json:"worker_kind"`
	RuntimeHost              string `json:"runtime_host,omitempty"`
	OuterRuntime             string `json:"outer_runtime,omitempty"`
	AGSAPIURL                string `json:"ags_api_url,omitempty"`
	AGSDomain                string `json:"ags_domain,omitempty"`
	OuterTemplateID          string `json:"outer_template_id,omitempty"`
	InnerTemplateID          string `json:"inner_template_id,omitempty"`
	SidecarBinaryPath        string `json:"sidecar_binary_path,omitempty"`
	SidecarURL               string `json:"sidecar_url,omitempty"`
	SidecarSHA256            string `json:"sidecar_sha256,omitempty"`
	SidecarSigURL            string `json:"sidecar_sig_url,omitempty"`
	SandboxHostURL           string `json:"sandbox_host_url,omitempty"`
	WispPackageURL           string `json:"wisp_package_url,omitempty"`
	WispSMHLibraryID         string `json:"wisp_smh_library_id,omitempty"`
	WispSMHAccessDomain      string `json:"wisp_smh_access_domain,omitempty"`
	WispSMHSecretConfigured  bool   `json:"wisp_smh_secret_configured,omitempty"`
	LocalRuntimeRoot         string `json:"local_runtime_root,omitempty"`
	LocalRuntimeCommandProxy bool   `json:"local_runtime_command_proxy,omitempty"`
	LocalRuntimeAllowPaths   bool   `json:"local_runtime_allow_host_paths,omitempty"`
	TokenHubAPIKeyConfigured bool   `json:"tokenhub_api_key_configured,omitempty"`
	AGSAPIKeyConfigured      bool   `json:"ags_api_key_configured,omitempty"`
	RuntimeWarmPoolEnabled   bool   `json:"runtime_warm_pool_enabled,omitempty"`
	RuntimeWarmPoolShared    bool   `json:"runtime_warm_pool_shared_store_confirmed,omitempty"`
}

type selfCheckItem struct {
	Name       string `json:"name"`
	Status     string `json:"status"`
	Message    string `json:"message,omitempty"`
	HTTPStatus int    `json:"http_status,omitempty"`
	URL        string `json:"url,omitempty"`
}

func (s *Server) handleSelfCheck(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	scope, errResp := scopeFromRequest(r)
	if errResp != nil {
		serverTimeline(start, "selfcheck_denied", "code="+errResp.Code)
		writeError(w, http.StatusUnauthorized, errResp.Code, errResp.Message)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	resp := s.selfCheck(ctx)
	status := http.StatusOK
	if !resp.OK {
		status = http.StatusServiceUnavailable
	}
	serverTimeline(start, "selfcheck_done",
		"tenant="+quoteServerField(scope.TenantID),
		"project="+quoteServerField(scope.ProjectID),
		"status="+resp.Status,
	)
	writeJSON(w, status, resp)
}

func (s *Server) handleReadyz(w http.ResponseWriter, _ *http.Request) {
	failures := s.readinessFailures()
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	if len(failures) > 0 {
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte("not ready\n"))
		for _, failure := range failures {
			_, _ = w.Write([]byte("- " + failure + "\n"))
		}
		return
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok\n"))
}

func (s *Server) readinessFailures() []string {
	if s.IsDraining() {
		return []string{"server is draining"}
	}
	switch worker := s.worker.(type) {
	case *AgentSidecarWorker:
		return worker.readinessFailures()
	case FakeWorker, *FakeWorker:
		return nil
	case nil:
		return []string{"worker is not configured"}
	default:
		return nil
	}
}

func (w *AgentSidecarWorker) readinessFailures() []string {
	var failures []string
	add := func(ok bool, message string) {
		if !ok {
			failures = append(failures, message)
		}
	}
	outerRuntime := normalizeOuterRuntime(w.outerRuntime)
	localRuntimeHost := w.defaultBackendName == runtimeHostTypeLocalWisp
	if !localRuntimeHost {
		add(w.client != nil, "AGS client is not configured")
	}
	if !localRuntimeHost && w.client != nil {
		add(w.client.apiKey != "", "GATEWAY_AGS_API_KEY is not configured")
		add(w.client.domain != "", "GATEWAY_AGS_DOMAIN is not configured")
		add(w.client.apiURL != "", "GATEWAY_AGS_API_URL is not configured")
	}
	add(strings.TrimSpace(w.outerTemplateID) != "", "outer runtime template is not configured")
	add(strings.TrimSpace(w.innerTemplateID) != "", "GATEWAY_AGENT_SIDECAR_INNER_TEMPLATE or INNER_SANDBOX_TEMPLATE is not configured")
	add(strings.TrimSpace(w.tokenHubAPIKey) != "", "GATEWAY_TOKENHUB_API_KEY is not configured")
	add(strings.TrimSpace(w.sidecarURL) != "" || strings.TrimSpace(w.sidecarBinaryPath) != "", "GATEWAY_AGENT_SIDECAR_URL or GATEWAY_AGENT_SIDECAR_BINARY is not configured")
	add(strings.TrimSpace(w.sidecarSHA256) == "" || isSHA256Hex(w.sidecarSHA256), "GATEWAY_AGENT_SIDECAR_SHA256 is not a valid sha256 hex string")
	add(outerRuntime == outerRuntimeAGS || outerRuntime == outerRuntimeWisp, "GATEWAY_AGENT_OUTER_RUNTIME is not supported")
	if outerRuntime == outerRuntimeWisp {
		add(strings.TrimSpace(w.wispPackageURL) != "", "GATEWAY_WISP_PACKAGE_URL is not configured")
		add(strings.TrimSpace(w.wispSMHLibraryID) != "", "GATEWAY_WISP_SMH_LIBRARY_ID is not configured")
		add(strings.TrimSpace(w.wispSMHAccessDomain) != "", "GATEWAY_WISP_SMH_ACCESS_DOMAIN is not configured")
		add(strings.TrimSpace(w.wispSMHLibrarySecret) != "", "GATEWAY_WISP_SMH_LIBRARY_SECRET is not configured")
		if localRuntimeHost {
			info := w.localRuntimeHostInfo()
			add(strings.TrimSpace(info.Root) != "", "GATEWAY_LOCAL_RUNTIME_ROOT is not configured")
			add(runtime.GOOS == "linux" || strings.TrimSpace(info.CommandPrefix) != "", "GATEWAY_LOCAL_RUNTIME_COMMAND_PREFIX is required for local_wisp on non-Linux gateway hosts")
		}
	}
	if w.runtimePool != nil {
		add(envFlagEnabled("GATEWAY_RUNTIME_WARM_POOL_SHARED_STORE_CONFIRMED"), "GATEWAY_RUNTIME_WARM_POOL_SHARED_STORE_CONFIRMED must be true when warm pool is enabled")
	}
	return failures
}

func (s *Server) selfCheck(ctx context.Context) selfCheckResponse {
	resp := selfCheckResponse{
		Object:      "cloudagent.selfcheck",
		OK:          true,
		Status:      "ok",
		GeneratedAt: time.Now().UTC().Format(time.RFC3339),
	}
	add := func(item selfCheckItem) {
		resp.Checks = append(resp.Checks, item)
		if item.Status == "fail" {
			resp.OK = false
			resp.Status = "failed"
		}
	}

	switch worker := s.worker.(type) {
	case *AgentSidecarWorker:
		resp.Summary = worker.selfCheckSummary()
		worker.appendSelfChecks(ctx, &resp, add)
	case FakeWorker:
		resp.Summary = selfCheckSummary{WorkerKind: "fake"}
		add(passCheck("worker", "fake worker configured"))
	case *FakeWorker:
		resp.Summary = selfCheckSummary{WorkerKind: "fake"}
		add(passCheck("worker", "fake worker configured"))
	default:
		resp.Summary = selfCheckSummary{WorkerKind: fmt.Sprintf("%T", s.worker)}
		add(passCheck("worker", "worker configured"))
	}
	return resp
}

func (w *AgentSidecarWorker) selfCheckSummary() selfCheckSummary {
	artifact := w.defaultSidecarArtifact()
	if artifact.URL != "" {
		artifact.SigURL = derivedSidecarSignatureURL(artifact.URL)
	}
	agsAPIURL := ""
	agsDomain := ""
	agsAPIKeyConfigured := false
	if w.client != nil {
		agsAPIURL = w.client.apiURL
		agsDomain = w.client.domain
		agsAPIKeyConfigured = w.client.apiKey != ""
	}
	localInfo := w.localRuntimeHostInfo()
	return selfCheckSummary{
		WorkerKind:               "agent_sidecar",
		RuntimeHost:              w.defaultBackendName,
		OuterRuntime:             w.outerRuntime,
		AGSAPIURL:                agsAPIURL,
		AGSDomain:                agsDomain,
		OuterTemplateID:          w.outerTemplateID,
		InnerTemplateID:          w.innerTemplateID,
		SidecarBinaryPath:        w.sidecarBinaryPath,
		SidecarURL:               artifact.URL,
		SidecarSHA256:            artifact.SHA256,
		SidecarSigURL:            artifact.SigURL,
		SandboxHostURL:           w.sandboxHostURL,
		WispPackageURL:           w.wispPackageURL,
		WispSMHLibraryID:         w.wispSMHLibraryID,
		WispSMHAccessDomain:      w.wispSMHAccessDomain,
		WispSMHSecretConfigured:  w.wispSMHLibrarySecret != "",
		LocalRuntimeRoot:         localInfo.Root,
		LocalRuntimeCommandProxy: strings.TrimSpace(localInfo.CommandPrefix) != "",
		LocalRuntimeAllowPaths:   localInfo.AllowHostPaths,
		TokenHubAPIKeyConfigured: w.tokenHubAPIKey != "",
		AGSAPIKeyConfigured:      agsAPIKeyConfigured,
		RuntimeWarmPoolEnabled:   w.runtimePool != nil,
		RuntimeWarmPoolShared:    envFlagEnabled("GATEWAY_RUNTIME_WARM_POOL_SHARED_STORE_CONFIRMED"),
	}
}

func (w *AgentSidecarWorker) appendSelfChecks(ctx context.Context, resp *selfCheckResponse, add func(selfCheckItem)) {
	outerRuntime := normalizeOuterRuntime(w.outerRuntime)
	localRuntimeHost := w.defaultBackendName == runtimeHostTypeLocalWisp
	if localRuntimeHost {
		add(passCheck("runtime_host.local_wisp", "local_wisp runtime host configured"))
		info := w.localRuntimeHostInfo()
		add(requiredCheck("runtime_host.local_wisp.root", "GATEWAY_LOCAL_RUNTIME_ROOT configured", strings.TrimSpace(info.Root) != ""))
		if info.Root != "" {
			add(dirWritableCheck("runtime_host.local_wisp.root_writable", info.Root))
		}
		if runtime.GOOS != "linux" && outerRuntime == outerRuntimeWisp {
			add(requiredCheck("runtime_host.local_wisp.command_prefix", "GATEWAY_LOCAL_RUNTIME_COMMAND_PREFIX configured for non-Linux Wisp runtime host", strings.TrimSpace(info.CommandPrefix) != ""))
		} else if strings.TrimSpace(info.CommandPrefix) != "" {
			add(passCheck("runtime_host.local_wisp.command_prefix", "local runtime commands use command prefix"))
		} else {
			add(passCheck("runtime_host.local_wisp.command_prefix", "local runtime commands execute on gateway host"))
		}
	} else {
		add(requiredCheck("ags.api_key", "GATEWAY_AGS_API_KEY configured", w.client != nil && w.client.apiKey != ""))
		add(requiredCheck("ags.domain", "GATEWAY_AGS_DOMAIN configured", w.client != nil && w.client.domain != ""))
		add(requiredCheck("ags.api_url", "GATEWAY_AGS_API_URL configured", w.client != nil && w.client.apiURL != ""))
	}
	add(requiredCheck("agent.outer_template", "outer runtime template configured", w.outerTemplateID != ""))
	add(requiredCheck("agent.inner_template", "inner AGS template configured", w.innerTemplateID != ""))
	add(requiredCheck("agent.tokenhub_api_key", "GATEWAY_TOKENHUB_API_KEY configured", w.tokenHubAPIKey != ""))
	add(requiredCheck("agent.sidecar_source", "GATEWAY_AGENT_SIDECAR_URL or GATEWAY_AGENT_SIDECAR_BINARY configured", w.sidecarURL != "" || w.sidecarBinaryPath != ""))
	add(requiredCheck("agent.sidecar_sha256", "GATEWAY_AGENT_SIDECAR_SHA256 is valid when configured", w.sidecarSHA256 == "" || isSHA256Hex(w.sidecarSHA256)))
	add(requiredCheck("agent.outer_runtime", "outer runtime is supported", outerRuntime == outerRuntimeAGS || outerRuntime == outerRuntimeWisp))

	if w.sidecarURL != "" {
		add(headURLCheck(ctx, "agent.sidecar_url_reachable", w.sidecarURL, w.client))
		add(headURLCheck(ctx, "agent.sidecar_sig_url_reachable", derivedSidecarSignatureURL(w.sidecarURL), w.client))
	}
	if w.sidecarBinaryPath != "" {
		add(fileExistsCheck("agent.sidecar_binary_present", w.sidecarBinaryPath))
	}
	if w.sandboxHostURL != "" {
		add(headURLCheck(ctx, "agent.sandbox_host_url_reachable", w.sandboxHostURL, w.client))
	}
	if outerRuntime == outerRuntimeWisp {
		add(requiredCheck("wisp.package_url", "GATEWAY_WISP_PACKAGE_URL configured", w.wispPackageURL != ""))
		add(requiredCheck("wisp.smh_library_id", "GATEWAY_WISP_SMH_LIBRARY_ID configured", w.wispSMHLibraryID != ""))
		add(requiredCheck("wisp.smh_access_domain", "GATEWAY_WISP_SMH_ACCESS_DOMAIN configured", w.wispSMHAccessDomain != ""))
		add(requiredCheck("wisp.smh_library_secret", "GATEWAY_WISP_SMH_LIBRARY_SECRET configured", w.wispSMHLibrarySecret != ""))
		if w.wispPackageURL != "" {
			add(headURLCheck(ctx, "wisp.package_url_reachable", w.wispPackageURL, w.client))
		}
	}
	if w.runtimePool != nil {
		add(requiredCheck("runtime_pool.shared_store", "warm pool worker and gateway share the same durable store", envFlagEnabled("GATEWAY_RUNTIME_WARM_POOL_SHARED_STORE_CONFIRMED")))
	}
}

func (w *AgentSidecarWorker) localRuntimeHostInfo() LocalRuntimeHostInfo {
	if w == nil {
		return LocalRuntimeHostInfo{}
	}
	backend, ok := w.backendForName(runtimeHostTypeLocalWisp)
	if !ok || backend.host == nil {
		return LocalRuntimeHostInfo{}
	}
	localHost, ok := backend.host.(*LocalRuntimeHost)
	if !ok {
		return LocalRuntimeHostInfo{}
	}
	return localHost.Info()
}

func requiredCheck(name, message string, ok bool) selfCheckItem {
	if ok {
		return passCheck(name, message)
	}
	return selfCheckItem{Name: name, Status: "fail", Message: message}
}

func passCheck(name, message string) selfCheckItem {
	return selfCheckItem{Name: name, Status: "pass", Message: message}
}

func fileExistsCheck(name, filePath string) selfCheckItem {
	if _, err := os.Stat(filePath); err != nil {
		return selfCheckItem{Name: name, Status: "fail", URL: filePath, Message: err.Error()}
	}
	return selfCheckItem{Name: name, Status: "pass", URL: filePath, Message: "present"}
}

func dirWritableCheck(name, dirPath string) selfCheckItem {
	if err := os.MkdirAll(dirPath, 0o755); err != nil {
		return selfCheckItem{Name: name, Status: "fail", URL: dirPath, Message: err.Error()}
	}
	probe, err := os.CreateTemp(dirPath, ".cloudagent-selfcheck-")
	if err != nil {
		return selfCheckItem{Name: name, Status: "fail", URL: dirPath, Message: err.Error()}
	}
	probePath := probe.Name()
	closeErr := probe.Close()
	removeErr := os.Remove(probePath)
	if closeErr != nil {
		return selfCheckItem{Name: name, Status: "fail", URL: dirPath, Message: closeErr.Error()}
	}
	if removeErr != nil {
		return selfCheckItem{Name: name, Status: "fail", URL: dirPath, Message: removeErr.Error()}
	}
	return selfCheckItem{Name: name, Status: "pass", URL: dirPath, Message: "writable"}
}

func headURLCheck(ctx context.Context, name, rawURL string, client *AGSClient) selfCheckItem {
	httpClient := http.DefaultClient
	if client != nil && client.httpClient != nil {
		httpClient = client.httpClient
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodHead, rawURL, nil)
	if err != nil {
		return selfCheckItem{Name: name, Status: "fail", URL: rawURL, Message: err.Error()}
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return selfCheckItem{Name: name, Status: "fail", URL: rawURL, Message: err.Error()}
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 200 && resp.StatusCode < 400 {
		return selfCheckItem{Name: name, Status: "pass", URL: rawURL, HTTPStatus: resp.StatusCode, Message: "reachable"}
	}
	return selfCheckItem{
		Name:       name,
		Status:     "fail",
		URL:        rawURL,
		HTTPStatus: resp.StatusCode,
		Message:    strings.TrimSpace(resp.Status),
	}
}
