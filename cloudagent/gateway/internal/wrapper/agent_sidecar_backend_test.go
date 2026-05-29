package wrapper

import (
	"strings"
	"testing"
)

func TestConfiguredModelsIncludesTalosWhenConfigured(t *testing.T) {
	t.Setenv("GATEWAY_MODELS", "")
	t.Setenv("GATEWAY_TALOS_API_KEY", "talos-test")

	models := configuredModels()
	if !hasModel(models, "agent-sidecar-talos") {
		t.Fatalf("configuredModels() missing agent-sidecar-talos: %#v", models)
	}
}

func TestAgentSidecarWorkerSelectsTalosBackendByModel(t *testing.T) {
	worker, err := NewAgentSidecarWorker(AgentSidecarWorkerConfig{
		Client:          &AGSClient{apiKey: "ags-key", apiURL: "https://api.ap-beijing.tencentags.com", domain: "ap-beijing.tencentags.com"},
		OuterTemplateID: "ags-outer",
		InnerTemplateID: "ags-inner",
		SidecarURL:      "https://example.com/hermes-sidecar",
		TokenHubAPIKey:  "tokenhub-key",
		AdditionalBackends: []AgentSidecarBackendConfig{
			{
				Name:            "talos",
				Client:          &AGSClient{apiKey: "talos-key", apiURL: "https://api.talos.ren", domain: "api.talos.ren"},
				OuterTemplateID: "tpl-pool-s3h-xunpeihu-01",
				InnerTemplateID: "tpl-pool-s3h-xunpeihu-01",
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	backend, err := worker.backendForJob(workerJob{Model: "agent-sidecar-talos-tool"})
	if err != nil {
		t.Fatal(err)
	}
	if backend.name != "talos" {
		t.Fatalf("backend=%q, want talos", backend.name)
	}
	if backend.client.apiURL != "https://api.talos.ren" {
		t.Fatalf("apiURL=%q, want talos control plane", backend.client.apiURL)
	}
}

func TestAgentSidecarWorkerRejectsTalosModelWithoutBackend(t *testing.T) {
	worker, err := NewAgentSidecarWorker(AgentSidecarWorkerConfig{
		Client:          &AGSClient{apiKey: "ags-key", apiURL: "https://api.ap-beijing.tencentags.com", domain: "ap-beijing.tencentags.com"},
		OuterTemplateID: "ags-outer",
		InnerTemplateID: "ags-inner",
		SidecarURL:      "https://example.com/hermes-sidecar",
		TokenHubAPIKey:  "tokenhub-key",
	})
	if err != nil {
		t.Fatal(err)
	}

	if _, err := worker.backendForJob(workerJob{Model: "agent-sidecar-talos"}); err == nil {
		t.Fatal("expected talos backend selection to fail without talos config")
	}
}

func TestAgentSidecarWorkerConfiguresWispOuterRuntime(t *testing.T) {
	worker, err := NewAgentSidecarWorker(AgentSidecarWorkerConfig{
		Client:               &AGSClient{apiKey: "ags-key", apiURL: "https://api.ap-shanghai.tencentags.com", domain: "ap-shanghai.tencentags.com"},
		OuterTemplateID:      "ags-outer",
		InnerTemplateID:      "ags-inner",
		SidecarURL:           "https://example.com/cloudagent-sidecar",
		TokenHubAPIKey:       "tokenhub-key",
		OuterRuntime:         "wisp",
		WispPackageURL:       "https://example.com/wisp.tar.gz",
		WispRootUpperSize:    "5G",
		WispJFSPrefix:        "agent-test",
		WispSMHLibraryID:     "library",
		WispSMHAccessDomain:  "https://library.example.com/",
		WispSMHLibrarySecret: "secret",
	})
	if err != nil {
		t.Fatal(err)
	}
	if worker.outerRuntime != outerRuntimeWisp {
		t.Fatalf("outerRuntime=%q, want wisp", worker.outerRuntime)
	}
	if worker.wispSMHAccessDomain != "https://library.example.com" {
		t.Fatalf("wispSMHAccessDomain=%q", worker.wispSMHAccessDomain)
	}
}

func TestAgentSidecarWorkerDefaultsToWispOuterRuntime(t *testing.T) {
	worker, err := NewAgentSidecarWorker(AgentSidecarWorkerConfig{
		Client:          &AGSClient{apiKey: "ags-key", apiURL: "https://api.ap-shanghai.tencentags.com", domain: "ap-shanghai.tencentags.com"},
		OuterTemplateID: "ags-outer",
		InnerTemplateID: "ags-inner",
		SidecarURL:      "https://example.com/cloudagent-sidecar",
		TokenHubAPIKey:  "tokenhub-key",
	})
	if err != nil {
		t.Fatal(err)
	}
	if worker.outerRuntime != outerRuntimeWisp {
		t.Fatalf("outerRuntime=%q, want default wisp", worker.outerRuntime)
	}
	if worker.wispPackageURL != defaultWispPackageURL {
		t.Fatalf("wispPackageURL=%q, want default package URL", worker.wispPackageURL)
	}
	if normalizeOuterRuntime("") != outerRuntimeWisp {
		t.Fatalf("empty outer runtime should normalize to wisp")
	}
}

func TestAgentSidecarWorkerDefaultsSandboxHostToCLILocalTransport(t *testing.T) {
	worker, err := NewAgentSidecarWorker(AgentSidecarWorkerConfig{
		Client:          &AGSClient{apiKey: "ags-key", apiURL: "https://api.ap-shanghai.tencentags.com", domain: "ap-shanghai.tencentags.com"},
		OuterTemplateID: "ags-outer",
		InnerTemplateID: "ags-inner",
		SidecarURL:      "https://example.com/cloudagent-sidecar",
		SandboxHostURL:  "https://example.com/sandbox-host",
		TokenHubAPIKey:  "tokenhub-key",
	})
	if err != nil {
		t.Fatal(err)
	}
	env := map[string]string{}
	worker.addSandboxHostEnv(env)
	if env["HERMES_SANDBOX_HOST_TRANSPORT"] != "cli" {
		t.Fatalf("sandbox host transport=%q, want cli", env["HERMES_SANDBOX_HOST_TRANSPORT"])
	}
	if env["HERMES_SANDBOX_HOST_ALLOW_CLI_FALLBACK"] != "false" {
		t.Fatalf("sandbox host cli fallback=%q, want false", env["HERMES_SANDBOX_HOST_ALLOW_CLI_FALLBACK"])
	}
	prefix := worker.sandboxHostEnvPrefix()
	if !strings.Contains(prefix, "HERMES_SANDBOX_HOST_TRANSPORT='cli'") || !strings.Contains(prefix, "HERMES_SANDBOX_HOST_ALLOW_CLI_FALLBACK='false'") {
		t.Fatalf("sandbox host env prefix missing CLI contract: %s", prefix)
	}
}

func TestAgentSidecarWorkerCanExplicitlyUseSandboxHostHTTPWithFallback(t *testing.T) {
	worker, err := NewAgentSidecarWorker(AgentSidecarWorkerConfig{
		Client:               &AGSClient{apiKey: "ags-key", apiURL: "https://api.ap-shanghai.tencentags.com", domain: "ap-shanghai.tencentags.com"},
		OuterTemplateID:      "ags-outer",
		InnerTemplateID:      "ags-inner",
		SidecarURL:           "https://example.com/cloudagent-sidecar",
		SandboxHostURL:       "https://example.com/sandbox-host",
		SandboxHostTransport: "http",
		SandboxHostFallback:  "true",
		TokenHubAPIKey:       "tokenhub-key",
	})
	if err != nil {
		t.Fatal(err)
	}
	env := map[string]string{}
	worker.addSandboxHostEnv(env)
	if env["HERMES_SANDBOX_HOST_TRANSPORT"] != "http" {
		t.Fatalf("sandbox host transport=%q, want http", env["HERMES_SANDBOX_HOST_TRANSPORT"])
	}
	if env["HERMES_SANDBOX_HOST_ALLOW_CLI_FALLBACK"] != "true" {
		t.Fatalf("sandbox host cli fallback=%q, want true", env["HERMES_SANDBOX_HOST_ALLOW_CLI_FALLBACK"])
	}
}

func TestAgentSidecarWorkerRejectsUnsupportedOuterRuntime(t *testing.T) {
	_, err := NewAgentSidecarWorker(AgentSidecarWorkerConfig{
		Client:          &AGSClient{apiKey: "ags-key", apiURL: "https://api.ap-shanghai.tencentags.com", domain: "ap-shanghai.tencentags.com"},
		OuterTemplateID: "ags-outer",
		InnerTemplateID: "ags-inner",
		SidecarURL:      "https://example.com/cloudagent-sidecar",
		TokenHubAPIKey:  "tokenhub-key",
		OuterRuntime:    "unknown",
	})
	if err == nil {
		t.Fatal("expected unsupported outer runtime to fail")
	}
}

func TestWorkspaceWispNameFromSessionIsShortAndStable(t *testing.T) {
	sessionID := "session_4c7055cd94970a97f79ae711e3f8e39e"
	first := workspaceWispNameFromSession(sessionID)
	second := workspaceWispNameFromSession(sessionID)
	if first != second {
		t.Fatalf("workspace wisp name not stable: %q != %q", first, second)
	}
	if len(first) > 48 {
		t.Fatalf("workspace wisp name too long: %q len=%d", first, len(first))
	}
	if !strings.HasPrefix(first, "workspace-") {
		t.Fatalf("workspace wisp name should be recognizable, got %q", first)
	}
	if first == wispNameFromRuntime(sessionID) {
		t.Fatalf("workspace wisp name should be distinct from outer runtime name: %q", first)
	}
}

func TestWorkspaceWispJFSPrefixIsWorkspaceScoped(t *testing.T) {
	prefix := workspaceWispJFSPrefix("cloudagent-agent-live", "space_ABC/123")
	if prefix == "cloudagent-agent-live" {
		t.Fatal("workspace prefix must not reuse outer runtime prefix")
	}
	if !strings.HasPrefix(prefix, "cloudagent-agent-live/workspace/") {
		t.Fatalf("workspace prefix=%q, want workspace-scoped prefix", prefix)
	}
	if strings.Contains(prefix, "//") {
		t.Fatalf("workspace prefix should not contain duplicate slashes: %q", prefix)
	}
	if prefix != workspaceWispJFSPrefix("cloudagent-agent-live", "space_ABC/123") {
		t.Fatalf("workspace prefix should be stable: %q", prefix)
	}
	if got := workspaceWispJFSPrefix("cloudagent-agent-live/workspace/space-x", "ignored"); got != "cloudagent-agent-live/workspace/space-x" {
		t.Fatalf("already scoped workspace prefix changed: %q", got)
	}
}

func TestWorkspaceIDForRuntimePrefersStableSessionWorkspace(t *testing.T) {
	req := ACPSessionRuntimeStartRequest{SessionID: "session_stable"}
	runtime := ACPSessionRuntime{
		WorkspaceID:     defaultWorkspaceID(req),
		WispWorkspaceID: "space_later",
		WispSMHSpaceID:  "space_later",
	}
	if got := workspaceIDForRuntime(runtime, req); got != "workspace_session_stable" {
		t.Fatalf("workspace id should stay session-scoped after SMH space resolves, got %q", got)
	}
}

func TestWispOuterRuntimeWrapsCommandWithEnvironment(t *testing.T) {
	runtime := ACPSessionRuntime{
		OuterRuntime:   outerRuntimeWisp,
		WispName:       "agent-session",
		WispClientPath: "/tmp/wisp/install/bin/wispclient",
	}
	command := runtime.wrapWispShellCommand("echo \"$TOKENHUB_MODEL\"", map[string]string{
		"TOKENHUB_MODEL": "minimax-m2.7",
		"bad-name":       "ignored",
	})
	for _, want := range []string{
		"'/tmp/wisp/install/bin/wispclient'",
		"exec --stream 'agent-session'",
		"export TOKENHUB_MODEL=",
		"minimax-m2.7",
		"echo \"$TOKENHUB_MODEL\"",
	} {
		if !strings.Contains(command, want) {
			t.Fatalf("wrapped command missing %q: %s", want, command)
		}
	}
	if strings.Contains(command, "bad-name") {
		t.Fatalf("wrapped command leaked invalid env name: %s", command)
	}
}

func TestWispOuterRuntimeWrapsControlCommandWithoutStream(t *testing.T) {
	runtime := ACPSessionRuntime{
		OuterRuntime:   outerRuntimeWisp,
		WispName:       "agent-session",
		WispClientPath: "/tmp/wisp/install/bin/wispclient",
	}
	command := runtime.wrapWispShellCommandBuffered("agent client session-status", nil)
	for _, want := range []string{
		"'/tmp/wisp/install/bin/wispclient'",
		"exec 'agent-session'",
		"agent client session-status",
	} {
		if !strings.Contains(command, want) {
			t.Fatalf("buffered command missing %q: %s", want, command)
		}
	}
	if strings.Contains(command, "--stream") {
		t.Fatalf("buffered control command should not use stream mode: %s", command)
	}
}

func TestWispOuterStopCommandStopsHostRuntime(t *testing.T) {
	runtime := ACPSessionRuntime{
		OuterRuntime:   outerRuntimeWisp,
		WispName:       "agent-session",
		WispClientPath: "/tmp/wisp/install/bin/wispclient",
		WispInstallDir: "/tmp/wisp/install",
		RemoteBinary:   "/tmp/cloudagent-session/hermes-sidecar",
	}
	command := wispOuterStopCommand(runtime)
	for _, want := range []string{
		"'/tmp/wisp/install/bin/wispclient'",
		"stop \"$name\"",
		"agent-session",
		"CLOUDAGENT_WISP_STOPPED",
		"/tmp/wisp/daemon.log",
	} {
		if !strings.Contains(command, want) {
			t.Fatalf("stop command missing %q: %s", want, command)
		}
	}
	if strings.Contains(command, "exec --stream") {
		t.Fatalf("stop command must run on the outer host, not inside the wisp runtime: %s", command)
	}
}

func TestAgentSidecarWorkerEnsureInnerCommandForcesWhenInnerIdentityMissing(t *testing.T) {
	worker, err := NewAgentSidecarWorker(AgentSidecarWorkerConfig{
		Client:          &AGSClient{apiKey: "ags-key", apiURL: "https://api.ap-beijing.tencentags.com", domain: "ap-beijing.tencentags.com"},
		OuterTemplateID: "ags-outer",
		InnerTemplateID: "ags-inner",
		SidecarURL:      "https://example.com/hermes-sidecar",
		TokenHubAPIKey:  "tokenhub-key",
	})
	if err != nil {
		t.Fatal(err)
	}

	runtime := ACPSessionRuntime{
		RemoteBinary:         "/tmp/hermes-sidecar",
		DaemonAddr:           "127.0.0.1:49999",
		InnerSandboxID:       "inner_1",
		InnerSandboxDomain:   "sandbox.test",
		InnerEnvdAccessToken: "inner-token",
	}
	if command := worker.ensureInnerCommand(runtime, false); strings.Contains(command, "--force") {
		t.Fatalf("command=%q should not force when identity is complete", command)
	}
	runtime.InnerEnvdAccessToken = ""
	if command := worker.ensureInnerCommand(runtime, false); !strings.Contains(command, "--force") {
		t.Fatalf("command=%q should force when persisted inner identity is incomplete", command)
	}
}

func TestAgentBehaviorPluginRegistry(t *testing.T) {
	plugin, err := agentBehaviorPluginFor("builtin.v1")
	if err != nil {
		t.Fatal(err)
	}
	script := plugin.buildInitScript(agentInitScriptContext{
		Prepare:        "mkdir -p /tmp/session",
		Workspace:      "/workspace",
		WorkspaceOwner: "user",
		Runtime:        ACPSessionRuntime{RemoteBinary: "/tmp/session/hermes-sidecar"},
		SessionID:      "session_1",
		ListenAddr:     "127.0.0.1:38000",
		MemoryDir:      "/tmp/session/memory",
		LogPath:        "/tmp/session/daemon.log",
		PIDPath:        "/tmp/session/daemon.pid",
	})
	if !strings.Contains(script, "daemon --addr") || !strings.Contains(script, "--session-id") {
		t.Fatalf("builtin init script missing daemon start: %s", script)
	}

	if _, err := agentBehaviorPluginFor("missing.v1"); err == nil {
		t.Fatal("expected unknown agent version to fail")
	}
	t.Setenv("GATEWAY_AGENT_VERSION_REGISTRY_JSON", `{
		"builtin.v1-54ecc6642308": {
			"sidecar_url": "https://cloudagent-sidecar-shanghai-1388575217.cos.ap-shanghai.myqcloud.com/agent-sidecar/20260522/cloudagent-sidecar-linux-amd64-54ecc6642308",
			"sidecar_sha256": "54ecc6642308b8fb71bb5b856d801c2f1da03ec47d0052bdbbaf44a821c8ba81",
			"sidecar_sig_url": "https://cloudagent-sidecar-shanghai-1388575217.cos.ap-shanghai.myqcloud.com/agent-sidecar/20260522/cloudagent-sidecar-linux-amd64-54ecc6642308.sig",
			"signing_key_id": "cloudagent-agent-release-v1"
		}
	}`)
	plugin, err = agentBehaviorPluginFor("builtin.v1-54ecc6642308")
	if err != nil {
		t.Fatal(err)
	}
	if plugin.sidecarURL == "" || plugin.sidecarSHA256 != "54ecc6642308b8fb71bb5b856d801c2f1da03ec47d0052bdbbaf44a821c8ba81" {
		t.Fatalf("unexpected version artifact: %#v", plugin)
	}
	if plugin.sidecarSigURL == "" || plugin.signingKeyID != "cloudagent-agent-release-v1" {
		t.Fatalf("unexpected version signing config: %#v", plugin)
	}
	t.Setenv("GATEWAY_AGENT_VERSION_REGISTRY_JSON", `{"custom.v1":{"sidecar_url":"https://example.com/hermes-sidecar"}}`)
	plugin, err = agentBehaviorPluginFor("custom.v1")
	if err != nil {
		t.Fatal(err)
	}
	if plugin.sidecarSHA256 != "" || plugin.sidecarSigURL != "https://example.com/hermes-sidecar.sig" || plugin.signingKeyID != defaultSigningKeyID {
		t.Fatalf("unexpected derived artifact: %#v", plugin)
	}
	t.Setenv("GATEWAY_AGENT_VERSION_REGISTRY_JSON", `{"bad.v2":{"sidecar_url":"https://example.com/hermes-sidecar","sidecar_sha256":"not-a-sha"}}`)
	if _, err := agentBehaviorPluginFor("bad.v2"); err == nil {
		t.Fatal("expected version with invalid sha256 to fail")
	}
	if _, err := workspaceRuntimeSpecFor("builtin.v1"); err != nil {
		t.Fatal(err)
	}
	if _, err := workspaceRuntimeSpecFor("missing.v1"); err == nil {
		t.Fatal("expected unknown workspace version to fail")
	}
}

func TestValidatedSidecarArtifactDerivesSignatureConfig(t *testing.T) {
	artifact, err := validatedSidecarArtifact("session sidecar_artifact", agentSidecarArtifact{
		URL: "https://example.com/releases/cloudagent-sidecar-linux-amd64",
	})
	if err != nil {
		t.Fatal(err)
	}
	if artifact.SHA256 != "" {
		t.Fatalf("sha256 should be optional for signed artifacts: %#v", artifact)
	}
	if artifact.SigURL != "https://example.com/releases/cloudagent-sidecar-linux-amd64.sig" {
		t.Fatalf("unexpected derived sig url: %#v", artifact)
	}
	if artifact.SigningKeyID != defaultSigningKeyID {
		t.Fatalf("unexpected default key id: %#v", artifact)
	}
	if !artifact.signed() {
		t.Fatalf("artifact should be signed without explicit sha256: %#v", artifact)
	}
}

func hasModel(models []modelRecord, id string) bool {
	for _, model := range models {
		if model.ID == id {
			return true
		}
	}
	return false
}
