package sandbox

import (
	"encoding/json"
	"net/http"
	"testing"
)

func TestApplyProcessHeadersIncludesAccessTokenWhenPresent(t *testing.T) {
	headers := make(http.Header)

	applyProcessHeaders(headers, "sbx-123", "root", "envd-token")

	if got := headers.Get("Host"); got != "49983-sbx-123-00000000.e2b.app" {
		t.Fatalf("unexpected host header: %s", got)
	}
	if got := headers.Get("Authorization"); got != "Basic cm9vdDo=" {
		t.Fatalf("unexpected authorization header: %s", got)
	}
	if got := headers.Get("X-Access-Token"); got != "envd-token" {
		t.Fatalf("unexpected access token header: %s", got)
	}
}

func TestApplyProcessHeadersOmitsEmptyAccessToken(t *testing.T) {
	headers := make(http.Header)

	applyProcessHeaders(headers, "sbx-123", "root", "")

	if got := headers.Get("X-Access-Token"); got != "" {
		t.Fatalf("expected empty access token header, got %s", got)
	}
}

func TestCreateSandboxRequestJSONIncludesTemplateClassIDWhenPresent(t *testing.T) {
	body, err := json.Marshal(&CreateSandboxRequest{
		TemplateClassID: "openclaw-default",
		TemplateID:      "pool-c0",
	})
	if err != nil {
		t.Fatalf("marshal create request: %v", err)
	}
	if got := string(body); got != `{"template_class_id":"openclaw-default","templateID":"pool-c0"}` {
		t.Fatalf("unexpected create request json: %s", got)
	}
}

func TestCreateSandboxRequestJSONIncludesSKUIDWhenPresent(t *testing.T) {
	body, err := json.Marshal(&CreateSandboxRequest{
		TemplateClassID: "hermes",
		TemplateID:      "pool-c3",
		SKUID:           "sku-hermes-4c8g",
	})
	if err != nil {
		t.Fatalf("marshal create request: %v", err)
	}
	if got := string(body); got != `{"template_class_id":"hermes","templateID":"pool-c3","sku_id":"sku-hermes-4c8g"}` {
		t.Fatalf("unexpected create request json: %s", got)
	}
}

func TestCreateSandboxRequestJSONOmitsTemplateClassIDWhenEmpty(t *testing.T) {
	body, err := json.Marshal(&CreateSandboxRequest{
		TemplateID: "pool-c0",
	})
	if err != nil {
		t.Fatalf("marshal create request: %v", err)
	}
	if got := string(body); got != `{"templateID":"pool-c0"}` {
		t.Fatalf("unexpected create request json: %s", got)
	}
}
