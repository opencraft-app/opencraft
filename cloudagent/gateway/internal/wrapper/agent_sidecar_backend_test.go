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

func hasModel(models []modelRecord, id string) bool {
	for _, model := range models {
		if model.ID == id {
			return true
		}
	}
	return false
}
