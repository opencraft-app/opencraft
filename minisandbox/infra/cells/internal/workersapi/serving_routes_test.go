package workersapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	kubefake "k8s.io/client-go/kubernetes/fake"
)

type testAdmissionSetResolver struct {
	candidates []registryPlacement
}

func (resolver *testAdmissionSetResolver) Check(context.Context) error { return nil }

func (resolver *testAdmissionSetResolver) Resolve(context.Context, string) (registryPlacement, error) {
	if len(resolver.candidates) == 0 {
		return registryPlacement{}, ErrNoAdmissionCapacity
	}
	return resolver.candidates[0], nil
}

func (resolver *testAdmissionSetResolver) AdmissionCandidates(context.Context) ([]registryPlacement, error) {
	return append([]registryPlacement(nil), resolver.candidates...), nil
}

func testServingRouteJSON(t *testing.T, revision int64, cellUID string) string {
	t.Helper()
	value := map[string]any{
		"schema": "actor-cell-serving-route/v1", "region": "ap-beijing",
		"pool_name": "actor-beijing-kubernetes", "pool_uid": "pool-uid",
		"cell_name": "actor-bj-a01", "cell_uid": cellUID, "datacenter": "default",
		"actor_gateway_authority":        "http://10.161.0.12:6420",
		"actor_gateway_service_uid":      "engine-service-uid",
		"stateless_executor_authority":   "http://10.161.0.14:19084",
		"stateless_executor_service_uid": "stateless-service-uid",
		"service_identity":               "actor-cell/" + cellUID,
		"revision":                       revision, "published_at": "2026-09-23T10:00:00Z",
	}
	unsigned, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(append(unsigned, '\n'))
	value["manifest_sha256"] = "sha256:" + hex.EncodeToString(digest[:])
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(append(encoded, '\n'))
}

func testServingConfigMap(t *testing.T, revision int64) *corev1.ConfigMap {
	t.Helper()
	raw := testServingRouteJSON(t, revision, "cell-uid")
	route, err := parseCellServingRoute(raw)
	if err != nil {
		t.Fatal(err)
	}
	return &corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{
			Name: "actor-cell-serving-route-actor-bj-a01", Namespace: "workers-api-system",
			Labels: map[string]string{cellServingRouteLabel: "true"},
			Annotations: map[string]string{
				"fleet.actor.dev/route-revision":        fmt.Sprint(revision),
				"fleet.actor.dev/route-manifest-sha256": route.ManifestSHA256,
			},
		},
		Data: map[string]string{"route.json": raw},
	}
}

func TestCellServingRouteRejectsDigestAndPublicAuthority(t *testing.T) {
	raw := testServingRouteJSON(t, 1, "cell-uid")
	if _, err := parseCellServingRoute(raw); err != nil {
		t.Fatal(err)
	}
	var value map[string]any
	if err := json.Unmarshal([]byte(raw), &value); err != nil {
		t.Fatal(err)
	}
	value["actor_gateway_authority"] = "http://8.8.8.8:6420"
	tampered, _ := json.Marshal(value)
	if _, err := parseCellServingRoute(string(tampered)); err == nil {
		t.Fatal("tampered serving route was accepted")
	}
}

func TestKubernetesServingRouteResolverMatchesUIDAndRejectsRollback(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 9, 23, 10, 0, 0, 0, time.UTC)
	client := kubefake.NewSimpleClientset(testServingConfigMap(t, 1))
	resolver, err := NewKubernetesServingRouteResolver(client, "workers-api-system", time.Second)
	if err != nil {
		t.Fatal(err)
	}
	resolver.now = func() time.Time { return now }
	placement := &registryPlacement{
		PoolName: "actor-beijing-kubernetes", PoolUID: "pool-uid",
		CellName: "actor-bj-a01", CellUID: "cell-uid", Datacenter: "default",
	}
	route, err := resolver.RouteForPlacement(ctx, placement)
	if err != nil || route.Revision != 1 || route.ActorGateway.Host != "10.161.0.12:6420" {
		t.Fatalf("unexpected serving route: route=%#v err=%v", route, err)
	}
	wrong := *placement
	wrong.CellUID = "replacement-cell"
	if _, err := resolver.RouteForPlacement(ctx, &wrong); err == nil {
		t.Fatal("replacement Cell UID inherited a serving route")
	}

	current, err := client.CoreV1().ConfigMaps("workers-api-system").Get(ctx, "actor-cell-serving-route-actor-bj-a01", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	replacement := testServingConfigMap(t, 2)
	replacement.ResourceVersion = current.ResourceVersion
	if _, err := client.CoreV1().ConfigMaps("workers-api-system").Update(ctx, replacement, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	now = now.Add(2 * time.Second)
	route, err = resolver.RouteForPlacement(ctx, placement)
	if err != nil || route.Revision != 2 {
		t.Fatalf("route revision did not advance: route=%#v err=%v", route, err)
	}

	current, _ = client.CoreV1().ConfigMaps("workers-api-system").Get(ctx, replacement.Name, metav1.GetOptions{})
	rollback := testServingConfigMap(t, 1)
	rollback.ResourceVersion = current.ResourceVersion
	if _, err := client.CoreV1().ConfigMaps("workers-api-system").Update(ctx, rollback, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	now = now.Add(2 * time.Second)
	if _, err := resolver.RouteForPlacement(ctx, placement); err == nil {
		t.Fatal("route revision rollback was accepted")
	}
}

func TestStatelessExecutorsUseAdmissionSetWithoutWithdrawingServingRoute(t *testing.T) {
	actorA, _ := url.Parse("http://10.161.0.12:6420")
	statelessA, _ := url.Parse("http://10.161.0.14:19084")
	actorB, _ := url.Parse("http://10.162.0.12:6420")
	statelessB, _ := url.Parse("http://10.162.0.14:19084")
	routes := &staticServingRouteResolver{routes: map[string]ServingRoute{
		"cell-a": {
			PoolName: "pool-a", PoolUID: "pool-uid", CellName: "actor-bj-a01", CellUID: "cell-a",
			Datacenter: "runtime-a", ActorGateway: actorA, StatelessExecutor: statelessA, Revision: 1,
		},
		"cell-b": {
			PoolName: "pool-a", PoolUID: "pool-uid", CellName: "actor-bj-b01", CellUID: "cell-b",
			Datacenter: "runtime-b", ActorGateway: actorB, StatelessExecutor: statelessB, Revision: 1,
		},
	}}
	admission := &testAdmissionSetResolver{candidates: []registryPlacement{{
		PoolName: "pool-a", PoolUID: "pool-uid", CellName: "actor-bj-a01", CellUID: "cell-a",
		Datacenter: "runtime-a",
	}}}
	api := &API{
		placementResolver: admission,
		servingRoutes:     routes,
		statelessTokensByCell: map[string]string{
			"cell-a": "aaaaaaaaaaaaaaaa", "cell-b": "bbbbbbbbbbbbbbbb",
		},
	}

	executors, err := api.statelessServingExecutors(context.Background())
	if err != nil || len(executors) != 1 || executors[0].cellUID != "cell-a" {
		t.Fatalf("stateless admission intersection = %#v, err=%v", executors, err)
	}
	placementB := &registryPlacement{
		PoolName: "pool-a", PoolUID: "pool-uid", CellName: "actor-bj-b01", CellUID: "cell-b",
		Datacenter: "runtime-b",
	}
	if route, err := routes.RouteForPlacement(context.Background(), placementB); err != nil || route.CellUID != "cell-b" {
		t.Fatalf("drained Cell serving route was withdrawn: route=%#v err=%v", route, err)
	}

	admission.candidates = nil
	if _, err := api.statelessServingExecutors(context.Background()); !errors.Is(err, ErrNoAdmissionCapacity) {
		t.Fatalf("closed admission returned error %v, want %v", err, ErrNoAdmissionCapacity)
	}
}
