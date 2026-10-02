package workersapi

import (
	"context"
	"strings"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	kubefake "k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"
)

func placementPool(candidates ...string) *unstructured.Unstructured {
	items := make([]any, len(candidates))
	for index, candidate := range candidates {
		items[index] = candidate
	}
	return &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "fleet.actor.dev/v1alpha1", "kind": "ShardPool",
		"metadata": map[string]any{
			"name": "pool-a", "namespace": "actor-fleet-system", "uid": "pool-uid",
			"generation": int64(3), "resourceVersion": "19",
		},
		"status": map[string]any{
			"observedGeneration": int64(3), "admissionOpen": true,
			"admissionCandidates": items,
		},
	}}
}

func placementCell(name, uid string, reportAt time.Time) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "fleet.actor.dev/v1alpha1", "kind": "RivetCell",
		"metadata": map[string]any{
			"name": name, "namespace": "actor-fleet-system", "uid": "logical-" + uid,
			"generation": int64(5), "resourceVersion": "23",
			"labels": map[string]any{"fleet.actor.dev/pool": "pool-a"},
		},
		"spec": map[string]any{"desiredState": "Ready"},
		"status": map[string]any{
			"observedGeneration": int64(5), "phase": "Ready", "readyForPlacement": true,
			"capacityRisk": "Normal", "reportObservedAt": reportAt.Format(time.RFC3339),
			"spokeCellRef": map[string]any{"uid": uid, "observedGeneration": int64(5)},
		},
	}}
}

func placementRoute(name, uid, datacenter string) *corev1.ConfigMap {
	immutable := true
	return &corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{
			Name: "actor-cell-route-" + name, Namespace: "workers-api-system",
			UID: types.UID("route-" + uid), Labels: map[string]string{cellRouteLabel: "true"},
		},
		Immutable: &immutable,
		Data: map[string]string{
			"pool-name": "pool-a", "pool-uid": "pool-uid", "cell-name": name,
			"cell-uid": uid, "datacenter": datacenter,
		},
	}
}

func testKubernetesResolver(t *testing.T, now time.Time, objects ...runtime.Object) *KubernetesPlacementResolver {
	t.Helper()
	dynamicObjects := []runtime.Object{}
	kubeObjects := []runtime.Object{}
	for _, object := range objects {
		switch object.(type) {
		case *unstructured.Unstructured:
			dynamicObjects = append(dynamicObjects, object)
		default:
			kubeObjects = append(kubeObjects, object)
		}
	}
	resolver, err := NewKubernetesPlacementResolver(
		dynamicfake.NewSimpleDynamicClient(runtime.NewScheme(), dynamicObjects...),
		kubefake.NewSimpleClientset(kubeObjects...),
		"actor-fleet-system", "pool-a", "workers-api-system", 30*time.Second, time.Second,
	)
	if err != nil {
		t.Fatal(err)
	}
	resolver.now = func() time.Time { return now }
	return resolver
}

func TestKubernetesPlacementBindsFreshSpokeUIDAndSnapshot(t *testing.T) {
	now := time.Date(2026, 9, 9, 1, 0, 0, 0, time.UTC)
	resolver := testKubernetesResolver(t, now,
		placementPool("actor-bj-a01", "actor-bj-b01"),
		placementCell("actor-bj-a01", "spoke-a", now.Add(-time.Second)),
		placementCell("actor-bj-b01", "spoke-b", now.Add(-2*time.Second)),
		placementRoute("actor-bj-a01", "spoke-a", "local-runtime-a"),
		placementRoute("actor-bj-b01", "spoke-b", "local-runtime-b"),
	)
	first, err := resolver.Resolve(context.Background(), "worker\x00class\x00object")
	if err != nil {
		t.Fatal(err)
	}
	second, err := resolver.Resolve(context.Background(), "worker\x00class\x00object")
	if err != nil || first.CellUID != second.CellUID {
		t.Fatalf("stable resolution changed: first=%+v second=%+v err=%v", first, second, err)
	}
	if first.PoolUID != "pool-uid" || first.SnapshotResourceVersion != "19" || !digestPattern.MatchString(first.SnapshotDigest) {
		t.Fatalf("placement lost snapshot identity: %+v", first)
	}
	if first.CellUID != "spoke-a" && first.CellUID != "spoke-b" {
		t.Fatalf("placement selected an unknown Cell: %+v", first)
	}
	candidates, err := resolver.AdmissionCandidates(context.Background())
	if err != nil || len(candidates) != 2 || candidates[0].PoolUID != "pool-uid" || candidates[1].PoolUID != "pool-uid" {
		t.Fatalf("admission candidates lost Pool identity: candidates=%+v err=%v", candidates, err)
	}
	uids := map[string]bool{candidates[0].CellUID: true, candidates[1].CellUID: true}
	if !uids["spoke-a"] || !uids["spoke-b"] {
		t.Fatalf("admission candidates differ from the leased snapshot: %+v", candidates)
	}
}

func TestKubernetesPlacementFailsClosedOnExpiredReport(t *testing.T) {
	now := time.Date(2026, 9, 9, 1, 0, 0, 0, time.UTC)
	resolver := testKubernetesResolver(t, now,
		placementPool("actor-bj-a01"),
		placementCell("actor-bj-a01", "spoke-a", now.Add(-31*time.Second)),
		placementRoute("actor-bj-a01", "spoke-a", "local-runtime-a"),
	)
	if _, err := resolver.Resolve(context.Background(), "new-object"); err == nil || !strings.Contains(err.Error(), "expired") {
		t.Fatalf("expired report resolution error = %v", err)
	}
}

func TestKubernetesPlacementFailsClosedOnReplacementUID(t *testing.T) {
	now := time.Date(2026, 9, 9, 1, 0, 0, 0, time.UTC)
	resolver := testKubernetesResolver(t, now,
		placementPool("actor-bj-a01"),
		placementCell("actor-bj-a01", "replacement-uid", now),
		placementRoute("actor-bj-a01", "old-uid", "local-runtime-a"),
	)
	if _, err := resolver.Resolve(context.Background(), "new-object"); err == nil || !strings.Contains(err.Error(), "route identity") {
		t.Fatalf("replacement UID resolution error = %v", err)
	}
}

func TestKubernetesPlacementAcceptsStableRouteWithoutReleaseEvidence(t *testing.T) {
	now := time.Date(2026, 9, 9, 1, 0, 0, 0, time.UTC)
	route := placementRoute("actor-bj-a01", "spoke-a", "local-runtime-a")
	if len(route.Data) != 5 {
		t.Fatalf("stable route unexpectedly embeds release evidence: %#v", route.Data)
	}
	resolver := testKubernetesResolver(t, now,
		placementPool("actor-bj-a01"),
		placementCell("actor-bj-a01", "spoke-a", now),
		route,
	)
	if _, err := resolver.Resolve(context.Background(), "new-object"); err != nil {
		t.Fatalf("stable identity route was rejected: %v", err)
	}
}

func TestKubernetesPlacementFailsClosedWhenPoolAdmissionCloses(t *testing.T) {
	now := time.Date(2026, 9, 9, 1, 0, 0, 0, time.UTC)
	pool := placementPool("actor-bj-a01")
	_ = unstructured.SetNestedField(pool.Object, false, "status", "admissionOpen")
	resolver := testKubernetesResolver(t, now, pool)
	if _, err := resolver.Resolve(context.Background(), "new-object"); err == nil {
		t.Fatal("closed Pool returned a placement")
	}
	if _, err := resolver.AdmissionCandidates(context.Background()); err == nil {
		t.Fatal("closed Pool returned stateless admission candidates")
	}
}

func TestKubernetesPlacementServesValidLeaseWhileSingleRefreshBlocks(t *testing.T) {
	now := time.Date(2026, 9, 9, 1, 0, 0, 0, time.UTC)
	resolver := testKubernetesResolver(t, now,
		placementPool("actor-bj-a01"),
		placementCell("actor-bj-a01", "spoke-a", now),
		placementRoute("actor-bj-a01", "spoke-a", "local-runtime-a"),
	)
	first, err := resolver.Resolve(context.Background(), "first")
	if err != nil {
		t.Fatal(err)
	}

	now = now.Add(2 * time.Second)
	resolver.now = func() time.Time { return now }
	started := make(chan struct{})
	release := make(chan struct{})
	resolver.dynamicClient.(*dynamicfake.FakeDynamicClient).PrependReactor("get", "shardpools", func(k8stesting.Action) (bool, runtime.Object, error) {
		close(started)
		<-release
		return false, nil, nil
	})

	second, err := resolver.Resolve(context.Background(), "second")
	if err != nil || second.SnapshotResourceVersion != first.SnapshotResourceVersion {
		t.Fatalf("valid lease was not served during refresh: decision=%+v err=%v", second, err)
	}
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("background refresh did not start")
	}
	third, err := resolver.Resolve(context.Background(), "third")
	if err != nil || third.SnapshotResourceVersion != first.SnapshotResourceVersion {
		t.Fatalf("concurrent caller did not reuse valid lease: decision=%+v err=%v", third, err)
	}
	resolver.mu.Lock()
	done := resolver.refreshDone
	resolver.mu.Unlock()
	close(release)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("background refresh did not finish")
	}
}

func TestKubernetesPlacementExpiredLeaseWaitsAndFailsClosed(t *testing.T) {
	now := time.Date(2026, 9, 9, 1, 0, 0, 0, time.UTC)
	resolver := testKubernetesResolver(t, now,
		placementPool("actor-bj-a01"),
		placementCell("actor-bj-a01", "spoke-a", now),
		placementRoute("actor-bj-a01", "spoke-a", "local-runtime-a"),
	)
	if _, err := resolver.Resolve(context.Background(), "first"); err != nil {
		t.Fatal(err)
	}

	now = now.Add(31 * time.Second)
	resolver.now = func() time.Time { return now }
	started := make(chan struct{})
	release := make(chan struct{})
	resolver.dynamicClient.(*dynamicfake.FakeDynamicClient).PrependReactor("get", "shardpools", func(k8stesting.Action) (bool, runtime.Object, error) {
		close(started)
		<-release
		return false, nil, nil
	})
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, err := resolver.Resolve(ctx, "expired"); err == nil || !strings.Contains(err.Error(), "deadline exceeded") {
		t.Fatalf("expired lease did not fail closed at caller deadline: %v", err)
	}
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("expired lease did not trigger refresh")
	}
	resolver.mu.Lock()
	done := resolver.refreshDone
	resolver.mu.Unlock()
	close(release)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("expired-lease refresh did not finish")
	}
}

func TestQualificationPlacementBindsExactPreAdmissionCell(t *testing.T) {
	resolver, err := NewQualificationPlacementResolver(
		"actor-bj-a01", "83a080e4-8160-492a-8c2f-9576631ef923", "actor-bj-a01",
	)
	if err != nil {
		t.Fatal(err)
	}
	if err := resolver.Check(context.Background()); err != nil {
		t.Fatal(err)
	}
	decision, err := resolver.Resolve(context.Background(), "worker\x00Agent\x00object")
	if err != nil {
		t.Fatal(err)
	}
	if decision.CellName != "actor-bj-a01" ||
		decision.CellUID != "83a080e4-8160-492a-8c2f-9576631ef923" ||
		decision.Datacenter != "actor-bj-a01" || decision.DecidedAt.IsZero() ||
		!digestPattern.MatchString(decision.SnapshotDigest) {
		t.Fatalf("qualification placement lost exact Cell identity: %+v", decision)
	}
}

func TestQualificationPlacementRejectsPartialOrUnsafeIdentity(t *testing.T) {
	for _, test := range []struct{ cell, uid, datacenter string }{
		{"", "uid", "actor-bj-a01"},
		{"actor-bj-a01", "", "actor-bj-a01"},
		{"actor-bj-a01", "uid\nforged", "actor-bj-a01"},
		{"actor-bj-a01", "uid", "INVALID"},
	} {
		if _, err := NewQualificationPlacementResolver(test.cell, test.uid, test.datacenter); err == nil {
			t.Fatalf("unsafe qualification identity was accepted: %#v", test)
		}
	}
}
