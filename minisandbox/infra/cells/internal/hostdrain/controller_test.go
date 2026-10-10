package hostdrain

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	autoscalingv2 "k8s.io/api/autoscaling/v2"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/kubernetes/fake"
)

func TestAutoscalerRawRecommendationIsTheDrainFloor(t *testing.T) {
	tests := []struct {
		name           string
		replicas       int32
		current        int32
		desired        int32
		activeActors   int64
		demandRising   bool
		scaleUpPending bool
	}{
		{name: "disabled scale down does not pin idle capacity", current: 5, desired: 5},
		{name: "raw demand keeps current capacity", current: 5, desired: 5, activeActors: 80, scaleUpPending: true},
		{name: "raw demand requests expansion", current: 5, desired: 5, activeActors: 81, demandRising: true, scaleUpPending: true},
		{name: "HPA status requests expansion", current: 5, desired: 7, demandRising: true, scaleUpPending: true},
		{name: "HPA observation lags workload", current: 4, desired: 4, scaleUpPending: true},
		{name: "HPA observation lags completed contraction", replicas: 4, current: 5, desired: 5},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			replicas := test.replicas
			if replicas == 0 {
				replicas = 5
			}
			statefulSet, hpa := healthyAutoscalerObjects(replicas, test.current, test.desired)
			rising, pending, err := autoscalerScaleSignals(hpa, statefulSet, 3, test.activeActors)
			if err != nil {
				t.Fatal(err)
			}
			if rising != test.demandRising || pending != test.scaleUpPending {
				t.Fatalf("signals = rising %t pending %t", rising, pending)
			}
		})
	}
}

func TestAutoscalerEvidenceFailsClosed(t *testing.T) {
	tests := map[string]func(*autoscalingv2.HorizontalPodAutoscaler, *appsv1.StatefulSet){
		"wrong target": func(hpa *autoscalingv2.HorizontalPodAutoscaler, _ *appsv1.StatefulSet) {
			hpa.Spec.ScaleTargetRef.Name = "other"
		},
		"wrong minimum": func(hpa *autoscalingv2.HorizontalPodAutoscaler, _ *appsv1.StatefulSet) {
			value := int32(2)
			hpa.Spec.MinReplicas = &value
		},
		"inactive metrics": func(hpa *autoscalingv2.HorizontalPodAutoscaler, _ *appsv1.StatefulSet) {
			hpa.Status.Conditions[1].Status = corev1.ConditionFalse
		},
		"invalid desired replicas": func(hpa *autoscalingv2.HorizontalPodAutoscaler, _ *appsv1.StatefulSet) {
			hpa.Status.DesiredReplicas = 0
		},
		"missing metric": func(hpa *autoscalingv2.HorizontalPodAutoscaler, _ *appsv1.StatefulSet) {
			hpa.Spec.Metrics = nil
		},
		"fractional target": func(hpa *autoscalingv2.HorizontalPodAutoscaler, _ *appsv1.StatefulSet) {
			value := resource.MustParse("15.5")
			hpa.Spec.Metrics[0].External.Target.AverageValue = &value
		},
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			statefulSet, hpa := healthyAutoscalerObjects(5, 5, 3)
			mutate(hpa, statefulSet)
			if _, pending, err := autoscalerScaleSignals(hpa, statefulSet, 3, 0); err == nil || !pending {
				t.Fatalf("invalid HPA evidence did not fail closed: pending=%t err=%v", pending, err)
			}
		})
	}
}

func healthyAutoscalerObjects(replicas, current, desired int32) (*appsv1.StatefulSet, *autoscalingv2.HorizontalPodAutoscaler) {
	minimum := int32(3)
	statefulSet := &appsv1.StatefulSet{
		ObjectMeta: metav1.ObjectMeta{Name: "runtime"},
		Spec:       appsv1.StatefulSetSpec{Replicas: &replicas},
	}
	hpa := &autoscalingv2.HorizontalPodAutoscaler{
		Spec: autoscalingv2.HorizontalPodAutoscalerSpec{
			ScaleTargetRef: autoscalingv2.CrossVersionObjectReference{
				APIVersion: "apps/v1", Kind: "StatefulSet", Name: statefulSet.Name,
			},
			MinReplicas: &minimum,
			MaxReplicas: 30,
			Metrics: []autoscalingv2.MetricSpec{{
				Type: autoscalingv2.ExternalMetricSourceType,
				External: &autoscalingv2.ExternalMetricSource{
					Metric: autoscalingv2.MetricIdentifier{Name: "active_actors"},
					Target: autoscalingv2.MetricTarget{
						Type: autoscalingv2.AverageValueMetricType,
						AverageValue: func() *resource.Quantity {
							value := resource.MustParse("16")
							return &value
						}(),
					},
				},
			}},
		},
		Status: autoscalingv2.HorizontalPodAutoscalerStatus{
			CurrentReplicas: current,
			DesiredReplicas: desired,
			Conditions: []autoscalingv2.HorizontalPodAutoscalerCondition{
				{Type: autoscalingv2.AbleToScale, Status: corev1.ConditionTrue},
				{Type: autoscalingv2.ScalingActive, Status: corev1.ConditionTrue},
			},
		},
	}
	return statefulSet, hpa
}

func TestSnapshotKeepsPendingHostIdentityWithoutManagementRequest(t *testing.T) {
	statefulSet, hpa := healthyAutoscalerObjects(3, 3, 3)
	statefulSet.Namespace = "cell"
	statefulSet.UID = types.UID("workload-uid")
	statefulSet.Status.ReadyReplicas = 2
	hpa.Namespace = "cell"
	hpa.Name = "runtime-capacity"
	pending := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Namespace: "cell", Name: "runtime-2", UID: types.UID("pending-uid"),
			Labels:          map[string]string{"app": "runtime"},
			OwnerReferences: hostOwnerReferences(statefulSet),
		},
		Status: corev1.PodStatus{Phase: corev1.PodPending},
	}
	controller := &Controller{
		Kubernetes: fake.NewSimpleClientset(hpa, pending),
		Config: ControllerConfig{
			Namespace: "cell", StatefulSetName: "runtime", HPAName: hpa.Name,
			PodSelector: "app=runtime", MinReplicas: 3,
		},
	}
	snapshot, err := controller.snapshot(context.Background(), statefulSet)
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Hosts) != 1 {
		t.Fatalf("Hosts = %#v", snapshot.Hosts)
	}
	host := snapshot.Hosts[0]
	if host.Name != pending.Name || host.UID != string(pending.UID) || host.Ordinal != 2 || host.Ready {
		t.Fatalf("pending Host identity = %#v", host)
	}
	if !snapshot.ScaleUpPending {
		t.Fatal("Pending Host topology must block scale-in")
	}
}

func TestSnapshotBatchesNodeTopologyAndBoundsParallelHostObservations(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		time.Sleep(50 * time.Millisecond)
		fmt.Fprint(response, `{"host_active_actors":0,"host_max_active_actors":32,"host_draining":false,"host_accepting_actors":true,"bridge_active_actors":0,"quiescent":true,"workerd_admission":{"in_flight":0,"queued":0,"max_in_flight":32}}`)
	}))
	defer server.Close()
	parsed, _ := url.Parse(server.URL)
	port, _ := strconv.Atoi(parsed.Port())
	const replicas = int32(64)
	statefulSet, hpa := healthyAutoscalerObjects(replicas, replicas, replicas)
	statefulSet.Namespace = "cell"
	statefulSet.UID = types.UID("workload-uid")
	statefulSet.Status.ReadyReplicas = replicas
	hpa.Namespace = "cell"
	hpa.Name = "runtime-capacity"
	objects := []runtime.Object{hpa, &corev1.Node{ObjectMeta: metav1.ObjectMeta{
		Name: "runtime-node", Labels: map[string]string{"topology.kubernetes.io/zone": "zone-a"},
	}}}
	for ordinal := int32(0); ordinal < replicas; ordinal++ {
		objects = append(objects, &corev1.Pod{
			ObjectMeta: metav1.ObjectMeta{Namespace: "cell", Name: fmt.Sprintf("runtime-%d", ordinal), UID: types.UID(fmt.Sprintf("uid-%d", ordinal)), Labels: map[string]string{"app": "runtime"}, OwnerReferences: hostOwnerReferences(statefulSet)},
			Spec:       corev1.PodSpec{NodeName: "runtime-node"},
			Status:     corev1.PodStatus{Phase: corev1.PodRunning, PodIP: parsed.Hostname(), Conditions: []corev1.PodCondition{{Type: corev1.PodReady, Status: corev1.ConditionTrue}}},
		})
	}
	client := fake.NewSimpleClientset(objects...)
	controller := &Controller{Kubernetes: client, HTTPClient: server.Client(), Config: ControllerConfig{
		Namespace: "cell", StatefulSetName: "runtime", HPAName: hpa.Name, PodSelector: "app=runtime",
		Token: "0123456789abcdef", ManagementPort: port, MinReplicas: 3, RequiredZones: 1,
		TopologyKey: "topology.kubernetes.io/zone",
	}}
	started := time.Now()
	snapshot, err := controller.snapshot(context.Background(), statefulSet)
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Hosts) != int(replicas) || time.Since(started) > time.Second {
		t.Fatalf("bounded parallel snapshot took %s for %d Hosts", time.Since(started), len(snapshot.Hosts))
	}
	var nodeLists, nodeGets int
	for _, action := range client.Actions() {
		if action.GetResource().Resource != "nodes" {
			continue
		}
		switch action.GetVerb() {
		case "list":
			nodeLists++
		case "get":
			nodeGets++
		}
	}
	if nodeLists != 1 || nodeGets != 0 {
		t.Fatalf("Node topology API amplification returned: lists=%d gets=%d actions=%#v", nodeLists, nodeGets, client.Actions())
	}
}

func TestManagementClientAuthenticatesAndBoundsTheDrainShape(t *testing.T) {
	const token = "0123456789abcdef0123456789abcdef"
	var drainCalls atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("x-rivet-workerd-token") != token {
			http.Error(response, "missing token", http.StatusUnauthorized)
			return
		}
		switch request.URL.Path {
		case "/v1/sqlite/stats":
			response.Header().Set("content-type", "application/json")
			fmt.Fprint(response, `{"host_active_actors":1,"host_max_active_actors":4,"host_draining":false,"host_accepting_actors":true,"bridge_active_actors":1,"quiescent":false,"workerd_admission":{"in_flight":0,"queued":0,"max_in_flight":2}}`)
		case "/v1/sqlite/drain":
			drainCalls.Add(1)
			response.Header().Set("content-type", "application/json")
			fmt.Fprint(response, `{"metadata_sent":true,"stats":{}}`)
		default:
			http.NotFound(response, request)
		}
	}))
	defer server.Close()

	parsed, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	port, err := strconv.Atoi(parsed.Port())
	if err != nil {
		t.Fatal(err)
	}
	controller := &Controller{
		HTTPClient: server.Client(),
		Config:     ControllerConfig{Token: token, ManagementPort: port},
	}
	pod := &corev1.Pod{}
	pod.Status.PodIP = parsed.Hostname()
	stats, err := controller.readHostStats(context.Background(), pod)
	if err != nil {
		t.Fatal(err)
	}
	if stats.HostActiveActors == nil || *stats.HostActiveActors != 1 || stats.WorkerdAdmission == nil || stats.WorkerdAdmission.MaxInFlight != 2 {
		t.Fatalf("stats = %#v", stats)
	}
	if err := controller.setHostDraining(context.Background(), pod, true); err != nil {
		t.Fatal(err)
	}
	if drainCalls.Load() != 1 {
		t.Fatalf("drain calls = %d", drainCalls.Load())
	}
}

func TestManagementStatsRejectUnknownFields(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(response, `{"unexpected":true}`)
	}))
	defer server.Close()
	parsed, _ := url.Parse(server.URL)
	port, _ := strconv.Atoi(parsed.Port())
	controller := &Controller{
		HTTPClient: server.Client(),
		Config:     ControllerConfig{Token: "0123456789abcdef", ManagementPort: port},
	}
	pod := &corev1.Pod{}
	pod.Status.PodIP = parsed.Hostname()
	if _, err := controller.readHostStats(context.Background(), pod); err == nil {
		t.Fatal("unknown management fields must fail closed")
	}
}

func TestManagementStatsRejectTrailingOrOversizedData(t *testing.T) {
	for name, body := range map[string]string{
		"trailing value":   `{}` + `{}`,
		"trailing garbage": `{}` + `garbage`,
		"oversized":        `{}` + string(make([]byte, 64*1024)),
	} {
		t.Run(name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
				fmt.Fprint(response, body)
			}))
			defer server.Close()
			parsed, _ := url.Parse(server.URL)
			port, _ := strconv.Atoi(parsed.Port())
			controller := &Controller{
				HTTPClient: server.Client(),
				Config:     ControllerConfig{Token: "0123456789abcdef", ManagementPort: port},
			}
			pod := &corev1.Pod{}
			pod.Status.PodIP = parsed.Hostname()
			if _, err := controller.readHostStats(context.Background(), pod); err == nil {
				t.Fatal("malformed management response must fail closed")
			}
		})
	}
}

func TestPersistedStateAndPodIdentityParsingFailClosed(t *testing.T) {
	if _, err := decodeState(`{"phase":"Draining","targetName":"runtime-2","targetUID":"uid-2","fromReplicas":3,"startedAt":"2026-08-25T12:00:00Z","unexpected":true}`); err == nil {
		t.Fatal("unknown persisted fields must fail closed")
	}
	if _, err := statefulOrdinal("runtime", "different-2"); err == nil {
		t.Fatal("foreign Pod name must not be accepted")
	}
	if ordinal, err := statefulOrdinal("runtime", "runtime-2"); err != nil || ordinal != 2 {
		t.Fatalf("ordinal = %d, %v", ordinal, err)
	}
}

func TestRuntimeReleaseHoldPausesScaleInBeforeReadingDynamicEvidence(t *testing.T) {
	statefulSet, _ := healthyAutoscalerObjects(3, 3, 3)
	statefulSet.Namespace = "cell"
	statefulSet.UID = types.UID("workload-uid")
	statefulSet.Annotations = map[string]string{
		ReleaseHoldAnnotation: `{"id":"release-0123456789abcdef","workload_uid":"workload-uid","acquired_at":"2026-09-05T13:00:00Z"}`,
	}
	controller := &Controller{
		Kubernetes: fake.NewSimpleClientset(statefulSet),
		Config: ControllerConfig{
			Namespace: "cell", CellName: "cell", StatefulSetName: statefulSet.Name,
			HPAName: "missing-on-purpose", PodSelector: "app=runtime",
			Token: "0123456789abcdef", ManagementPort: 19083, MinReplicas: 3,
			MaxRemainingUsagePct: 70,
		},
	}
	result, err := controller.ReconcileOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.Applied || result.Decision.State.Phase != PhaseIdle || result.Decision.Action.Kind != ActionNone {
		t.Fatalf("release hold decision = %#v", result)
	}
}

func TestRuntimeReleaseHoldFailsClosed(t *testing.T) {
	valid := `{"id":"release-0123456789abcdef","workload_uid":"workload-uid","acquired_at":"2026-09-05T13:00:00Z"}`
	for name, raw := range map[string]string{
		"unknown field": `{"id":"release-0123456789abcdef","workload_uid":"workload-uid","acquired_at":"2026-09-05T13:00:00Z","extra":true}`,
		"foreign UID":   `{"id":"release-0123456789abcdef","workload_uid":"other","acquired_at":"2026-09-05T13:00:00Z"}`,
		"bad ID":        `{"id":"RELEASE/INVALID/IDENTITY","workload_uid":"workload-uid","acquired_at":"2026-09-05T13:00:00Z"}`,
		"trailing JSON": valid + `{}`,
		"oversized":     valid + strings.Repeat(" ", 4*1024),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := decodeReleaseHold(raw, "workload-uid"); err == nil {
				t.Fatal("invalid release hold must fail closed")
			}
		})
	}
	hold, err := decodeReleaseHold(valid, "workload-uid")
	if err != nil || hold == nil || hold.AcquiredAt != time.Date(2026, 9, 5, 13, 0, 0, 0, time.UTC) {
		t.Fatalf("valid release hold = %#v, %v", hold, err)
	}
}

func TestRuntimeReleaseHoldCannotOverlapActiveDrain(t *testing.T) {
	statefulSet, _ := healthyAutoscalerObjects(4, 4, 4)
	statefulSet.Namespace = "cell"
	statefulSet.UID = types.UID("workload-uid")
	statefulSet.Annotations = map[string]string{
		StateAnnotation:       `{"phase":"Selected","epoch":1,"targetName":"runtime-3","targetUID":"pod-uid","fromReplicas":4,"startedAt":"2026-09-05T13:00:00Z","transitionAt":"2026-09-05T13:00:00Z"}`,
		ReleaseHoldAnnotation: `{"id":"release-0123456789abcdef","workload_uid":"workload-uid","acquired_at":"2026-09-05T13:00:00Z"}`,
	}
	controller := &Controller{
		Kubernetes: fake.NewSimpleClientset(statefulSet),
		Config: ControllerConfig{
			Namespace: "cell", CellName: "cell", StatefulSetName: statefulSet.Name,
			HPAName: "unused", PodSelector: "app=runtime", Token: "0123456789abcdef",
			ManagementPort: 19083, MinReplicas: 3, MaxRemainingUsagePct: 70,
		},
	}
	if _, err := controller.ReconcileOnce(context.Background()); err == nil {
		t.Fatal("release hold overlapping a non-idle drain must fail closed")
	}
}
