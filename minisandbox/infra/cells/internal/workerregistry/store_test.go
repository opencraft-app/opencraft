package workerregistry

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestStoreVersionDeploymentAndRestart(t *testing.T) {
	root := t.TempDir()
	store := mustStore(t, root)
	request := validRequest("export default { fetch() { return new Response('one') } }")

	first, created, err := store.PutWorker(context.Background(), "default", "hello", request)
	if err != nil {
		t.Fatal(err)
	}
	if !created {
		t.Fatal("first upload did not create a version")
	}
	second, created, err := store.PutWorker(context.Background(), "default", "hello", request)
	if err != nil {
		t.Fatal(err)
	}
	if created {
		t.Fatal("identical upload created a second version")
	}
	if first.Versions[0].VersionID != second.Versions[0].VersionID {
		t.Fatalf("identical upload changed version: %s != %s", first.Versions[0].VersionID, second.Versions[0].VersionID)
	}

	request.Modules[request.MainModule] = "export default { fetch() { return new Response('two') } }"
	third, created, err := store.PutWorker(context.Background(), "default", "hello", request)
	if err != nil {
		t.Fatal(err)
	}
	if !created || third.Versions[0].VersionID == first.Versions[0].VersionID {
		t.Fatal("changed source did not create a distinct version")
	}
	oldVersion, err := store.GetVersion(context.Background(), "default", "hello", first.Versions[0].VersionID)
	if err != nil {
		t.Fatal(err)
	}
	if oldVersion.Content.Modules[oldVersion.Content.MainModule] == request.Modules[request.MainModule] {
		t.Fatal("old immutable version was overwritten")
	}

	restarted := mustStore(t, root)
	active, err := restarted.GetWorker(context.Background(), "default", "hello")
	if err != nil {
		t.Fatal(err)
	}
	if active.Versions[0].VersionID != third.Versions[0].VersionID {
		t.Fatalf("restart lost deployment: got %s, want %s", active.Versions[0].VersionID, third.Versions[0].VersionID)
	}
}

func TestStoreVersionIdentityIncludesDurableObjectConfiguration(t *testing.T) {
	store := mustStore(t, t.TempDir())
	request := validRequest("export class Counter {}; export default {}")
	request.DurableObjects = map[string]string{"COUNTER": "Counter"}
	first, created, err := store.UploadVersion(context.Background(), "default", "configured", request)
	if err != nil || !created {
		t.Fatalf("upload first config: created=%v err=%v", created, err)
	}

	request.DurableObjects = map[string]string{"COUNTER": "RenamedCounter"}
	second, created, err := store.UploadVersion(context.Background(), "default", "configured", request)
	if err != nil || !created {
		t.Fatalf("upload changed config: created=%v err=%v", created, err)
	}
	if first.VersionID == second.VersionID {
		t.Fatal("identical code with different Durable Object config reused one Version")
	}
	if len(first.DurableObjectNamespaces) != 1 || len(second.DurableObjectNamespaces) != 1 {
		t.Fatalf("unexpected namespace inventory: first=%+v second=%+v", first, second)
	}
	stored, err := store.GetVersion(context.Background(), "default", "configured", second.VersionID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Content.Bindings["COUNTER"].ClassName != "RenamedCounter" || stored.Content.Exports["RenamedCounter"].Storage != DurableObjectSQLite {
		t.Fatalf("immutable Version lost binding/export config: %+v", stored.Content)
	}
}

func TestVersionIdentityTreatsOmittedEmptyInventoryAsEmpty(t *testing.T) {
	left := VersionSummary{
		VersionID:         "v_" + strings.Repeat("a", 64),
		Digest:            "sha256:" + strings.Repeat("a", 64),
		CreatedAt:         time.Unix(1, 0),
		MainModule:        "main.js",
		ModuleCount:       1,
		CompatibilityDate: "2026-08-14",
	}
	right := left
	right.CreatedAt = time.Unix(2, 0)
	right.DurableObjectNamespaces = []DurableObjectNamespace{}
	if !sameVersionIdentity(left, right) {
		t.Fatal("server timestamp or nil/empty JSON normalization changed immutable Version identity")
	}
}

func TestStoreDeleteRejectsHistoricalDurableObjectNamespace(t *testing.T) {
	store := mustStore(t, t.TempDir())
	withObject := validRequest("export class Counter {}; export default {}")
	withObject.DurableObjects = map[string]string{"COUNTER": "Counter"}
	if _, _, err := store.PutWorker(context.Background(), "default", "durable", withObject); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.PutWorker(context.Background(), "default", "durable", validRequest("export default {}")); err != nil {
		t.Fatal(err)
	}
	if err := store.DeleteWorker(context.Background(), "default", "durable"); !errors.Is(err, ErrDurableObjectNamespaces) {
		t.Fatalf("delete error = %v, want ErrDurableObjectNamespaces", err)
	}
	if _, err := store.GetWorker(context.Background(), "default", "durable"); err != nil {
		t.Fatalf("blocked delete removed the active Worker: %v", err)
	}
}

func TestStoreDurableObjectTombstoneSurvivesRestart(t *testing.T) {
	root := t.TempDir()
	store := mustStore(t, root)
	request := validRequest("export class Counter {}; export default {}")
	request.DurableObjects = map[string]string{"COUNTER": "Counter"}
	if _, _, err := store.PutWorker(context.Background(), "default", "counter", request); err != nil {
		t.Fatal(err)
	}
	objectID := strings.Repeat("a", 64)
	if _, err := store.ClaimObject(context.Background(), "default", "counter", "Counter", objectID, nil); !errors.Is(err, ErrPlacementRequired) {
		t.Fatalf("new claim without placement = %v, want ErrPlacementRequired", err)
	}
	record, err := store.ClaimObject(context.Background(), "default", "counter", "Counter", objectID, testObjectPlacement())
	if err != nil || record.State != ObjectStateActive || record.ActorID != "" {
		t.Fatalf("claim = %+v, err=%v", record, err)
	}
	if !reflect.DeepEqual(record.Placement, testObjectPlacement()) {
		t.Fatalf("claim placement = %+v, want %+v", record.Placement, testObjectPlacement())
	}
	if count, err := store.GetCellPlacementCount(context.Background(), "actor-bj-a01", "cell-uid"); err != nil || count != 1 {
		t.Fatalf("placement count after claim = %d, err=%v; want 1", count, err)
	}
	competing := *testObjectPlacement()
	competing.CellName, competing.CellUID, competing.Datacenter = "actor-bj-b01", "other-cell-uid", "local-runtime-b"
	winner, err := store.ClaimObject(context.Background(), "default", "counter", "Counter", objectID, &competing)
	if err != nil || !reflect.DeepEqual(winner.Placement, testObjectPlacement()) {
		t.Fatalf("competing placement replaced the FDB winner: %+v, err=%v", winner.Placement, err)
	}
	record, err = store.ActivateObject(context.Background(), "default", "counter", "Counter", objectID, "actor-1")
	if err != nil || record.ActorID != "actor-1" {
		t.Fatalf("activate = %+v, err=%v", record, err)
	}
	observed, err := store.GetObject(context.Background(), "default", "counter", "Counter", objectID)
	if err != nil || !reflect.DeepEqual(observed, record) {
		t.Fatalf("get object = %+v, err=%v; want %+v", observed, err, record)
	}

	restarted := mustStore(t, root)
	if count, err := restarted.GetCellPlacementCount(context.Background(), "actor-bj-a01", "cell-uid"); err != nil || count != 1 {
		t.Fatalf("placement count after restart = %d, err=%v; want 1", count, err)
	}
	persisted, err := restarted.ClaimObject(context.Background(), "default", "counter", "Counter", objectID, nil)
	if err != nil || !reflect.DeepEqual(persisted.Placement, testObjectPlacement()) {
		t.Fatalf("persisted placement = %+v, err=%v", persisted.Placement, err)
	}
	record, err = restarted.DeleteObject(context.Background(), "default", "counter", "Counter", objectID)
	if err != nil || record.State != ObjectStateDeleted || record.ActorID != "actor-1" || record.DeletedAt == nil {
		t.Fatalf("delete = %+v, err=%v", record, err)
	}
	if count, err := restarted.GetCellPlacementCount(context.Background(), "actor-bj-a01", "cell-uid"); err != nil || count != 0 {
		t.Fatalf("placement count after delete = %d, err=%v; want 0", count, err)
	}
	if _, err := restarted.ClaimObject(context.Background(), "default", "counter", "Counter", objectID, nil); !errors.Is(err, ErrObjectDeleted) {
		t.Fatalf("claim after delete = %v, want ErrObjectDeleted", err)
	}
	again, err := restarted.DeleteObject(context.Background(), "default", "counter", "Counter", objectID)
	if err != nil || !reflect.DeepEqual(record, again) {
		t.Fatalf("idempotent delete = %+v, err=%v; want %+v", again, err, record)
	}
	if count, err := restarted.GetCellPlacementCount(context.Background(), "actor-bj-a01", "cell-uid"); err != nil || count != 0 {
		t.Fatalf("placement count after repeated delete = %d, err=%v; want 0", count, err)
	}
	if _, err := restarted.ClaimObject(context.Background(), "default", "counter", "Missing", objectID, nil); !errors.Is(err, ErrObjectClassNotFound) {
		t.Fatalf("missing class claim = %v, want ErrObjectClassNotFound", err)
	}
}

func testObjectPlacement() *ObjectPlacement {
	return &ObjectPlacement{
		PoolName: "pool-a", PoolUID: "pool-uid", SnapshotResourceVersion: "17",
		SnapshotDigest: "sha256:" + strings.Repeat("c", 64), CellName: "actor-bj-a01",
		CellUID: "cell-uid", Datacenter: "local-runtime-a",
		DecidedAt: time.Date(2026, 9, 9, 0, 0, 0, 0, time.UTC),
	}
}

func TestStorePlacementCountSurvivesCompetingLifecycleCalls(t *testing.T) {
	store := mustStore(t, t.TempDir())
	request := validRequest("export class Counter {}; export default {}")
	request.DurableObjects = map[string]string{"COUNTER": "Counter"}
	if _, _, err := store.PutWorker(context.Background(), "default", "counter", request); err != nil {
		t.Fatal(err)
	}
	objectID := strings.Repeat("d", 64)
	var wait sync.WaitGroup
	errors := make(chan error, 64)
	for range 64 {
		wait.Add(1)
		go func() {
			defer wait.Done()
			_, err := store.ClaimObject(context.Background(), "default", "counter", "Counter", objectID, testObjectPlacement())
			errors <- err
		}()
	}
	wait.Wait()
	close(errors)
	for err := range errors {
		if err != nil {
			t.Fatal(err)
		}
	}
	if count, err := store.GetCellPlacementCount(context.Background(), "actor-bj-a01", "cell-uid"); err != nil || count != 1 {
		t.Fatalf("count after competing claims = %d, err=%v; want 1", count, err)
	}
	errors = make(chan error, 64)
	for range 64 {
		wait.Add(1)
		go func() {
			defer wait.Done()
			_, err := store.DeleteObject(context.Background(), "default", "counter", "Counter", objectID)
			errors <- err
		}()
	}
	wait.Wait()
	close(errors)
	for err := range errors {
		if err != nil {
			t.Fatal(err)
		}
	}
	if count, err := store.GetCellPlacementCount(context.Background(), "actor-bj-a01", "cell-uid"); err != nil || count != 0 {
		t.Fatalf("count after competing deletes = %d, err=%v; want 0", count, err)
	}
}

func TestStoreRejectsInvalidVersionRetention(t *testing.T) {
	for _, retention := range []int{0, MaxVersionRetention + 1} {
		if _, err := NewStoreWithRetention(t.TempDir(), retention); err == nil {
			t.Fatalf("retention %d was accepted", retention)
		}
	}
}

func TestStoreConcurrentUploadsRemainConsistent(t *testing.T) {
	store := mustStore(t, t.TempDir())
	requests := []PutWorkerRequest{
		validRequest("export default { fetch() { return new Response('a') } }"),
		validRequest("export default { fetch() { return new Response('b') } }"),
	}
	var wait sync.WaitGroup
	errors := make(chan error, 32)
	for index := 0; index < 32; index++ {
		wait.Add(1)
		go func(request PutWorkerRequest) {
			defer wait.Done()
			_, _, err := store.PutWorker(context.Background(), "default", "concurrent", request)
			errors <- err
		}(requests[index%len(requests)])
	}
	wait.Wait()
	close(errors)
	for err := range errors {
		if err != nil {
			t.Fatal(err)
		}
	}
	active, err := store.GetWorker(context.Background(), "default", "concurrent")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.GetVersion(context.Background(), "default", "concurrent", active.Versions[0].VersionID); err != nil {
		t.Fatal(err)
	}
}

func TestStoreDeploymentCompareAndSwap(t *testing.T) {
	store := mustStore(t, t.TempDir())
	v1, _, err := store.UploadVersion(context.Background(), "default", "cas", validRequest("export default { fetch() { return new Response('v1') } }"))
	if err != nil {
		t.Fatal(err)
	}
	v2, _, err := store.UploadVersion(context.Background(), "default", "cas", validRequest("export default { fetch() { return new Response('v2') } }"))
	if err != nil {
		t.Fatal(err)
	}
	noActive := ""
	first, err := store.CreateDeployment(context.Background(), "default", "cas", CreateDeploymentRequest{
		Strategy: PercentageStrategy, Versions: []DeploymentVersion{{VersionID: v1.VersionID, Percentage: 100}}, ExpectedDeploymentID: &noActive,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.CreateDeployment(context.Background(), "default", "cas", CreateDeploymentRequest{
		Strategy: PercentageStrategy, Versions: []DeploymentVersion{{VersionID: v2.VersionID, Percentage: 100}}, ExpectedDeploymentID: &noActive,
	}); !errors.Is(err, ErrDeploymentConflict) {
		t.Fatalf("stale deployment error = %v, want ErrDeploymentConflict", err)
	}
	expected := first.Deployment.ID
	second, err := store.CreateDeployment(context.Background(), "default", "cas", CreateDeploymentRequest{
		Strategy: PercentageStrategy, Versions: []DeploymentVersion{{VersionID: v2.VersionID, Percentage: 100}}, ExpectedDeploymentID: &expected,
	})
	if err != nil {
		t.Fatal(err)
	}
	if second.Versions[0].VersionID != v2.VersionID {
		t.Fatalf("CAS deployment activated %s, want %s", second.Versions[0].VersionID, v2.VersionID)
	}
}

func TestStoreUploadAndGradualDeploymentAreIndependent(t *testing.T) {
	root := t.TempDir()
	store := mustStore(t, root)
	v1, created, err := store.UploadVersion(context.Background(), "default", "gradual", validRequest("export default { fetch() { return new Response('v1') } }"))
	if err != nil || !created {
		t.Fatalf("upload v1: created=%v err=%v", created, err)
	}
	v2, created, err := store.UploadVersion(context.Background(), "default", "gradual", validRequest("export default { fetch() { return new Response('v2') } }"))
	if err != nil || !created {
		t.Fatalf("upload v2: created=%v err=%v", created, err)
	}
	if _, err := store.GetWorker(context.Background(), "default", "gradual"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("version upload unexpectedly deployed code: %v", err)
	}

	deployed, err := store.CreateDeployment(context.Background(), "default", "gradual", CreateDeploymentRequest{
		Strategy: PercentageStrategy,
		Versions: []DeploymentVersion{
			{VersionID: v1.VersionID, Percentage: 75},
			{VersionID: v2.VersionID, Percentage: 25},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !validDeploymentID(deployed.Deployment.ID) || len(deployed.Versions) != 2 || !reflect.DeepEqual(deployed.Versions[0], v1) || !reflect.DeepEqual(deployed.Versions[1], v2) {
		t.Fatalf("unexpected gradual deployment: %#v", deployed)
	}

	restarted := mustStore(t, root)
	recovered, err := restarted.GetWorker(context.Background(), "default", "gradual")
	if err != nil {
		t.Fatal(err)
	}
	if recovered.Deployment.ID != deployed.Deployment.ID || len(recovered.Versions) != 2 {
		t.Fatalf("restart lost gradual deployment: %#v", recovered)
	}
	if !reflect.DeepEqual(recovered.Deployment.Versions, deployed.Deployment.Versions) {
		t.Fatalf("restart reordered gradual deployment targets: got %#v want %#v", recovered.Deployment.Versions, deployed.Deployment.Versions)
	}
}

func TestStoreRetainsFiveDeployableVersionsAndDeploymentHistory(t *testing.T) {
	store, err := NewStoreWithRetention(t.TempDir(), 5)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 9, 1, 1, 0, 0, 0, time.UTC)
	store.now = func() time.Time {
		result := now
		now = now.Add(time.Second)
		return result
	}

	versions := make([]VersionSummary, 0, 6)
	for index := 1; index <= 6; index++ {
		version, created, err := store.UploadVersion(context.Background(), "default", "retained", validRequest(fmt.Sprintf("export default { fetch() { return new Response('v%d') } }", index)))
		if err != nil || !created {
			t.Fatalf("upload v%d: created=%v err=%v", index, created, err)
		}
		versions = append(versions, version)
	}

	listed, err := store.ListVersions(context.Background(), "default", "retained", 1, 10)
	if err != nil {
		t.Fatal(err)
	}
	if listed.Retention != 5 || listed.GCMode != "report_only" || len(listed.Versions) != 6 {
		t.Fatalf("unexpected version retention view: %+v", listed)
	}
	for index, record := range listed.Versions {
		if got, want := record.VersionID, versions[5-index].VersionID; got != want {
			t.Fatalf("version %d order: got %s want %s", index, got, want)
		}
		if got, want := record.Deployable, index < 5; got != want {
			t.Fatalf("version %d deployable=%v want %v", index, got, want)
		}
	}
	oldest := listed.Versions[5]
	if oldest.GCStatus != VersionGCStatusCandidateReportOnly || oldest.GCBlockedReason != "actor_pin_index_unavailable" {
		t.Fatalf("oldest version is not a report-only GC candidate: %+v", oldest)
	}

	if _, err := store.CreateDeployment(context.Background(), "default", "retained", CreateDeploymentRequest{
		Strategy: PercentageStrategy, Versions: []DeploymentVersion{{VersionID: versions[0].VersionID, Percentage: 100}},
	}); !errors.Is(err, ErrVersionNotDeployable) {
		t.Fatalf("oldest version deployment error=%v, want ErrVersionNotDeployable", err)
	}
	first, err := store.CreateDeployment(context.Background(), "default", "retained", CreateDeploymentRequest{
		Strategy: PercentageStrategy, Versions: []DeploymentVersion{{VersionID: versions[5].VersionID, Percentage: 100}},
	})
	if err != nil {
		t.Fatal(err)
	}
	second, err := store.CreateDeployment(context.Background(), "default", "retained", CreateDeploymentRequest{
		Strategy: PercentageStrategy, Versions: []DeploymentVersion{{VersionID: versions[1].VersionID, Percentage: 100}},
	})
	if err != nil {
		t.Fatal(err)
	}
	history, err := store.ListDeployments(context.Background(), "default", "retained", 1, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(history.Deployments) != 2 || history.Deployments[0].ID != second.Deployment.ID || !history.Deployments[0].Active || !history.Deployments[0].RollbackAvailable {
		t.Fatalf("unexpected deployment history: %+v", history)
	}
	if err := store.DeleteDeployment(context.Background(), "default", "retained", second.Deployment.ID); !errors.Is(err, ErrActiveDeployment) {
		t.Fatalf("delete active deployment error=%v", err)
	}
	if err := store.DeleteDeployment(context.Background(), "default", "retained", first.Deployment.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.GetDeployment(context.Background(), "default", "retained", first.Deployment.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted deployment error=%v, want ErrNotFound", err)
	}
}

func TestStoreRejectsInvalidOrMissingDeploymentVersionsWithoutReplacingActive(t *testing.T) {
	store := mustStore(t, t.TempDir())
	active, _, err := store.PutWorker(context.Background(), "default", "hello", validRequest("export default {}"))
	if err != nil {
		t.Fatal(err)
	}
	invalid := []CreateDeploymentRequest{
		{Strategy: PercentageStrategy, Versions: []DeploymentVersion{{VersionID: active.Versions[0].VersionID, Percentage: 99.99}}},
		{Strategy: PercentageStrategy, Versions: []DeploymentVersion{{VersionID: active.Versions[0].VersionID, Percentage: 50}, {VersionID: active.Versions[0].VersionID, Percentage: 50}}},
		{Strategy: PercentageStrategy, Versions: []DeploymentVersion{{VersionID: "v_" + strings.Repeat("f", 64), Percentage: 100}}},
	}
	for _, request := range invalid {
		if _, err := store.CreateDeployment(context.Background(), "default", "hello", request); err == nil {
			t.Fatalf("invalid deployment was accepted: %#v", request)
		}
	}
	current, err := store.GetWorker(context.Background(), "default", "hello")
	if err != nil {
		t.Fatal(err)
	}
	if current.Deployment.ID != active.Deployment.ID {
		t.Fatal("failed deployment replaced the active pointer")
	}
}

func TestStoreRejectsGradualRolloutThatRebindsDurableObjectNamespace(t *testing.T) {
	store := mustStore(t, t.TempDir())
	firstRequest := validRequest("export class Counter {}; export default {}")
	firstRequest.DurableObjects = map[string]string{"COUNTER": "Counter"}
	first, _, err := store.UploadVersion(context.Background(), "default", "counter", firstRequest)
	if err != nil {
		t.Fatal(err)
	}
	secondRequest := validRequest("export class DifferentCounter {}; export default {}")
	secondRequest.DurableObjects = map[string]string{"COUNTER": "DifferentCounter"}
	second, _, err := store.UploadVersion(context.Background(), "default", "counter", secondRequest)
	if err != nil {
		t.Fatal(err)
	}
	_, err = store.CreateDeployment(context.Background(), "default", "counter", CreateDeploymentRequest{
		Strategy: PercentageStrategy,
		Versions: []DeploymentVersion{
			{VersionID: first.VersionID, Percentage: 90},
			{VersionID: second.VersionID, Percentage: 10},
		},
	})
	if !errors.Is(err, ErrIncompatibleRolloutBindings) {
		t.Fatalf("rollout error = %v, want ErrIncompatibleRolloutBindings", err)
	}

	compatibleRequest := validRequest("export class Counter {}; export default { fetch() {} }")
	compatibleRequest.DurableObjects = map[string]string{"COUNTER": "Counter"}
	compatible, _, err := store.UploadVersion(context.Background(), "default", "counter", compatibleRequest)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.CreateDeployment(context.Background(), "default", "counter", CreateDeploymentRequest{
		Strategy: PercentageStrategy,
		Versions: []DeploymentVersion{
			{VersionID: first.VersionID, Percentage: 50},
			{VersionID: compatible.VersionID, Percentage: 50},
		},
	}); err != nil {
		t.Fatalf("compatible rollout failed: %v", err)
	}
}

func TestStoreListsWorkersInStableOrder(t *testing.T) {
	store := mustStore(t, t.TempDir())
	for _, name := range []string{"zebra", "alpha", "middle"} {
		if _, _, err := store.PutWorker(context.Background(), "default", name, validRequest("export default {}")); err != nil {
			t.Fatal(err)
		}
	}
	workers, err := store.ListWorkers(context.Background(), "default")
	if err != nil {
		t.Fatal(err)
	}
	for index, want := range []string{"alpha", "middle", "zebra"} {
		if workers[index].Name != want {
			t.Fatalf("worker %d = %q, want %q", index, workers[index].Name, want)
		}
	}
}

func TestStoreDeleteRetainsImmutableVersion(t *testing.T) {
	store := mustStore(t, t.TempDir())
	worker, _, err := store.PutWorker(context.Background(), "default", "hello", validRequest("export default {}"))
	if err != nil {
		t.Fatal(err)
	}
	if err := store.DeleteWorker(context.Background(), "default", "hello"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.GetWorker(context.Background(), "default", "hello"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted Worker lookup error = %v, want ErrNotFound", err)
	}
	if _, err := store.GetVersion(context.Background(), "default", "hello", worker.Versions[0].VersionID); err != nil {
		t.Fatalf("delete removed immutable version: %v", err)
	}
	workers, err := store.ListWorkers(context.Background(), "default")
	if err != nil {
		t.Fatal(err)
	}
	if len(workers) != 0 {
		t.Fatalf("deleted Worker remained in list: %#v", workers)
	}
}

func TestStoreRejectsCorruptedVersion(t *testing.T) {
	root := t.TempDir()
	store := mustStore(t, root)
	worker, _, err := store.PutWorker(context.Background(), "default", "hello", validRequest("export default {}"))
	if err != nil {
		t.Fatal(err)
	}
	versionPath := filepath.Join(root, "v5", "namespaces", "default", "workers", "hello", "versions", worker.Versions[0].VersionID+".json")
	encoded, err := os.ReadFile(versionPath)
	if err != nil {
		t.Fatal(err)
	}
	var version WorkerVersion
	if err := json.Unmarshal(encoded, &version); err != nil {
		t.Fatal(err)
	}
	version.Content.Modules[version.Content.MainModule] = "tampered"
	encoded, err = json.Marshal(version)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(versionPath, encoded, 0o640); err != nil {
		t.Fatal(err)
	}
	if _, err := store.GetWorker(context.Background(), "default", "hello"); err == nil {
		t.Fatal("corrupted version was accepted")
	}
}

func TestStoreRejectsInvalidInput(t *testing.T) {
	store := mustStore(t, t.TempDir())
	tests := []struct {
		name      string
		namespace string
		worker    string
		request   PutWorkerRequest
	}{
		{name: "namespace traversal", namespace: "../bad", worker: "worker", request: validRequest("ok")},
		{name: "worker traversal", namespace: "default", worker: "../bad", request: validRequest("ok")},
		{name: "module traversal", namespace: "default", worker: "worker", request: PutWorkerRequest{MainModule: "../main.js", Modules: map[string]string{"../main.js": "ok"}, CompatibilityDate: "2026-08-26"}},
		{name: "missing main", namespace: "default", worker: "worker", request: PutWorkerRequest{MainModule: "main.js", Modules: map[string]string{"other.js": "ok"}, CompatibilityDate: "2026-08-26"}},
		{name: "bad date", namespace: "default", worker: "worker", request: PutWorkerRequest{MainModule: "main.js", Modules: map[string]string{"main.js": "ok"}, CompatibilityDate: "today"}},
		{name: "bad Durable Object binding", namespace: "default", worker: "worker", request: PutWorkerRequest{MainModule: "main.js", Modules: map[string]string{"main.js": "ok"}, CompatibilityDate: "2026-08-26", DurableObjects: map[string]string{"bad-binding": "Counter"}}},
		{name: "bad Durable Object class", namespace: "default", worker: "worker", request: PutWorkerRequest{MainModule: "main.js", Modules: map[string]string{"main.js": "ok"}, CompatibilityDate: "2026-08-26", DurableObjects: map[string]string{"COUNTER": "bad-class"}}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, _, err := store.PutWorker(context.Background(), test.namespace, test.worker, test.request); err == nil {
				t.Fatal("invalid input was accepted")
			}
		})
	}
}

func mustStore(t *testing.T, root string) *Store {
	t.Helper()
	store, err := NewStore(root)
	if err != nil {
		t.Fatal(err)
	}
	store.now = func() time.Time { return time.Date(2026, 8, 26, 12, 0, 0, 0, time.UTC) }
	return store
}

func validRequest(source string) PutWorkerRequest {
	return PutWorkerRequest{
		MainModule:         "main.js",
		Modules:            map[string]string{"main.js": source},
		CompatibilityDate:  "2026-08-26",
		CompatibilityFlags: []string{"nodejs_compat"},
	}
}
