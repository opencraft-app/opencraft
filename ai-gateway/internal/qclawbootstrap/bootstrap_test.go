package qclawbootstrap

import (
	"encoding/json"
	"testing"
)

func TestEnsureChatCompletionsEnabledAddsHTTPConfig(t *testing.T) {
	input := []byte(`{
  "gateway": {
    "port": 28789,
    "bind": "tailnet",
    "auth": {
      "mode": "token",
      "token": "secret-token"
    }
  }
}`)

	updated, state, changed, err := EnsureChatCompletionsEnabled(input)
	if err != nil {
		t.Fatalf("EnsureChatCompletionsEnabled: %v", err)
	}
	if !changed {
		t.Fatal("expected config to change")
	}
	if state.Port != 28789 {
		t.Fatalf("expected port 28789, got %d", state.Port)
	}
	if state.Token != "secret-token" {
		t.Fatalf("expected token to be preserved")
	}
	if state.Bind != "loopback" {
		t.Fatalf("expected bind loopback, got %q", state.Bind)
	}
	if !state.ChatCompletionsEnabled {
		t.Fatal("expected chat completions to be enabled")
	}

	var decoded map[string]any
	if err := json.Unmarshal(updated, &decoded); err != nil {
		t.Fatalf("unmarshal updated config: %v", err)
	}

	gateway := decoded["gateway"].(map[string]any)
	if gateway["bind"] != "loopback" {
		t.Fatalf("expected bind to be rewritten to loopback, got %v", gateway["bind"])
	}
	httpCfg := gateway["http"].(map[string]any)
	endpoints := httpCfg["endpoints"].(map[string]any)
	chat := endpoints["chatCompletions"].(map[string]any)
	if chat["enabled"] != true {
		t.Fatalf("expected chatCompletions.enabled=true, got %v", chat["enabled"])
	}
}

func TestEnsureChatCompletionsEnabledNoopWhenAlreadyEnabled(t *testing.T) {
	input := []byte(`{
  "gateway": {
    "port": 28789,
    "bind": "loopback",
    "auth": {
      "mode": "token",
      "token": "secret-token"
    },
    "http": {
      "endpoints": {
        "chatCompletions": {
          "enabled": true
        }
      }
    }
  }
}`)

	updated, state, changed, err := EnsureChatCompletionsEnabled(input)
	if err != nil {
		t.Fatalf("EnsureChatCompletionsEnabled: %v", err)
	}
	if changed {
		t.Fatal("expected config to stay unchanged")
	}
	if string(updated) == "" {
		t.Fatal("expected updated bytes")
	}
	if !state.ChatCompletionsEnabled {
		t.Fatal("expected chat completions to remain enabled")
	}
}

func TestEnsureChatCompletionsEnabledRejectsMissingToken(t *testing.T) {
	input := []byte(`{
  "gateway": {
    "port": 28789,
    "bind": "loopback",
    "auth": {
      "mode": "token"
    }
  }
}`)

	_, _, _, err := EnsureChatCompletionsEnabled(input)
	if err == nil {
		t.Fatal("expected missing token error")
	}
}

func TestBuildProviderPayload(t *testing.T) {
	payload := BuildProviderPayload("qclaw-local", "http://127.0.0.1:28789", "gateway-token", "openclaw:main")
	if payload.Name != "qclaw-local" {
		t.Fatalf("unexpected provider name: %q", payload.Name)
	}
	if payload.ProviderType != "openai" {
		t.Fatalf("unexpected provider type: %q", payload.ProviderType)
	}
	if payload.BaseURL != "http://127.0.0.1:28789" {
		t.Fatalf("unexpected base url: %q", payload.BaseURL)
	}
	if payload.APIKey != "gateway-token" {
		t.Fatalf("unexpected api key")
	}
	if payload.TotalQuota <= 0 {
		t.Fatalf("expected positive total quota, got %d", payload.TotalQuota)
	}
	if len(payload.SupportedModels) != 1 || payload.SupportedModels[0] != "openclaw:main" {
		t.Fatalf("unexpected supported models: %#v", payload.SupportedModels)
	}
}

func TestBuildMappingPayload(t *testing.T) {
	payload := BuildMappingPayload("gpt-4o-mini", "provider-123")
	if payload.ModelPattern != "gpt-4o-mini" {
		t.Fatalf("unexpected model pattern: %q", payload.ModelPattern)
	}
	if payload.ProviderID != "provider-123" {
		t.Fatalf("unexpected provider id: %q", payload.ProviderID)
	}
	if !payload.IsActive {
		t.Fatal("expected active mapping")
	}
	if payload.Weight != 100 {
		t.Fatalf("unexpected weight: %d", payload.Weight)
	}
}
