package workersapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

const (
	testVersionOne = "v_1111111111111111111111111111111111111111111111111111111111111111"
	testVersionTwo = "v_2222222222222222222222222222222222222222222222222222222222222222"
	testObjectID   = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
)

type fakeBackends struct {
	testing            *testing.T
	mu                 sync.Mutex
	active             string
	version            string
	prepareFails       bool
	exports            map[string]registryExport
	events             []string
	actorCreates       int
	actorDeletes       int
	actorDestroyed     bool
	actorCreateDelay   time.Duration
	gatewayDelay       time.Duration
	gatewayBodyDelay   time.Duration
	gatewayTruncate    bool
	gatewayClose       bool
	hasDOInventory     bool
	actorIdentities    map[string]struct{}
	actorDatacenters   []string
	objects            map[string]registryObject
	objectClaims       int
	executorDispatches int
	executorVersions   []string
	executorTruncate   bool
	availableVersions  []string
	deploymentVersions []DeploymentVersion
	deploymentCursor   string
	deploymentSequence uint64
	deploymentChanged  chan struct{}
	workerReads        int
}

type unavailablePlacementResolver struct{}

func (unavailablePlacementResolver) Check(context.Context) error { return ErrNoAdmissionCapacity }
func (unavailablePlacementResolver) Resolve(context.Context, string) (registryPlacement, error) {
	return registryPlacement{}, ErrNoAdmissionCapacity
}
func (unavailablePlacementResolver) AdmissionCandidates(context.Context) ([]registryPlacement, error) {
	return nil, ErrNoAdmissionCapacity
}

func newTestAPI(t *testing.T, fake *fakeBackends) (*API, *httptest.Server) {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(fake.serveHTTP))
	t.Cleanup(server.Close)
	api, err := NewAPI(Config{
		RegistryURL:    server.URL + "/registry",
		EngineURLs:     []string{server.URL + "/engine"},
		EngineCells:    []string{"actor-bj-a01"},
		EngineCellUIDs: []string{"test-cell-uid"},
		EnginePoolUIDs: []string{"test-pool-uid"},
		Datacenters:    []string{"local-runtime-a"},
		Namespace:      "private-namespace",
		ObjectRouterTokens: []string{
			"fedcba9876543210fedcba9876543210",
		},
		StatelessExecutorURLs:   []string{server.URL + "/executor"},
		StatelessExecutorTokens: []string{"abcdef0123456789abcdef0123456789"},
		PrepareTimeout:          time.Second,
		PlacementResolver:       newStaticPlacementResolver("local-runtime-a"),
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(api.Close)
	return api, server
}

func (f *fakeBackends) serveHTTP(writer http.ResponseWriter, request *http.Request) {
	if request.URL.Path == "/registry/internal/v1/namespaces/private-namespace/deployment-cursor" {
		f.watchDeploymentCursor(writer, request)
		return
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	path := request.URL.Path
	switch {
	case strings.HasPrefix(path, "/executor/internal/v1/workers/counter/versions/") && strings.HasSuffix(path, "/prepare"):
		if request.Header.Get(statelessExecutorTokenHeader) != "abcdef0123456789abcdef0123456789" {
			f.testing.Errorf("unexpected stateless executor token")
			writeJSON(writer, http.StatusUnauthorized, registryErrorEnvelope{Code: "unauthorized", Message: "unauthorized"})
			return
		}
		f.events = append(f.events, "stateless-prepare")
		if f.prepareFails {
			writeJSON(writer, http.StatusUnprocessableEntity, registryErrorEnvelope{Code: "worker_prepare_failed", Message: "bad export"})
			return
		}
		writer.WriteHeader(http.StatusNoContent)
	case strings.HasPrefix(path, "/executor/internal/v1/workers/counter/versions/") && strings.HasSuffix(path, "/dispatch"):
		if request.Header.Get(statelessExecutorTokenHeader) != "abcdef0123456789abcdef0123456789" {
			f.testing.Errorf("unexpected stateless executor token")
			writeJSON(writer, http.StatusUnauthorized, registryErrorEnvelope{Code: "unauthorized", Message: "unauthorized"})
			return
		}
		if request.Header.Get(internalOriginalURLHeader) != "https://counter.example/increment?by=1" {
			f.testing.Errorf("unexpected stateless original URL %q", request.Header.Get(internalOriginalURLHeader))
		}
		if request.Header.Get("X-Rivet-User-Supplied") != "" || request.Header.Get(objectRouterTokenHeader) != "" {
			f.testing.Errorf("untrusted internal header reached stateless executor")
		}
		version := strings.TrimSuffix(strings.TrimPrefix(path, "/executor/internal/v1/workers/counter/versions/"), "/dispatch")
		f.executorDispatches++
		f.executorVersions = append(f.executorVersions, version)
		body, _ := io.ReadAll(request.Body)
		writer.Header().Set("Content-Type", "application/json")
		writer.Header().Set("X-Workers-Error", "must-not-leak")
		if f.executorTruncate {
			writer.Header().Set("Content-Length", "1024")
			writer.WriteHeader(http.StatusOK)
			_, _ = writer.Write([]byte("{"))
			return
		}
		writeJSON(writer, http.StatusCreated, map[string]string{"version": version, "body": string(body)})
	case path == "/registry/readyz" || path == "/engine/health":
		writeJSON(writer, http.StatusOK, map[string]string{"status": "ok"})
	case strings.HasSuffix(path, "/versions") && request.Method == http.MethodPost:
		f.events = append(f.events, "version")
		writeJSON(writer, http.StatusCreated, f.versionResource())
	case strings.Contains(path, "/internal/v1/") && strings.Contains(path, "/versions/") && request.Method == http.MethodGet:
		versionID := path[strings.LastIndex(path, "/")+1:]
		writeJSON(writer, http.StatusOK, registryImmutableVersion{
			VersionID: versionID,
			Content: registryVersionContent{
				Schema:  "rivet-worker-registry/v5",
				Exports: f.exports,
			},
		})
	case strings.Contains(path, "/versions/") && request.Method == http.MethodGet:
		writeJSON(writer, http.StatusOK, f.versionResource())
	case strings.HasSuffix(path, "/versions") && request.Method == http.MethodGet:
		writeJSON(writer, http.StatusOK, map[string]any{"versions": []registryVersion{f.versionResource()}, "page": 1, "per_page": 20})
	case strings.HasSuffix(path, "/workers/counter") && request.Method == http.MethodGet:
		f.workerReads++
		if f.active == "" {
			writeJSON(writer, http.StatusNotFound, registryErrorEnvelope{Code: "not_found", Message: "missing"})
			return
		}
		writeJSON(writer, http.StatusOK, f.workerResource())
	case strings.HasSuffix(path, "/workers") && request.Method == http.MethodGet:
		workers := []registryWorker{}
		if f.active != "" {
			workers = append(workers, f.workerResource())
		}
		writeJSON(writer, http.StatusOK, registryWorkerList{Workers: workers})
	case strings.HasSuffix(path, "/deployments") && request.Method == http.MethodPost:
		f.events = append(f.events, "deployment")
		var body struct {
			Versions             []DeploymentVersion `json:"versions"`
			ExpectedDeploymentID *string             `json:"expected_deployment_id"`
		}
		decodeForTest(f.testing, request.Body, &body)
		current := ""
		if f.active != "" {
			current = deploymentIDForTest(f.active)
		}
		if body.ExpectedDeploymentID != nil && *body.ExpectedDeploymentID != current {
			writeJSON(writer, http.StatusConflict, registryErrorEnvelope{Code: "deployment_conflict", Message: "changed"})
			return
		}
		f.active = body.Versions[0].VersionID
		f.deploymentVersions = append([]DeploymentVersion(nil), body.Versions...)
		f.rotateDeploymentCursorLocked()
		writeJSON(writer, http.StatusCreated, f.workerResource())
	case strings.HasSuffix(path, "/workers/counter") && request.Method == http.MethodDelete:
		if f.hasDOInventory {
			writeJSON(writer, http.StatusConflict, registryErrorEnvelope{Code: "durable_object_namespaces", Message: "associated"})
			return
		}
		f.active = ""
		f.rotateDeploymentCursorLocked()
		writer.WriteHeader(http.StatusNoContent)
	case strings.Contains(path, "/internal/v1/") && strings.Contains(path, "/objects/") && strings.HasSuffix(path, "/activate") && request.Method == http.MethodPost:
		key := path[:len(path)-len("/activate")]
		record := f.objects[key]
		if record.State == "deleted" {
			writeJSON(writer, http.StatusGone, registryErrorEnvelope{Code: "object_deleted", Message: "deleted"})
			return
		}
		var input struct {
			ActorID string `json:"actor_id"`
		}
		decodeForTest(f.testing, request.Body, &input)
		record.ActorID = input.ActorID
		record.State = "active"
		if f.objects == nil {
			f.objects = make(map[string]registryObject)
		}
		f.objects[key] = record
		writeJSON(writer, http.StatusOK, record)
	case strings.Contains(path, "/internal/v1/") && strings.Contains(path, "/objects/") && request.Method == http.MethodPut:
		f.objectClaims++
		if f.objects == nil {
			f.objects = make(map[string]registryObject)
		}
		record, found := f.objects[path]
		if found && record.State == "deleted" {
			writeJSON(writer, http.StatusGone, registryErrorEnvelope{Code: "object_deleted", Message: "deleted"})
			return
		}
		if !found {
			var input claimObjectRequest
			decodeForTest(f.testing, request.Body, &input)
			if input.Placement == nil {
				writeJSON(writer, http.StatusPreconditionRequired, registryErrorEnvelope{Code: "placement_required", Message: "placement required"})
				return
			}
			record.State = "active"
			record.Placement = input.Placement
			f.objects[path] = record
		}
		writeJSON(writer, http.StatusOK, record)
	case strings.Contains(path, "/internal/v1/") && strings.Contains(path, "/objects/") && request.Method == http.MethodDelete:
		if f.objects == nil {
			f.objects = make(map[string]registryObject)
		}
		record := f.objects[path]
		record.State = "deleted"
		f.objects[path] = record
		writeJSON(writer, http.StatusOK, record)
	case path == "/engine/actors" && request.Method == http.MethodPut:
		var body struct {
			Name       string            `json:"name"`
			Key        string            `json:"key"`
			Worker     map[string]string `json:"worker"`
			Datacenter string            `json:"datacenter"`
		}
		decodeForTest(f.testing, request.Body, &body)
		if body.Worker["version_id"] != "" {
			f.events = append(f.events, "prepare-create")
			writeJSON(writer, http.StatusOK, actorCreateResponse{Actor: actorState{ActorID: "probe-actor"}})
			return
		}
		if f.actorCreateDelay > 0 {
			time.Sleep(f.actorCreateDelay)
		}
		f.actorCreates++
		f.actorDatacenters = append(f.actorDatacenters, body.Datacenter)
		if f.actorIdentities == nil {
			f.actorIdentities = make(map[string]struct{})
		}
		f.actorIdentities[body.Name+"\x00"+body.Key] = struct{}{}
		f.events = append(f.events, "object-create")
		writeJSON(writer, http.StatusOK, actorCreateResponse{Actor: actorState{ActorID: "object-actor"}})
	case path == "/engine/actors" && request.Method == http.MethodGet && request.URL.Query().Get("name") != "":
		actors := []actorState{}
		if f.actorCreates != 0 && !f.actorDestroyed {
			actors = append(actors, actorState{ActorID: "object-actor"})
		}
		writeJSON(writer, http.StatusOK, actorListResponse{Actors: actors})
	case path == "/engine/actors" && request.Method == http.MethodGet:
		f.events = append(f.events, "prepare-poll")
		if f.prepareFails {
			now := int64(1)
			writeJSON(writer, http.StatusOK, actorListResponse{Actors: []actorState{{ActorID: "probe-actor", SleepTS: &now, Error: map[string]string{"code": "bad_export"}}}})
			return
		}
		now := int64(1)
		writeJSON(writer, http.StatusOK, actorListResponse{Actors: []actorState{{ActorID: "probe-actor", ConnectableTS: &now}}})
	case path == "/engine/actors/probe-actor" && request.Method == http.MethodDelete:
		f.events = append(f.events, "prepare-delete")
		writer.WriteHeader(http.StatusNoContent)
	case path == "/engine/actors/object-actor" && request.Method == http.MethodDelete:
		f.actorDeletes++
		f.actorDestroyed = true
		writer.WriteHeader(http.StatusNoContent)
	case strings.HasPrefix(path, "/engine/gateway/object-actor"):
		f.gatewayClose = request.Close
		if f.gatewayDelay > 0 {
			time.Sleep(f.gatewayDelay)
		}
		if path != "/engine/gateway/object-actor/" {
			f.testing.Errorf("original URL path escaped the fixed gateway route: %q", path)
		}
		if request.Header.Get(internalOriginalURLHeader) != "https://counter.example/increment?by=1" {
			f.testing.Errorf("unexpected original URL header %q", request.Header.Get(internalOriginalURLHeader))
		}
		if request.Header.Get("X-Rivet-Worker-Version") != "" {
			f.testing.Error("public internal header reached Engine")
		}
		if request.Header.Get(objectRouterTokenHeader) != "" {
			f.testing.Error("Object Router token reached Engine")
		}
		body, _ := io.ReadAll(request.Body)
		writer.Header().Set("X-Workers-Error", "true")
		writer.Header().Set("Content-Type", "application/json")
		if f.gatewayTruncate {
			writer.Header().Set("Content-Length", "1024")
		}
		writer.WriteHeader(http.StatusCreated)
		if flusher, ok := writer.(http.Flusher); ok {
			flusher.Flush()
		}
		if f.gatewayTruncate {
			_, _ = writer.Write([]byte("{"))
			return
		}
		if f.gatewayBodyDelay > 0 {
			time.Sleep(f.gatewayBodyDelay)
		}
		_ = json.NewEncoder(writer).Encode(map[string]any{"path": request.URL.RequestURI(), "body": string(body)})
	default:
		f.testing.Errorf("unexpected upstream request %s %s", request.Method, request.URL.String())
		writeJSON(writer, http.StatusNotFound, registryErrorEnvelope{Code: "not_found", Message: "unexpected"})
	}
}

func (f *fakeBackends) versionResource() registryVersion {
	namespaces := make([]registryDurableObjectNamespace, 0, len(f.exports))
	for className, export := range f.exports {
		namespaces = append(namespaces, registryDurableObjectNamespace{ClassName: className, Storage: export.Storage})
	}
	return registryVersion{
		VersionID:               f.version,
		Digest:                  strings.TrimPrefix(f.version, "v_"),
		CreatedAt:               time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC),
		MainModule:              "main.js",
		ModuleCount:             1,
		CompatibilityDate:       "2026-08-14",
		DurableObjectNamespaces: namespaces,
	}
}

func (f *fakeBackends) deploymentResource() registryDeployment {
	versions := f.deploymentVersions
	if len(versions) == 0 {
		versions = []DeploymentVersion{{VersionID: f.active, Percentage: 100}}
	}
	return registryDeployment{
		ID:         deploymentIDForTest(f.active),
		Worker:     "counter",
		Versions:   versions,
		DeployedAt: time.Date(2026, 9, 1, 12, 1, 0, 0, time.UTC),
	}
}

func deploymentIDForTest(versionID string) string {
	return "d_" + strings.TrimPrefix(versionID, "v_")[:32]
}

func (f *fakeBackends) workerResource() registryWorker {
	versionIDs := f.availableVersions
	if len(versionIDs) == 0 {
		versionIDs = []string{f.version}
	}
	versions := make([]registryVersion, 0, len(versionIDs))
	for _, versionID := range versionIDs {
		version := f.versionResource()
		version.VersionID = versionID
		versions = append(versions, version)
	}
	return registryWorker{
		Name:             "counter",
		Deployment:       f.deploymentResource(),
		Versions:         versions,
		DeploymentCursor: f.deploymentCursorLocked(),
	}
}

func (f *fakeBackends) deploymentCursorLocked() string {
	if f.deploymentCursor == "" {
		if f.active == "" {
			return initialDeploymentCursor
		}
		f.deploymentSequence = 1
		f.deploymentCursor = fmt.Sprintf("c_%032x", f.deploymentSequence)
	}
	return f.deploymentCursor
}

func (f *fakeBackends) rotateDeploymentCursorLocked() {
	f.deploymentSequence++
	if f.deploymentSequence == 0 {
		f.deploymentSequence = 1
	}
	f.deploymentCursor = fmt.Sprintf("c_%032x", f.deploymentSequence)
	if f.deploymentChanged != nil {
		close(f.deploymentChanged)
	}
	f.deploymentChanged = make(chan struct{})
}

func (f *fakeBackends) watchDeploymentCursor(writer http.ResponseWriter, request *http.Request) {
	after := request.URL.Query().Get("after")
	for {
		f.mu.Lock()
		cursor := f.deploymentCursorLocked()
		if cursor != after {
			f.mu.Unlock()
			writeJSON(writer, http.StatusOK, registryDeploymentCursor{Schema: deploymentCursorSchema, Namespace: "private-namespace", Cursor: cursor})
			return
		}
		if f.deploymentChanged == nil {
			f.deploymentChanged = make(chan struct{})
		}
		changed := f.deploymentChanged
		f.mu.Unlock()
		select {
		case <-request.Context().Done():
			return
		case <-changed:
		}
	}
}

func TestPublicResourcesHideTopologyAndPrepareBeforeDeployment(t *testing.T) {
	fake := &fakeBackends{testing: t, version: testVersionOne}
	api, _ := newTestAPI(t, fake)

	versionResponse := performJSON(t, api, http.MethodPost, "/v1/workers/counter/versions", UploadVersionRequest{
		MainModule: "main.js", Modules: map[string]string{"main.js": "export default {}"}, CompatibilityDate: "2026-08-14", DurableObjects: map[string]string{"COUNTER": "Counter"},
	})
	if versionResponse.Code != http.StatusCreated {
		t.Fatalf("upload status = %d: %s", versionResponse.Code, versionResponse.Body.String())
	}
	assertNoTopology(t, versionResponse.Body.Bytes())

	fake.exports = map[string]registryExport{"Counter": {Type: "durable_object", Storage: "sqlite"}}
	deploymentResponse := performJSON(t, api, http.MethodPost, "/v1/workers/counter/deployments", CreateDeploymentRequest{VersionID: testVersionOne})
	if deploymentResponse.Code != http.StatusCreated {
		t.Fatalf("deployment status = %d: %s", deploymentResponse.Code, deploymentResponse.Body.String())
	}
	var deployment Deployment
	decodeForTest(t, deploymentResponse.Body, &deployment)
	if deployment.Object != resourceDeployment || deployment.Worker != "counter" || !deploymentPattern.MatchString(deployment.ID) || deployment.Versions[0].VersionID != testVersionOne {
		t.Fatalf("unexpected deployment: %#v", deployment)
	}
	assertNoTopology(t, deploymentResponse.Body.Bytes())
	fake.mu.Lock()
	events := append([]string(nil), fake.events...)
	fake.mu.Unlock()
	want := []string{"version", "stateless-prepare", "prepare-create", "prepare-poll", "prepare-delete", "deployment"}
	if strings.Join(events, ",") != strings.Join(want, ",") {
		t.Fatalf("event order = %v, want %v", events, want)
	}

	workerResponse := performJSON(t, api, http.MethodGet, "/v1/workers/counter", nil)
	var worker Worker
	decodeForTest(t, workerResponse.Body, &worker)
	if worker.Object != resourceWorker || worker.Name != "counter" || worker.Deployment == nil {
		t.Fatalf("unexpected Worker: %#v", worker)
	}
	assertNoTopology(t, workerResponse.Body.Bytes())
}

func TestDeploymentRejectsStaleExpectedDeployment(t *testing.T) {
	fake := &fakeBackends{testing: t, version: testVersionOne}
	api, _ := newTestAPI(t, fake)
	first := performJSON(t, api, http.MethodPost, "/v1/workers/counter/deployments", CreateDeploymentRequest{VersionID: testVersionOne})
	if first.Code != http.StatusCreated {
		t.Fatalf("first deployment status = %d: %s", first.Code, first.Body.String())
	}
	fake.version = testVersionTwo
	stale := "d_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	response := performJSON(t, api, http.MethodPost, "/v1/workers/counter/deployments", CreateDeploymentRequest{
		VersionID: testVersionTwo, ExpectedDeploymentID: &stale,
	})
	if response.Code != http.StatusConflict {
		t.Fatalf("stale deployment status = %d: %s", response.Code, response.Body.String())
	}
	var failure ErrorResponse
	decodeForTest(t, response.Body, &failure)
	if failure.Error.Code != "deployment_conflict" {
		t.Fatalf("stale deployment error = %#v", failure)
	}
	fake.mu.Lock()
	active := fake.active
	fake.mu.Unlock()
	if active != testVersionOne {
		t.Fatalf("stale deployment replaced active version with %s", active)
	}
}

func TestGradualDeploymentPreparesEveryVersionAndPublishesExactWeights(t *testing.T) {
	fake := &fakeBackends{
		testing: t, version: testVersionOne,
		availableVersions: []string{testVersionOne, testVersionTwo},
	}
	api, _ := newTestAPI(t, fake)
	targets := []DeploymentVersion{
		{VersionID: testVersionOne, Percentage: 90},
		{VersionID: testVersionTwo, Percentage: 10},
	}
	response := performJSON(t, api, http.MethodPost, "/v1/workers/counter/deployments", CreateDeploymentRequest{Versions: targets})
	if response.Code != http.StatusCreated {
		t.Fatalf("gradual deployment status = %d: %s", response.Code, response.Body.String())
	}
	var deployment Deployment
	decodeForTest(t, response.Body, &deployment)
	if !sameDeploymentTargets(deployment.Versions, targets) {
		t.Fatalf("deployment targets = %+v, want %+v", deployment.Versions, targets)
	}
	fake.mu.Lock()
	events := append([]string(nil), fake.events...)
	fake.mu.Unlock()
	if strings.Join(events, ",") != "stateless-prepare,stateless-prepare,deployment" {
		t.Fatalf("gradual deployment did not prepare both Versions first: %v", events)
	}

	invalid := performJSON(t, api, http.MethodPost, "/v1/workers/counter/deployments", CreateDeploymentRequest{
		Versions: []DeploymentVersion{
			{VersionID: testVersionOne, Percentage: 60},
			{VersionID: testVersionTwo, Percentage: 39},
		},
	})
	if invalid.Code != http.StatusBadRequest {
		t.Fatalf("invalid rollout status = %d: %s", invalid.Code, invalid.Body.String())
	}
}

func TestRejectedPreparePreservesActiveDeploymentAndUsesStableError(t *testing.T) {
	fake := &fakeBackends{testing: t, version: testVersionTwo, active: testVersionOne, prepareFails: true, exports: map[string]registryExport{"MissingCounter": {Type: "durable_object", Storage: "sqlite"}}}
	api, _ := newTestAPI(t, fake)
	response := performJSON(t, api, http.MethodPost, "/v1/workers/counter/deployments", CreateDeploymentRequest{VersionID: testVersionTwo})
	if response.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d: %s", response.Code, response.Body.String())
	}
	var envelope ErrorResponse
	decodeForTest(t, response.Body, &envelope)
	if envelope.Error.Code != "worker_prepare_failed" || envelope.Error.Retryable || !strings.HasPrefix(envelope.Error.RequestID, "req_") {
		t.Fatalf("unexpected error: %#v", envelope)
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if fake.active != testVersionOne {
		t.Fatalf("active version changed to %s", fake.active)
	}
	if contains(fake.events, "deployment") || !contains(fake.events, "stateless-prepare") || contains(fake.events, "prepare-create") {
		t.Fatalf("unexpected events: %v", fake.events)
	}
}

func TestActiveVersionDeploymentIsIdempotent(t *testing.T) {
	fake := &fakeBackends{testing: t, version: testVersionOne, active: testVersionOne}
	api, _ := newTestAPI(t, fake)
	response := performJSON(t, api, http.MethodPost, "/v1/workers/counter/deployments", CreateDeploymentRequest{VersionID: testVersionOne})
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", response.Code, response.Body.String())
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if len(fake.events) != 0 {
		t.Fatalf("idempotent deployment touched runtime: %v", fake.events)
	}
}

func TestDeploymentPrepareOverloadFailsFastWithoutCanary(t *testing.T) {
	fake := &fakeBackends{testing: t, version: testVersionOne}
	api, _ := newTestAPI(t, fake)
	for range cap(api.preparePermits) {
		api.preparePermits <- struct{}{}
	}

	response := performJSON(t, api, http.MethodPost, "/v1/workers/counter/deployments", CreateDeploymentRequest{VersionID: testVersionOne})
	if response.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d: %s", response.Code, response.Body.String())
	}
	if response.Header().Get("Retry-After") != "1" {
		t.Fatalf("Retry-After = %q", response.Header().Get("Retry-After"))
	}
	var envelope ErrorResponse
	decodeForTest(t, response.Body, &envelope)
	if envelope.Error.Code != "prepare_overloaded" || !envelope.Error.Retryable {
		t.Fatalf("unexpected error: %#v", envelope)
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if len(fake.events) != 0 {
		t.Fatalf("overloaded prepare touched runtime: %v", fake.events)
	}
}

func TestObjectResourceAndFetchUseOnePublicEndpoint(t *testing.T) {
	fake := &fakeBackends{testing: t, version: testVersionOne, active: testVersionOne, exports: map[string]registryExport{"Counter": {Type: "durable_object", Storage: "sqlite"}}}
	api, _ := newTestAPI(t, fake)
	objectPath := "/v1/workers/counter/objects/Counter/" + testObjectID
	put := performJSON(t, api, http.MethodPut, objectPath, nil)
	if put.Code != http.StatusOK {
		t.Fatalf("put status = %d: %s", put.Code, put.Body.String())
	}
	var object ObjectRef
	decodeForTest(t, put.Body, &object)
	if object.Object != resourceObject || object.ID != testObjectID || object.ClassName != "Counter" {
		t.Fatalf("unexpected ObjectRef: %#v", object)
	}

	request := httptest.NewRequest(http.MethodPost, objectPath+"/fetch", bytes.NewBufferString("payload"))
	request.Header.Set(publicOriginalURLHeader, "https://counter.example/increment?by=1")
	request.Header.Set("X-Rivet-Worker-Version", "attacker-controlled")
	response := httptest.NewRecorder()
	api.ServeHTTP(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("fetch status = %d: %s", response.Code, response.Body.String())
	}
	if response.Header().Get("X-Workers-Error") != "" {
		t.Fatal("Worker response spoofed the platform error marker")
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if fake.actorCreates != 1 {
		t.Fatalf("actor creates = %d, want 1", fake.actorCreates)
	}
	if !fake.gatewayClose {
		t.Fatal("Worker fetch reused an Engine keep-alive connection")
	}
}

func TestInternalObjectRouterRequiresCapabilityAndForwardsFetch(t *testing.T) {
	fake := &fakeBackends{testing: t, version: testVersionOne, active: testVersionOne, exports: map[string]registryExport{"Counter": {Type: "durable_object", Storage: "sqlite"}}}
	api, _ := newTestAPI(t, fake)
	path := "/internal/v1/workers/counter/objects/Counter/" + testObjectID + "/fetch"

	publicRequest := httptest.NewRequest(http.MethodPost, path, strings.NewReader("payload"))
	publicRequest.Header.Set(internalOriginalURLHeader, "https://counter.example/increment?by=1")
	publicRequest.Header.Set(objectRouterTokenHeader, "fedcba9876543210fedcba9876543210")
	publicResponse := httptest.NewRecorder()
	api.ServeHTTP(publicResponse, publicRequest)
	if publicResponse.Code != http.StatusNotFound {
		t.Fatalf("public listener exposed internal route: status = %d", publicResponse.Code)
	}

	unauthorized := httptest.NewRequest(http.MethodPost, path, strings.NewReader("payload"))
	unauthorized.Header.Set(internalOriginalURLHeader, "https://counter.example/increment?by=1")
	unauthorizedResponse := httptest.NewRecorder()
	api.InternalHandler().ServeHTTP(unauthorizedResponse, unauthorized)
	if unauthorizedResponse.Code != http.StatusNotFound {
		t.Fatalf("unauthorized internal status = %d", unauthorizedResponse.Code)
	}
	fake.mu.Lock()
	if fake.objectClaims != 0 || fake.actorCreates != 0 {
		fake.mu.Unlock()
		t.Fatal("unauthorized Object Router request reached placement")
	}
	fake.mu.Unlock()

	authorized := httptest.NewRequest(http.MethodPost, path, strings.NewReader("payload"))
	authorized.Header.Set(internalOriginalURLHeader, "https://counter.example/increment?by=1")
	authorized.Header.Set(objectRouterTokenHeader, "fedcba9876543210fedcba9876543210")
	authorizedResponse := httptest.NewRecorder()
	api.InternalHandler().ServeHTTP(authorizedResponse, authorized)
	if authorizedResponse.Code != http.StatusCreated {
		t.Fatalf("authorized status = %d: %s", authorizedResponse.Code, authorizedResponse.Body.String())
	}
	if authorizedResponse.Header().Get("X-Workers-Error") != "" {
		t.Fatal("Worker response spoofed the platform error marker")
	}
}

func TestConcurrentDurableObjectMissesSingleFlight(t *testing.T) {
	fake := &fakeBackends{
		testing: t, version: testVersionOne, active: testVersionOne,
		exports:          map[string]registryExport{"Counter": {Type: "durable_object", Storage: "sqlite"}},
		actorCreateDelay: 50 * time.Millisecond,
	}
	api, _ := newTestAPI(t, fake)
	const concurrency = 100
	start := make(chan struct{})
	errors := make(chan string, concurrency)
	var wait sync.WaitGroup
	for range concurrency {
		wait.Add(1)
		go func() {
			defer wait.Done()
			<-start
			request := httptest.NewRequest(http.MethodPost, "/v1/workers/counter/objects/Counter/"+testObjectID+"/fetch", strings.NewReader("payload"))
			request.Header.Set(publicOriginalURLHeader, "https://counter.example/increment?by=1")
			response := httptest.NewRecorder()
			api.ServeHTTP(response, request)
			if response.Code != http.StatusCreated {
				errors <- fmt.Sprintf("status=%d body=%s", response.Code, response.Body.String())
			}
		}()
	}
	close(start)
	wait.Wait()
	close(errors)
	for failure := range errors {
		t.Fatal(failure)
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if fake.objectClaims != 2 {
		t.Fatalf("Registry claims = %d, want one lookup and one placement commit", fake.objectClaims)
	}
	if fake.actorCreates != 1 {
		t.Fatalf("Actor creates = %d, want 1", fake.actorCreates)
	}
}

func TestDurableObjectCacheHitBypassesRegistryClaim(t *testing.T) {
	fake := &fakeBackends{testing: t, version: testVersionOne, active: testVersionOne, exports: map[string]registryExport{"Counter": {Type: "durable_object", Storage: "sqlite"}}}
	api, _ := newTestAPI(t, fake)
	objectPath := "/v1/workers/counter/objects/Counter/" + testObjectID
	for range 3 {
		request := httptest.NewRequest(http.MethodPost, objectPath+"/fetch", strings.NewReader("payload"))
		request.Header.Set(publicOriginalURLHeader, "https://counter.example/increment?by=1")
		response := httptest.NewRecorder()
		api.ServeHTTP(response, request)
		if response.Code != http.StatusCreated {
			t.Fatalf("fetch status = %d: %s", response.Code, response.Body.String())
		}
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	// The first request performs an unplaced lookup followed by the atomic
	// placement claim. Stable requests must not touch Registry again.
	if fake.objectClaims != 2 {
		t.Fatalf("Registry claims = %d, want 2", fake.objectClaims)
	}
	if fake.actorCreates != 1 {
		t.Fatalf("Actor creates = %d, want 1", fake.actorCreates)
	}
}

func TestMetricsExposeBoundedRouterAndDispatchState(t *testing.T) {
	fake := &fakeBackends{testing: t, version: testVersionOne, active: testVersionOne, exports: map[string]registryExport{"Counter": {Type: "durable_object", Storage: "sqlite"}}}
	api, _ := newTestAPI(t, fake)
	objectPath := "/v1/workers/counter/objects/Counter/" + testObjectID + "/fetch"
	for range 2 {
		request := httptest.NewRequest(http.MethodPost, objectPath, strings.NewReader("payload"))
		request.Header.Set(publicOriginalURLHeader, "https://counter.example/increment?by=1")
		response := httptest.NewRecorder()
		api.ServeHTTP(response, request)
		if response.Code != http.StatusCreated {
			t.Fatalf("Object fetch status = %d: %s", response.Code, response.Body.String())
		}
	}
	dispatch := httptest.NewRequest(http.MethodGet, "/v1/workers/counter/dispatch", nil)
	dispatch.Header.Set(publicOriginalURLHeader, "https://counter.example/increment?by=1")
	dispatchResponse := httptest.NewRecorder()
	api.ServeHTTP(dispatchResponse, dispatch)
	if dispatchResponse.Code != http.StatusCreated {
		t.Fatalf("dispatch status = %d: %s", dispatchResponse.Code, dispatchResponse.Body.String())
	}

	metricsResponse := httptest.NewRecorder()
	api.ServeHTTP(metricsResponse, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if metricsResponse.Code != http.StatusOK {
		t.Fatalf("metrics status = %d: %s", metricsResponse.Code, metricsResponse.Body.String())
	}
	metrics := metricsResponse.Body.String()
	for _, expected := range []string{
		"worker_dispatch_requests_total",
		"workers_api_routing_requests_total",
		"workers_api_routing_request_duration_seconds",
		"process_cpu_seconds_total",
		"process_resident_memory_bytes",
		"workers_api_routing_requests_in_flight",
		"object_router_requests_total",
		"object_router_request_duration_seconds",
		"object_router_cache_requests_total",
		"object_router_registry_seconds",
		"object_router_route_revision",
		"object_router_inflight",
		"object_router_indeterminate_total",
	} {
		if !strings.Contains(metrics, expected) {
			t.Fatalf("metrics omitted %s:\n%s", expected, metrics)
		}
	}
	if strings.Contains(metrics, testObjectID) || strings.Contains(metrics, "object-actor") {
		t.Fatal("metrics leaked an Object or Actor identity as a label")
	}
}

func TestDurableObjectCacheEvictionFallsBackToRegistry(t *testing.T) {
	fake := &fakeBackends{testing: t, version: testVersionOne, active: testVersionOne, exports: map[string]registryExport{"Counter": {Type: "durable_object", Storage: "sqlite"}}}
	api, _ := newTestAPI(t, fake)
	api.objectRouter = newObjectRouter(api, 1, time.Hour, defaultObjectMissCapacity)
	fetch := func(objectID string) {
		request := httptest.NewRequest(http.MethodPost, "/v1/workers/counter/objects/Counter/"+objectID+"/fetch", strings.NewReader("payload"))
		request.Header.Set(publicOriginalURLHeader, "https://counter.example/increment?by=1")
		response := httptest.NewRecorder()
		api.ServeHTTP(response, request)
		if response.Code != http.StatusCreated {
			t.Fatalf("fetch status = %d: %s", response.Code, response.Body.String())
		}
	}
	secondObjectID := strings.Repeat("b", 64)
	fetch(testObjectID)
	fetch(secondObjectID)
	fetch(testObjectID)
	fake.mu.Lock()
	defer fake.mu.Unlock()
	// Two claims create each record. Re-reading the evicted first record is one
	// read/write ClaimObject call returning its already activated Actor ID.
	if fake.objectClaims != 5 {
		t.Fatalf("Registry claims after eviction = %d, want 5", fake.objectClaims)
	}
	if fake.actorCreates != 2 {
		t.Fatalf("Actor creates after eviction = %d, want 2", fake.actorCreates)
	}
}

func TestEngineDialRetriesOnlyBeforeAConnectionExists(t *testing.T) {
	attempts := 0
	peerClosed := make(chan struct{})
	dial := retryEngineDialContext(func(context.Context, string, string) (net.Conn, error) {
		attempts++
		if attempts < 3 {
			return nil, &net.OpError{Op: "dial", Net: "tcp", Err: syscall.ECONNREFUSED}
		}
		client, peer := net.Pipe()
		go func() {
			_ = peer.Close()
			close(peerClosed)
		}()
		return client, nil
	})
	connection, err := dial(context.Background(), "tcp", "engine.invalid:6420")
	if err != nil {
		t.Fatal(err)
	}
	_ = connection.Close()
	<-peerClosed
	if attempts != 3 {
		t.Fatalf("dial attempts = %d, want 3", attempts)
	}

	attempts = 0
	reset := &net.OpError{Op: "read", Net: "tcp", Err: syscall.ECONNRESET}
	_, err = retryEngineDialContext(func(context.Context, string, string) (net.Conn, error) {
		attempts++
		return nil, reset
	})(context.Background(), "tcp", "engine.invalid:6420")
	if !errors.Is(err, syscall.ECONNRESET) || attempts != 1 {
		t.Fatalf("post-connect error was retried: attempts=%d error=%v", attempts, err)
	}
}

func TestNewAgentReadyDeadlineIsIndependentFromConversationFetch(t *testing.T) {
	t.Run("new Agent fails closed at the ready deadline", func(t *testing.T) {
		fake := &fakeBackends{
			testing:          t,
			version:          testVersionOne,
			active:           testVersionOne,
			actorCreateDelay: 100 * time.Millisecond,
		}
		server := httptest.NewServer(http.HandlerFunc(fake.serveHTTP))
		defer server.Close()
		api, err := NewAPI(Config{
			RegistryURL:       server.URL + "/registry",
			EngineURLs:        []string{server.URL + "/engine"},
			EngineCells:       []string{"actor-bj-a01"},
			EngineCellUIDs:    []string{"test-cell-uid"},
			EnginePoolUIDs:    []string{"test-pool-uid"},
			Datacenters:       []string{"local-runtime-a"},
			ActorReadyTimeout: 20 * time.Millisecond,
			RequestTimeout:    time.Second,
			PlacementResolver: newStaticPlacementResolver("local-runtime-a"),
		})
		if err != nil {
			t.Fatal(err)
		}
		started := time.Now()
		response := performJSON(
			t,
			api,
			http.MethodPut,
			"/v1/workers/counter/objects/Counter/"+testObjectID,
			nil,
		)
		if response.Code != http.StatusGatewayTimeout || time.Since(started) >= 100*time.Millisecond {
			t.Fatalf("ready response status=%d duration=%s body=%s", response.Code, time.Since(started), response.Body.String())
		}
		var failure ErrorResponse
		decodeForTest(t, response.Body, &failure)
		if failure.Error.Code != "actor_ready_timeout" || !failure.Error.Retryable {
			t.Fatalf("ready failure = %#v", failure)
		}
	})

	t.Run("conversation is not capped by the control timeout", func(t *testing.T) {
		fake := &fakeBackends{
			testing:      t,
			version:      testVersionOne,
			active:       testVersionOne,
			gatewayDelay: 50 * time.Millisecond,
		}
		server := httptest.NewServer(http.HandlerFunc(fake.serveHTTP))
		defer server.Close()
		api, err := NewAPI(Config{
			RegistryURL:       server.URL + "/registry",
			EngineURLs:        []string{server.URL + "/engine"},
			EngineCells:       []string{"actor-bj-a01"},
			EngineCellUIDs:    []string{"test-cell-uid"},
			EnginePoolUIDs:    []string{"test-pool-uid"},
			Datacenters:       []string{"local-runtime-a"},
			ActorReadyTimeout: time.Second,
			RequestTimeout:    10 * time.Millisecond,
			PlacementResolver: newStaticPlacementResolver("local-runtime-a"),
		})
		if err != nil {
			t.Fatal(err)
		}
		objectPath := "/v1/workers/counter/objects/Counter/" + testObjectID
		if response := performJSON(t, api, http.MethodPut, objectPath, nil); response.Code != http.StatusOK {
			t.Fatalf("put status = %d: %s", response.Code, response.Body.String())
		}
		request := httptest.NewRequest(http.MethodPost, objectPath+"/fetch", nil)
		request.Header.Set(publicOriginalURLHeader, "https://counter.example/increment?by=1")
		response := httptest.NewRecorder()
		api.ServeHTTP(response, request)
		if response.Code != http.StatusCreated {
			t.Fatalf("long fetch status = %d: %s", response.Code, response.Body.String())
		}
	})

	t.Run("slow response headers fail fast without limiting a streaming body", func(t *testing.T) {
		fake := &fakeBackends{
			testing:      t,
			version:      testVersionOne,
			active:       testVersionOne,
			gatewayDelay: 50 * time.Millisecond,
		}
		server := httptest.NewServer(http.HandlerFunc(fake.serveHTTP))
		defer server.Close()
		api, err := NewAPI(Config{
			RegistryURL:                server.URL + "/registry",
			EngineURLs:                 []string{server.URL + "/engine"},
			EngineCells:                []string{"actor-bj-a01"},
			EngineCellUIDs:             []string{"test-cell-uid"},
			EnginePoolUIDs:             []string{"test-pool-uid"},
			Datacenters:                []string{"local-runtime-a"},
			ActorReadyTimeout:          time.Second,
			RequestTimeout:             time.Second,
			FetchResponseHeaderTimeout: 10 * time.Millisecond,
			PlacementResolver:          newStaticPlacementResolver("local-runtime-a"),
		})
		if err != nil {
			t.Fatal(err)
		}
		objectPath := "/v1/workers/counter/objects/Counter/" + testObjectID
		if response := performJSON(t, api, http.MethodPut, objectPath, nil); response.Code != http.StatusOK {
			t.Fatalf("put status = %d: %s", response.Code, response.Body.String())
		}
		request := httptest.NewRequest(http.MethodPost, objectPath+"/fetch", nil)
		request.Header.Set(publicOriginalURLHeader, "https://counter.example/increment?by=1")
		response := httptest.NewRecorder()
		started := time.Now()
		api.ServeHTTP(response, request)
		if response.Code != http.StatusBadGateway || time.Since(started) >= 50*time.Millisecond {
			t.Fatalf("slow-header status=%d duration=%s body=%s", response.Code, time.Since(started), response.Body.String())
		}
		var failure ErrorResponse
		decodeForTest(t, response.Body, &failure)
		if failure.Error.Code != "indeterminate_result" || failure.Error.Retryable {
			t.Fatalf("slow-header failure = %#v", failure)
		}

		// ResponseHeaderTimeout returns before the synthetic upstream handler
		// finishes its sleep. Let that handler release the fake's serialization
		// lock before changing the scenario to a slow response body.
		time.Sleep(60 * time.Millisecond)
		fake.mu.Lock()
		fake.gatewayDelay = 0
		fake.gatewayBodyDelay = 50 * time.Millisecond
		fake.mu.Unlock()
		response = httptest.NewRecorder()
		started = time.Now()
		api.ServeHTTP(response, request)
		if response.Code != http.StatusCreated || time.Since(started) < 50*time.Millisecond {
			t.Fatalf("streaming-body status=%d duration=%s body=%s", response.Code, time.Since(started), response.Body.String())
		}
	})
}

func TestDeleteObjectIsIdempotentAndTombstonePreventsRecreation(t *testing.T) {
	fake := &fakeBackends{testing: t, version: testVersionOne, active: testVersionOne, exports: map[string]registryExport{"Counter": {Type: "durable_object", Storage: "sqlite"}}}
	api, _ := newTestAPI(t, fake)
	objectPath := "/v1/workers/counter/objects/Counter/" + testObjectID
	if response := performJSON(t, api, http.MethodPut, objectPath, nil); response.Code != http.StatusOK {
		t.Fatalf("put status = %d: %s", response.Code, response.Body.String())
	}
	for attempt := range 2 {
		response := performJSON(t, api, http.MethodDelete, objectPath, nil)
		if response.Code != http.StatusNoContent {
			t.Fatalf("delete %d status = %d: %s", attempt+1, response.Code, response.Body.String())
		}
	}
	request := httptest.NewRequest(http.MethodPost, objectPath+"/fetch", strings.NewReader("payload"))
	request.Header.Set(publicOriginalURLHeader, "https://counter.example/increment?by=1")
	response := httptest.NewRecorder()
	api.ServeHTTP(response, request)
	if response.Code != http.StatusGone {
		t.Fatalf("fetch after delete status = %d, want 410: %s", response.Code, response.Body.String())
	}
	var failure ErrorResponse
	decodeForTest(t, response.Body, &failure)
	if failure.Error.Code != "object_deleted" || failure.Error.Retryable {
		t.Fatalf("fetch after delete error = %#v", failure)
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if fake.actorCreates != 1 || fake.actorDeletes != 2 {
		t.Fatalf("Actor lifecycle creates=%d deletes=%d", fake.actorCreates, fake.actorDeletes)
	}
}

func TestDeleteNeverClaimedObjectDoesNotRequireEnginePlacement(t *testing.T) {
	fake := &fakeBackends{testing: t, version: testVersionOne, active: testVersionOne, exports: map[string]registryExport{"Counter": {Type: "durable_object", Storage: "sqlite"}}}
	api, _ := newTestAPI(t, fake)
	objectPath := "/v1/workers/counter/objects/Counter/" + testObjectID

	response := performJSON(t, api, http.MethodDelete, objectPath, nil)
	if response.Code != http.StatusNoContent {
		t.Fatalf("delete unclaimed Object status = %d: %s", response.Code, response.Body.String())
	}
	fake.mu.Lock()
	deletes := fake.actorDeletes
	fake.mu.Unlock()
	if deletes != 0 {
		t.Fatalf("unclaimed Object caused %d Actor deletes", deletes)
	}

	request := httptest.NewRequest(http.MethodPost, objectPath+"/fetch", nil)
	request.Header.Set(publicOriginalURLHeader, "https://counter.example/increment?by=1")
	response = httptest.NewRecorder()
	api.ServeHTTP(response, request)
	if response.Code != http.StatusGone {
		t.Fatalf("fetch after delete status = %d, want 410: %s", response.Code, response.Body.String())
	}
}

func TestInvalidRequestsAlwaysReturnPublicErrorShape(t *testing.T) {
	fake := &fakeBackends{testing: t, version: testVersionOne}
	api, _ := newTestAPI(t, fake)
	request := httptest.NewRequest(http.MethodPost, "/v1/workers/INVALID/deployments", strings.NewReader(`{}`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Request-ID", "client-request_1")
	response := httptest.NewRecorder()
	api.ServeHTTP(response, request)
	var envelope ErrorResponse
	decodeForTest(t, response.Body, &envelope)
	if response.Code != http.StatusBadRequest || envelope.Error.Code != "invalid_worker" || envelope.Error.RequestID != "client-request_1" {
		t.Fatalf("unexpected response: status=%d body=%#v", response.Code, envelope)
	}
	assertNoTopology(t, response.Body.Bytes())
}

func TestDeleteWorkerWithDurableObjectInventoryReturnsStableConflict(t *testing.T) {
	fake := &fakeBackends{testing: t, version: testVersionOne, active: testVersionOne, hasDOInventory: true}
	api, _ := newTestAPI(t, fake)
	response := performJSON(t, api, http.MethodDelete, "/v1/workers/counter", nil)
	if response.Code != http.StatusConflict {
		t.Fatalf("delete status = %d: %s", response.Code, response.Body.String())
	}
	var failure ErrorResponse
	decodeForTest(t, response.Body, &failure)
	if failure.Error.Code != "worker_has_durable_objects" || failure.Error.Retryable {
		t.Fatalf("unexpected delete error: %#v", failure)
	}
	if fake.active != testVersionOne {
		t.Fatal("blocked delete removed the active Worker")
	}
}

func TestAPIReplicaRestartConvergesAndStaleCacheCannotBypassDelete(t *testing.T) {
	fake := &fakeBackends{testing: t, version: testVersionOne, active: testVersionOne}
	first, server := newTestAPI(t, fake)
	second, err := NewAPI(Config{
		RegistryURL:             server.URL + "/registry",
		EngineURLs:              []string{server.URL + "/engine"},
		EngineCells:             []string{"actor-bj-a01"},
		EngineCellUIDs:          []string{"test-cell-uid"},
		EnginePoolUIDs:          []string{"test-pool-uid"},
		Datacenters:             []string{"local-runtime-a"},
		Namespace:               "private-namespace",
		StatelessExecutorURLs:   []string{server.URL + "/executor"},
		StatelessExecutorTokens: []string{"abcdef0123456789abcdef0123456789"},
		PlacementResolver:       newStaticPlacementResolver("local-runtime-a"),
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(second.Close)

	invoke := func(handler http.Handler) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodPost, "/v1/workers/counter/dispatch", strings.NewReader("payload"))
		request.Header.Set(publicOriginalURLHeader, "https://counter.example/increment?by=1")
		request.Header.Set("X-Rivet-User-Supplied", "must-be-stripped")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		return response
	}
	if response := invoke(first); response.Code != http.StatusCreated {
		t.Fatalf("first replica fetch = %d: %s", response.Code, response.Body.String())
	} else if response.Header().Get("X-Workers-Error") != "" {
		t.Fatalf("internal response header leaked to client: %q", response.Header().Get("X-Workers-Error"))
	}
	if response := invoke(second); response.Code != http.StatusCreated {
		t.Fatalf("replacement replica fetch = %d: %s", response.Code, response.Body.String())
	}
	if response := performJSON(t, second, http.MethodDelete, "/v1/workers/counter", nil); response.Code != http.StatusNoContent {
		t.Fatalf("delete from second replica = %d: %s", response.Code, response.Body.String())
	}
	stale := invoke(first)
	if stale.Code != http.StatusNotFound {
		t.Fatalf("stale replica fetch = %d, want 404: %s", stale.Code, stale.Body.String())
	}
	var failure ErrorResponse
	decodeForTest(t, stale.Body, &failure)
	if failure.Error.Code != "not_found" {
		t.Fatalf("stale replica error = %#v", failure)
	}
	fake.mu.Lock()
	dispatches := fake.executorDispatches
	versions := append([]string(nil), fake.executorVersions...)
	actorCreates := fake.actorCreates
	objectClaims := fake.objectClaims
	fake.mu.Unlock()
	if dispatches != 2 || strings.Join(versions, ",") != testVersionOne+","+testVersionOne {
		t.Fatalf("stateless dispatches=%d versions=%v", dispatches, versions)
	}
	if actorCreates != 0 || objectClaims != 0 {
		t.Fatalf("stateless dispatch entered durable path: actorCreates=%d objectClaims=%d", actorCreates, objectClaims)
	}
}

func TestStatelessStreamingBodyFailureAbortsThePublicResponse(t *testing.T) {
	fake := &fakeBackends{
		testing: t, version: testVersionOne, active: testVersionOne,
		executorTruncate: true,
	}
	api, _ := newTestAPI(t, fake)
	request := httptest.NewRequest(http.MethodGet, "/v1/workers/counter/dispatch", nil)
	request.Header.Set(publicOriginalURLHeader, "https://counter.example/increment?by=1")
	response := httptest.NewRecorder()
	var recovered any
	func() {
		defer func() { recovered = recover() }()
		api.ServeHTTP(response, request)
	}()
	if recovered != http.ErrAbortHandler {
		t.Fatalf("stream failure recovered %#v, want http.ErrAbortHandler", recovered)
	}
	if response.Code != http.StatusOK || response.Body.String() != "{" {
		t.Fatalf("partial response status=%d body=%q", response.Code, response.Body.String())
	}
}

func TestDurableStreamingBodyFailureAbortsThePublicResponse(t *testing.T) {
	fake := &fakeBackends{
		testing: t, version: testVersionOne, active: testVersionOne,
		exports:         map[string]registryExport{"Counter": {Type: "durable_object", Storage: "sqlite"}},
		gatewayTruncate: true,
	}
	api, _ := newTestAPI(t, fake)
	objectPath := "/v1/workers/counter/objects/Counter/" + testObjectID
	if response := performJSON(t, api, http.MethodPut, objectPath, nil); response.Code != http.StatusOK {
		t.Fatalf("put status = %d: %s", response.Code, response.Body.String())
	}
	request := httptest.NewRequest(http.MethodPost, objectPath+"/fetch", nil)
	request.Header.Set(publicOriginalURLHeader, "https://counter.example/increment?by=1")
	response := httptest.NewRecorder()
	var recovered any
	func() {
		defer func() { recovered = recover() }()
		api.ServeHTTP(response, request)
	}()
	if recovered != http.ErrAbortHandler {
		t.Fatalf("stream failure recovered %#v, want http.ErrAbortHandler", recovered)
	}
	if response.Code != http.StatusCreated || response.Body.String() != "{" {
		t.Fatalf("partial response status=%d body=%q", response.Code, response.Body.String())
	}
}

func TestStatelessDispatchUsesCursorInvalidatedDeploymentCache(t *testing.T) {
	fake := &fakeBackends{
		testing: t, version: testVersionOne, active: testVersionOne,
		availableVersions: []string{testVersionOne, testVersionTwo},
	}
	api, _ := newTestAPI(t, fake)
	api.startDeploymentWatcher()
	waitDeploymentCacheState(t, api, func(cursor string, synced bool) bool {
		return synced && cursor != initialDeploymentCursor
	})

	dispatch := func() string {
		request := httptest.NewRequest(http.MethodPost, "/v1/workers/counter/dispatch", strings.NewReader("payload"))
		request.Header.Set(publicOriginalURLHeader, "https://counter.example/increment?by=1")
		response := httptest.NewRecorder()
		api.ServeHTTP(response, request)
		if response.Code != http.StatusCreated {
			t.Fatalf("dispatch status = %d: %s", response.Code, response.Body.String())
		}
		var body map[string]string
		decodeForTest(t, response.Body, &body)
		return body["version"]
	}
	if got := dispatch(); got != testVersionOne {
		t.Fatalf("first selected Version = %s", got)
	}
	if got := dispatch(); got != testVersionOne {
		t.Fatalf("cached selected Version = %s", got)
	}
	fake.mu.Lock()
	if fake.workerReads != 1 {
		reads := fake.workerReads
		fake.mu.Unlock()
		t.Fatalf("Registry Worker reads = %d, want 1", reads)
	}
	fake.active = testVersionTwo
	fake.deploymentVersions = []DeploymentVersion{{VersionID: testVersionTwo, Percentage: 100}}
	fake.rotateDeploymentCursorLocked()
	changedCursor := fake.deploymentCursor
	fake.mu.Unlock()
	waitDeploymentCacheState(t, api, func(cursor string, synced bool) bool {
		return synced && cursor == changedCursor && api.deployments.Len() == 0
	})
	if got := dispatch(); got != testVersionTwo {
		t.Fatalf("post-invalidation selected Version = %s", got)
	}
	if got := dispatch(); got != testVersionTwo {
		t.Fatalf("post-invalidation cached Version = %s", got)
	}
	fake.mu.Lock()
	reads := fake.workerReads
	fake.mu.Unlock()
	if reads != 2 {
		t.Fatalf("Registry Worker reads after Deployment change = %d, want 2", reads)
	}
}

func waitDeploymentCacheState(t *testing.T, api *API, predicate func(string, bool) bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		_, cursor, synced := api.deployments.Fence()
		if predicate(cursor, synced) {
			return
		}
		time.Sleep(time.Millisecond)
	}
	_, cursor, synced := api.deployments.Fence()
	t.Fatalf("deployment cache state did not converge: cursor=%s synced=%t entries=%d", cursor, synced, api.deployments.Len())
}

func TestSelectStatelessVersionValidatesWholeDeploymentBeforeSelection(t *testing.T) {
	worker := registryWorker{
		Name: "counter",
		Deployment: registryDeployment{
			ID:     "d_11111111111111111111111111111111",
			Worker: "counter",
			Versions: []DeploymentVersion{
				{VersionID: testVersionOne, Percentage: 50},
				{VersionID: testVersionTwo, Percentage: 50},
			},
		},
		Versions: []registryVersion{{VersionID: testVersionOne}, {VersionID: testVersionTwo}},
	}

	seen := map[string]bool{}
	for index := range 10_000 {
		version, upstream := selectStatelessVersion("private-namespace", "counter", fmt.Sprintf("request-%d", index), worker)
		if upstream != nil {
			t.Fatalf("valid rollout failed: %v", upstream)
		}
		seen[version] = true
	}
	if !seen[testVersionOne] || !seen[testVersionTwo] {
		t.Fatalf("request-scoped rollout did not select both versions: %v", seen)
	}

	worker.Deployment.Versions[1].Percentage = 49
	if _, upstream := selectStatelessVersion("private-namespace", "counter", "request", worker); upstream == nil || upstream.Code != "invalid_upstream_response" {
		t.Fatalf("invalid total was accepted: %#v", upstream)
	}
	worker.Deployment.Versions[1].Percentage = 50
	worker.Deployment.Versions[1].VersionID = testVersionOne
	if _, upstream := selectStatelessVersion("private-namespace", "counter", "request", worker); upstream == nil {
		t.Fatal("duplicate rollout target was accepted")
	}
}

func TestThreeAPIReplicasRaceOneLogicalObjectIdentity(t *testing.T) {
	fake := &fakeBackends{
		testing: t,
		version: testVersionOne,
		active:  testVersionOne,
		exports: map[string]registryExport{"Counter": {Type: "durable_object", Storage: "sqlite"}},
	}
	server := httptest.NewServer(http.HandlerFunc(fake.serveHTTP))
	defer server.Close()
	apis := make([]*API, 0, 3)
	for index := range 3 {
		resolver := newStaticPlacementResolver("local-runtime-a").(*staticPlacementResolver)
		resolver.decision.CellName = fmt.Sprintf("actor-bj-%c01", 'a'+index)
		resolver.decision.CellUID = fmt.Sprintf("cell-%d-uid", index+1)
		if index > 0 {
			resolver.decision.Datacenter = "local-runtime-b"
		}
		api, err := NewAPI(Config{
			RegistryURL:       server.URL + "/registry",
			EngineURLs:        []string{server.URL + "/engine", server.URL + "/engine", server.URL + "/engine"},
			EngineCells:       []string{"actor-bj-a01", "actor-bj-b01", "actor-bj-c01"},
			EngineCellUIDs:    []string{"cell-1-uid", "cell-2-uid", "cell-3-uid"},
			EnginePoolUIDs:    []string{"test-pool-uid", "test-pool-uid", "test-pool-uid"},
			Datacenters:       []string{"local-runtime-a", "local-runtime-b", "local-runtime-b"},
			Namespace:         "private-namespace",
			PlacementResolver: resolver,
		})
		if err != nil {
			t.Fatal(err)
		}
		apis = append(apis, api)
	}

	path := "/v1/workers/counter/objects/Counter/" + testObjectID
	start := make(chan struct{})
	responses := make(chan *httptest.ResponseRecorder, len(apis))
	for _, api := range apis {
		go func(handler http.Handler) {
			<-start
			responses <- performJSON(t, handler, http.MethodPut, path, nil)
		}(api)
	}
	close(start)
	for range apis {
		response := <-responses
		if response.Code != http.StatusOK {
			t.Fatalf("concurrent object resolution = %d: %s", response.Code, response.Body.String())
		}
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if len(fake.actorIdentities) != 1 {
		t.Fatalf("three replicas emitted %d logical Actor identities: %#v", len(fake.actorIdentities), fake.actorIdentities)
	}
	for _, datacenter := range fake.actorDatacenters {
		if datacenter != fake.actorDatacenters[0] {
			t.Fatalf("replicas used different persisted placements: %v", fake.actorDatacenters)
		}
	}
	for _, record := range fake.objects {
		if record.Placement == nil || record.Placement.Datacenter != fake.actorDatacenters[0] {
			t.Fatalf("actor creation did not follow the FDB-authoritative placement: record=%+v datacenters=%v", record, fake.actorDatacenters)
		}
	}
}

func TestWorkersAPIRequiresFailClosedPlacementResolver(t *testing.T) {
	if _, err := NewAPI(Config{RegistryURL: "http://registry.invalid", EngineURLs: []string{"http://engine.invalid"}}); err == nil || !strings.Contains(err.Error(), "placement resolver") {
		t.Fatalf("missing placement resolver error = %v", err)
	}
}

func TestWorkersAPIReadinessSurvivesClosedPlacementAndCellOutage(t *testing.T) {
	server := func(path, token string) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			if request.URL.Path != path {
				t.Errorf("unexpected upstream path %q", request.URL.Path)
			}
			if got := request.Header.Get("Authorization"); got != "Bearer "+token {
				t.Errorf("authorization for %s = %q", path, got)
			}
			if path == "/readyz" {
				writeJSON(writer, http.StatusOK, map[string]string{"status": "ok"})
				return
			}
			writeJSON(writer, http.StatusServiceUnavailable, map[string]string{"status": "draining"})
		}))
	}
	registry := server("/readyz", "registry-token")
	engineA := server("/health", "engine-a-token")
	engineB := server("/health", "engine-b-token")
	defer registry.Close()
	defer engineA.Close()
	defer engineB.Close()

	api, err := NewAPI(Config{
		RegistryURL:       registry.URL,
		EngineURLs:        []string{engineA.URL, engineB.URL},
		EngineCells:       []string{"actor-bj-a01", "actor-bj-b01"},
		EngineCellUIDs:    []string{"cell-a-uid", "cell-b-uid"},
		EnginePoolUIDs:    []string{"test-pool-uid", "test-pool-uid"},
		Datacenters:       []string{"local-runtime-a", "local-runtime-b"},
		InternalToken:     "registry-token",
		EngineTokens:      []string{"engine-a-token", "engine-b-token"},
		PlacementResolver: unavailablePlacementResolver{},
	})
	if err != nil {
		t.Fatal(err)
	}
	response := performJSON(t, api, http.MethodGet, "/readyz", nil)
	if response.Code != http.StatusOK {
		t.Fatalf("ready = %d: %s", response.Code, response.Body.String())
	}
	if strings.Join(api.engineTokens, ",") != "engine-a-token,engine-b-token" {
		t.Fatalf("cell-scoped Engine tokens changed: %v", api.engineTokens)
	}
}

func TestPublicPlacementErrorsKeepStableProductCodes(t *testing.T) {
	tests := []struct {
		code    string
		message string
	}{
		{"no_admission_capacity", "No fresh admitted Cell is available"},
		{"placement_unavailable", "The Object placement is unavailable"},
		{"worker_unavailable", "The Worker is temporarily unavailable"},
	}
	for _, test := range tests {
		t.Run(test.code, func(t *testing.T) {
			err := &upstreamError{Status: http.StatusServiceUnavailable, Code: test.code, Message: "internal detail", Retryable: true}
			if got := publicUpstreamCode(err); got != test.code {
				t.Fatalf("public code = %q, want %q", got, test.code)
			}
			if got := publicUpstreamMessage(err); got != test.message {
				t.Fatalf("public message = %q, want %q", got, test.message)
			}
		})
	}
}

func TestWorkersAPIRejectsPartialEngineTokenInventory(t *testing.T) {
	_, err := NewAPI(Config{
		RegistryURL:       "http://registry.invalid",
		EngineURLs:        []string{"http://engine-a.invalid", "http://engine-b.invalid"},
		EngineCells:       []string{"actor-bj-a01", "actor-bj-b01"},
		EngineCellUIDs:    []string{"cell-a-uid", "cell-b-uid"},
		EnginePoolUIDs:    []string{"test-pool-uid", "test-pool-uid"},
		Datacenters:       []string{"local-runtime-a", "local-runtime-b"},
		EngineTokens:      []string{"only-one"},
		PlacementResolver: newStaticPlacementResolver("local-runtime-a"),
	})
	if err == nil || !strings.Contains(err.Error(), "Engine token count") {
		t.Fatalf("partial Engine token inventory error = %v", err)
	}
}

func TestWorkersAPIRejectsPartialOrUnownedObjectRouterTokenInventory(t *testing.T) {
	base := Config{
		RegistryURL:       "http://registry.invalid",
		EngineURLs:        []string{"http://engine-a.invalid", "http://engine-b.invalid"},
		EngineCells:       []string{"actor-bj-a01", "actor-bj-b01"},
		EngineCellUIDs:    []string{"cell-a-uid", "cell-b-uid"},
		EnginePoolUIDs:    []string{"test-pool-uid", "test-pool-uid"},
		Datacenters:       []string{"local-runtime-a", "local-runtime-b"},
		PlacementResolver: newStaticPlacementResolver("local-runtime-a"),
	}
	for name, tokens := range map[string][]string{
		"partial": {"router-capability-a"},
		"extra":   {"router-capability-a", "router-capability-b", "unowned-capability"},
	} {
		t.Run(name, func(t *testing.T) {
			config := base
			config.ObjectRouterTokens = tokens
			if _, err := NewAPI(config); err == nil || !strings.Contains(err.Error(), "Object Router token count") {
				t.Fatalf("Object Router token inventory error = %v", err)
			}
		})
	}
}

func TestWorkersAPIRejectsIncompleteOrAmbiguousEngineIdentity(t *testing.T) {
	base := Config{
		RegistryURL:       "http://registry.invalid",
		EngineURLs:        []string{"http://engine-a.invalid", "http://engine-b.invalid"},
		EngineCells:       []string{"actor-bj-a01", "actor-bj-b01"},
		EngineCellUIDs:    []string{"cell-a-uid", "cell-b-uid"},
		EnginePoolUIDs:    []string{"pool-uid", "pool-uid"},
		Datacenters:       []string{"default", "default"},
		PlacementResolver: newStaticPlacementResolver("default"),
	}
	tests := []struct {
		name    string
		mutate  func(*Config)
		message string
	}{
		{
			name: "missing Cell UID",
			mutate: func(config *Config) {
				config.EngineCellUIDs = config.EngineCellUIDs[:1]
			},
			message: "Engine Cell UID count",
		},
		{
			name: "missing Pool UID",
			mutate: func(config *Config) {
				config.EnginePoolUIDs = config.EnginePoolUIDs[:1]
			},
			message: "Engine Pool UID count",
		},
		{
			name: "duplicate Cell name",
			mutate: func(config *Config) {
				config.EngineCells[1] = config.EngineCells[0]
			},
			message: "Engine Cell mappings must be unique",
		},
		{
			name: "duplicate Cell UID",
			mutate: func(config *Config) {
				config.EngineCellUIDs[1] = config.EngineCellUIDs[0]
			},
			message: "Engine Cell UID mappings must be unique",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			config := base
			config.EngineCells = append([]string(nil), base.EngineCells...)
			config.EngineCellUIDs = append([]string(nil), base.EngineCellUIDs...)
			config.EnginePoolUIDs = append([]string(nil), base.EnginePoolUIDs...)
			test.mutate(&config)
			if _, err := NewAPI(config); err == nil || !strings.Contains(err.Error(), test.message) {
				t.Fatalf("Engine route identity error = %v, want %q", err, test.message)
			}
		})
	}
}

func TestPlacementCellSelectsExactEngineAndDatacenter(t *testing.T) {
	api, err := NewAPI(Config{
		RegistryURL:       "http://registry.invalid",
		EngineURLs:        []string{"http://engine-a.invalid", "http://engine-b.invalid"},
		EngineCells:       []string{"actor-bj-a01", "actor-bj-b01"},
		EngineCellUIDs:    []string{"cell-a-uid", "cell-b-uid"},
		EnginePoolUIDs:    []string{"test-pool-uid", "test-pool-uid"},
		Datacenters:       []string{"default", "default"},
		PlacementResolver: newStaticPlacementResolver("default"),
	})
	if err != nil {
		t.Fatal(err)
	}
	engine, upstream := api.engineForPlacement(context.Background(), &registryPlacement{
		PoolUID: "test-pool-uid", CellName: "actor-bj-b01", CellUID: "cell-b-uid", Datacenter: "default",
	})
	if upstream != nil || engine.Host != "engine-b.invalid" {
		t.Fatalf("B placement route = engine=%v error=%v", engine, upstream)
	}
	for _, placement := range []*registryPlacement{
		{PoolUID: "test-pool-uid", CellName: "actor-bj-c01", CellUID: "cell-b-uid", Datacenter: "default"},
		{PoolUID: "test-pool-uid", CellName: "actor-bj-b01", CellUID: "cell-b-uid", Datacenter: "actor-bj-b01"},
		{PoolUID: "test-pool-uid", CellName: "actor-bj-b01", CellUID: "replaced-cell-uid", Datacenter: "default"},
		{PoolUID: "replaced-pool-uid", CellName: "actor-bj-b01", CellUID: "cell-b-uid", Datacenter: "default"},
		nil,
	} {
		if _, upstream := api.engineForPlacement(context.Background(), placement); upstream == nil {
			t.Fatalf("invalid placement unexpectedly resolved: %#v", placement)
		}
	}
}

func TestDynamicServingRouteReplacesStartupEndpointArrays(t *testing.T) {
	placement := registryPlacement{
		PoolName: "actor-beijing-kubernetes", PoolUID: "test-pool-uid",
		CellName: "actor-bj-a01", CellUID: "cell-a-uid", Datacenter: "default",
	}
	routes := &staticServingRouteResolver{routes: map[string]ServingRoute{
		placement.CellUID: {
			PoolName: placement.PoolName, PoolUID: placement.PoolUID,
			CellName: placement.CellName, CellUID: placement.CellUID, Datacenter: placement.Datacenter,
			ActorGateway:      mustBaseURL(t, "http://engine-v1.invalid:6420"),
			StatelessExecutor: mustBaseURL(t, "http://executor-v1.invalid:19084"),
			Revision:          1,
		},
	}}
	api, err := NewAPI(Config{
		RegistryURL: "http://registry.invalid",
		EngineCells: []string{placement.CellName}, EngineCellUIDs: []string{placement.CellUID},
		EnginePoolUIDs: []string{placement.PoolUID}, Datacenters: []string{placement.Datacenter},
		EngineTokens:            []string{"engine-capability-0001"},
		StatelessExecutorTokens: []string{"executor-capability-01"},
		PlacementResolver:       &testAdmissionSetResolver{candidates: []registryPlacement{placement}},
		ServingRouteResolver:    routes,
	})
	if err != nil {
		t.Fatal(err)
	}
	engine, upstream := api.engineForPlacement(context.Background(), &placement)
	if upstream != nil || engine.Host != "engine-v1.invalid:6420" {
		t.Fatalf("dynamic Engine route = %v, %v", engine, upstream)
	}
	target := *engine
	target.Path = "/actors"
	if token := api.tokenForURL(&target); token != "engine-capability-0001" {
		t.Fatalf("dynamic Engine capability = %q", token)
	}
	executors, err := api.statelessServingExecutors(context.Background())
	if err != nil || len(executors) != 1 || executors[0].endpoint.Host != "executor-v1.invalid:19084" {
		t.Fatalf("dynamic stateless routes = %#v, %v", executors, err)
	}

	route := routes.routes[placement.CellUID]
	route.ActorGateway = mustBaseURL(t, "http://engine-v2.invalid:6420")
	route.StatelessExecutor = mustBaseURL(t, "http://executor-v2.invalid:19084")
	route.Revision = 2
	routes.routes[placement.CellUID] = route
	refreshed, upstream := api.refreshActorBinding(context.Background(), actorBinding{
		actorID: "actor-1", engine: engine, placement: placement, routeRevision: 1,
	})
	if upstream != nil || refreshed.routeRevision != 2 || refreshed.engine.Host != "engine-v2.invalid:6420" {
		t.Fatalf("refreshed Actor route = %#v, %v", refreshed, upstream)
	}
	executors, err = api.statelessServingExecutors(context.Background())
	if err != nil || executors[0].endpoint.Host != "executor-v2.invalid:19084" {
		t.Fatalf("refreshed stateless route = %#v, %v", executors, err)
	}
}

func mustBaseURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	parsed, err := parseBaseURL(raw)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func performJSON(t *testing.T, handler http.Handler, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		reader = bytes.NewReader(encoded)
	}
	request := httptest.NewRequest(method, path, reader)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func decodeForTest(t *testing.T, reader io.Reader, destination any) {
	t.Helper()
	if err := json.NewDecoder(reader).Decode(destination); err != nil {
		t.Fatal(err)
	}
}

func assertNoTopology(t *testing.T, encoded []byte) {
	t.Helper()
	for _, forbidden := range []string{"namespace", "runner", "datacenter", "actor_id", "private-namespace"} {
		if bytes.Contains(bytes.ToLower(encoded), []byte(forbidden)) {
			t.Fatalf("public response leaked %q: %s", forbidden, encoded)
		}
	}
}

func contains(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}
