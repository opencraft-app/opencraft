package wrapper

import (
	"encoding/json"
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
		"GET /v1/cloudagent/sessions/{session_id}/events?after_seq=N",
		"GET /v1/cloudagent/sessions/{session_id}/events?after_id=evt_x",
	} {
		if !strings.Contains(endpointStrings, want) {
			t.Fatalf("capabilities endpoint strings missing %q in:\n%s", want, endpointStrings)
		}
	}
}

func TestCloudAgentOpenAPISpecDocumentsDurableSessionEventStream(t *testing.T) {
	openapi := CloudAgentOpenAPISpec()
	paths := openapi["paths"].(map[string]any)
	submitPath := paths["/v1/cloudagent/sessions/{session_id}/events"].(map[string]any)
	if _, ok := submitPath["post"].(map[string]any)["requestBody"]; !ok {
		t.Fatalf("session events submit endpoint must document requestBody: %#v", submitPath["post"])
	}

	eventsPath := paths["/v1/cloudagent/sessions/{session_id}/events/stream"].(map[string]any)
	operation := eventsPath["get"].(map[string]any)
	responses := operation["responses"].(map[string]any)
	okResponse := responses["200"].(map[string]any)
	content := okResponse["content"].(map[string]any)
	if _, ok := content["text/event-stream"]; !ok {
		t.Fatalf("session events endpoint must document SSE stream content: %#v", content)
	}

	params := operation["parameters"].([]any)
	for _, want := range []string{"after_seq", "after_id", "Last-Event-ID"} {
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

	raw, err := json.Marshal(openapi)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "agent.raw") || strings.Contains(string(raw), "sessionUpdate") {
		t.Fatalf("openapi must not expose internal sidecar/acp event types: %s", raw)
	}
}
