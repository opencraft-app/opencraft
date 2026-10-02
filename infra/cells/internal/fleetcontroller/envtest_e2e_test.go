package fleetcontroller

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/envtest"
)

// This is intentionally a small serial gate. The large fault matrix uses the
// in-memory API; this test exists to catch differences in CRD defaulting,
// status resourceVersions and UID allocation against a real kube-apiserver.
func TestEnvtestCRDAndStatusSemantics(t *testing.T) {
	assets := os.Getenv("KUBEBUILDER_ASSETS")
	if assets == "" {
		t.Skip("KUBEBUILDER_ASSETS is not installed; run this gate in the envtest CI job")
	}
	crds, err := filepath.Abs("../../deploy/tencent/fleet/crds.yaml")
	if err != nil {
		t.Fatal(err)
	}
	environment := &envtest.Environment{BinaryAssetsDirectory: assets, CRDInstallOptions: envtest.CRDInstallOptions{Paths: []string{crds}, ErrorIfPathMissing: true}}
	config, err := environment.Start()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := environment.Stop(); err != nil {
			t.Errorf("stop envtest: %v", err)
		}
	})

	scheme := runtime.NewScheme()
	if err := corev1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	addUnstructuredTypes(scheme, poolGVK, claimGVK)
	kubeClient, err := client.New(config, client.Options{Scheme: scheme})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if err := kubeClient.Create(ctx, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "envtest-mesh"}}); err != nil {
		t.Fatal(err)
	}

	pool := object(poolGVK)
	pool.SetName("pool")
	pool.SetNamespace("envtest-mesh")
	pool.Object["spec"] = map[string]any{
		"className": "class", "minCells": int64(2), "maxCells": int64(4), "maxConcurrentCellProvisioning": int64(1),
		"placement":   map[string]any{"region": "ap-beijing", "managementClusters": []any{"tke-a"}},
		"routing":     map[string]any{"strategy": "route-hinted-v1", "exactExceptionDirectory": "versioned-exact-v1", "perActorKubernetesObjects": false},
		"reservation": map[string]any{"mode": "CAS", "maxPendingPerCell": int64(10), "ttlSeconds": int64(30)},
		"rebalance":   map[string]any{"onScaleOut": "NewActorsOnly", "migrationBatchSize": int64(10)},
	}
	if err := kubeClient.Create(ctx, pool); err != nil {
		t.Fatal(err)
	}
	stored := object(poolGVK)
	if err := kubeClient.Get(ctx, types.NamespacedName{Name: pool.GetName(), Namespace: pool.GetNamespace()}, stored); err != nil {
		t.Fatal(err)
	}
	if nestedInt64(stored.Object, "spec", "scaleIn", "enterUtilizationPercent") != 25 || nestedInt64(stored.Object, "spec", "scaleIn", "exitUtilizationPercent") != 40 {
		t.Fatalf("CRD scale-in defaults were not applied: %#v", stored.Object["spec"])
	}
	stale := stored.DeepCopy()
	stored.Object["status"] = map[string]any{"observedGeneration": stored.GetGeneration()}
	if err := kubeClient.Status().Update(ctx, stored); err != nil {
		t.Fatal(err)
	}
	stale.Object["status"] = map[string]any{"observedGeneration": stale.GetGeneration(), "admissionOpen": true}
	if err := kubeClient.Status().Update(ctx, stale); !apierrors.IsConflict(err) {
		t.Fatalf("stale status resourceVersion did not conflict: %v", err)
	}
}
