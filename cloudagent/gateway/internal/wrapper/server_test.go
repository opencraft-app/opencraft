package wrapper

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestUploadStreamGetResponseAndDownloadArtifact(t *testing.T) {
	srv, _ := newTestServer(t, FakeWorker{OutputText: "hello from worker"})

	uploadResp := uploadFile(t, srv, "tenant-a", "project-a", "input.txt", []byte("input data"))
	fileID := uploadResp["id"].(string)

	body := map[string]any{
		"model":  "minimax-m2.7",
		"stream": true,
		"input": []any{
			map[string]any{"type": "input_text", "text": "read the file"},
			map[string]any{"type": "input_file", "file_id": fileID},
		},
	}
	resp := jsonRequest(t, srv, http.MethodPost, "/v1/responses", "tenant-a", "project-a", body)
	if resp.Code != http.StatusOK {
		t.Fatalf("stream response status=%d body=%s", resp.Code, resp.Body.String())
	}
	events := parseSSE(t, resp.Body.String())
	requireEventOrder(t, events, []string{
		"response.created",
		"response.output_text.delta",
		"response.output_text.done",
		"response.completed",
	})
	if strings.Contains(resp.Body.String(), "sandbox.") {
		t.Fatalf("stream leaked custom sandbox event: %s", resp.Body.String())
	}
	responseID := eventResponseID(t, events[0])

	getResp := request(t, srv, http.MethodGet, "/v1/responses/"+responseID, "tenant-a", "project-a", nil, "")
	if getResp.Code != http.StatusOK {
		t.Fatalf("get response status=%d body=%s", getResp.Code, getResp.Body.String())
	}
	var response ResponseRecord
	if err := json.Unmarshal(getResp.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response.Status != "completed" {
		t.Fatalf("status=%s", response.Status)
	}
	if response.OutputText != "hello from worker" {
		t.Fatalf("output=%q", response.OutputText)
	}
	if len(response.ArtifactFileIDs) != 1 {
		t.Fatalf("artifact ids=%v", response.ArtifactFileIDs)
	}

	contentResp := request(t, srv, http.MethodGet, "/v1/files/"+response.ArtifactFileIDs[0]+"/content", "tenant-a", "project-a", nil, "")
	if contentResp.Code != http.StatusOK {
		t.Fatalf("artifact download status=%d body=%s", contentResp.Code, contentResp.Body.String())
	}
	if got := contentResp.Body.String(); got != "hello from worker\n" {
		t.Fatalf("artifact content=%q", got)
	}
}

func TestBrowserFileUploadPreflightAllowsMyChatHeaders(t *testing.T) {
	srv, _ := newTestServer(t, FakeWorker{})
	req := httptest.NewRequest(http.MethodOptions, "/v1/files", nil)
	req.Header.Set("Origin", "http://127.0.0.1:5173")
	req.Header.Set("Access-Control-Request-Method", "POST")
	req.Header.Set("Access-Control-Request-Headers", "content-type,x-tenant-id,x-project-id")
	resp := httptest.NewRecorder()

	srv.Handler().ServeHTTP(resp, req)

	if resp.Code != http.StatusNoContent {
		t.Fatalf("preflight status=%d body=%s", resp.Code, resp.Body.String())
	}
	if got := resp.Header().Get("Access-Control-Allow-Origin"); got != "*" {
		t.Fatalf("allow origin=%q", got)
	}
	if got := resp.Header().Get("Access-Control-Allow-Methods"); !strings.Contains(got, "POST") {
		t.Fatalf("allow methods=%q", got)
	}
	if got := strings.ToLower(resp.Header().Get("Access-Control-Allow-Headers")); !strings.Contains(got, "x-tenant-id") || !strings.Contains(got, "x-project-id") {
		t.Fatalf("allow headers=%q", got)
	}
}

func TestBrowserFileUploadResponseIncludesCORS(t *testing.T) {
	srv, _ := newTestServer(t, FakeWorker{})
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("file", "input.txt")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write([]byte("input data")); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/v1/files", &body)
	req.Header.Set("Origin", "http://127.0.0.1:5173")
	req.Header.Set("X-Tenant-ID", "tenant-a")
	req.Header.Set("X-Project-ID", "project-a")
	req.Header.Set("Content-Type", writer.FormDataContentType())
	resp := httptest.NewRecorder()

	srv.Handler().ServeHTTP(resp, req)

	if resp.Code != http.StatusOK {
		t.Fatalf("upload status=%d body=%s", resp.Code, resp.Body.String())
	}
	if got := resp.Header().Get("Access-Control-Allow-Origin"); got != "*" {
		t.Fatalf("allow origin=%q", got)
	}
}

func TestHealthzAllowsUnauthenticatedProbe(t *testing.T) {
	srv, _ := newTestServer(t, FakeWorker{})
	resp := request(t, srv, http.MethodGet, "/healthz", "", "", nil, "")

	if resp.Code != http.StatusOK {
		t.Fatalf("healthz status=%d body=%s", resp.Code, resp.Body.String())
	}
	if got := resp.Body.String(); got != "ok\n" {
		t.Fatalf("healthz body=%q", got)
	}
}

func TestCrossScopeFileReadDenied(t *testing.T) {
	srv, _ := newTestServer(t, FakeWorker{})
	uploadResp := uploadFile(t, srv, "tenant-a", "project-a", "input.txt", []byte("input data"))
	fileID := uploadResp["id"].(string)

	resp := request(t, srv, http.MethodGet, "/v1/files/"+fileID+"/content", "tenant-b", "project-a", nil, "")
	if resp.Code != http.StatusForbidden {
		t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
	}
	assertErrorCode(t, resp.Body.Bytes(), "scope_denied")
}

func TestStorePersistsFilesAndResponsesAcrossRestart(t *testing.T) {
	root := t.TempDir()
	scope := Scope{TenantID: "tenant-a", ProjectID: "project-a"}
	store, err := NewStore(root)
	if err != nil {
		t.Fatal(err)
	}
	file, err := store.PutFile(scope, "input.txt", "assistants", "text/plain", "input", "", []byte("input data"))
	if err != nil {
		t.Fatal(err)
	}
	response := store.CreateResponse(scope, "agent-sidecar-chat")
	store.CompleteResponse(response.ID, "persisted output", []string{file.ID})
	if err := store.db.Close(); err != nil {
		t.Fatal(err)
	}

	restarted, err := NewStore(root)
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.db.Close()
	gotFile, content, apiErr := restarted.GetFile(scope, file.ID)
	if apiErr != nil {
		t.Fatalf("get file after restart: %#v", apiErr)
	}
	if gotFile.SHA256 != file.SHA256 || string(content) != "input data" {
		t.Fatalf("unexpected file after restart: %#v content=%q", gotFile, string(content))
	}
	gotResponse, apiErr := restarted.GetResponse(scope, response.ID)
	if apiErr != nil {
		t.Fatalf("get response after restart: %#v", apiErr)
	}
	if gotResponse.Status != "completed" || gotResponse.OutputText != "persisted output" || len(gotResponse.ArtifactFileIDs) != 1 || gotResponse.ArtifactFileIDs[0] != file.ID {
		t.Fatalf("unexpected response after restart: %#v", gotResponse)
	}
}

func TestExpiredFileReadDenied(t *testing.T) {
	srv, store := newTestServer(t, FakeWorker{})
	uploadResp := uploadFile(t, srv, "tenant-a", "project-a", "input.txt", []byte("input data"))
	fileID := uploadResp["id"].(string)
	store.ExpireFile(fileID)

	resp := request(t, srv, http.MethodGet, "/v1/files/"+fileID+"/content", "tenant-a", "project-a", nil, "")
	if resp.Code != http.StatusGone {
		t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
	}
	assertErrorCode(t, resp.Body.Bytes(), "file_expired")
}

func TestMissingIdentityRejected(t *testing.T) {
	srv, _ := newTestServer(t, FakeWorker{})
	resp := request(t, srv, http.MethodGet, "/v1/files/file_missing/content", "", "", nil, "")
	if resp.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
	}
	assertErrorCode(t, resp.Body.Bytes(), "identity_missing")
}

func TestListModelsWithBearerAuth(t *testing.T) {
	srv, _ := newTestServer(t, FakeWorker{})
	resp := bearerRequest(t, srv, http.MethodGet, "/v1/models", "test-key", nil, "")
	if resp.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
	}
	var out listModelsResponse
	if err := json.Unmarshal(resp.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out.Object != "list" || len(out.Data) == 0 {
		t.Fatalf("unexpected model response=%+v", out)
	}
	if out.Data[0].Object != "model" {
		t.Fatalf("unexpected model object=%+v", out.Data[0])
	}
}

func TestBearerAuthUsesDefaultMockScope(t *testing.T) {
	srv, _ := newTestServer(t, FakeWorker{OutputText: "bearer ok"})
	resp := bearerJSONRequest(t, srv, http.MethodPost, "/v1/responses", "test-key", map[string]any{
		"model": "agent-sidecar-chat",
		"input": "hello",
	})
	if resp.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
	}
	var out ResponseRecord
	if err := json.Unmarshal(resp.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out.Status != "completed" || out.OutputText != "bearer ok" {
		t.Fatalf("unexpected response=%+v", out)
	}
	getResp := bearerRequest(t, srv, http.MethodGet, "/v1/responses/"+out.ID, "test-key", nil, "")
	if getResp.Code != http.StatusOK {
		t.Fatalf("get status=%d body=%s", getResp.Code, getResp.Body.String())
	}
}

func TestChatCompletionsSupportsNonStreamingAndStreaming(t *testing.T) {
	srv, _ := newTestServer(t, FakeWorker{OutputText: "chat ok"})
	body := map[string]any{
		"model": "agent-sidecar-chat",
		"messages": []any{
			map[string]any{"role": "system", "content": "You are concise."},
			map[string]any{"role": "user", "content": "hello"},
		},
	}
	resp := bearerJSONRequest(t, srv, http.MethodPost, "/v1/chat/completions", "test-key", body)
	if resp.Code != http.StatusOK {
		t.Fatalf("chat completion status=%d body=%s", resp.Code, resp.Body.String())
	}
	var out struct {
		Object  string `json:"object"`
		Choices []struct {
			Message struct {
				Role    string `json:"role"`
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(resp.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out.Object != "chat.completion" || len(out.Choices) != 1 || out.Choices[0].Message.Content != "chat ok" {
		t.Fatalf("unexpected chat response=%+v", out)
	}

	body["stream"] = true
	streamResp := bearerJSONRequest(t, srv, http.MethodPost, "/v1/chat/completions", "test-key", body)
	if streamResp.Code != http.StatusOK {
		t.Fatalf("chat stream status=%d body=%s", streamResp.Code, streamResp.Body.String())
	}
	raw := streamResp.Body.String()
	if !strings.Contains(raw, `"object":"chat.completion.chunk"`) {
		t.Fatalf("missing chat chunk: %s", raw)
	}
	if !strings.Contains(raw, `"content":"chat"`) || !strings.Contains(raw, `"content":" ok"`) {
		t.Fatalf("missing chat delta: %s", raw)
	}
	if !strings.Contains(raw, "data: [DONE]") {
		t.Fatalf("missing done sentinel: %s", raw)
	}
}

func TestPreviousResponseIDAcceptedForSameScope(t *testing.T) {
	srv, _ := newTestServer(t, FakeWorker{OutputText: "turn"})
	first := jsonRequest(t, srv, http.MethodPost, "/v1/responses", "tenant-a", "project-a", map[string]any{
		"model": "minimax-m2.7",
		"input": "first",
	})
	if first.Code != http.StatusOK {
		t.Fatalf("first status=%d body=%s", first.Code, first.Body.String())
	}
	var firstOut ResponseRecord
	if err := json.Unmarshal(first.Body.Bytes(), &firstOut); err != nil {
		t.Fatal(err)
	}
	second := jsonRequest(t, srv, http.MethodPost, "/v1/responses", "tenant-a", "project-a", map[string]any{
		"model":                "minimax-m2.7",
		"previous_response_id": firstOut.ID,
		"input":                "second",
	})
	if second.Code != http.StatusOK {
		t.Fatalf("second status=%d body=%s", second.Code, second.Body.String())
	}
}

func TestPreviousResponseIDDeniedAcrossScopes(t *testing.T) {
	srv, _ := newTestServer(t, FakeWorker{OutputText: "turn"})
	first := jsonRequest(t, srv, http.MethodPost, "/v1/responses", "tenant-a", "project-a", map[string]any{
		"model": "minimax-m2.7",
		"input": "first",
	})
	var firstOut ResponseRecord
	if err := json.Unmarshal(first.Body.Bytes(), &firstOut); err != nil {
		t.Fatal(err)
	}
	second := jsonRequest(t, srv, http.MethodPost, "/v1/responses", "tenant-b", "project-a", map[string]any{
		"model":                "minimax-m2.7",
		"previous_response_id": firstOut.ID,
		"input":                "second",
	})
	if second.Code != http.StatusForbidden {
		t.Fatalf("second status=%d body=%s", second.Code, second.Body.String())
	}
	assertErrorCode(t, second.Body.Bytes(), "scope_denied")
}

func TestLangChainResponsesFieldsAccepted(t *testing.T) {
	srv, _ := newTestServer(t, FakeWorker{OutputText: "langchain ok"})
	resp := bearerJSONRequest(t, srv, http.MethodPost, "/v1/responses", "test-key", map[string]any{
		"model":               "agent-sidecar-chat",
		"stream":              true,
		"temperature":         0.2,
		"top_p":               1,
		"user":                "user-1",
		"service_tier":        "auto",
		"truncation":          "disabled",
		"include":             []any{},
		"tools":               []any{},
		"tool_choice":         nil,
		"text":                map[string]any{"format": map[string]any{"type": "text"}},
		"parallel_tool_calls": true,
		"max_output_tokens":   1024,
		"prompt_cache_key":    "cache-key",
		"metadata":            map[string]any{"source": "test"},
		"store":               true,
		"input": []any{
			map[string]any{
				"type": "message",
				"role": "user",
				"content": []any{
					map[string]any{"type": "input_text", "text": "hello"},
				},
			},
		},
	})
	if resp.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
	}
	events := parseSSE(t, resp.Body.String())
	requireEventOrder(t, events, []string{"response.created", "response.output_text.delta", "response.completed"})
}

func TestUnknownTopLevelFieldRejected(t *testing.T) {
	srv, _ := newTestServer(t, FakeWorker{})
	resp := jsonRequest(t, srv, http.MethodPost, "/v1/responses", "tenant-a", "project-a", map[string]any{
		"model":      "minimax-m2.7",
		"input":      "hello",
		"unexpected": true,
	})
	if resp.Code != http.StatusBadRequest {
		t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
	}
	assertErrorCode(t, resp.Body.Bytes(), "invalid_json")
}

func TestUnsupportedNestedInputFieldRejected(t *testing.T) {
	srv, _ := newTestServer(t, FakeWorker{})
	resp := jsonRequest(t, srv, http.MethodPost, "/v1/responses", "tenant-a", "project-a", map[string]any{
		"model": "minimax-m2.7",
		"input": []any{
			map[string]any{"type": "input_text", "text": "hello", "bogus": true},
		},
	})
	if resp.Code != http.StatusBadRequest {
		t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
	}
	assertErrorCode(t, resp.Body.Bytes(), "invalid_input")
}

func TestUnsupportedNestedInputTypeRejected(t *testing.T) {
	srv, _ := newTestServer(t, FakeWorker{})
	resp := jsonRequest(t, srv, http.MethodPost, "/v1/responses", "tenant-a", "project-a", map[string]any{
		"model": "minimax-m2.7",
		"input": []any{
			map[string]any{"type": "mystery", "text": "hello"},
		},
	})
	if resp.Code != http.StatusBadRequest {
		t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
	}
	assertErrorCode(t, resp.Body.Bytes(), "invalid_input")
}

func TestInvalidIdentityRejected(t *testing.T) {
	srv, _ := newTestServer(t, FakeWorker{})
	resp := request(t, srv, http.MethodGet, "/v1/files/file_missing/content", "tenant a", "project-a", nil, "")
	if resp.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
	}
	assertErrorCode(t, resp.Body.Bytes(), "identity_invalid")
}

func TestWorkerContractVersionMismatchFailsWithoutCompleted(t *testing.T) {
	srv, _ := newTestServer(t, FakeWorker{ExpectedVersion: "future.v2"})
	resp := jsonRequest(t, srv, http.MethodPost, "/v1/responses", "tenant-a", "project-a", map[string]any{
		"model":  "minimax-m2.7",
		"stream": true,
		"input":  "hello",
	})
	if resp.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
	}
	body := resp.Body.String()
	if !strings.Contains(body, "worker_contract_version_mismatch") {
		t.Fatalf("expected version mismatch body=%s", body)
	}
	if strings.Contains(body, "event: response.completed") {
		t.Fatalf("must not complete on contract mismatch: %s", body)
	}
}

func TestWorkerMissingEventVersionFailsWithoutCompleted(t *testing.T) {
	srv, _ := newTestServer(t, FakeWorker{OmitEventVersion: true})
	resp := jsonRequest(t, srv, http.MethodPost, "/v1/responses", "tenant-a", "project-a", map[string]any{
		"model":  "minimax-m2.7",
		"stream": true,
		"input":  "hello",
	})
	if resp.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
	}
	body := resp.Body.String()
	if !strings.Contains(body, "worker_contract_version_missing") {
		t.Fatalf("expected missing event version body=%s", body)
	}
	if strings.Contains(body, "event: response.completed") {
		t.Fatalf("must not complete on missing event version: %s", body)
	}
}

func TestWorkerMissingResultVersionFailsWithoutCompleted(t *testing.T) {
	srv, _ := newTestServer(t, FakeWorker{OmitResultVersion: true})
	resp := jsonRequest(t, srv, http.MethodPost, "/v1/responses", "tenant-a", "project-a", map[string]any{
		"model":  "minimax-m2.7",
		"stream": true,
		"input":  "hello",
	})
	if resp.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
	}
	body := resp.Body.String()
	if !strings.Contains(body, "worker_contract_version_missing") {
		t.Fatalf("expected missing version body=%s", body)
	}
	if strings.Contains(body, "event: response.completed") {
		t.Fatalf("must not complete on missing worker result version: %s", body)
	}
}

func TestWorkerMissingArtifactVersionFailsWithoutCompleted(t *testing.T) {
	srv, _ := newTestServer(t, FakeWorker{OmitArtifactVersion: true})
	resp := jsonRequest(t, srv, http.MethodPost, "/v1/responses", "tenant-a", "project-a", map[string]any{
		"model":  "minimax-m2.7",
		"stream": true,
		"input":  "hello",
	})
	if resp.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
	}
	body := resp.Body.String()
	if !strings.Contains(body, "worker_contract_version_missing") {
		t.Fatalf("expected missing artifact version body=%s", body)
	}
	if strings.Contains(body, "event: response.completed") {
		t.Fatalf("must not complete on missing artifact version: %s", body)
	}
}

func TestArtifactPersistenceFailureDoesNotEmitCompleted(t *testing.T) {
	srv, store := newTestServer(t, FakeWorker{OutputText: "will fail after worker"})
	store.SetFailArtifactPersist(true)

	resp := jsonRequest(t, srv, http.MethodPost, "/v1/responses", "tenant-a", "project-a", map[string]any{
		"model":  "minimax-m2.7",
		"stream": true,
		"input":  "make artifact",
	})
	if resp.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
	}
	body := resp.Body.String()
	if !strings.Contains(body, "artifact_persistence_failed") {
		t.Fatalf("expected artifact persistence failure body=%s", body)
	}
	if strings.Contains(body, "event: response.completed") {
		t.Fatalf("must not complete when artifact persistence fails: %s", body)
	}
}

func TestArtifactChecksumMismatchFailsWithoutCompleted(t *testing.T) {
	srv, _ := newTestServer(t, FakeWorker{BadArtifactChecksum: true})
	resp := jsonRequest(t, srv, http.MethodPost, "/v1/responses", "tenant-a", "project-a", map[string]any{
		"model":  "minimax-m2.7",
		"stream": true,
		"input":  "make artifact",
	})
	if resp.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
	}
	body := resp.Body.String()
	if !strings.Contains(body, "artifact_persistence_failed") || !strings.Contains(body, "checksum mismatch") {
		t.Fatalf("expected checksum persistence failure body=%s", body)
	}
	if strings.Contains(body, "event: response.completed") {
		t.Fatalf("must not complete when artifact checksum mismatches: %s", body)
	}
}

func TestArtifactSizeMismatchFailsWithoutCompleted(t *testing.T) {
	srv, _ := newTestServer(t, FakeWorker{BadArtifactSize: true})
	resp := jsonRequest(t, srv, http.MethodPost, "/v1/responses", "tenant-a", "project-a", map[string]any{
		"model":  "minimax-m2.7",
		"stream": true,
		"input":  "make artifact",
	})
	if resp.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
	}
	body := resp.Body.String()
	if !strings.Contains(body, "artifact_persistence_failed") || !strings.Contains(body, "size mismatch") {
		t.Fatalf("expected size persistence failure body=%s", body)
	}
	if strings.Contains(body, "event: response.completed") {
		t.Fatalf("must not complete when artifact size mismatches: %s", body)
	}
}

func TestFailedResponseMetadataAfterArtifactPersistenceFailure(t *testing.T) {
	srv, store := newTestServer(t, FakeWorker{OutputText: "will fail after worker"})
	store.SetFailArtifactPersist(true)
	resp := jsonRequest(t, srv, http.MethodPost, "/v1/responses", "tenant-a", "project-a", map[string]any{
		"model": "minimax-m2.7",
		"input": "make artifact",
	})
	if resp.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
	}
	var failed ResponseRecord
	if err := json.Unmarshal(resp.Body.Bytes(), &failed); err != nil {
		t.Fatal(err)
	}
	if failed.Status != "failed" || failed.Error == nil || failed.Error.Code != "artifact_persistence_failed" {
		t.Fatalf("unexpected failed response %#v", failed)
	}
	getResp := request(t, srv, http.MethodGet, "/v1/responses/"+failed.ID, "tenant-a", "project-a", nil, "")
	if getResp.Code != http.StatusOK {
		t.Fatalf("get status=%d body=%s", getResp.Code, getResp.Body.String())
	}
	var retrieved ResponseRecord
	if err := json.Unmarshal(getResp.Body.Bytes(), &retrieved); err != nil {
		t.Fatal(err)
	}
	if retrieved.Status != "failed" || retrieved.Error == nil || retrieved.Error.Code != "artifact_persistence_failed" {
		t.Fatalf("unexpected retrieved response %#v", retrieved)
	}
}

func TestCrossScopeArtifactDownloadDenied(t *testing.T) {
	srv, _ := newTestServer(t, FakeWorker{OutputText: "artifact owner"})
	resp := jsonRequest(t, srv, http.MethodPost, "/v1/responses", "tenant-a", "project-a", map[string]any{
		"model": "minimax-m2.7",
		"input": "make artifact",
	})
	if resp.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
	}
	var response ResponseRecord
	if err := json.Unmarshal(resp.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if len(response.ArtifactFileIDs) != 1 {
		t.Fatalf("artifact ids=%v", response.ArtifactFileIDs)
	}
	download := request(t, srv, http.MethodGet, "/v1/files/"+response.ArtifactFileIDs[0]+"/content", "tenant-a", "project-b", nil, "")
	if download.Code != http.StatusForbidden {
		t.Fatalf("status=%d body=%s", download.Code, download.Body.String())
	}
	assertErrorCode(t, download.Body.Bytes(), "scope_denied")
}

func TestCrossScopeResponseReadDenied(t *testing.T) {
	srv, _ := newTestServer(t, FakeWorker{OutputText: "owned response"})
	resp := jsonRequest(t, srv, http.MethodPost, "/v1/responses", "tenant-a", "project-a", map[string]any{
		"model": "minimax-m2.7",
		"input": "hello",
	})
	if resp.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
	}
	var response ResponseRecord
	if err := json.Unmarshal(resp.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	denied := request(t, srv, http.MethodGet, "/v1/responses/"+response.ID, "tenant-a", "project-b", nil, "")
	if denied.Code != http.StatusForbidden {
		t.Fatalf("status=%d body=%s", denied.Code, denied.Body.String())
	}
	assertErrorCode(t, denied.Body.Bytes(), "scope_denied")
}

func TestImmediateResponseAuditIncludesTerminalState(t *testing.T) {
	srv, _ := newTestServer(t, FakeWorker{OutputText: "audit me"})
	resp := jsonRequest(t, srv, http.MethodPost, "/v1/responses", "tenant-a", "project-a", map[string]any{
		"model": "minimax-m2.7",
		"input": "hello",
	})
	if resp.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
	}
	var response ResponseRecord
	if err := json.Unmarshal(resp.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	assertAuditContains(t, response.AuditSummary, "response_completed")
	assertAuditContains(t, response.AuditSummary, "artifact_created")
}

func TestResponseCreateWithOutOfScopeFileDenied(t *testing.T) {
	srv, _ := newTestServer(t, FakeWorker{})
	uploadResp := uploadFile(t, srv, "tenant-a", "project-a", "input.txt", []byte("input data"))
	fileID := uploadResp["id"].(string)
	resp := jsonRequest(t, srv, http.MethodPost, "/v1/responses", "tenant-b", "project-a", map[string]any{
		"model": "minimax-m2.7",
		"input": []any{
			map[string]any{"type": "input_file", "file_id": fileID},
		},
	})
	if resp.Code != http.StatusForbidden {
		t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
	}
	assertErrorCode(t, resp.Body.Bytes(), "scope_denied")
}

func newTestServer(t *testing.T, worker Worker) (*Server, *Store) {
	t.Helper()
	store, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return NewServer(store, worker), store
}

func uploadFile(t *testing.T, srv *Server, tenant, project, filename string, content []byte) map[string]any {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	if err := writer.WriteField("purpose", "assistants"); err != nil {
		t.Fatal(err)
	}
	part, err := writer.CreateFormFile("file", filename)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(content); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	resp := request(t, srv, http.MethodPost, "/v1/files", tenant, project, &body, writer.FormDataContentType())
	if resp.Code != http.StatusOK {
		t.Fatalf("upload status=%d body=%s", resp.Code, resp.Body.String())
	}
	var out map[string]any
	if err := json.Unmarshal(resp.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func jsonRequest(t *testing.T, srv *Server, method, target, tenant, project string, body any) *httptest.ResponseRecorder {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	return request(t, srv, method, target, tenant, project, bytes.NewBuffer(raw), "application/json")
}

func request(t *testing.T, srv *Server, method, target, tenant, project string, body io.Reader, contentType string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, target, body)
	if tenant != "" {
		req.Header.Set("X-Tenant-ID", tenant)
	}
	if project != "" {
		req.Header.Set("X-Project-ID", project)
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	resp := httptest.NewRecorder()
	srv.Handler().ServeHTTP(resp, req)
	return resp
}

func bearerJSONRequest(t *testing.T, srv *Server, method, target, token string, body any) *httptest.ResponseRecorder {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	return bearerRequest(t, srv, method, target, token, bytes.NewBuffer(raw), "application/json")
}

func bearerRequest(t *testing.T, srv *Server, method, target, token string, body io.Reader, contentType string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, target, body)
	req.Header.Set("Authorization", "Bearer "+token)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	resp := httptest.NewRecorder()
	srv.Handler().ServeHTTP(resp, req)
	return resp
}

type sseEvent struct {
	Name string
	Data map[string]any
}

func parseSSE(t *testing.T, body string) []sseEvent {
	t.Helper()
	var events []sseEvent
	scanner := bufio.NewScanner(strings.NewReader(body))
	var current sseEvent
	for scanner.Scan() {
		line := scanner.Text()
		switch {
		case strings.HasPrefix(line, "event: "):
			current.Name = strings.TrimPrefix(line, "event: ")
		case strings.HasPrefix(line, "data: "):
			if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &current.Data); err != nil {
				t.Fatal(err)
			}
		case line == "":
			if current.Name != "" {
				events = append(events, current)
				current = sseEvent{}
			}
		}
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
	return events
}

func requireEventOrder(t *testing.T, events []sseEvent, required []string) {
	t.Helper()
	pos := 0
	for _, event := range events {
		if pos < len(required) && event.Name == required[pos] {
			pos++
		}
	}
	if pos != len(required) {
		names := make([]string, 0, len(events))
		for _, event := range events {
			names = append(names, event.Name)
		}
		t.Fatalf("events %v do not contain required order %v", names, required)
	}
}

func eventResponseID(t *testing.T, event sseEvent) string {
	t.Helper()
	id, ok := event.Data["response_id"].(string)
	if !ok || id == "" {
		t.Fatalf("missing response id in event %#v", event)
	}
	return id
}

func assertErrorCode(t *testing.T, raw []byte, code string) {
	t.Helper()
	var payload struct {
		Error APIError `json:"error"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Error.Code != code {
		t.Fatalf("error code=%q want=%q raw=%s", payload.Error.Code, code, string(raw))
	}
}

func assertAuditContains(t *testing.T, events []AuditEvent, eventType string) {
	t.Helper()
	for _, event := range events {
		if event.Type == eventType {
			return
		}
	}
	t.Fatalf("audit missing %s in %#v", eventType, events)
}
