package modelgateway

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestGatewayTranslatesResponsesToChatAndBack(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			t.Errorf("path=%q", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer secret" {
			t.Errorf("authorization=%q", got)
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		messages := body["messages"].([]any)
		if len(messages) != 2 || messages[0].(map[string]any)["role"] != "system" || messages[1].(map[string]any)["role"] != "user" {
			t.Errorf("messages=%#v", messages)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"id":"chatcmpl_1","model":"vendor-model","choices":[{"message":{"role":"assistant","content":"hello"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}`)
	}))
	defer upstream.Close()

	registry := NewRegistry()
	if _, err := registry.Register("test", upstream.URL); err != nil {
		t.Fatal(err)
	}
	gateway := New("", registry)
	request := httptest.NewRequest(http.MethodPost, "/providers/test/v1/responses", strings.NewReader(`{"model":"vendor-model","instructions":"be concise","input":"hi"}`))
	request.Header.Set("Authorization", "Bearer secret")
	response := httptest.NewRecorder()
	gateway.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var result map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result["object"] != "response" || result["status"] != "completed" {
		t.Fatalf("response=%#v", result)
	}
	output := result["output"].([]any)
	text := output[0].(map[string]any)["content"].([]any)[0].(map[string]any)["text"]
	if text != "hello" {
		t.Fatalf("text=%#v", text)
	}
	usage := result["usage"].(map[string]any)
	if usage["input_tokens"] != float64(3) || usage["output_tokens"] != float64(1) {
		t.Fatalf("usage=%#v", usage)
	}
}

func TestGatewayTranslatesStreamingChatEvents(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: {\"id\":\"chatcmpl_stream\",\"model\":\"vendor\",\"choices\":[{\"delta\":{\"content\":\"hel\"}}]}\n\n")
		_, _ = io.WriteString(w, "data: {\"id\":\"chatcmpl_stream\",\"model\":\"vendor\",\"choices\":[{\"delta\":{\"content\":\"lo\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":1,\"total_tokens\":3}}\n\n")
		_, _ = io.WriteString(w, "data: [DONE]\n\n")
	}))
	defer upstream.Close()
	registry := NewRegistry()
	if _, err := registry.Register("stream", upstream.URL); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/providers/stream/v1/responses", strings.NewReader(`{"model":"vendor","input":"hi","stream":true}`))
	request.Header.Set("Authorization", "Bearer secret")
	response := httptest.NewRecorder()
	New("", registry).ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	body := response.Body.String()
	for _, expected := range []string{
		"event: response.created",
		`"type":"response.output_text.delta"`,
		`"delta":"hel"`,
		`"delta":"lo"`,
		`"text":"hello"`,
		`"input_tokens":2`,
		"event: response.completed",
	} {
		if !strings.Contains(body, expected) {
			t.Fatalf("stream missing %q:\n%s", expected, body)
		}
	}
}

func TestGatewayTranslatesResponsesLiteAdditionalTools(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		messages := body["messages"].([]any)
		if len(messages) != 2 || messages[0].(map[string]any)["role"] != "system" || messages[1].(map[string]any)["role"] != "user" {
			t.Fatalf("messages=%#v", messages)
		}
		tools := body["tools"].([]any)
		if len(tools) != 3 {
			t.Fatalf("tools=%#v", tools)
		}
		gotNames := make([]string, 0, len(tools))
		for _, raw := range tools {
			function := raw.(map[string]any)["function"].(map[string]any)
			gotNames = append(gotNames, function["name"].(string))
		}
		if strings.Join(gotNames, ",") != "exec,wait,editor__apply_patch" {
			t.Fatalf("tool names=%v", gotNames)
		}
		execParameters := tools[0].(map[string]any)["function"].(map[string]any)["parameters"].(map[string]any)
		if execParameters["properties"].(map[string]any)["input"] == nil {
			t.Fatalf("custom tool was not wrapped: %#v", execParameters)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"id":"chatcmpl_tools","model":"vendor","choices":[{"message":{"role":"assistant","tool_calls":[{"id":"call_1","type":"function","function":{"name":"exec","arguments":"{\"input\":\"echo aaa\"}"}}]},"finish_reason":"tool_calls"}]}`)
	}))
	defer upstream.Close()

	registry := NewRegistry()
	if _, err := registry.Register("lite", upstream.URL); err != nil {
		t.Fatal(err)
	}
	requestBody := `{
		"model":"vendor",
		"input":[
			{"type":"additional_tools","role":"developer","tools":[
				{"type":"tool_search","execution":"client"},
				{"type":"namespace","name":"functions","description":"","tools":[
					{"type":"custom","name":"exec","description":"Run code","format":{"type":"grammar","syntax":"lark","definition":"start: /.+/"}},
					{"type":"function","name":"wait","description":"Wait","parameters":{"type":"object","properties":{}}}
				]},
				{"type":"namespace","name":"editor","description":"Editing tools","tools":[
					{"type":"function","name":"apply_patch","description":"Apply patch","parameters":{"type":"object","properties":{}}}
				]}
			]},
			{"type":"message","role":"developer","content":[{"type":"input_text","text":"Use tools carefully"}]},
			{"type":"message","role":"user","content":[{"type":"input_text","text":"run it"}]}
		]
	}`
	request := httptest.NewRequest(http.MethodPost, "/providers/lite/v1/responses", strings.NewReader(requestBody))
	request.Header.Set("Authorization", "Bearer secret")
	response := httptest.NewRecorder()
	New("", registry).ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var result map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	call := result["output"].([]any)[0].(map[string]any)
	if call["type"] != "custom_tool_call" || call["namespace"] != "functions" || call["name"] != "exec" || call["input"] != "echo aaa" {
		t.Fatalf("translated call=%#v", call)
	}
}

func TestResponsesLiteCustomToolHistoryRoundTripsThroughChat(t *testing.T) {
	body := []byte(`{"input":[
		{"type":"additional_tools","role":"developer","tools":[{"type":"namespace","name":"functions","tools":[{"type":"custom","name":"exec","description":"Run","format":{"type":"grammar"}}]}]},
		{"type":"custom_tool_call","call_id":"call_1","namespace":"functions","name":"exec","input":"echo aaa"},
		{"type":"custom_tool_call_output","call_id":"call_1","name":"exec","output":"aaa"},
		{"type":"message","role":"user","content":[{"type":"input_text","text":"continue"}]}
	]}`)
	chatBody, _, _, err := responsesToChat(body)
	if err != nil {
		t.Fatal(err)
	}
	var chat map[string]any
	if err := json.Unmarshal(chatBody, &chat); err != nil {
		t.Fatal(err)
	}
	messages := chat["messages"].([]any)
	if len(messages) != 3 {
		t.Fatalf("messages=%#v", messages)
	}
	call := messages[0].(map[string]any)["tool_calls"].([]any)[0].(map[string]any)
	function := call["function"].(map[string]any)
	if function["name"] != "exec" || function["arguments"] != `{"input":"echo aaa"}` {
		t.Fatalf("history call=%#v", function)
	}
	if messages[1].(map[string]any)["role"] != "tool" || messages[1].(map[string]any)["content"] != "aaa" {
		t.Fatalf("history output=%#v", messages[1])
	}
}

func TestGatewayStreamsResponsesLiteCustomToolCall(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: {\"id\":\"chatcmpl_custom\",\"model\":\"vendor\",\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"exec\",\"arguments\":\"{\\\"input\\\":\\\"echo \"}}]}}]}\n\n")
		_, _ = io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"aaa\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n")
		_, _ = io.WriteString(w, "data: [DONE]\n\n")
	}))
	defer upstream.Close()
	registry := NewRegistry()
	if _, err := registry.Register("lite-stream", upstream.URL); err != nil {
		t.Fatal(err)
	}
	body := `{"model":"vendor","stream":true,"input":[
		{"type":"additional_tools","role":"developer","tools":[{"type":"namespace","name":"functions","tools":[{"type":"custom","name":"exec","description":"Run","format":{"type":"grammar"}}]}]},
		{"type":"message","role":"user","content":[{"type":"input_text","text":"run"}]}
	]}`
	request := httptest.NewRequest(http.MethodPost, "/providers/lite-stream/v1/responses", strings.NewReader(body))
	request.Header.Set("Authorization", "Bearer secret")
	response := httptest.NewRecorder()
	New("", registry).ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	stream := response.Body.String()
	for _, expected := range []string{`"type":"custom_tool_call"`, `"namespace":"functions"`, `"name":"exec"`, `"input":"echo aaa"`} {
		if !strings.Contains(stream, expected) {
			t.Fatalf("stream missing %q:\n%s", expected, stream)
		}
	}
	if strings.Contains(stream, "response.function_call_arguments") {
		t.Fatalf("custom call leaked function-call delta events:\n%s", stream)
	}
}

func TestGatewayRequiresAuthorizationAndDoesNotEchoIt(t *testing.T) {
	registry := NewRegistry()
	if _, err := registry.Register("test", "https://models.example/v1"); err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	New("", registry).ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/providers/test/v1/responses", strings.NewReader(`{"input":"hi"}`)))
	if response.Code != http.StatusUnauthorized || strings.Contains(response.Body.String(), "secret") {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}
