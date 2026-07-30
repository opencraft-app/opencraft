package provisioner

import (
	"context"
	"testing"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	"git.woa.com/wisp/mono2/llmgateway/internal/gateway"
	velagwv1alpha1 "git.woa.com/wisp/mono2/llmgateway/internal/velagwset/api/v1alpha1"
)

type recordingUpgradeControl struct {
	masterCompleted int
	candidateURL    string
	drainCompleted  int
}

func (c *recordingUpgradeControl) CompleteUpgradeMaster(context.Context, string, string, bool, string) (gateway.SetUpgradeRun, error) {
	c.masterCompleted++
	return gateway.SetUpgradeRun{Status: gateway.SetUpgradeRunStatusVerifyingCompatibility}, nil
}

func (c *recordingUpgradeControl) CompleteUpgradeCompatibility(context.Context, string, string, bool, string) (gateway.SetUpgradeRun, error) {
	return gateway.SetUpgradeRun{}, nil
}

func (c *recordingUpgradeControl) UpgradeProbeCredential(context.Context, string, string) (gateway.SetUpgradeProbeCredential, error) {
	return gateway.SetUpgradeProbeCredential{UpstreamKey: "sk-probe"}, nil
}

func (c *recordingUpgradeControl) PrepareUpgradeCandidate(_ context.Context, _, _, baseURL string) (gateway.SetUpgradeRun, error) {
	c.candidateURL = baseURL
	return gateway.SetUpgradeRun{Status: gateway.SetUpgradeRunStatusProbing}, nil
}

func (c *recordingUpgradeControl) RecordUpgradeProbe(context.Context, string, string, bool, string) (gateway.SetUpgradeRun, error) {
	return gateway.SetUpgradeRun{}, nil
}

func (c *recordingUpgradeControl) UpgradeAction(_ context.Context, _, action, _ string, _ bool, _, _ string) (gateway.SetUpgradeRun, error) {
	if action == "drain-complete" {
		c.drainCompleted++
	}
	return gateway.SetUpgradeRun{}, nil
}

func TestNativeUpgradePatchesAdminThenWaitsForObservedReadiness(t *testing.T) {
	scheme := testScheme(t)
	set := managedUpgradeSet()
	cl := fake.NewClientBuilder().WithScheme(scheme).WithRuntimeObjects(set).
		WithStatusSubresource(&velagwv1alpha1.VelaGWSet{}).Build()
	control := &recordingUpgradeControl{}
	reconciler := UpgradeReconciler{Client: cl, Control: control}
	run := nativeUpgradeRun(gateway.SetUpgradeRunStatusUpgradingMaster)

	if err := reconciler.Reconcile(t.Context(), run, "owner-a"); err != ErrWaiting {
		t.Fatalf("first reconcile err=%v want ErrWaiting", err)
	}
	got := getUpgradeSet(t, cl)
	if got.Spec.Admin.Image != run.TargetImage {
		t.Fatalf("admin image=%q want %q", got.Spec.Admin.Image, run.TargetImage)
	}
	if control.masterCompleted != 0 {
		t.Fatalf("master completion calls=%d before readiness", control.masterCompleted)
	}

	got.Status.ObservedGeneration = got.Generation
	got.Status.AdminReadyReplicas = 1
	got.Status.Conditions = []metav1.Condition{{Type: "AdminReady", Status: metav1.ConditionTrue}}
	if err := cl.Status().Update(t.Context(), got); err != nil {
		t.Fatal(err)
	}
	if err := reconciler.Reconcile(t.Context(), run, "owner-a"); err != nil {
		t.Fatal(err)
	}
	if control.masterCompleted != 1 {
		t.Fatalf("master completion calls=%d want 1", control.masterCompleted)
	}
}

func TestNativeUpgradeAppendsImmutableGreenRuntime(t *testing.T) {
	scheme := testScheme(t)
	set := managedUpgradeSet()
	cl := fake.NewClientBuilder().WithScheme(scheme).WithRuntimeObjects(set).
		WithStatusSubresource(&velagwv1alpha1.VelaGWSet{}).Build()
	control := &recordingUpgradeControl{}
	reconciler := UpgradeReconciler{Client: cl, Control: control}
	run := nativeUpgradeRun(gateway.SetUpgradeRunStatusPreparing)

	if err := reconciler.Reconcile(t.Context(), run, "owner-a"); err != ErrWaiting {
		t.Fatalf("first reconcile err=%v want ErrWaiting", err)
	}
	got := getUpgradeSet(t, cl)
	if len(got.Spec.TrafficRuntimes) != 2 || got.Spec.TrafficRuntimes[0].Generation != 1 || got.Spec.TrafficRuntimes[1].Generation != 2 {
		t.Fatalf("traffic runtimes=%+v", got.Spec.TrafficRuntimes)
	}
	if got.Spec.TrafficRuntimes[0].Image != testReleaseImage || got.Spec.TrafficRuntimes[1].Image != run.TargetImage {
		t.Fatalf("runtime images=%+v", got.Spec.TrafficRuntimes)
	}

	got.Status.ObservedGeneration = got.Generation
	got.Status.TrafficRuntimes = []velagwv1alpha1.TrafficRuntimeStatus{
		{Generation: 1, DesiredReplicas: 2, ReadyReplicas: 2, AvailableReplicas: 2},
		{Generation: 2, DesiredReplicas: 2, ReadyReplicas: 2, AvailableReplicas: 2},
	}
	if err := cl.Status().Update(t.Context(), got); err != nil {
		t.Fatal(err)
	}
	reconciler.Probe = func(context.Context, string, string, string) error { return nil }
	if err := reconciler.Reconcile(t.Context(), run, "owner-a"); err != nil {
		t.Fatal(err)
	}
	if control.candidateURL != "http://prod-set-a-g2-newapi-traffic:3000" {
		t.Fatalf("candidate url=%q", control.candidateURL)
	}
}

func TestNativeUpgradeDrainRetiresOnlySelectedGeneration(t *testing.T) {
	scheme := testScheme(t)
	set := managedUpgradeSet()
	set.Spec.Admin.Image = nextReleaseImage
	set.Spec.TrafficRuntimes = append(set.Spec.TrafficRuntimes,
		velagwv1alpha1.TrafficRuntimeSpec{Generation: 2, Image: nextReleaseImage, Replicas: 2},
		velagwv1alpha1.TrafficRuntimeSpec{Generation: 3, Image: thirdReleaseImage, Replicas: 2},
	)
	cl := fake.NewClientBuilder().WithScheme(scheme).WithRuntimeObjects(set).
		WithStatusSubresource(&velagwv1alpha1.VelaGWSet{}).Build()
	control := &recordingUpgradeControl{}
	now := time.Date(2026, 7, 22, 12, 0, 0, 0, time.UTC)
	reconciler := UpgradeReconciler{Client: cl, Control: control, Now: func() time.Time { return now }}
	run := nativeUpgradeRun(gateway.SetUpgradeRunStatusDraining)
	run.DrainDeadline = now.Add(-time.Second)
	run.RollbackDeadline = now.Add(-time.Minute)

	if err := reconciler.Reconcile(t.Context(), run, "owner-a"); err != ErrWaiting {
		t.Fatalf("retire reconcile err=%v want ErrWaiting", err)
	}
	got := getUpgradeSet(t, cl)
	if len(got.Spec.TrafficRuntimes) != 2 || got.Spec.TrafficRuntimes[0].Generation != 2 || got.Spec.TrafficRuntimes[1].Generation != 3 {
		t.Fatalf("traffic runtimes after drain=%+v", got.Spec.TrafficRuntimes)
	}
	if control.drainCompleted != 0 {
		t.Fatalf("drain completed before controller observed deletion")
	}

	got.Status.ObservedGeneration = got.Generation
	got.Status.TrafficRuntimes = []velagwv1alpha1.TrafficRuntimeStatus{
		{Generation: 2, DesiredReplicas: 2, ReadyReplicas: 2, AvailableReplicas: 2},
		{Generation: 3, DesiredReplicas: 2, ReadyReplicas: 2, AvailableReplicas: 2},
	}
	if err := cl.Status().Update(t.Context(), got); err != nil {
		t.Fatal(err)
	}
	if err := reconciler.Reconcile(t.Context(), run, "owner-a"); err != nil {
		t.Fatal(err)
	}
	if control.drainCompleted != 1 {
		t.Fatalf("drain completed calls=%d want 1", control.drainCompleted)
	}
}

func managedUpgradeSet() *velagwv1alpha1.VelaGWSet {
	return &velagwv1alpha1.VelaGWSet{
		ObjectMeta: metav1.ObjectMeta{Name: "set-a", Namespace: "llmgateway", Generation: 4},
		Spec: velagwv1alpha1.VelaGWSetSpec{
			FleetRef: "prod", ManagementPolicy: velagwv1alpha1.ManagementPolicyManaged,
			Admin:           velagwv1alpha1.AdminRuntimeSpec{Image: testReleaseImage},
			TrafficRuntimes: []velagwv1alpha1.TrafficRuntimeSpec{{Generation: 1, Image: testReleaseImage, Replicas: 2}},
		},
	}
}

func nativeUpgradeRun(status string) gateway.SetUpgradeRun {
	return gateway.SetUpgradeRun{
		ID: "upgrade-a", SetID: "set-a", Source: "prod", Namespace: "llmgateway", Fleet: "prod",
		TargetImage: nextReleaseImage, FromGeneration: 1, ToGeneration: 2, Status: status,
	}
}

func getUpgradeSet(t *testing.T, cl client.Client) *velagwv1alpha1.VelaGWSet {
	t.Helper()
	set := &velagwv1alpha1.VelaGWSet{}
	if err := cl.Get(t.Context(), client.ObjectKey{Namespace: "llmgateway", Name: "set-a"}, set); err != nil {
		t.Fatal(err)
	}
	return set
}

const (
	nextReleaseImage  = "registry.example/new-api@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	thirdReleaseImage = "registry.example/new-api@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
)
