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
