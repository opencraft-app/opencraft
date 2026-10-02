package workersapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/rivet-dev/rivet/infra/cells/internal/workerregistry"
)

func TestThreeReplicasInvalidateActiveDeploymentWithoutRegistryHotPath(t *testing.T) {
	store, err := workerregistry.NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	registryAPI := workerregistry.NewAPI(store, workerregistry.DefaultMaxRequestBytes)
	var activeReads atomic.Int64
	registryServer := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method == http.MethodGet && request.URL.Path == "/v1/namespaces/default/workers/cache-worker" {
			activeReads.Add(1)
		}
		registryAPI.ServeHTTP(writer, request)
	}))
	t.Cleanup(registryServer.Close)

	executor := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get(statelessExecutorTokenHeader) != "stateless-capability-token" {
			writer.WriteHeader(http.StatusUnauthorized)
			return
		}
		if strings.HasSuffix(request.URL.Path, "/prepare") {
			writer.WriteHeader(http.StatusNoContent)
			return
		}
		if strings.HasSuffix(request.URL.Path, "/dispatch") {
			parts := strings.Split(request.URL.Path, "/")
			if len(parts) < 2 {
				writer.WriteHeader(http.StatusNotFound)
				return
			}
			writeJSON(writer, http.StatusOK, map[string]string{"version": parts[len(parts)-2]})
			return
		}
		writer.WriteHeader(http.StatusNotFound)
	}))
	t.Cleanup(executor.Close)

	replicas := make([]*API, 3)
	for index := range replicas {
		replicas[index], err = NewAPI(Config{
			RegistryURL: registryServer.URL,
			EngineURLs:  []string{executor.URL}, EngineCells: []string{"actor-bj-a01"},
			EngineCellUIDs: []string{"test-cell-uid"}, EnginePoolUIDs: []string{"test-pool-uid"},
			Datacenters: []string{"local-runtime-a"}, Namespace: "default",
			StatelessExecutorURLs:   []string{executor.URL},
			StatelessExecutorTokens: []string{"stateless-capability-token"},
			PlacementResolver:       newStaticPlacementResolver("local-runtime-a"),
			DeploymentCacheCapacity: 2,
		})
		if err != nil {
			t.Fatal(err)
		}
		replica := replicas[index]
		t.Cleanup(replica.Close)
		replica.startDeploymentWatcher()
	}

	versionOne := uploadIntegrationVersion(t, replicas[0], "export default { fetch() { return new Response('one') } }")
	deployIntegrationVersion(t, replicas[0], versionOne)
	waitReplicasAtRegistryCursor(t, replicas, store, "cache-worker")
	assertDispatchVersion(t, replicas, versionOne)
	readsAfterMiss := activeReads.Load()
	if readsAfterMiss != 4 { // createDeployment reads current once; each replica misses once.
		t.Fatalf("active Worker reads after three replica misses = %d, want 4", readsAfterMiss)
	}
	assertDispatchVersion(t, replicas, versionOne)
	if reads := activeReads.Load(); reads != readsAfterMiss {
		t.Fatalf("cache-hit dispatches read Registry: before=%d after=%d", readsAfterMiss, reads)
	}

	versionTwo := uploadIntegrationVersion(t, replicas[1], "export default { fetch() { return new Response('two') } }")
	deployIntegrationVersion(t, replicas[1], versionTwo)
	readsAfterPublish := activeReads.Load()
	waitReplicasAtRegistryCursor(t, replicas, store, "cache-worker")
	assertDispatchVersion(t, replicas, versionTwo)
	if reads := activeReads.Load(); reads != readsAfterPublish+3 {
		t.Fatalf("post-change Registry reads = %d, want %d", reads, readsAfterPublish+3)
	}
	assertDispatchVersion(t, replicas, versionTwo)
	if reads := activeReads.Load(); reads != readsAfterPublish+3 {
		t.Fatalf("post-change cache hits read Registry: got %d", reads)
	}
}

func uploadIntegrationVersion(t *testing.T, api *API, source string) string {
	t.Helper()
	response := performJSON(t, api, http.MethodPost, "/v1/workers/cache-worker/versions", UploadVersionRequest{
		MainModule: "main.js", Modules: map[string]string{"main.js": source}, CompatibilityDate: "2026-08-14",
	})
	if response.Code != http.StatusCreated {
		t.Fatalf("upload status = %d: %s", response.Code, response.Body.String())
	}
	var version Version
	decodeForTest(t, response.Body, &version)
	return version.ID
}

func deployIntegrationVersion(t *testing.T, api *API, versionID string) {
	t.Helper()
	response := performJSON(t, api, http.MethodPost, "/v1/workers/cache-worker/deployments", CreateDeploymentRequest{VersionID: versionID})
	if response.Code != http.StatusCreated {
		t.Fatalf("deployment status = %d: %s", response.Code, response.Body.String())
	}
}

func waitReplicasAtRegistryCursor(t *testing.T, replicas []*API, store *workerregistry.Store, worker string) {
	t.Helper()
	current, err := store.GetWorker(context.Background(), "default", worker)
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		converged := true
		for _, replica := range replicas {
			_, cursor, synced := replica.deployments.Fence()
			if !synced || cursor != current.DeploymentCursor {
				converged = false
				break
			}
		}
		if converged {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("three Workers API replicas did not observe the Registry Deployment cursor")
}

func assertDispatchVersion(t *testing.T, replicas []*API, versionID string) {
	t.Helper()
	for index, replica := range replicas {
		request := httptest.NewRequest(http.MethodPost, "/v1/workers/cache-worker/dispatch", strings.NewReader("payload"))
		request.Header.Set(publicOriginalURLHeader, "https://worker.example/fetch")
		response := httptest.NewRecorder()
		replica.ServeHTTP(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("replica %d dispatch status = %d: %s", index, response.Code, response.Body.String())
		}
		var body map[string]string
		if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if body["version"] != versionID {
			t.Fatalf("replica %d selected Version %q, want %q", index, body["version"], versionID)
		}
	}
}
