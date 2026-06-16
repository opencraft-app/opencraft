package wrapper

import (
	"strings"
	"testing"
)

func TestCloudAgentOpenAPISpecCoversRuntimeCapabilities(t *testing.T) {
	spec := CloudAgentRunSpec()
	openapi := CloudAgentOpenAPISpec()
	paths, ok := openapi["paths"].(map[string]any)
	if !ok {
		t.Fatalf("openapi paths missing: %#v", openapi["paths"])
	}

	for _, endpoint := range spec.Endpoints {
		pathItem, ok := paths[endpoint.Path].(map[string]any)
		if !ok {
			t.Fatalf("openapi missing path %s", endpoint.Path)
		}
		if _, ok := pathItem[strings.ToLower(endpoint.Method)]; !ok {
			t.Fatalf("openapi missing operation %s %s", endpoint.Method, endpoint.Path)
		}
	}

	endpointStrings := strings.Join(spec.EndpointStrings(), "\n")
	for _, want := range []string{
		"GET /v1/cloudagent/runs/{run_id}/events?after_seq=N",
		"GET /v1/cloudagent/runs/{run_id}/events?after_seq=N&stream=true",
	} {
		if !strings.Contains(endpointStrings, want) {
			t.Fatalf("capabilities endpoint strings missing %q in:\n%s", want, endpointStrings)
		}
	}
}

func TestCloudAgentOpenAPISpecDocumentsDurableRunStream(t *testing.T) {
	openapi := CloudAgentOpenAPISpec()
	paths := openapi["paths"].(map[string]any)
	eventsPath := paths["/v1/cloudagent/runs/{run_id}/events"].(map[string]any)
	operation := eventsPath["get"].(map[string]any)
	responses := operation["responses"].(map[string]any)
	okResponse := responses["200"].(map[string]any)
	content := okResponse["content"].(map[string]any)
	if _, ok := content["application/x-ndjson"]; !ok {
		t.Fatalf("events endpoint must document NDJSON stream content: %#v", content)
	}

	params := operation["parameters"].([]any)
	for _, want := range []string{"after_seq", "stream"} {
		found := false
		for _, param := range params {
			item, ok := param.(map[string]any)
			if ok && item["name"] == want {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("events endpoint missing query param %q in %#v", want, params)
		}
	}
}
