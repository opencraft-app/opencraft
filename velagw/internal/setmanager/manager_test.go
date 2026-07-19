package setmanager

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"time"
)

func TestRunOnceAlwaysUsesLLMFleetBackend(t *testing.T) {
	t.Setenv("LLMGATEWAY_SET_MANAGER_RUNTIME_BACKEND", "direct")

	fleetCalled := false
	kubeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/apis/llmgateway.io/v1alpha1/namespaces/prod/llmfleets/prod" {
			t.Fatalf("unexpected kube path: %s", r.URL.Path)
		}
		fleetCalled = true
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"metadata":{"name":"prod","namespace":"prod","generation":1},"spec":{"sets":[]},"status":{"conditions":[{"type":"Ready","status":"True","observedGeneration":1}]}}`))
	}))
	defer kubeServer.Close()

	capacityCalls := 0
	controlServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/internal/set-manager/set-upgrade-runs":
			_, _ = w.Write([]byte(`{"success":true,"data":[]}`))
		case r.Method == http.MethodPost && r.URL.Path == "/api/internal/set-manager/shards":
			_, _ = w.Write([]byte(`{"success":true,"data":{}}`))
		case r.Method == http.MethodGet && r.URL.Path == "/api/internal/set-manager/set-decommissions":
			_, _ = w.Write([]byte(`{"success":true,"data":[]}`))
		case r.Method == http.MethodPost && r.URL.Path == "/api/admin/set-capacity/reconcile":
			capacityCalls++
			_, _ = w.Write([]byte(`{"success":true,"data":{}}`))
		case r.Method == http.MethodGet && r.URL.Path == "/api/internal/set-manager/set-provision-requests":
			_, _ = w.Write([]byte(`{"success":true,"data":[]}`))
		default:
			t.Fatalf("unexpected control request: %s %s", r.Method, r.URL.Path)
		}
	}))
	defer controlServer.Close()

	cfg := LoadConfigFromEnv()
	cfg.Namespace = "prod"
	cfg.ControlURL = controlServer.URL
	cfg.Source = "prod"
	cfg.Fleet = "prod"
	cfg.RequestLimit = 20
	cfg.WaitTimeout = 1
	err := RunOnce(context.Background(), cfg, ControlClient{}, KubeClient{BaseURL: kubeServer.URL, HTTPClient: kubeServer.Client()})
	if err != nil {
		t.Fatal(err)
	}
	if !fleetCalled {
		t.Fatalf("RunOnce did not read LLMFleet")
	}
	if capacityCalls != 0 {
		t.Fatalf("RunOnce called capacity reconcile %d times; set-manager must only execute pending requests", capacityCalls)
	}
}

func TestRegressionUpgradeHoldIsDisabledUnlessStatusMatches(t *testing.T) {
	cfg := Config{RegressionHoldUpgradeStatus: "switching"}
	if err := holdUpgradeAtRegressionPoint(t.Context(), cfg, "preparing"); err != nil {
		t.Fatal(err)
	}
}

func TestRegressionUpgradeOwnerOverrideIsExplicit(t *testing.T) {
	cfg := Config{RegressionUpgradeOwner: "regression-manager-job-01"}
	if got := setUpgradeOwner(cfg, "run-1"); got != "regression-manager-job-01" {
		t.Fatalf("owner=%q", got)
	}
}

func TestRegressionUpgradeHoldBlocksUntilManagerIsTerminated(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan error, 1)
	go func() {
		done <- holdUpgradeAtRegressionPoint(ctx, Config{RegressionHoldUpgradeStatus: "switching"}, "switching")
	}()
	select {
	case err := <-done:
		t.Fatalf("hold returned before cancellation: %v", err)
	case <-time.After(20 * time.Millisecond):
	}
	cancel()
	if err := <-done; err == nil || err != context.Canceled {
		t.Fatalf("hold error = %v", err)
	}
}

func TestControlClientUsesInternalTokenForScopedSetManagerEndpoints(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer internal-token" {
			t.Fatalf("%s authorization = %q, want internal token", r.URL.Path, got)
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/internal/set-manager/set-decommissions":
			_, _ = w.Write([]byte(`{"success":true,"data":[]}`))
		case "/api/internal/set-manager/shards":
			_, _ = w.Write([]byte(`{"success":true,"data":null}`))
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer server.Close()

	client := ControlClient{BaseURL: server.URL, InternalToken: "internal-token", HTTPClient: server.Client()}
	if _, err := client.SetDecommissions(t.Context(), 10); err != nil {
		t.Fatal(err)
	}
	if err := client.UpsertShard(t.Context(), ShardProjection{ID: "shard-a"}); err != nil {
		t.Fatal(err)
	}
}

func TestRunOnceClaimsDecommissionAndPatchesCleanupWithoutWaitingFleetReady(t *testing.T) {
	patchCalls := 0
	kubeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method {
		case http.MethodGet:
			_, _ = w.Write([]byte(`{
				"metadata":{"name":"prod","namespace":"prod","generation":7,"resourceVersion":"rv-7"},
				"spec":{"newapi":{},"shards":[{"name":"shard-a","redisDBStart":10,"redisDBLimit":32}],"sets":[{"name":"set-a","shardRef":"shard-a","databaseName":"newapi_set_a","redisDB":"17"}],"trafficRuntimes":[{"setID":"set-a","generation":1,"image":"registry/new-api:a"}],"cleanups":[]},
				"status":{"conditions":[{"type":"Ready","status":"False","observedGeneration":6}]}
			}`))
		case http.MethodPatch:
			patchCalls++
			var operations []map[string]any
			if err := json.NewDecoder(r.Body).Decode(&operations); err != nil {
				t.Fatal(err)
			}
			if len(operations) != 4 {
				t.Fatalf("operations = %+v", operations)
			}
			if operations[2]["path"] != "/spec/trafficRuntimes" {
				t.Fatalf("traffic runtime patch = %+v", operations)
			}
			if runtimes, ok := operations[2]["value"].([]any); !ok || len(runtimes) != 0 {
				t.Fatalf("traffic runtimes were not removed: %+v", operations[2])
			}
			_, _ = w.Write([]byte(`{}`))
		default:
			t.Fatalf("unexpected kube request: %s %s", r.Method, r.URL.Path)
		}
	}))
	defer kubeServer.Close()

	controlServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/internal/set-manager/shards":
			_, _ = w.Write([]byte(`{"success":true,"data":{}}`))
		case r.Method == http.MethodGet && r.URL.Path == "/api/internal/set-manager/set-decommissions":
			_, _ = w.Write([]byte(`{"success":true,"data":[{"id":"decom-a","set_id":"set-a","status":"pending"}]}`))
		case r.Method == http.MethodPost && r.URL.Path == "/api/internal/set-manager/set-decommissions/decom-a/claim":
			_, _ = w.Write([]byte(`{"success":true,"data":{"job":{"id":"decom-a","set_id":"set-a","status":"removing_runtime","attempt":1},"cleanup":{"cleanup_id":"decom-a","set_id":"set-a","attempt":1,"source":"prod","namespace":"prod","fleet":"prod","shard_ref":"shard-a","database_name":"newapi_set_a","redis_db":"17","lease_fingerprint":"fp","claim_token":"claim","cleanup_capability":"cap"}}}`))
		case r.Method == http.MethodGet && r.URL.Path == "/api/internal/set-manager/set-provision-requests":
			_, _ = w.Write([]byte(`{"success":true,"data":[]}`))
		default:
			t.Fatalf("unexpected control request: %s %s", r.Method, r.URL.Path)
		}
	}))
	defer controlServer.Close()

	cfg := Config{Namespace: "prod", ControlURL: controlServer.URL, Source: "prod", Fleet: "prod", RequestLimit: 20, NewSetReplicas: 1, WaitTimeout: time.Millisecond}
	err := RunOnce(t.Context(), cfg, ControlClient{HTTPClient: controlServer.Client()}, KubeClient{BaseURL: kubeServer.URL, HTTPClient: kubeServer.Client()})
	if err != nil {
		t.Fatal(err)
	}
	if patchCalls != 1 {
		t.Fatalf("patch calls = %d", patchCalls)
	}
}

func TestRunOncePrunesOrphanTrafficRuntimesBeforeOtherWork(t *testing.T) {
	patchCalls := 0
	kubeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method {
		case http.MethodGet:
			_, _ = w.Write([]byte(`{
				"metadata":{"name":"prod","namespace":"prod","generation":7,"resourceVersion":"rv-7"},
				"spec":{"sets":[{"name":"set-a"}],"trafficRuntimes":[{"setID":"set-a","generation":1},{"setID":"set-deleted","generation":2}],"cleanups":[]}
			}`))
		case http.MethodPatch:
			patchCalls++
			var operations []map[string]any
			if err := json.NewDecoder(r.Body).Decode(&operations); err != nil {
				t.Fatal(err)
			}
			if len(operations) != 3 || operations[2]["path"] != "/spec/trafficRuntimes" {
				t.Fatalf("operations = %+v", operations)
			}
			runtimes, ok := operations[2]["value"].([]any)
			if !ok || len(runtimes) != 1 {
				t.Fatalf("repaired runtimes = %+v", operations[2]["value"])
			}
			runtime := runtimes[0].(map[string]any)
			if runtime["setID"] != "set-a" {
				t.Fatalf("remaining runtime = %+v", runtime)
			}
			_, _ = w.Write([]byte(`{}`))
		default:
			t.Fatalf("unexpected kube request: %s %s", r.Method, r.URL.Path)
		}
	}))
	defer kubeServer.Close()

	controlCalls := 0
	controlServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		controlCalls++
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/internal/set-manager/set-reconcile-facts", "/api/internal/set-manager/set-reconcile-facts/reconcile":
			_, _ = w.Write([]byte(`{"success":true,"data":{}}`))
		default:
			t.Fatalf("orphan repair continued into other control work: %s %s", r.Method, r.URL.Path)
		}
	}))
	defer controlServer.Close()

	cfg := Config{Namespace: "prod", ControlURL: controlServer.URL, Source: "prod", Fleet: "prod", RequestLimit: 20}
	err := RunOnce(t.Context(), cfg, ControlClient{HTTPClient: controlServer.Client()}, KubeClient{BaseURL: kubeServer.URL, HTTPClient: kubeServer.Client()})
	if err != nil {
		t.Fatal(err)
	}
	if patchCalls != 1 || controlCalls != 2 {
		t.Fatalf("patch calls=%d control calls=%d", patchCalls, controlCalls)
	}
}

func TestRunOnceSkipsConflictingDecommissionAndClaimsNextJob(t *testing.T) {
	patchCalls := 0
	kubeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method {
		case http.MethodGet:
			_, _ = w.Write([]byte(`{
				"metadata":{"name":"prod","namespace":"prod","generation":7,"resourceVersion":"rv-7"},
				"spec":{"newapi":{},"shards":[{"name":"shard-a","redisDBStart":10,"redisDBLimit":32}],"sets":[{"name":"set-b","shardRef":"shard-a","databaseName":"newapi_set_b","redisDB":"18"}],"cleanups":[]},
				"status":{"conditions":[{"type":"Ready","status":"True","observedGeneration":7}]}
			}`))
		case http.MethodPatch:
			patchCalls++
			_, _ = w.Write([]byte(`{}`))
		default:
			t.Fatalf("unexpected kube request: %s %s", r.Method, r.URL.Path)
		}
	}))
	defer kubeServer.Close()

	controlServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/internal/set-manager/shards":
			_, _ = w.Write([]byte(`{"success":true,"data":{}}`))
		case r.Method == http.MethodGet && r.URL.Path == "/api/internal/set-manager/set-decommissions":
			_, _ = w.Write([]byte(`{"success":true,"data":[{"id":"decom-stale","set_id":"set-stale","status":"pending"},{"id":"decom-b","set_id":"set-b","status":"pending"}]}`))
		case r.Method == http.MethodPost && r.URL.Path == "/api/internal/set-manager/set-decommissions/decom-stale/claim":
			w.WriteHeader(http.StatusConflict)
			_, _ = w.Write([]byte(`{"success":false,"message":"set lifecycle changed"}`))
		case r.Method == http.MethodPost && r.URL.Path == "/api/internal/set-manager/set-decommissions/decom-b/claim":
			_, _ = w.Write([]byte(`{"success":true,"data":{"job":{"id":"decom-b","set_id":"set-b","status":"removing_runtime","attempt":1},"cleanup":{"cleanup_id":"decom-b","set_id":"set-b","attempt":1,"source":"prod","namespace":"prod","fleet":"prod","shard_ref":"shard-a","database_name":"newapi_set_b","redis_db":"18","lease_fingerprint":"fp","claim_token":"claim","cleanup_capability":"cap"}}}`))
		default:
			t.Fatalf("unexpected control request: %s %s", r.Method, r.URL.Path)
		}
	}))
	defer controlServer.Close()

	cfg := Config{Namespace: "prod", ControlURL: controlServer.URL, Source: "prod", Fleet: "prod", RequestLimit: 20}
	err := RunOnce(t.Context(), cfg, ControlClient{HTTPClient: controlServer.Client()}, KubeClient{BaseURL: kubeServer.URL, HTTPClient: kubeServer.Client()})
	if err != nil {
		t.Fatal(err)
	}
	if patchCalls != 1 {
		t.Fatalf("patch calls = %d", patchCalls)
	}
}

func TestRunOnceReportsFailedCleanupAndRemovesItForExplicitRetry(t *testing.T) {
	patchCalls := 0
	failCalls := 0
	kubeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method {
		case http.MethodGet:
			_, _ = w.Write([]byte(`{
				"metadata":{"name":"prod","namespace":"prod","generation":8,"resourceVersion":"rv-8"},
				"spec":{"newapi":{},"shards":[{"name":"shard-a","redisDBStart":10,"redisDBLimit":32}],"sets":[],"cleanups":[{"cleanupID":"decom-a","setID":"set-a","attempt":1,"source":"prod","namespace":"prod","fleet":"prod","shardRef":"shard-a","databaseName":"newapi_set_a","redisDB":"17","leaseFingerprint":"fp","claimToken":"claim"}]},
				"status":{"cleanups":[{"cleanupID":"decom-a","attempt":1,"jobUID":"job-uid-a","failed":1}]}
			}`))
		case http.MethodPatch:
			patchCalls++
			var operations []map[string]any
			if err := json.NewDecoder(r.Body).Decode(&operations); err != nil {
				t.Fatal(err)
			}
			cleanups, ok := operations[2]["value"].([]any)
			if !ok || len(cleanups) != 0 {
				t.Fatalf("cleanup removal patch = %+v", operations)
			}
			_, _ = w.Write([]byte(`{}`))
		default:
			t.Fatalf("unexpected kube request: %s %s", r.Method, r.URL.Path)
		}
	}))
	defer kubeServer.Close()

	controlServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/internal/set-manager/set-decommissions/decom-a/fail":
			failCalls++
			_, _ = w.Write([]byte(`{"success":true,"data":{"id":"decom-a","status":"error"}}`))
		case r.Method == http.MethodPost && r.URL.Path == "/api/internal/set-manager/shards":
			_, _ = w.Write([]byte(`{"success":true,"data":{}}`))
		default:
			t.Fatalf("unexpected control request: %s %s", r.Method, r.URL.Path)
		}
	}))
	defer controlServer.Close()

	cfg := Config{Namespace: "prod", ControlURL: controlServer.URL, Source: "prod", Fleet: "prod", RequestLimit: 20}
	err := RunOnce(t.Context(), cfg, ControlClient{HTTPClient: controlServer.Client()}, KubeClient{BaseURL: kubeServer.URL, HTTPClient: kubeServer.Client()})
	if err != nil {
		t.Fatal(err)
	}
	if failCalls != 1 || patchCalls != 1 {
		t.Fatalf("fail calls=%d patch calls=%d", failCalls, patchCalls)
	}
}

func TestLLMFleetSetFromRequestUsesRequestShape(t *testing.T) {
	cfg := Config{Fleet: "prod", NewSetReplicas: 2}
	req := ProvisionRequest{
		SetID:        "set-auto-000123",
		ShardRef:     "shard-b",
		DatabaseName: "newapi_set_auto_000123",
		RedisDB:      "14",
		ReleaseImage: "registry/new-api@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
	}

	got := LLMFleetSetFromRequest(req, cfg)

	if got.Name != "set-auto-000123" {
		t.Fatalf("name = %q", got.Name)
	}
	if got.ShardRef != "shard-b" {
		t.Fatalf("shard ref = %q", got.ShardRef)
	}
	if got.Replicas != 0 {
		t.Fatalf("bootstrap slave replicas = %d, want 0", got.Replicas)
	}
	if got.LegacyTrafficEnabled == nil || *got.LegacyTrafficEnabled {
		t.Fatalf("new set must disable legacy traffic: %+v", got)
	}
	if got.DatabaseName != "newapi_set_auto_000123" {
		t.Fatalf("database name = %q", got.DatabaseName)
	}
	if got.RedisDB != "14" {
		t.Fatalf("redis db = %q", got.RedisDB)
	}
	if got.SessionSecret != "llmgateway-prod-set-auto-000123-session-secret" {
		t.Fatalf("session secret = %q", got.SessionSecret)
	}
	if got.AdminImage != req.ReleaseImage || got.LegacyTrafficImage != req.ReleaseImage {
		t.Fatalf("release image was not pinned on the new set: %+v", got)
	}
}

func TestAddInitialTrafficRuntimesUsesGenerationOne(t *testing.T) {
	var fleet LLMFleet
	fleet.Spec.NewAPIImage = "registry/new-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	disabled := false
	fleet.Spec.Sets = []LLMFleetSet{{Name: "set-a", Replicas: 0, LegacyTrafficEnabled: &disabled}}
	changed, err := AddInitialTrafficRuntimes(&fleet, []ProvisionRequest{{SetID: "set-a"}})
	if err != nil {
		t.Fatal(err)
	}
	if !changed || len(fleet.Spec.TrafficRuntimes) != 1 {
		t.Fatalf("changed=%v runtimes=%+v", changed, fleet.Spec.TrafficRuntimes)
	}
	runtime := fleet.Spec.TrafficRuntimes[0]
	if runtime.Generation != 1 || runtime.Image != fleet.Spec.NewAPIImage || runtime.Replicas != 0 {
		t.Fatalf("runtime=%+v", runtime)
	}
	if changed, err := AddInitialTrafficRuntimes(&fleet, []ProvisionRequest{{SetID: "set-a"}}); err != nil || changed {
		t.Fatalf("idempotent add changed=%v err=%v", changed, err)
	}
}

func TestAddInitialTrafficRuntimesPrefersProvisionReleaseImage(t *testing.T) {
	var fleet LLMFleet
	fleet.Spec.NewAPIImage = "registry/new-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	disabled := false
	fleet.Spec.Sets = []LLMFleetSet{{Name: "set-a", Replicas: 0, LegacyTrafficEnabled: &disabled}}
	request := ProvisionRequest{
		SetID:        "set-a",
		ReleaseImage: "registry/new-api@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
	}
	changed, err := AddInitialTrafficRuntimes(&fleet, []ProvisionRequest{request})
	if err != nil {
		t.Fatal(err)
	}
	if !changed || len(fleet.Spec.TrafficRuntimes) != 1 || fleet.Spec.TrafficRuntimes[0].Image != request.ReleaseImage {
		t.Fatalf("runtimes=%+v changed=%v", fleet.Spec.TrafficRuntimes, changed)
	}
}

func TestScaleConfiguredLLMFleetSetsRaisesOnlyConfiguredSetsToTarget(t *testing.T) {
	sets := []LLMFleetSet{
		{Name: "set-a", Replicas: 0},
		{Name: "set-b", Replicas: 0},
	}
	requests := []ProvisionRequest{{ID: "req-a", SetID: "set-a", Status: "configured"}}

	got, adopted, changed, err := ScaleConfiguredLLMFleetSets(sets, requests, Config{NewSetReplicas: 2})
	if err != nil {
		t.Fatal(err)
	}
	if !changed || len(adopted) != 1 {
		t.Fatalf("changed=%v adopted=%+v", changed, adopted)
	}
	if got[0].Replicas != 2 || got[1].Replicas != 0 {
		t.Fatalf("scaled sets = %+v", got)
	}
}

func TestScaleConfiguredLLMFleetSetsIsIdempotentAfterReplicaPatch(t *testing.T) {
	sets := []LLMFleetSet{{Name: "set-a", Replicas: 2}}
	requests := []ProvisionRequest{{ID: "req-a", SetID: "set-a", Status: "configured"}}

	got, adopted, changed, err := ScaleConfiguredLLMFleetSets(sets, requests, Config{NewSetReplicas: 2})
	if err != nil {
		t.Fatal(err)
	}
	if changed || len(adopted) != 1 || got[0].Replicas != 2 {
		t.Fatalf("changed=%v adopted=%+v sets=%+v", changed, adopted, got)
	}
}

func TestRecoverableErroredProvisionRequestsRequiresReadyMatchingFleetResources(t *testing.T) {
	fleet := LLMFleet{}
	fleet.Metadata.Generation = 9
	fleet.Status.Conditions = []LLMFleetCondition{{Type: "Ready", Status: "True", ObservedGeneration: 9}}
	fleet.Spec.Sets = []LLMFleetSet{{
		Name: "set-a", ShardRef: "shard-a", DatabaseName: "newapi_set_a", RedisDB: "7",
		AdminImage: "registry/new-api@sha256:v1",
	}}
	fleet.Spec.TrafficRuntimes = []LLMFleetTrafficRuntime{{
		SetID: "set-a", Generation: 1, Image: "registry/new-api@sha256:v1", Replicas: 0,
	}}
	requests := []ProvisionRequest{{
		ID: "req-a", SetID: "set-a", ShardRef: "shard-a", DatabaseName: "newapi_set_a", RedisDB: "7",
		ReleaseImage: "registry/new-api@sha256:v1", Status: "error",
	}}

	got := recoverableErroredProvisionRequests(fleet, requests)
	if len(got) != 1 || got[0].ID != "req-a" {
		t.Fatalf("recoverable requests = %+v", got)
	}
}

func TestRecoverableErroredProvisionRequestsRejectsIncompleteOrMismatchedEvidence(t *testing.T) {
	readyFleet := LLMFleet{}
	readyFleet.Metadata.Generation = 9
	readyFleet.Status.Conditions = []LLMFleetCondition{{Type: "Ready", Status: "True", ObservedGeneration: 9}}
	readyFleet.Spec.Sets = []LLMFleetSet{{
		Name: "set-a", ShardRef: "shard-a", DatabaseName: "newapi_set_a", RedisDB: "7",
		AdminImage: "registry/new-api@sha256:v1",
	}}
	request := ProvisionRequest{
		ID: "req-a", SetID: "set-a", ShardRef: "shard-a", DatabaseName: "newapi_set_a", RedisDB: "7",
		ReleaseImage: "registry/new-api@sha256:v1", Status: "error",
	}

	tests := []struct {
		name   string
		mutate func(*LLMFleet, *ProvisionRequest)
	}{
		{name: "fleet not ready", mutate: func(fleet *LLMFleet, _ *ProvisionRequest) {
			fleet.Status.Conditions[0].Status = "False"
		}},
		{name: "redis db mismatch", mutate: func(_ *LLMFleet, request *ProvisionRequest) {
			request.RedisDB = "8"
		}},
		{name: "runtime missing", mutate: func(fleet *LLMFleet, _ *ProvisionRequest) {
			fleet.Spec.TrafficRuntimes = nil
		}},
		{name: "runtime image mismatch", mutate: func(fleet *LLMFleet, _ *ProvisionRequest) {
			fleet.Spec.TrafficRuntimes[0].Image = "registry/new-api@sha256:v2"
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fleet := readyFleet
			fleet.Status.Conditions = append([]LLMFleetCondition(nil), readyFleet.Status.Conditions...)
			fleet.Spec.Sets = append([]LLMFleetSet(nil), readyFleet.Spec.Sets...)
			fleet.Spec.TrafficRuntimes = []LLMFleetTrafficRuntime{{
				SetID: "set-a", Generation: 1, Image: "registry/new-api@sha256:v1", Replicas: 0,
			}}
			candidate := request
			tt.mutate(&fleet, &candidate)
			if got := recoverableErroredProvisionRequests(fleet, []ProvisionRequest{candidate}); len(got) != 0 {
				t.Fatalf("unexpected recoverable requests = %+v", got)
			}
		})
	}
}

func TestRecoverErroredLLMFleetRequestsMovesOnlyProvenRequestsToConfigured(t *testing.T) {
	fleet := LLMFleet{}
	fleet.Metadata.Generation = 9
	fleet.Status.Conditions = []LLMFleetCondition{{Type: "Ready", Status: "True", ObservedGeneration: 9}}
	fleet.Spec.Sets = []LLMFleetSet{{
		Name: "set-a", ShardRef: "shard-a", DatabaseName: "newapi_set_a", RedisDB: "7",
		AdminImage: "registry/new-api@sha256:v1",
	}}
	fleet.Spec.TrafficRuntimes = []LLMFleetTrafficRuntime{{
		SetID: "set-a", Generation: 1, Image: "registry/new-api@sha256:v1", Replicas: 0,
	}}

	var updates []map[string]string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/internal/set-manager/set-provision-requests":
			if r.URL.Query().Get("status") != "error" {
				t.Fatalf("status query = %q", r.URL.Query().Get("status"))
			}
			_, _ = w.Write([]byte(`{"success":true,"data":[
				{"id":"req-a","set_id":"set-a","shard_ref":"shard-a","database_name":"newapi_set_a","redis_db":"7","release_image":"registry/new-api@sha256:v1","status":"error"},
				{"id":"req-b","set_id":"set-b","shard_ref":"shard-a","database_name":"newapi_set_b","redis_db":"8","release_image":"registry/new-api@sha256:v1","status":"error"}
			]}`))
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/status"):
			var body map[string]string
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			updates = append(updates, body)
			_, _ = w.Write([]byte(`{"success":true,"data":{}}`))
		default:
			t.Fatalf("unexpected control request: %s %s", r.Method, r.URL.Path)
		}
	}))
	defer server.Close()

	client := ControlClient{BaseURL: server.URL, InternalToken: "internal", HTTPClient: server.Client()}
	recovered, err := recoverErroredLLMFleetRequests(t.Context(), Config{Source: "prod", Namespace: "prod", Fleet: "prod", RequestLimit: 20}, client, fleet)
	if err != nil {
		t.Fatal(err)
	}
	if recovered != 1 || len(updates) != 1 || updates[0]["status"] != "configured" {
		t.Fatalf("recovered=%d updates=%+v", recovered, updates)
	}
}

func TestScaleConfiguredLLMFleetRequestsMarksManagedAfterFleetReady(t *testing.T) {
	patchCalls := 0
	kubeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method {
		case http.MethodPatch:
			patchCalls++
			_, _ = w.Write([]byte(`{}`))
		case http.MethodGet:
			_, _ = w.Write([]byte(`{
				"metadata":{"name":"prod","namespace":"prod","generation":2,"resourceVersion":"rv-2"},
				"spec":{"sets":[{"name":"set-a","replicas":2}]},
				"status":{"conditions":[{"type":"Ready","status":"True","observedGeneration":2}]}
			}`))
		default:
			t.Fatalf("unexpected kube request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer kubeServer.Close()

	managedCalls := 0
	controlServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || !strings.HasSuffix(r.URL.Path, "/req-a/status") {
			t.Fatalf("unexpected control request %s %s", r.Method, r.URL.Path)
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body["status"] != "managed" {
			t.Fatalf("status body = %+v", body)
		}
		managedCalls++
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"success":true,"data":{}}`))
	}))
	defer controlServer.Close()

	fleet := LLMFleet{}
	fleet.Metadata.Name = "prod"
	fleet.Metadata.ResourceVersion = "rv-1"
	fleet.Spec.Sets = []LLMFleetSet{{Name: "set-a", Replicas: 0}}
	fleet.Status.Conditions = []LLMFleetCondition{{Type: "Ready", Status: "True", ObservedGeneration: 1}}
	requests := []ProvisionRequest{{ID: "req-a", SetID: "set-a", Status: "configured"}}
	cfg := Config{Namespace: "prod", Fleet: "prod", NewSetReplicas: 2, WaitTimeout: time.Second}

	_, err := scaleConfiguredLLMFleetRequests(t.Context(), cfg,
		ControlClient{BaseURL: controlServer.URL, HTTPClient: controlServer.Client()},
		KubeClient{BaseURL: kubeServer.URL, HTTPClient: kubeServer.Client()}, fleet, requests)
	if err != nil {
		t.Fatal(err)
	}
	if patchCalls != 1 || managedCalls != 1 {
		t.Fatalf("patch calls=%d managed calls=%d", patchCalls, managedCalls)
	}
}

func TestScaleConfiguredLLMFleetRequestsPersistsPatchFailureForRetry(t *testing.T) {
	kubeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "patch failed", http.StatusInternalServerError)
	}))
	defer kubeServer.Close()

	retryErrors := 0
	controlServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body["status"] != "configured" || !strings.Contains(body["last_error"].(string), "scale configured llmfleet sets") {
			t.Fatalf("retry body = %+v", body)
		}
		retryErrors++
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"success":true,"data":{}}`))
	}))
	defer controlServer.Close()

	fleet := LLMFleet{}
	fleet.Metadata.ResourceVersion = "rv-1"
	fleet.Spec.Sets = []LLMFleetSet{{Name: "set-a", Replicas: 0}}
	requests := []ProvisionRequest{{ID: "req-a", SetID: "set-a", Status: "configured"}}
	_, err := scaleConfiguredLLMFleetRequests(t.Context(), Config{Namespace: "prod", Fleet: "prod", NewSetReplicas: 1},
		ControlClient{BaseURL: controlServer.URL, HTTPClient: controlServer.Client()},
		KubeClient{BaseURL: kubeServer.URL, HTTPClient: kubeServer.Client()}, fleet, requests)
	if err == nil {
		t.Fatal("expected patch failure")
	}
	if retryErrors != 1 {
		t.Fatalf("retry error updates = %d", retryErrors)
	}
}

func TestMergeLLMFleetSetsAppendsOnlyMissingRequests(t *testing.T) {
	existing := []LLMFleetSet{{Name: "set-a", ShardRef: "shard-a"}}
	requests := []ProvisionRequest{
		{ID: "req-a", SetID: "set-a", ShardRef: "shard-a"},
		{ID: "req-b", SetID: "set-b", ShardRef: "shard-b", RedisDB: "11"},
	}

	sets, adopted, changed, err := MergeLLMFleetSets(existing, requests, Config{Fleet: "prod", NewSetReplicas: 1})
	if err != nil {
		t.Fatal(err)
	}

	if !changed {
		t.Fatalf("changed = false")
	}
	if len(adopted) != 2 {
		t.Fatalf("adopted = %d", len(adopted))
	}
	if len(sets) != 2 {
		t.Fatalf("sets = %d", len(sets))
	}
	if sets[1].Name != "set-b" || sets[1].ShardRef != "shard-b" || sets[1].RedisDB != "11" {
		t.Fatalf("unexpected appended set: %+v", sets[1])
	}
}

func TestMergeLLMFleetSetsRejectsRedisDBReuseOnSameShard(t *testing.T) {
	existing := []LLMFleetSet{{Name: "set-a", ShardRef: "shard-a", RedisDB: "12"}}
	requests := []ProvisionRequest{
		{ID: "req-b", SetID: "set-b", ShardRef: "shard-a", RedisDB: "12"},
	}

	_, _, _, err := MergeLLMFleetSets(existing, requests, Config{Fleet: "prod", NewSetReplicas: 1})
	if err == nil {
		t.Fatal("expected duplicate redis db on same shard to fail")
	}
	if got := err.Error(); got != `redis db 12 on shard shard-a is already used by set set-a` {
		t.Fatalf("error = %q", got)
	}
}

func TestMergeLLMFleetSetsAllowsSameRedisDBOnDifferentShards(t *testing.T) {
	existing := []LLMFleetSet{{Name: "set-a", ShardRef: "shard-a", RedisDB: "12"}}
	requests := []ProvisionRequest{
		{ID: "req-b", SetID: "set-b", ShardRef: "shard-b", RedisDB: "12"},
	}

	sets, _, changed, err := MergeLLMFleetSets(existing, requests, Config{Fleet: "prod", NewSetReplicas: 1})
	if err != nil {
		t.Fatal(err)
	}
	if !changed || len(sets) != 2 {
		t.Fatalf("sets=%+v changed=%v", sets, changed)
	}
}

func TestMergeLLMFleetSetsRejectsDuplicateRedisDBInsideExistingFleet(t *testing.T) {
	existing := []LLMFleetSet{
		{Name: "set-a", ShardRef: "shard-a", RedisDB: "12"},
		{Name: "set-b", ShardRef: "shard-a", RedisDB: "12"},
	}

	_, _, _, err := MergeLLMFleetSets(existing, nil, Config{Fleet: "prod", NewSetReplicas: 1})
	if err == nil {
		t.Fatal("expected existing duplicate redis db to fail")
	}
	if got := err.Error(); got != `redis db 12 on shard shard-a is already used by set set-a` {
		t.Fatalf("error = %q", got)
	}
}

func TestApplyCleanupToFleetRemovesSetAndFreezesShardRange(t *testing.T) {
	var fleet LLMFleet
	fleet.Spec.Shards = []LLMFleetShard{{Name: "shard-a", RedisDBStart: 10, RedisDBLimit: 32}}
	fleet.Spec.Sets = []LLMFleetSet{
		{Name: "set-a", ShardRef: "shard-a", DatabaseName: "newapi_set_a", RedisDB: "17"},
		{Name: "set-b", ShardRef: "shard-a", DatabaseName: "newapi_set_b", RedisDB: "18"},
	}
	fleet.Spec.TrafficRuntimes = []LLMFleetTrafficRuntime{
		{SetID: "set-a", Generation: 1, Image: "registry/new-api:a"},
		{SetID: "set-a", Generation: 2, Image: "registry/new-api:b"},
		{SetID: "set-b", Generation: 1, Image: "registry/new-api:a"},
	}
	payload := RuntimeCleanupPayload{
		CleanupID: "decom-a", SetID: "set-a", Attempt: 1, Source: "prod", Namespace: "llmgateway", Fleet: "prod",
		ShardRef: "shard-a", DatabaseName: "newapi_set_a", RedisDB: "17", LeaseFingerprint: "fingerprint",
		ClaimToken: "claim-token", CleanupCapability: "capability",
	}

	changed, err := ApplyCleanupToFleet(&fleet, payload)
	if err != nil {
		t.Fatal(err)
	}
	if !changed || len(fleet.Spec.Sets) != 1 || fleet.Spec.Sets[0].Name != "set-b" {
		t.Fatalf("sets after cleanup = %+v changed=%v", fleet.Spec.Sets, changed)
	}
	if len(fleet.Spec.TrafficRuntimes) != 1 || fleet.Spec.TrafficRuntimes[0].SetID != "set-b" {
		t.Fatalf("traffic runtimes after cleanup = %+v", fleet.Spec.TrafficRuntimes)
	}
	if len(fleet.Spec.Cleanups) != 1 {
		t.Fatalf("cleanups = %+v", fleet.Spec.Cleanups)
	}
	cleanup := fleet.Spec.Cleanups[0]
	if cleanup.RedisDBStart != 10 || cleanup.RedisDBLimit != 32 || cleanup.CleanupCapability != "capability" {
		t.Fatalf("cleanup = %+v", cleanup)
	}
}

func TestApplyCleanupToFleetUsesDNS1123RuntimeJobName(t *testing.T) {
	var fleet LLMFleet
	fleet.Spec.Shards = []LLMFleetShard{{Name: "shard-a", RedisDBStart: 0, RedisDBLimit: 256}}

	payload := RuntimeCleanupPayload{
		CleanupID: "set-decommission-SzK5P2u5NyC8IM0vNTtJZIs8aAt4JE1B", SetID: "set-a", Attempt: 7,
		Source: "prod", Namespace: "llmgateway", Fleet: "prod", ShardRef: "shard-a",
		DatabaseName: "newapi_set_a", RedisDB: "19", LeaseFingerprint: "fingerprint",
		ClaimToken: "claim-token", CleanupCapability: "capability",
	}

	changed, err := ApplyCleanupToFleet(&fleet, payload)
	if err != nil {
		t.Fatal(err)
	}
	if !changed || len(fleet.Spec.Cleanups) != 1 {
		t.Fatalf("cleanups = %+v changed=%v", fleet.Spec.Cleanups, changed)
	}
	cleanup := fleet.Spec.Cleanups[0]
	if cleanup.CleanupID != payload.CleanupID {
		t.Fatalf("cleanup id = %q, want original %q", cleanup.CleanupID, payload.CleanupID)
	}
	if !regexp.MustCompile(`^llmgw-cleanup-[a-f0-9]{32}-7$`).MatchString(cleanup.JobName) {
		t.Fatalf("job name = %q, want stable DNS-1123 name", cleanup.JobName)
	}

	var retryFleet LLMFleet
	retryFleet.Spec.Shards = fleet.Spec.Shards
	_, err = ApplyCleanupToFleet(&retryFleet, payload)
	if err != nil {
		t.Fatal(err)
	}
	if retryFleet.Spec.Cleanups[0].JobName != cleanup.JobName {
		t.Fatalf("job name changed: first=%q retry=%q", cleanup.JobName, retryFleet.Spec.Cleanups[0].JobName)
	}
}

func TestApplyCleanupToFleetRejectsRuntimePayloadDrift(t *testing.T) {
	var fleet LLMFleet
	fleet.Spec.Shards = []LLMFleetShard{{Name: "shard-a", RedisDBStart: 10, RedisDBLimit: 32}}
	fleet.Spec.Sets = []LLMFleetSet{{Name: "set-a", ShardRef: "shard-a", DatabaseName: "newapi_set_a", RedisDB: "17"}}

	_, err := ApplyCleanupToFleet(&fleet, RuntimeCleanupPayload{
		CleanupID: "decom-a", SetID: "set-a", Attempt: 1, ShardRef: "shard-a", DatabaseName: "newapi_other", RedisDB: "17",
	})
	if err == nil {
		t.Fatal("expected cleanup payload drift to fail")
	}
}

func TestApplyCleanupToFleetAllowsRetryAfterSetWasAlreadyRemoved(t *testing.T) {
	var fleet LLMFleet
	fleet.Spec.Shards = []LLMFleetShard{{Name: "shard-a", RedisDBStart: 10, RedisDBLimit: 32}}
	fleet.Spec.TrafficRuntimes = []LLMFleetTrafficRuntime{{SetID: "set-a", Generation: 3, Image: "registry/new-api:c"}}
	changed, err := ApplyCleanupToFleet(&fleet, RuntimeCleanupPayload{
		CleanupID: "decom-a", SetID: "set-a", Attempt: 2, Source: "prod", Namespace: "llmgateway", Fleet: "prod",
		ShardRef: "shard-a", DatabaseName: "newapi_set_a", RedisDB: "17", LeaseFingerprint: "fingerprint-2",
		ClaimToken: "claim-token-2", CleanupCapability: "capability-2",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !changed || len(fleet.Spec.Cleanups) != 1 || fleet.Spec.Cleanups[0].Attempt != 2 || len(fleet.Spec.TrafficRuntimes) != 0 {
		t.Fatalf("retry cleanup = %+v changed=%v", fleet.Spec.Cleanups, changed)
	}
}

func TestPruneOrphanTrafficRuntimesKeepsOnlyExistingSets(t *testing.T) {
	var fleet LLMFleet
	fleet.Spec.Sets = []LLMFleetSet{{Name: "set-a"}, {Name: "set-b"}}
	fleet.Spec.TrafficRuntimes = []LLMFleetTrafficRuntime{
		{SetID: "set-a", Generation: 1},
		{SetID: "set-deleted", Generation: 1},
		{SetID: "set-deleted", Generation: 2},
	}

	if removed := PruneOrphanTrafficRuntimes(&fleet); removed != 2 {
		t.Fatalf("removed = %d, want 2", removed)
	}
	if len(fleet.Spec.TrafficRuntimes) != 1 || fleet.Spec.TrafficRuntimes[0].SetID != "set-a" {
		t.Fatalf("traffic runtimes = %+v", fleet.Spec.TrafficRuntimes)
	}
	if removed := PruneOrphanTrafficRuntimes(&fleet); removed != 0 {
		t.Fatalf("second prune removed = %d, want idempotent 0", removed)
	}
}

func TestPatchLLMFleetRuntimeUsesOneResourceVersionGuardedPatch(t *testing.T) {
	var operations []map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPatch {
			t.Fatalf("method = %s", r.Method)
		}
		if got := r.Header.Get("Content-Type"); got != "application/json-patch+json" {
			t.Fatalf("content type = %q", got)
		}
		if err := json.NewDecoder(r.Body).Decode(&operations); err != nil {
			t.Fatal(err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{}`))
	}))
	defer server.Close()

	client := KubeClient{BaseURL: server.URL, HTTPClient: server.Client()}
	err := client.PatchLLMFleetRuntime(t.Context(), "prod", "fleet", "rv-7", []LLMFleetSet{{Name: "set-b"}}, []LLMFleetCleanup{{CleanupID: "decom-a"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(operations) != 3 || operations[0]["op"] != "test" || operations[0]["value"] != "rv-7" || operations[1]["path"] != "/spec/sets" || operations[2]["path"] != "/spec/cleanups" {
		t.Fatalf("patch operations = %+v", operations)
	}
}

func TestPatchLLMFleetDecommissionAtomicallyWritesOwnedState(t *testing.T) {
	var operations []map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPatch {
			t.Fatalf("method = %s", r.Method)
		}
		if got := r.Header.Get("Content-Type"); got != "application/json-patch+json" {
			t.Fatalf("content type = %q", got)
		}
		if err := json.NewDecoder(r.Body).Decode(&operations); err != nil {
			t.Fatal(err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{}`))
	}))
	defer server.Close()

	client := KubeClient{BaseURL: server.URL, HTTPClient: server.Client()}
	err := client.PatchLLMFleetDecommission(t.Context(), "prod", "fleet", "rv-9",
		[]LLMFleetSet{{Name: "set-b"}},
		[]LLMFleetTrafficRuntime{{SetID: "set-b", Generation: 1}},
		[]LLMFleetCleanup{{CleanupID: "decom-a"}},
	)
	if err != nil {
		t.Fatal(err)
	}
	wantPaths := []string{"/metadata/resourceVersion", "/spec/sets", "/spec/trafficRuntimes", "/spec/cleanups"}
	if len(operations) != len(wantPaths) {
		t.Fatalf("patch operations = %+v", operations)
	}
	for index, wantPath := range wantPaths {
		if operations[index]["path"] != wantPath {
			t.Fatalf("operation %d path = %v, want %s", index, operations[index]["path"], wantPath)
		}
	}
	if operations[0]["op"] != "test" || operations[0]["value"] != "rv-9" {
		t.Fatalf("resource version guard = %+v", operations[0])
	}
}

func TestApplySetUpgradeCandidateAndRetireLegacyRuntime(t *testing.T) {
	var fleet LLMFleet
	fleet.Metadata.Name = "prod"
	fleet.Spec.NewAPIImage = "registry/new-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	fleet.Spec.Sets = []LLMFleetSet{{Name: "set-a", Replicas: 3}}
	run := SetUpgradeRun{SetID: "set-a", FromGeneration: 0, ToGeneration: 1, TargetImage: "registry/new-api@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}

	baseURL, changed, err := ApplySetUpgradeCandidateToFleet(&fleet, run)
	if err != nil {
		t.Fatal(err)
	}
	if !changed || baseURL != "http://prod-set-a-g1-newapi-traffic:3000" || len(fleet.Spec.TrafficRuntimes) != 1 {
		t.Fatalf("baseURL=%q changed=%v runtimes=%+v", baseURL, changed, fleet.Spec.TrafficRuntimes)
	}
	if _, changed, err := ApplySetUpgradeCandidateToFleet(&fleet, run); err != nil || changed {
		t.Fatalf("idempotent apply changed=%v err=%v", changed, err)
	}
	changed, err = RetireSetUpgradeRuntimeFromFleet(&fleet, run, false)
	if err != nil || !changed || fleet.Spec.Sets[0].LegacyTrafficEnabled == nil || *fleet.Spec.Sets[0].LegacyTrafficEnabled {
		t.Fatalf("retire changed=%v set=%+v err=%v", changed, fleet.Spec.Sets[0], err)
	}
	if changed, err := ApplySetUpgradeMasterToFleet(&fleet, run); err != nil || !changed || fleet.Spec.Sets[0].AdminImage != run.TargetImage {
		t.Fatalf("master changed=%v set=%+v err=%v", changed, fleet.Spec.Sets[0], err)
	}
}

func TestSetUpgradeCurrentTrafficURLHandlesLegacyAndVersionedRuntime(t *testing.T) {
	if got := setUpgradeCurrentTrafficBaseURL("prod", "set-a", 0); got != "http://prod-set-a-newapi-traffic:3000" {
		t.Fatalf("legacy url=%q", got)
	}
	if got := setUpgradeCurrentTrafficBaseURL("prod", "set-a", 12); got != "http://prod-set-a-g12-newapi-traffic:3000" {
		t.Fatalf("versioned url=%q", got)
	}
}

func TestRetireSetUpgradeRuntimeRemovesVersionedGeneration(t *testing.T) {
	var fleet LLMFleet
	fleet.Spec.Sets = []LLMFleetSet{{Name: "set-a", Replicas: 2}}
	fleet.Spec.TrafficRuntimes = []LLMFleetTrafficRuntime{
		{SetID: "set-a", Generation: 12, Image: "old", Replicas: 2},
		{SetID: "set-a", Generation: 13, Image: "new", Replicas: 2},
	}
	run := SetUpgradeRun{SetID: "set-a", FromGeneration: 12, ToGeneration: 13}
	changed, err := RetireSetUpgradeRuntimeFromFleet(&fleet, run, false)
	if err != nil || !changed || len(fleet.Spec.TrafficRuntimes) != 1 || fleet.Spec.TrafficRuntimes[0].Generation != 13 {
		t.Fatalf("changed=%v runtimes=%+v err=%v", changed, fleet.Spec.TrafficRuntimes, err)
	}
}

func TestProbeSetUpgradeRuntimeChecksStatusAndInference(t *testing.T) {
	var statusCalls, chatCalls int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/status":
			statusCalls++
			w.WriteHeader(http.StatusOK)
		case "/v1/chat/completions":
			chatCalls++
			if r.Header.Get("Authorization") != "Bearer sk-probe" {
				t.Fatalf("authorization=%q", r.Header.Get("Authorization"))
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"}}]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	if err := ProbeSetUpgradeRuntime(t.Context(), server.Client(), server.URL, "sk-probe", "auto"); err != nil {
		t.Fatal(err)
	}
	if statusCalls != 1 || chatCalls != 1 {
		t.Fatalf("status=%d chat=%d", statusCalls, chatCalls)
	}
}

func TestWaitSetUpgradeRuntimeReadyDoesNotCountStartupFailures(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls < 3 {
			http.Error(w, "starting", http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	if err := WaitSetUpgradeRuntimeReady(t.Context(), server.Client(), server.URL, time.Second, time.Millisecond); err != nil {
		t.Fatal(err)
	}
	if calls != 3 {
		t.Fatalf("status calls=%d, want 3", calls)
	}
}

func TestWaitSetUpgradeRuntimeFunctionalReadyWaitsForPricingCache(t *testing.T) {
	chatCalls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/status":
			w.WriteHeader(http.StatusOK)
		case "/v1/chat/completions":
			chatCalls++
			if chatCalls < 3 {
				http.Error(w, "model price cache is still loading", http.StatusBadRequest)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"}}]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	err := WaitSetUpgradeRuntimeFunctionalReady(
		t.Context(), server.Client(), server.URL, "sk-probe", "llmgw-regression-upgrade-probe", time.Second, time.Millisecond,
	)
	if err != nil {
		t.Fatal(err)
	}
	if chatCalls != 3 {
		t.Fatalf("chat calls=%d, want 3", chatCalls)
	}
}

func TestFactsFromLLMFleetUsesServiceNames(t *testing.T) {
	var fleet LLMFleet
	fleet.Metadata.Name = "prod-fleet"
	fleet.Spec.Sets = []LLMFleetSet{
		{Name: "set-a", DisplayName: "Set A", ShardRef: "shard-a"},
		{Name: "set-b", ShardRef: "shard-b"},
	}

	facts := FactsFromLLMFleet(fleet)

	if len(facts) != 2 {
		t.Fatalf("facts = %d", len(facts))
	}
	if facts[0].Name != "Set A" {
		t.Fatalf("first fact name = %q", facts[0].Name)
	}
	if facts[0].BaseURL != "http://prod-fleet-set-a-newapi-admin:3000" {
		t.Fatalf("first fact base url = %q", facts[0].BaseURL)
	}
	if facts[0].TrafficBaseURL != "http://prod-fleet-set-a-newapi-traffic:3000" {
		t.Fatalf("first fact traffic base url = %q", facts[0].TrafficBaseURL)
	}
	if facts[0].DatabaseName != "" || facts[0].RedisDB != "" {
		t.Fatalf("first fact runtime = %s/%s, want empty when fleet set omits runtime", facts[0].DatabaseName, facts[0].RedisDB)
	}
	if facts[1].Name != "set-b" || facts[1].ShardRef != "shard-b" {
		t.Fatalf("second fact = %+v", facts[1])
	}
}

func TestFactsFromLLMFleetUsesInitialVersionedRuntime(t *testing.T) {
	var fleet LLMFleet
	fleet.Metadata.Name = "prod-fleet"
	disabled := false
	fleet.Spec.Sets = []LLMFleetSet{{Name: "set-a", LegacyTrafficEnabled: &disabled}}
	fleet.Spec.TrafficRuntimes = []LLMFleetTrafficRuntime{{
		SetID: "set-a", Generation: 1, Image: "registry/new-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	}}
	facts := FactsFromLLMFleet(fleet)
	if len(facts) != 1 {
		t.Fatalf("facts=%+v", facts)
	}
	if facts[0].RuntimeGeneration != 1 || facts[0].RuntimeImage != fleet.Spec.TrafficRuntimes[0].Image {
		t.Fatalf("runtime fact=%+v", facts[0])
	}
	if facts[0].TrafficBaseURL != "http://prod-fleet-set-a-g1-newapi-traffic:3000" {
		t.Fatalf("traffic url=%q", facts[0].TrafficBaseURL)
	}
}

func TestFactsFromLLMFleetIncludesRuntimeLeaseFields(t *testing.T) {
	var fleet LLMFleet
	fleet.Metadata.Name = "prod"
	fleet.Spec.Sets = []LLMFleetSet{{
		Name:         "set-a",
		ShardRef:     "shard-a",
		DatabaseName: "newapi_set_a",
		RedisDB:      "12",
	}}

	facts := FactsFromLLMFleet(fleet)

	if len(facts) != 1 {
		t.Fatalf("facts = %d", len(facts))
	}
	if facts[0].DatabaseName != "newapi_set_a" || facts[0].RedisDB != "12" {
		t.Fatalf("runtime fields = %s/%s", facts[0].DatabaseName, facts[0].RedisDB)
	}
}

func TestResolveSetRuntimeConfigUsesFleetDefaultsAndShardLeafOverrides(t *testing.T) {
	var fleet LLMFleet
	fleet.Spec.NewAPI.DatabasePool.Admin = LLMFleetDatabasePool{
		MaxOpenConns:       32,
		MaxIdleConns:       2,
		MaxLifetimeSeconds: 60,
	}
	fleet.Spec.NewAPI.DatabasePool.Traffic = LLMFleetDatabasePool{
		MaxOpenConns:       32,
		MaxIdleConns:       2,
		MaxLifetimeSeconds: 60,
	}
	fleet.Spec.NewAPI.SubscriptionWriteConcurrency = 8
	fleet.Spec.Shards = []LLMFleetShard{{
		Name:    "shard-b",
		MaxSets: 16,
		DatabasePool: LLMFleetDatabasePools{
			Admin: LLMFleetDatabasePool{MaxOpenConns: 24},
		},
	}}

	got, err := ResolveSetRuntimeConfig(fleet, "shard-b")
	if err != nil {
		t.Fatal(err)
	}
	if got.Admin.MaxOpenConns != 24 || got.Admin.MaxIdleConns != 2 || got.Admin.MaxLifetimeSeconds != 60 {
		t.Fatalf("admin pool = %+v", got.Admin)
	}
	if got.Traffic.MaxOpenConns != 32 || got.Traffic.MaxIdleConns != 2 || got.Traffic.MaxLifetimeSeconds != 60 {
		t.Fatalf("traffic pool = %+v", got.Traffic)
	}
	if got.SubscriptionWriteConcurrency != 8 {
		t.Fatalf("subscription concurrency = %d", got.SubscriptionWriteConcurrency)
	}
}

func TestResolveSetRuntimeConfigRejectsUnsafeSubscriptionConcurrency(t *testing.T) {
	var fleet LLMFleet
	fleet.Spec.NewAPI.DatabasePool.Admin = LLMFleetDatabasePool{MaxOpenConns: 12, MaxIdleConns: 2, MaxLifetimeSeconds: 60}
	fleet.Spec.NewAPI.DatabasePool.Traffic = LLMFleetDatabasePool{MaxOpenConns: 12, MaxIdleConns: 2, MaxLifetimeSeconds: 60}
	fleet.Spec.NewAPI.SubscriptionWriteConcurrency = 8
	fleet.Spec.Shards = []LLMFleetShard{{Name: "shard-a", MaxSets: 8}}

	if _, err := ResolveSetRuntimeConfig(fleet, "shard-a"); err == nil {
		t.Fatal("expected unsafe subscription concurrency to fail")
	}
}

func TestApplyFleetRuntimeConfigRefreshesExistingAndNewSets(t *testing.T) {
	var fleet LLMFleet
	fleet.Spec.NewAPI.DatabasePool.Admin = LLMFleetDatabasePool{MaxOpenConns: 32, MaxIdleConns: 2, MaxLifetimeSeconds: 60}
	fleet.Spec.NewAPI.DatabasePool.Traffic = LLMFleetDatabasePool{MaxOpenConns: 24, MaxIdleConns: 2, MaxLifetimeSeconds: 90}
	fleet.Spec.NewAPI.SubscriptionWriteConcurrency = 8
	fleet.Spec.Shards = []LLMFleetShard{{Name: "shard-a", MaxSets: 16}}
	fleet.Spec.Sets = []LLMFleetSet{{Name: "set-a", ShardRef: "shard-a", AdminSQLMaxOpenConns: 5}}

	changed, err := ApplyFleetRuntimeConfig(&fleet)
	if err != nil {
		t.Fatal(err)
	}
	if !changed {
		t.Fatal("expected existing set projection to change")
	}
	set := fleet.Spec.Sets[0]
	if set.AdminSQLMaxOpenConns != 32 || set.AdminSQLMaxIdleConns != 2 || set.AdminSQLMaxLifetimeSeconds != 60 {
		t.Fatalf("admin projection = %+v", set)
	}
	if set.TrafficSQLMaxOpenConns != 24 || set.TrafficSQLMaxIdleConns != 2 || set.TrafficSQLMaxLifetimeSeconds != 90 {
		t.Fatalf("traffic projection = %+v", set)
	}
	if set.SubscriptionWriteConcurrency != 8 {
		t.Fatalf("subscription concurrency = %d", set.SubscriptionWriteConcurrency)
	}
}

func TestSyncFleetShardsProjectsCapacityAndEffectivePool(t *testing.T) {
	var got ShardProjection
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/internal/set-manager/shards" {
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Fatal(err)
		}
		_, _ = w.Write([]byte(`{"success":true}`))
	}))
	defer server.Close()

	var fleet LLMFleet
	fleet.Spec.NewAPI.DatabasePool.Admin = LLMFleetDatabasePool{MaxOpenConns: 32, MaxIdleConns: 2, MaxLifetimeSeconds: 60}
	fleet.Spec.NewAPI.DatabasePool.Traffic = LLMFleetDatabasePool{MaxOpenConns: 24, MaxIdleConns: 2, MaxLifetimeSeconds: 90}
	fleet.Spec.NewAPI.SubscriptionWriteConcurrency = 8
	fleet.Spec.Shards = []LLMFleetShard{{
		Name: "shard-a", MySQLHost: "mysql.internal", MySQLPort: "3306",
		RedisHost: "redis.internal", RedisPort: "6379", SecretName: "newapi-shard-a",
		MaxSets: 16, RedisDBStart: 256, RedisDBLimit: 512,
	}}

	if err := syncFleetShards(t.Context(), ControlClient{BaseURL: server.URL, HTTPClient: server.Client()}, fleet); err != nil {
		t.Fatal(err)
	}
	if got.ID != "shard-a" || got.MaxSets != 16 || got.Endpoint != "mysql.internal:3306" {
		t.Fatalf("shard projection = %+v", got)
	}
	if got.RedisEndpoint != "redis.internal:6379" || got.SecretName != "newapi-shard-a" || got.RedisDBStart != 256 || got.RedisDBLimit != 512 {
		t.Fatalf("redis projection = %+v", got)
	}
	if got.AdminSQLMaxOpenConns != 32 || got.TrafficSQLMaxOpenConns != 24 || got.SubscriptionWriteConcurrency != 8 {
		t.Fatalf("runtime projection = %+v", got)
	}
}

func TestPatchLLMFleetSetsUsesResourceVersionGuard(t *testing.T) {
	var gotContentType string
	var gotPatch []map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPatch {
			t.Fatalf("method = %s", r.Method)
		}
		if r.URL.Path != "/apis/llmgateway.io/v1alpha1/namespaces/prod/llmfleets/prod" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		gotContentType = r.Header.Get("Content-Type")
		if err := json.NewDecoder(r.Body).Decode(&gotPatch); err != nil {
			t.Fatal(err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{}`))
	}))
	defer server.Close()

	err := (KubeClient{BaseURL: server.URL, HTTPClient: server.Client()}).PatchLLMFleetSets(
		context.Background(),
		"prod",
		"prod",
		"12345",
		[]LLMFleetSet{{Name: "set-a", ShardRef: "shard-a"}},
	)
	if err != nil {
		t.Fatal(err)
	}
	if gotContentType != "application/json-patch+json" {
		t.Fatalf("content type = %q", gotContentType)
	}
	if len(gotPatch) != 2 {
		t.Fatalf("patch len = %d", len(gotPatch))
	}
	if gotPatch[0]["op"] != "test" || gotPatch[0]["path"] != "/metadata/resourceVersion" || gotPatch[0]["value"] != "12345" {
		t.Fatalf("missing resourceVersion guard: %#v", gotPatch[0])
	}
	if gotPatch[1]["op"] != "replace" || gotPatch[1]["path"] != "/spec/sets" {
		t.Fatalf("missing sets replace: %#v", gotPatch[1])
	}
}
