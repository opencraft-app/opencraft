package workerregistry

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestAPIWorkerLifecycle(t *testing.T) {
	api := NewAPI(mustStore(t, t.TempDir()), DefaultMaxRequestBytes)
	server := httptest.NewServer(api)
	defer server.Close()

	upload := validRequest("export default { fetch() { return new Response('hello') } }")
	response := requestJSON(t, http.MethodPut, server.URL+"/v1/namespaces/default/workers/hello", upload)
	if response.StatusCode != http.StatusCreated {
		t.Fatalf("upload status = %d, body = %s", response.StatusCode, readBody(t, response))
	}
	var worker Worker
	decodeResponse(t, response, &worker)

	response = requestJSON(t, http.MethodPut, server.URL+"/v1/namespaces/default/workers/hello", upload)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("idempotent upload status = %d, body = %s", response.StatusCode, readBody(t, response))
	}
	response.Body.Close()

	response, err := http.Get(server.URL + "/v1/namespaces/default/workers")
	if err != nil {
		t.Fatal(err)
	}
	var list WorkerList
	decodeResponse(t, response, &list)
	if len(list.Workers) != 1 || list.Workers[0].Name != "hello" {
		t.Fatalf("unexpected Worker list: %#v", list)
	}

	internalURL := server.URL + "/internal/v1/namespaces/default/workers/hello/versions/" + worker.Versions[0].VersionID
	response, err = http.Get(internalURL)
	if err != nil {
		t.Fatal(err)
	}
	if response.Header.Get("Cache-Control") != "private, max-age=31536000, immutable" || response.Header.Get("ETag") == "" {
		t.Fatalf("immutable response has incorrect caching headers: %#v", response.Header)
	}
	etag := response.Header.Get("ETag")
	var version WorkerVersion
	decodeResponse(t, response, &version)
	if version.Content.Modules[version.Content.MainModule] != upload.Modules[upload.MainModule] {
		t.Fatal("internal version endpoint did not return module source")
	}

	request, err := http.NewRequest(http.MethodGet, internalURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("If-None-Match", etag)
	response, err = http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusNotModified {
		t.Fatalf("conditional version request status = %d", response.StatusCode)
	}
	response.Body.Close()

	request, err = http.NewRequest(http.MethodDelete, server.URL+"/v1/namespaces/default/workers/hello", nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err = http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusNoContent {
		t.Fatalf("delete status = %d, body = %s", response.StatusCode, readBody(t, response))
	}
	response.Body.Close()
	response, err = http.Get(internalURL)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK {
		t.Fatalf("retained version status = %d, body = %s", response.StatusCode, readBody(t, response))
	}
	response.Body.Close()
}

func TestAPIDeploymentCursorWatchesTransactionalChanges(t *testing.T) {
	store := mustStore(t, t.TempDir())
	api := NewAPI(store, DefaultMaxRequestBytes)
	server := httptest.NewServer(api)
	defer server.Close()

	worker, _, err := store.PutWorker(t.Context(), "default", "hello", validRequest("export default { fetch() { return new Response('one') } }"))
	if err != nil {
		t.Fatal(err)
	}
	if !validDeploymentCursor(worker.DeploymentCursor) || worker.DeploymentCursor == InitialDeploymentCursor {
		t.Fatalf("invalid initial deployment cursor %q", worker.DeploymentCursor)
	}
	invalid, err := http.Get(server.URL + "/internal/v1/namespaces/default/deployment-cursor?after=bad")
	if err != nil {
		t.Fatal(err)
	}
	if invalid.StatusCode != http.StatusBadRequest {
		t.Fatalf("invalid cursor status = %d", invalid.StatusCode)
	}
	invalid.Body.Close()

	type watchResult struct {
		response *http.Response
		err      error
	}
	result := make(chan watchResult, 1)
	go func() {
		response, err := http.Get(server.URL + "/internal/v1/namespaces/default/deployment-cursor?after=" + worker.DeploymentCursor)
		result <- watchResult{response: response, err: err}
	}()
	// The filesystem backend is only for deterministic local development; its
	// watch polls the durable cursor file. Production uses an FDB watch on the
	// cursor written in the Deployment transaction.
	time.Sleep(20 * time.Millisecond)
	updated, _, err := store.PutWorker(t.Context(), "default", "hello", validRequest("export default { fetch() { return new Response('two') } }"))
	if err != nil {
		t.Fatal(err)
	}
	select {
	case watched := <-result:
		if watched.err != nil {
			t.Fatal(watched.err)
		}
		if watched.response.StatusCode != http.StatusOK {
			t.Fatalf("watch status = %d, body = %s", watched.response.StatusCode, readBody(t, watched.response))
		}
		var cursor DeploymentCursor
		decodeResponse(t, watched.response, &cursor)
		if cursor.Schema != DeploymentCursorSchema || cursor.Namespace != "default" || cursor.Cursor != updated.DeploymentCursor || cursor.Cursor == worker.DeploymentCursor {
			t.Fatalf("unexpected watched cursor: %#v", cursor)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("deployment cursor watch did not observe active Deployment change")
	}
}

func TestAPIDeploymentCursorWatchCapacityFailsFast(t *testing.T) {
	api := NewAPI(mustStore(t, t.TempDir()), DefaultMaxRequestBytes)
	for range cap(api.deploymentWatchPermits) {
		api.deploymentWatchPermits <- struct{}{}
	}
	request := httptest.NewRequest(http.MethodGet, "/internal/v1/namespaces/default/deployment-cursor?after="+InitialDeploymentCursor, nil)
	response := httptest.NewRecorder()
	api.ServeHTTP(response, request)
	if response.Code != http.StatusTooManyRequests || response.Header().Get("Retry-After") != "1" {
		t.Fatalf("overloaded watch response = %d headers=%v body=%s", response.Code, response.Header(), response.Body.String())
	}
	var failure apiError
	if err := json.Unmarshal(response.Body.Bytes(), &failure); err != nil {
		t.Fatal(err)
	}
	if failure.Code != "watch_overloaded" {
		t.Fatalf("overloaded watch error = %#v", failure)
	}
}

func TestAPIDurableObjectWorkerDeleteReturnsConflict(t *testing.T) {
	api := NewAPI(mustStore(t, t.TempDir()), DefaultMaxRequestBytes)
	server := httptest.NewServer(api)
	defer server.Close()

	upload := validRequest("export class Counter {}; export default {}")
	upload.DurableObjects = map[string]string{"COUNTER": "Counter"}
	response := requestJSON(t, http.MethodPut, server.URL+"/v1/namespaces/default/workers/counter", upload)
	if response.StatusCode != http.StatusCreated {
		t.Fatalf("upload status = %d, body = %s", response.StatusCode, readBody(t, response))
	}
	response.Body.Close()

	request, err := http.NewRequest(http.MethodDelete, server.URL+"/v1/namespaces/default/workers/counter", nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err = http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusConflict {
		t.Fatalf("delete status = %d, body = %s", response.StatusCode, readBody(t, response))
	}
	var failure apiError
	decodeResponse(t, response, &failure)
	if failure.Code != "durable_object_namespaces" {
		t.Fatalf("unexpected delete error: %#v", failure)
	}
}

func TestAPIInternalDurableObjectLifecycleIsTerminal(t *testing.T) {
	api := NewAPI(mustStore(t, t.TempDir()), DefaultMaxRequestBytes)
	server := httptest.NewServer(api)
	defer server.Close()

	upload := validRequest("export class Counter {}; export default {}")
	upload.DurableObjects = map[string]string{"COUNTER": "Counter"}
	response := requestJSON(t, http.MethodPut, server.URL+"/v1/namespaces/default/workers/counter", upload)
	if response.StatusCode != http.StatusCreated {
		t.Fatalf("upload status = %d, body = %s", response.StatusCode, readBody(t, response))
	}
	response.Body.Close()
	objectID := strings.Repeat("c", 64)
	objectURL := server.URL + "/internal/v1/namespaces/default/workers/counter/objects/Counter/" + objectID
	response = requestJSON(t, http.MethodPut, objectURL, ClaimObjectRequest{Placement: testObjectPlacement()})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("claim status = %d, body = %s", response.StatusCode, readBody(t, response))
	}
	response.Body.Close()
	response, err := http.Get(server.URL + "/internal/v1/cells/actor-bj-a01/placement-count?cell_uid=cell-uid")
	if err != nil {
		t.Fatal(err)
	}
	var count CellPlacementCount
	decodeResponse(t, response, &count)
	if response.StatusCode != http.StatusOK || count.Schema != CellPlacementCountSchema || count.Count != 1 || count.Shards != CellPlacementCountShards {
		t.Fatalf("placement count response status=%d value=%+v", response.StatusCode, count)
	}
	response = requestJSON(t, http.MethodPost, objectURL+"/activate", ActivateObjectRequest{ActorID: "actor-3"})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("activate status = %d, body = %s", response.StatusCode, readBody(t, response))
	}
	response.Body.Close()
	request, err := http.NewRequest(http.MethodGet, objectURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err = http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	var observed DurableObjectRecord
	decodeResponse(t, response, &observed)
	if response.StatusCode != http.StatusOK || observed.ActorID != "actor-3" || observed.Placement == nil {
		t.Fatalf("get object status=%d record=%+v", response.StatusCode, observed)
	}
	for attempt := range 2 {
		request, err := http.NewRequest(http.MethodDelete, objectURL, nil)
		if err != nil {
			t.Fatal(err)
		}
		response, err = http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		if response.StatusCode != http.StatusOK {
			t.Fatalf("delete %d status = %d, body = %s", attempt+1, response.StatusCode, readBody(t, response))
		}
		response.Body.Close()
	}
	response, err = http.Get(server.URL + "/internal/v1/cells/actor-bj-a01/placement-count?cell_uid=cell-uid")
	if err != nil {
		t.Fatal(err)
	}
	decodeResponse(t, response, &count)
	if response.StatusCode != http.StatusOK || count.Count != 0 {
		t.Fatalf("placement count after delete status=%d value=%+v", response.StatusCode, count)
	}
	response = requestJSON(t, http.MethodPut, objectURL, nil)
	if response.StatusCode != http.StatusGone {
		t.Fatalf("claim after delete status = %d, body = %s", response.StatusCode, readBody(t, response))
	}
	var failure apiError
	decodeResponse(t, response, &failure)
	if failure.Code != "object_deleted" {
		t.Fatalf("unexpected claim failure: %#v", failure)
	}
}

func TestAPIUploadsVersionsWithoutDeployingThenCreatesGradualDeployment(t *testing.T) {
	api := NewAPI(mustStore(t, t.TempDir()), DefaultMaxRequestBytes)
	server := httptest.NewServer(api)
	defer server.Close()
	base := server.URL + "/v1/namespaces/default/workers/gradual"

	var versions []VersionSummary
	for _, source := range []string{"export default { fetch() { return new Response('v1') } }", "export default { fetch() { return new Response('v2') } }"} {
		response := requestJSON(t, http.MethodPost, base+"/versions", validRequest(source))
		if response.StatusCode != http.StatusCreated {
			t.Fatalf("version upload status = %d, body = %s", response.StatusCode, readBody(t, response))
		}
		var version VersionSummary
		decodeResponse(t, response, &version)
		versions = append(versions, version)
	}
	response, err := http.Get(base)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusNotFound {
		t.Fatalf("upload-only Worker became active: %d %s", response.StatusCode, readBody(t, response))
	}
	response.Body.Close()

	response = requestJSON(t, http.MethodPost, base+"/deployments", CreateDeploymentRequest{
		Strategy: PercentageStrategy,
		Versions: []DeploymentVersion{
			{VersionID: versions[0].VersionID, Percentage: 50},
			{VersionID: versions[1].VersionID, Percentage: 50},
		},
	})
	if response.StatusCode != http.StatusCreated {
		t.Fatalf("deployment status = %d, body = %s", response.StatusCode, readBody(t, response))
	}
	var worker Worker
	decodeResponse(t, response, &worker)
	if len(worker.Deployment.Versions) != 2 || len(worker.Versions) != 2 || !validDeploymentID(worker.Deployment.ID) {
		t.Fatalf("unexpected deployment response: %#v", worker)
	}
}

func TestAPIRejectsMalformedRequests(t *testing.T) {
	api := NewAPI(mustStore(t, t.TempDir()), 64)
	server := httptest.NewServer(api)
	defer server.Close()
	endpoint := server.URL + "/v1/namespaces/default/workers/hello"

	tests := []struct {
		name        string
		contentType string
		body        string
		status      int
		code        string
	}{
		{name: "content type", contentType: "text/plain", body: `{}`, status: http.StatusUnsupportedMediaType, code: "invalid_content_type"},
		{name: "unknown field", contentType: "application/json", body: `{"unknown":true}`, status: http.StatusBadRequest, code: "invalid_request"},
		{name: "trailing value", contentType: "application/json", body: `{} {}`, status: http.StatusBadRequest, code: "invalid_request"},
		{name: "oversized", contentType: "application/json", body: strings.Repeat(" ", 65) + `{}`, status: http.StatusRequestEntityTooLarge, code: "request_too_large"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request, err := http.NewRequest(http.MethodPut, endpoint, strings.NewReader(test.body))
			if err != nil {
				t.Fatal(err)
			}
			request.Header.Set("Content-Type", test.contentType)
			response, err := http.DefaultClient.Do(request)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			if response.StatusCode != test.status {
				t.Fatalf("status = %d, want %d", response.StatusCode, test.status)
			}
			var responseError apiError
			decodeResponse(t, response, &responseError)
			if responseError.Group != "worker" || responseError.Code != test.code {
				t.Fatalf("error = %s.%s, want worker.%s", responseError.Group, responseError.Code, test.code)
			}
		})
	}
}

func TestAPIRejectsInvalidDeploymentWithoutPublishing(t *testing.T) {
	api := NewAPI(mustStore(t, t.TempDir()), DefaultMaxRequestBytes)
	server := httptest.NewServer(api)
	defer server.Close()
	endpoint := server.URL + "/v1/namespaces/default/workers/hello/deployments"
	versionID := "v_" + strings.Repeat("a", 64)

	response := requestJSON(t, http.MethodPost, endpoint, CreateDeploymentRequest{
		Strategy: PercentageStrategy,
		Versions: []DeploymentVersion{{VersionID: versionID, Percentage: 99.99}},
	})
	if response.StatusCode != http.StatusBadRequest {
		t.Fatalf("invalid percentage status = %d, body = %s", response.StatusCode, readBody(t, response))
	}
	response.Body.Close()

	response = requestJSON(t, http.MethodPost, endpoint, CreateDeploymentRequest{
		Strategy: PercentageStrategy,
		Versions: []DeploymentVersion{{VersionID: versionID, Percentage: 100}},
	})
	if response.StatusCode != http.StatusNotFound {
		t.Fatalf("missing version status = %d, body = %s", response.StatusCode, readBody(t, response))
	}
	response.Body.Close()

	request, err := http.NewRequest(http.MethodPost, endpoint, strings.NewReader(strings.Repeat(" ", (64<<10)+1)))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	response, err = http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized deployment status = %d, body = %s", response.StatusCode, readBody(t, response))
	}
	response.Body.Close()
}

func TestAPIVersionRetentionAndDeploymentHistory(t *testing.T) {
	store, err := NewStoreWithRetention(t.TempDir(), 5)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 9, 1, 2, 0, 0, 0, time.UTC)
	store.now = func() time.Time {
		result := now
		now = now.Add(time.Second)
		return result
	}
	server := httptest.NewServer(NewAPI(store, DefaultMaxRequestBytes))
	defer server.Close()
	base := server.URL + "/v1/namespaces/default/workers/history"

	versions := make([]VersionSummary, 0, 6)
	for index := 1; index <= 6; index++ {
		response := requestJSON(t, http.MethodPost, base+"/versions", validRequest(fmt.Sprintf("export default { fetch() { return new Response('v%d') } }", index)))
		if response.StatusCode != http.StatusCreated {
			t.Fatalf("upload v%d status=%d body=%s", index, response.StatusCode, readBody(t, response))
		}
		var version VersionSummary
		decodeResponse(t, response, &version)
		versions = append(versions, version)
	}

	response, err := http.Get(base + "/versions?page=1&per_page=10")
	if err != nil {
		t.Fatal(err)
	}
	var list VersionList
	decodeResponse(t, response, &list)
	if list.Retention != 5 || len(list.Versions) != 6 || list.Versions[5].Deployable || list.Versions[5].GCStatus != VersionGCStatusCandidateReportOnly {
		t.Fatalf("unexpected retention response: %+v", list)
	}

	response = requestJSON(t, http.MethodPost, base+"/deployments", CreateDeploymentRequest{
		Strategy: PercentageStrategy, Versions: []DeploymentVersion{{VersionID: versions[0].VersionID, Percentage: 100}},
	})
	if response.StatusCode != http.StatusConflict {
		t.Fatalf("expired deployment status=%d body=%s", response.StatusCode, readBody(t, response))
	}
	var responseError apiError
	decodeResponse(t, response, &responseError)
	if responseError.Code != "version_not_deployable" {
		t.Fatalf("expired deployment error=%+v", responseError)
	}

	deploymentIDs := make([]string, 0, 2)
	for index, version := range []VersionSummary{versions[5], versions[1]} {
		annotations := DeploymentAnnotations{}
		if index == 1 {
			annotations = DeploymentAnnotations{Message: "Rollback after smoke test", TriggeredBy: "rollback"}
		}
		response = requestJSON(t, http.MethodPost, base+"/deployments", CreateDeploymentRequest{
			Strategy: PercentageStrategy, Versions: []DeploymentVersion{{VersionID: version.VersionID, Percentage: 100}}, Annotations: annotations,
		})
		if response.StatusCode != http.StatusCreated {
			t.Fatalf("deployment status=%d body=%s", response.StatusCode, readBody(t, response))
		}
		var worker Worker
		decodeResponse(t, response, &worker)
		deploymentIDs = append(deploymentIDs, worker.Deployment.ID)
	}

	response, err = http.Get(base + "/deployments")
	if err != nil {
		t.Fatal(err)
	}
	var history DeploymentList
	decodeResponse(t, response, &history)
	if len(history.Deployments) != 2 || history.Deployments[0].ID != deploymentIDs[1] || !history.Deployments[0].Active ||
		history.Deployments[0].Source != "api" || history.Deployments[0].Annotations.TriggeredBy != "rollback" ||
		history.Deployments[0].Annotations.Message != "Rollback after smoke test" {
		t.Fatalf("unexpected deployment history: %+v", history)
	}
	request, err := http.NewRequest(http.MethodDelete, base+"/deployments/"+deploymentIDs[1], nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err = http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusConflict {
		t.Fatalf("delete active status=%d body=%s", response.StatusCode, readBody(t, response))
	}
	response.Body.Close()
	request, err = http.NewRequest(http.MethodDelete, base+"/deployments/"+deploymentIDs[0], nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err = http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusNoContent {
		t.Fatalf("delete historical status=%d body=%s", response.StatusCode, readBody(t, response))
	}
	response.Body.Close()
	response, err = http.Get(base + "/deployments/" + deploymentIDs[0])
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusNotFound {
		t.Fatalf("deleted history status=%d body=%s", response.StatusCode, readBody(t, response))
	}
	response.Body.Close()
}

func TestAPIRejectsCompatibilityDateNewerThanRuntime(t *testing.T) {
	api := NewAPIWithMaxCompatibilityDate(mustStore(t, t.TempDir()), DefaultMaxRequestBytes, "2026-08-14")
	server := httptest.NewServer(api)
	defer server.Close()

	upload := validRequest("export default {}")
	upload.CompatibilityDate = "2026-08-15"
	response := requestJSON(t, http.MethodPut, server.URL+"/v1/namespaces/default/workers/hello", upload)
	if response.StatusCode != http.StatusBadRequest {
		t.Fatalf("upload status = %d, body = %s", response.StatusCode, readBody(t, response))
	}
	var responseError apiError
	decodeResponse(t, response, &responseError)
	if responseError.Code != "unsupported_compatibility_date" {
		t.Fatalf("error code = %q", responseError.Code)
	}
}

func TestAPINotFoundDoesNotLeakStoragePaths(t *testing.T) {
	root := t.TempDir()
	api := NewAPI(mustStore(t, root), DefaultMaxRequestBytes)
	request := httptest.NewRequest(http.MethodGet, "/v1/namespaces/default/workers/missing", nil)
	response := httptest.NewRecorder()
	api.ServeHTTP(response, request)
	if response.Code != http.StatusNotFound || strings.Contains(response.Body.String(), root) {
		t.Fatalf("unexpected not-found response: %d %s", response.Code, response.Body.String())
	}
}

func requestJSON(t *testing.T, method, url string, value any) *http.Response {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequest(method, url, bytes.NewReader(encoded))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	return response
}

func decodeResponse(t *testing.T, response *http.Response, destination any) {
	t.Helper()
	defer response.Body.Close()
	if err := json.NewDecoder(response.Body).Decode(destination); err != nil {
		t.Fatal(err)
	}
}

func readBody(t *testing.T, response *http.Response) string {
	t.Helper()
	defer response.Body.Close()
	encoded, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}
