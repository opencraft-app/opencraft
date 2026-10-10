package workersapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

// The real client-go REST stack reads protocol fixtures over a TCP listener.
// This is not a Kubernetes server or cross-Cell network qualification.
func newRouteRESTFixture(t *testing.T) (*KubernetesServingRouteResolver, func(...*corev1.ConfigMap)) {
	t.Helper()
	var mu sync.RWMutex
	var items []corev1.ConfigMap
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet || request.URL.Path != "/api/v1/namespaces/workers-api-system/configmaps" ||
			request.URL.Query().Get("labelSelector") != cellServingRouteLabel+"=true" {
			http.Error(writer, "unexpected route inventory request", http.StatusBadRequest)
			return
		}
		mu.RLock()
		defer mu.RUnlock()
		writer.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(writer).Encode(corev1.ConfigMapList{
			TypeMeta: metav1.TypeMeta{APIVersion: "v1", Kind: "ConfigMapList"}, Items: items,
		})
	}))
	t.Cleanup(server.Close)
	client, err := kubernetes.NewForConfig(&rest.Config{Host: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	resolver, err := NewKubernetesServingRouteResolver(client, "workers-api-system", time.Second)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 10, 4, 0, 0, 0, 0, time.UTC)
	resolver.now = func() time.Time { return now }
	return resolver, func(replacement ...*corev1.ConfigMap) {
		mu.Lock()
		defer mu.Unlock()
		items = nil
		for _, item := range replacement {
			items = append(items, *item.DeepCopy())
		}
		now = now.Add(2 * time.Second)
	}
}

func rewrittenRouteManifest(t *testing.T, revision int64, field, value string) *corev1.ConfigMap {
	t.Helper()
	item := testServingConfigMap(t, revision)
	var document map[string]any
	if err := json.Unmarshal([]byte(item.Data["route.json"]), &document); err != nil {
		t.Fatal(err)
	}
	delete(document, "manifest_sha256")
	document[field] = value
	unsigned, err := json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(append(unsigned, '\n'))
	document["manifest_sha256"] = "sha256:" + hex.EncodeToString(digest[:])
	encoded, err := json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	item.Data["route.json"] = string(encoded)
	item.Annotations["fleet.actor.dev/route-manifest-sha256"] = document["manifest_sha256"].(string)
	return item
}

func TestServingRouteRevisionRejectsRewrittenManifestOverREST(t *testing.T) {
	for field, value := range map[string]string{
		"actor_gateway_authority":        "http://10.161.0.19:6420",
		"stateless_executor_authority":   "http://10.161.0.20:19084",
		"actor_gateway_service_uid":      "replacement-gateway-service",
		"stateless_executor_service_uid": "replacement-executor-service",
		"published_at":                   "2026-10-04T01:00:00Z",
	} {
		t.Run(field, func(t *testing.T) {
			resolver, publish := newRouteRESTFixture(t)
			placement := &registryPlacement{PoolUID: "pool-uid", CellName: "actor-bj-a01", CellUID: "cell-uid", Datacenter: "default"}
			ctx := context.Background()
			first := testServingConfigMap(t, 1)
			publish(first)
			if _, err := resolver.RouteForPlacement(ctx, placement); err != nil {
				t.Fatal(err)
			}
			publish(first)
			if _, err := resolver.StatelessRoutes(ctx); err != nil {
				t.Fatalf("exact revision replay rejected: %v", err)
			}
			publish(rewrittenRouteManifest(t, 1, field, value))
			if _, err := resolver.RouteForPlacement(ctx, placement); err == nil {
				t.Fatal("same revision with rewritten manifest was accepted")
			}
			if _, err := resolver.StatelessRoutes(ctx); err == nil {
				t.Fatal("stateless route accepted a rewritten revision")
			}
			publish(rewrittenRouteManifest(t, 2, field, value))
			if route, err := resolver.RouteForPlacement(ctx, placement); err != nil || route.Revision != 2 {
				t.Fatalf("new revision rejected: route=%#v err=%v", route, err)
			}
		})
	}
}

func TestServingRouteRevisionRetainsIdentityAcrossInventoryRemoval(t *testing.T) {
	resolver, publish := newRouteRESTFixture(t)
	ctx := context.Background()
	first := testServingConfigMap(t, 1)
	publish(first)
	if _, err := resolver.StatelessRoutes(ctx); err != nil {
		t.Fatal(err)
	}
	publish()
	if _, err := resolver.StatelessRoutes(ctx); err == nil {
		t.Fatal("removed inventory still supplied a route")
	}
	publish(rewrittenRouteManifest(t, 1, "actor_gateway_authority", "http://10.161.0.19:6420"))
	if _, err := resolver.StatelessRoutes(ctx); err == nil {
		t.Fatal("removal erased the accepted revision identity")
	}
	publish(first)
	if _, err := resolver.StatelessRoutes(ctx); err != nil {
		t.Fatalf("restored exact revision rejected: %v", err)
	}
}

func TestServingRouteRevisionFailedInventoryDoesNotAdvanceFence(t *testing.T) {
	resolver, publish := newRouteRESTFixture(t)
	ctx := context.Background()
	first := testServingConfigMap(t, 1)
	publish(first)
	if _, err := resolver.StatelessRoutes(ctx); err != nil {
		t.Fatal(err)
	}
	invalid := testServingConfigMap(t, 1)
	invalid.Name = "actor-cell-serving-route-invalid"
	publish(testServingConfigMap(t, 2), invalid)
	if _, err := resolver.StatelessRoutes(ctx); err == nil {
		t.Fatal("partly invalid inventory accepted")
	}
	publish(first)
	if routes, err := resolver.StatelessRoutes(ctx); err != nil || len(routes) != 1 || routes[0].Revision != 1 {
		t.Fatalf("failed inventory advanced the fence: routes=%#v err=%v", routes, err)
	}
}
