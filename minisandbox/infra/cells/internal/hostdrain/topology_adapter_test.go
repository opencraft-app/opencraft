package hostdrain

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/rivet-dev/rivet/infra/cells/internal/runtimecapacity/admission"
	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	policyv1 "k8s.io/api/policy/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/kubernetes/fake"
	"k8s.io/client-go/rest"
	ktesting "k8s.io/client-go/testing"
)

func hostOwnerReferences(workload *appsv1.StatefulSet) []metav1.OwnerReference {
	controller := true
	return []metav1.OwnerReference{{APIVersion: "apps/v1", Kind: "StatefulSet", Name: workload.Name, UID: workload.UID, Controller: &controller}}
}

func adapterObjects(t *testing.T) (State, *appsv1.StatefulSet, *corev1.Pod) {
	t.Helper()
	state, snapshot := authorizedEviction(t)
	replicas := snapshot.Replicas
	workload := &appsv1.StatefulSet{
		ObjectMeta: metav1.ObjectMeta{Name: "runtime", Namespace: "cell", UID: types.UID(state.RepairWorkloadUID), ResourceVersion: "5000"},
		Spec:       appsv1.StatefulSetSpec{Replicas: &replicas},
	}
	workload.Annotations = map[string]string{StateAnnotation: encodedState(t, state)}
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: state.TargetName, Namespace: "cell", UID: types.UID(state.TargetUID), ResourceVersion: state.EvictionResourceVersion,
			OwnerReferences: hostOwnerReferences(workload), Labels: map[string]string{"app": "runtime"}},
		Status: corev1.PodStatus{PodIP: "127.0.0.1", Conditions: []corev1.PodCondition{{Type: corev1.PodReady, Status: corev1.ConditionTrue}}},
	}
	return state, workload, pod
}

func encodedState(t *testing.T, state State) string {
	t.Helper()
	payload, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	return string(payload)
}

func managementTestController(t *testing.T, handler http.HandlerFunc) *Controller {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	address, _ := url.Parse(server.URL)
	port, _ := strconv.Atoi(address.Port())
	return &Controller{HTTPClient: server.Client(), Now: func() time.Time { return repairSnapshot().Now },
		Config: ControllerConfig{Namespace: "cell", StatefulSetName: "runtime", HPAName: "runtime-capacity", PodSelector: "app=runtime", MinReplicas: 4,
			Token: "0123456789abcdef", ManagementPort: port}}
}

func quiescentResponse(response http.ResponseWriter, _ *http.Request) {
	fmt.Fprint(response, `{"host_active_actors":0,"host_max_active_actors":32,"host_draining":true,"host_accepting_actors":false,"bridge_active_actors":0,"quiescent":true,"workerd_admission":{"in_flight":0,"queued":0,"max_in_flight":32}}`)
}

func apiTestClient(t *testing.T, handler http.HandlerFunc) kubernetes.Interface {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	client, err := kubernetes.NewForConfig(&rest.Config{Host: server.URL, Timeout: 2 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	return client
}

// This is a real typed-client HTTP contract test, not a Kubernetes server/PDB
// integration test. The real API gate is intentionally still pending.
func TestEvictionHTTPUsesOnlyPersistedUIDRVAndNormalGrace(t *testing.T) {
	for _, status := range []int{200, 429, 409, 503} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			state, _, pod := adapterObjects(t)
			controller := managementTestController(t, quiescentResponse)
			var calls atomic.Int32
			controller.Kubernetes = apiTestClient(t, func(response http.ResponseWriter, request *http.Request) {
				calls.Add(1)
				if request.Method != http.MethodPost || request.URL.Path != "/api/v1/namespaces/cell/pods/runtime-109/eviction" {
					t.Errorf("unexpected Kubernetes action %s %s", request.Method, request.URL.Path)
				}
				var eviction policyv1.Eviction
				if err := json.NewDecoder(request.Body).Decode(&eviction); err != nil {
					t.Error(err)
				}
				options := eviction.DeleteOptions
				if eviction.APIVersion != "policy/v1" || eviction.Kind != "Eviction" || eviction.Name != pod.Name || options == nil || options.Preconditions == nil ||
					options.Preconditions.UID == nil || *options.Preconditions.UID != pod.UID || options.Preconditions.ResourceVersion == nil || *options.Preconditions.ResourceVersion != state.EvictionResourceVersion ||
					options.GracePeriodSeconds != nil || options.DryRun != nil || options.PropagationPolicy != nil {
					t.Errorf("unsafe eviction request: %#v", eviction)
				}
				response.Header().Set("Content-Type", "application/json")
				response.WriteHeader(status)
				if status == 200 {
					fmt.Fprint(response, `{"kind":"Status","apiVersion":"v1","status":"Success"}`)
				} else {
					fmt.Fprintf(response, `{"kind":"Status","apiVersion":"v1","status":"Failure","reason":"TooManyRequests","code":%d}`, status)
				}
			})
			err := controller.evictHost(context.Background(), pod, state)
			if (err == nil) != (status == 200) {
				t.Fatalf("HTTP %d: %v", status, err)
			}
			if status == 429 && !apierrors.IsTooManyRequests(err) {
				t.Fatalf("PDB rejection was hidden: %v", err)
			}
			if calls.Load() != 1 {
				t.Fatalf("unexpected retry/delete: %d calls", calls.Load())
			}
		})
	}
}

func TestEvictionLostResponseDoesNotReplayOrForceDelete(t *testing.T) {
	state, _, pod := adapterObjects(t)
	controller := managementTestController(t, quiescentResponse)
	var calls atomic.Int32
	controller.Kubernetes = apiTestClient(t, func(response http.ResponseWriter, request *http.Request) {
		calls.Add(1)
		connection, _, err := response.(http.Hijacker).Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		connection.Close()
	})
	if err := controller.evictHost(context.Background(), pod, state); err == nil {
		t.Fatal("lost response cannot mean success")
	}
	if calls.Load() != 1 {
		t.Fatalf("indeterminate eviction replayed %d times", calls.Load())
	}
}

func TestEvictionRejectsStaleIdentityAndNonQuiescentEvidence(t *testing.T) {
	for _, test := range []struct {
		name   string
		mutate func(*corev1.Pod, *State)
		body   string
	}{
		{name: "replacement UID", mutate: func(p *corev1.Pod, _ *State) { p.UID = "new-uid" }},
		{name: "changed RV", mutate: func(p *corev1.Pod, _ *State) { p.ResourceVersion = "new-rv" }},
		{name: "not Ready", mutate: func(p *corev1.Pod, _ *State) { p.Status.Conditions = nil }},
		{name: "terminating", mutate: func(p *corev1.Pod, _ *State) { now := metav1.Now(); p.DeletionTimestamp = &now }},
		{name: "wrong phase", mutate: func(_ *corev1.Pod, s *State) { s.Phase = PhaseRebalanceCancelling }},
		{name: "bridge still active", body: `{"host_active_actors":0,"host_max_active_actors":32,"host_draining":true,"host_accepting_actors":false,"bridge_active_actors":1,"quiescent":true,"workerd_admission":{"in_flight":0,"queued":0,"max_in_flight":32}}`},
		{name: "incomplete", body: `{}`},
		{name: "negative counters", body: `{"host_active_actors":-1,"host_max_active_actors":32,"host_draining":true,"host_accepting_actors":false,"bridge_active_actors":0,"quiescent":true,"workerd_admission":{"in_flight":0,"queued":0,"max_in_flight":32}}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			state, _, pod := adapterObjects(t)
			if test.mutate != nil {
				test.mutate(pod, &state)
			}
			controller := managementTestController(t, func(w http.ResponseWriter, r *http.Request) {
				if test.body != "" {
					fmt.Fprint(w, test.body)
				} else {
					quiescentResponse(w, r)
				}
			})
			client := fake.NewSimpleClientset()
			controller.Kubernetes = client
			if err := controller.evictHost(context.Background(), pod, state); err == nil {
				t.Fatal("unsafe eviction accepted")
			}
			if len(client.Actions()) != 0 {
				t.Fatalf("unexpected Kubernetes mutation: %#v", client.Actions())
			}
		})
	}
}

func TestCancellationHTTPTestsCurrentUIDRVBeforeAddingEpochProof(t *testing.T) {
	for _, annotations := range []map[string]string{nil, {"unrelated": "preserve-me"}} {
		t.Run(fmt.Sprint(annotations == nil), func(t *testing.T) {
			state, _, pod := adapterObjects(t)
			state.Phase = PhaseRebalanceCancelling
			// Model the RV advanced by the eviction server's condition update.
			pod.ResourceVersion, pod.Annotations = "after-condition-update", annotations
			controller := &Controller{}
			var calls atomic.Int32
			controller.Kubernetes = apiTestClient(t, func(response http.ResponseWriter, request *http.Request) {
				calls.Add(1)
				if request.Method != "PATCH" || request.URL.Path != "/api/v1/namespaces/cell/pods/runtime-109" || request.Header.Get("Content-Type") != "application/json-patch+json" {
					t.Error("not exact metadata CAS")
				}
				var operations []map[string]any
				if err := json.NewDecoder(request.Body).Decode(&operations); err != nil {
					t.Error(err)
				}
				if len(operations) != 3 || operations[0]["op"] != "test" || operations[0]["path"] != "/metadata/uid" || operations[0]["value"] != string(pod.UID) ||
					operations[1]["op"] != "test" || operations[1]["path"] != "/metadata/resourceVersion" || operations[1]["value"] != pod.ResourceVersion || operations[2]["op"] != "add" {
					t.Errorf("unsafe cancellation CAS: %#v", operations)
				}
				if annotations == nil {
					if operations[2]["path"] != "/metadata/annotations" || operations[2]["value"].(map[string]any)[EvictionCancellationAnnotation] != cancellationToken(state) {
						t.Error("missing bound proof")
					}
				} else if operations[2]["path"] != "/metadata/annotations/"+escapeJSONPointer(EvictionCancellationAnnotation) || operations[2]["value"] != cancellationToken(state) {
					t.Error("unexpected metadata replacement")
				}
				response.Header().Set("Content-Type", "application/json")
				json.NewEncoder(response).Encode(pod)
			})
			action := Action{Kind: ActionCancelEviction, TargetName: pod.Name, TargetUID: string(pod.UID), ResourceVersion: pod.ResourceVersion}
			if err := controller.cancelEviction(context.Background(), pod, action, state); err != nil {
				t.Fatal(err)
			}
			if calls.Load() != 1 || evictionCancellationObserved(state, pod) {
				t.Fatal("CAS response alone must not restore placement")
			}
		})
	}
}

func TestCancellationProofIsExactAndSurvivesLostResponse(t *testing.T) {
	state, _, pod := adapterObjects(t)
	state.Phase = PhaseRebalanceCancelling
	pod.ResourceVersion = "after-our-cas"
	pod.Annotations = map[string]string{EvictionCancellationAnnotation: cancellationToken(state)}
	if !evictionCancellationObserved(state, pod) {
		t.Fatal("exact proof not accepted")
	}
	for _, mutate := range []func(*State){
		func(s *State) { s.Epoch++ }, func(s *State) { s.RepairWorkloadUID = "other-workload" },
		func(s *State) { s.EvictionResourceVersion = "other-original-rv" }, func(s *State) { s.TargetUID = "successor" },
	} {
		changed := state
		mutate(&changed)
		if evictionCancellationObserved(changed, pod) {
			t.Fatal("foreign operation inherited cancellation")
		}
	}
	controller := &Controller{Kubernetes: fake.NewSimpleClientset()}
	if err := controller.cancelEviction(context.Background(), pod, Action{ResourceVersion: pod.ResourceVersion}, state); err != nil {
		t.Fatal(err)
	}
	if len(controller.Kubernetes.(*fake.Clientset).Actions()) != 0 {
		t.Fatal("restart replayed successful cancellation")
	}
	pod.Annotations = nil
	if evictionCancellationObserved(state, pod) {
		t.Fatal("RV change alone is not proof")
	}
}

func TestActionRechecksDurableAuthorityBeforeAnyMutation(t *testing.T) {
	for _, mutate := range []struct {
		name  string
		apply func(*appsv1.StatefulSet, *corev1.Pod, State)
	}{
		{"workload replacement", func(w *appsv1.StatefulSet, _ *corev1.Pod, _ State) { w.UID = "replacement-workload" }},
		{"state changed", func(w *appsv1.StatefulSet, _ *corev1.Pod, s State) {
			s.Epoch++
			w.Annotations[StateAnnotation] = encodedState(t, s)
		}},
		{"release hold", func(w *appsv1.StatefulSet, _ *corev1.Pod, s State) {
			w.Annotations[ReleaseHoldAnnotation] = fmt.Sprintf(`{"id":"release-0123456789abcdef","workload_uid":%q,"acquired_at":"2026-10-03T21:30:19Z"}`, s.RepairWorkloadUID)
		}},
		{"Pod replacement", func(_ *appsv1.StatefulSet, p *corev1.Pod, _ State) { p.UID = "successor" }},
		{"foreign owner", func(_ *appsv1.StatefulSet, p *corev1.Pod, _ State) { p.OwnerReferences[0].UID = "foreign-workload" }},
		{"no owner", func(_ *appsv1.StatefulSet, p *corev1.Pod, _ State) { p.OwnerReferences = nil }},
		{"deletion won", func(_ *appsv1.StatefulSet, p *corev1.Pod, _ State) { now := metav1.Now(); p.DeletionTimestamp = &now }},
	} {
		t.Run(mutate.name, func(t *testing.T) {
			state, workload, pod := adapterObjects(t)
			state.Phase = PhaseRebalanceCancelling
			workload.Annotations[StateAnnotation] = encodedState(t, state)
			original := workload.DeepCopy()
			mutate.apply(workload, pod, state)
			client := fake.NewSimpleClientset(workload, pod)
			controller := &Controller{Kubernetes: client, Config: ControllerConfig{Namespace: "cell"}}
			action := Action{Kind: ActionCancelEviction, TargetName: state.TargetName, TargetUID: state.TargetUID, ResourceVersion: pod.ResourceVersion}
			if err := controller.applyAction(context.Background(), original, action, state); err == nil {
				t.Fatal("stale authority accepted")
			}
			for _, action := range client.Actions() {
				if action.GetVerb() != "get" {
					t.Fatalf("unexpected mutation %s", action.GetVerb())
				}
			}
		})
	}
}

func TestCancellationDoesNotDependOnHostManagementAvailability(t *testing.T) {
	state, workload, pod := adapterObjects(t)
	state.Phase = PhaseRebalanceCancelling
	workload.Annotations[StateAnnotation] = encodedState(t, state)
	controller := managementTestController(t, func(w http.ResponseWriter, _ *http.Request) {
		t.Error("cancellation contacted Host")
		w.WriteHeader(503)
	})
	client := fake.NewSimpleClientset(workload, pod)
	controller.Kubernetes = client
	action := Action{Kind: ActionCancelEviction, TargetName: pod.Name, TargetUID: string(pod.UID), ResourceVersion: pod.ResourceVersion}
	if err := controller.applyAction(context.Background(), workload, action, state); err != nil {
		t.Fatal(err)
	}
	var patches int
	for _, a := range client.Actions() {
		if a.GetVerb() == "patch" && a.GetResource().Resource == "pods" {
			patches++
		}
	}
	if patches != 1 {
		t.Fatalf("patches = %d", patches)
	}
}

func TestDrainStateRequiresEOFAndExplicitBound(t *testing.T) {
	for _, raw := range []string{`{"phase":"Idle"}{}`, `{"phase":"Idle"} garbage`, `{"phase":"Idle"}` + strings.Repeat(" ", 16*1024)} {
		if _, err := decodeState(raw); err == nil {
			t.Fatal("malformed/oversized state accepted")
		}
	}
}

func TestReconcileCancelsIndeterminateEvictionWhenHostEvidenceIsLost(t *testing.T) {
	state, workload, pod := adapterObjects(t)
	controller := managementTestController(t, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(503) })
	controller.Config.CellName = "cell"
	controller.Config.MaxRemainingUsagePct = 70
	controller.Config.MinReplicas = 3
	_, hpa := healthyAutoscalerObjects(state.FromReplicas, state.FromReplicas, state.FromReplicas)
	hpa.Name, hpa.Namespace = "runtime-capacity", "cell"
	client := fake.NewSimpleClientset(workload, pod, hpa)
	controller.Kubernetes = client
	result, err := controller.ReconcileOnce(context.Background())
	if err == nil || !result.Applied || result.Decision.State.Phase != PhaseRebalanceCancelling {
		t.Fatalf("lost evidence recovery=%#v err=%v", result, err)
	}
	result, err = controller.ReconcileOnce(context.Background())
	if err != nil || result.Decision.Action.Kind != ActionCancelEviction || !result.Applied {
		t.Fatalf("Kubernetes-only cancellation=%#v err=%v", result, err)
	}
	var patches, evictions int
	for _, a := range client.Actions() {
		if a.GetVerb() == "patch" && a.GetResource().Resource == "pods" {
			patches++
		}
		if a.GetSubresource() == "eviction" {
			evictions++
		}
	}
	if patches != 1 || evictions != 0 {
		t.Fatalf("patches=%d evictions=%d", patches, evictions)
	}
}

func TestCancellationLostResponseRecoveredByAuthoritativeGET(t *testing.T) {
	state, _, pod := adapterObjects(t)
	state.Phase = PhaseRebalanceCancelling
	var calls atomic.Int32
	var lock sync.Mutex
	serverPod := pod.DeepCopy()
	controller := &Controller{}
	controller.Kubernetes = apiTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		lock.Lock()
		defer lock.Unlock()
		if r.Method == "PATCH" {
			calls.Add(1)
			serverPod.Annotations = map[string]string{EvictionCancellationAnnotation: cancellationToken(state)}
			serverPod.ResourceVersion = "after-persisted-cancel"
			connection, _, err := w.(http.Hijacker).Hijack()
			if err != nil {
				t.Error(err)
				return
			}
			connection.Close()
			return
		}
		if r.Method != "GET" {
			t.Errorf("unexpected method %s", r.Method)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(serverPod)
	})
	action := Action{ResourceVersion: state.EvictionResourceVersion}
	if err := controller.cancelEviction(context.Background(), pod, action, state); err == nil {
		t.Fatal("lost CAS response reported success")
	}
	recovered, err := controller.Kubernetes.CoreV1().Pods("cell").Get(context.Background(), pod.Name, metav1.GetOptions{})
	if err != nil || !evictionCancellationObserved(state, recovered) {
		t.Fatalf("proof not recovered: %v", err)
	}
	if err := controller.cancelEviction(context.Background(), recovered, Action{ResourceVersion: recovered.ResourceVersion}, state); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 1 {
		t.Fatal("confirmed cancellation was replayed")
	}
}

func TestReconcileCancellationNeverActsOnSuccessorUID(t *testing.T) {
	state, workload, pod := adapterObjects(t)
	state.Phase = PhaseRebalanceCancelling
	workload.Annotations[StateAnnotation] = encodedState(t, state)
	pod.UID = "successor-uid"
	client := fake.NewSimpleClientset(workload, pod)
	controller := &Controller{Kubernetes: client, Config: ControllerConfig{Namespace: "cell", CellName: "cell", StatefulSetName: "runtime", HPAName: "missing", PodSelector: "app=runtime", Token: "0123456789abcdef", ManagementPort: 19083, MinReplicas: 4, MaxRemainingUsagePct: 70}}
	result, err := controller.ReconcileOnce(context.Background())
	if err != nil || result.Decision.State.Phase != PhaseRebalanceReplacing || result.Decision.Action.Kind != ActionNone {
		t.Fatalf("successor recovery=%#v err=%v", result, err)
	}
	for _, a := range client.Actions() {
		if a.GetResource().Resource == "pods" && a.GetVerb() != "get" {
			t.Fatalf("successor mutation: %s", a.GetVerb())
		}
	}
}

func TestStatePersistenceAndScaleCASBindUIDRVAndOperation(t *testing.T) {
	state, workload, _ := adapterObjects(t)
	client := fake.NewSimpleClientset(workload)
	controller := &Controller{Kubernetes: client, Config: ControllerConfig{Namespace: "cell"}}
	client.PrependReactor("patch", "statefulsets", func(a ktesting.Action) (bool, runtime.Object, error) {
		patch := a.(ktesting.PatchAction)
		var operations []map[string]any
		if err := json.Unmarshal(patch.GetPatch(), &operations); err != nil {
			t.Fatal(err)
		}
		if len(operations) < 3 || operations[0]["path"] != "/metadata/uid" || operations[0]["value"] != string(workload.UID) || operations[1]["path"] != "/metadata/resourceVersion" || operations[1]["value"] != workload.ResourceVersion {
			t.Errorf("missing workload identity CAS: %#v", operations)
		}
		if len(operations) == 5 && (operations[2]["path"] != "/metadata/annotations/"+escapeJSONPointer(StateAnnotation) || operations[2]["value"] != workload.Annotations[StateAnnotation]) {
			t.Error("scale did not bind exact operation")
		}
		return true, workload.DeepCopy(), nil
	})
	if err := controller.persistState(context.Background(), workload, state); err != nil {
		t.Fatal(err)
	}
	if err := controller.setReplicas(context.Background(), workload, state, state.FromReplicas-1); err != nil {
		t.Fatal(err)
	}
}

func TestEvictionDeadlineIsRecheckedAfterManagementObservation(t *testing.T) {
	state, _, pod := adapterObjects(t)
	var elapsed atomic.Int64
	controller := managementTestController(t, func(w http.ResponseWriter, r *http.Request) {
		elapsed.Store(int64(2 * time.Second))
		quiescentResponse(w, r)
	})
	controller.Config.DrainTimeout = time.Second
	controller.Now = func() time.Time { return state.StartedAt.Add(time.Duration(elapsed.Load())) }
	client := fake.NewSimpleClientset()
	controller.Kubernetes = client
	if err := controller.evictHost(context.Background(), pod, state); err == nil {
		t.Fatal("expired eviction was authorized after stats call")
	}
	if len(client.Actions()) != 0 {
		t.Fatal("expired eviction reached Kubernetes")
	}
}

func TestFullReconcileRevalidatesCapacityBeforeExactEviction(t *testing.T) {
	for _, mode := range []string{"authorized", "HPA expansion wins", "workload changes during observation"} {
		t.Run(mode, func(t *testing.T) {
			state, workload, _ := adapterObjects(t)
			snapshot := repairSnapshot()
			controller, template, nodes, machines, _ := capacityObjects(t)
			workload.Spec.Template = template.Spec.Template
			workload.Status.ReadyReplicas = state.FromReplicas
			prototype := nodes.Items[1].DeepCopy()
			machines = machines[:1]
			nodes.Items = nil
			objects := []runtime.Object{workload}
			addNode := func(index int, zone string) string {
				node := prototype.DeepCopy()
				node.Name = fmt.Sprintf("repair-node-%d", index)
				node.UID = types.UID(fmt.Sprintf("node-uid-%d", index))
				node.Spec.ProviderID = "provider-" + node.Name
				node.Labels[corev1.LabelTopologyZone], node.Labels[corev1.LabelHostname] = zone, node.Name
				machine := &unstructured.Unstructured{Object: map[string]any{"apiVersion": "node.tke.cloud.tencent.com/v1beta1", "kind": "Machine", "metadata": map[string]any{"name": "machine-" + node.Name, "uid": "machine-uid-" + node.Name, "labels": map[string]any{runtimeMachineSetLabel: "np-runtime0"}}, "status": map[string]any{"nodeRef": map[string]any{"name": node.Name}}}}
				proof, err := admission.DecodeState(prototype.Annotations[admission.StateAnnotation])
				if err != nil {
					t.Fatal(err)
				}
				proof.Identity.NodeUID, proof.Identity.ProviderID, proof.Identity.MachineUID = string(node.UID), node.Spec.ProviderID, string(machine.GetUID())
				encoded, err := admission.EncodeState(proof)
				if err != nil {
					t.Fatal(err)
				}
				node.Annotations[admission.StateAnnotation] = encoded
				objects = append(objects, node)
				machines = append(machines, machine)
				return node.Name
			}
			for index, host := range snapshot.Hosts {
				name := addNode(index, host.Zone)
				objects = append(objects, &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: host.Name, Namespace: "cell", UID: types.UID(host.UID), ResourceVersion: host.ResourceVersion, Labels: workload.Spec.Template.Labels, OwnerReferences: hostOwnerReferences(workload)}, Spec: corev1.PodSpec{NodeName: name}, Status: corev1.PodStatus{PodIP: fmt.Sprintf("127.0.0.%d", index+1), Conditions: []corev1.PodCondition{{Type: corev1.PodReady, Status: corev1.ConditionTrue}}}})
			}
			for index, zone := range []string{"zone-a", "zone-b", "zone-c"} {
				addNode(111+index, zone)
			}
			_, hpa := healthyAutoscalerObjects(111, 111, 111)
			minimum := int32(4)
			hpa.Spec.MinReplicas = &minimum
			hpa.Spec.MaxReplicas = 301
			hpa.Name, hpa.Namespace = "runtime-capacity", "cell"
			objects = append(objects, hpa)
			resetCapacityClients(controller, machines, objects)
			client := controller.Kubernetes.(*fake.Clientset)
			var hpaReads, workloadReads atomic.Int32
			client.PrependReactor("get", "horizontalpodautoscalers", func(a ktesting.Action) (bool, runtime.Object, error) {
				if hpaReads.Add(1) > 1 && mode == "HPA expansion wins" {
					copy := hpa.DeepCopy()
					copy.Status.DesiredReplicas = 113
					return true, copy, nil
				}
				return false, nil, nil
			})
			client.PrependReactor("get", "statefulsets", func(a ktesting.Action) (bool, runtime.Object, error) {
				if workloadReads.Add(1) == 3 && mode == "workload changes during observation" {
					copy := workload.DeepCopy()
					copy.ResourceVersion = "later-rv"
					return true, copy, nil
				}
				return false, nil, nil
			})
			client.PrependReactor("create", "pods", func(a ktesting.Action) (bool, runtime.Object, error) {
				if a.GetSubresource() != "eviction" {
					return false, nil, nil
				}
				eviction := a.(ktesting.CreateAction).GetObject().(*policyv1.Eviction)
				if eviction.Name != state.TargetName || *eviction.DeleteOptions.Preconditions.UID != types.UID(state.TargetUID) || *eviction.DeleteOptions.Preconditions.ResourceVersion != state.EvictionResourceVersion {
					t.Error("reconcile changed exact eviction authority")
				}
				return true, &metav1.Status{Status: metav1.StatusSuccess}, nil
			})
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				address, _, err := net.SplitHostPort(r.Host)
				if err != nil {
					t.Error(err)
					return
				}
				if address == "127.0.0.110" {
					quiescentResponse(w, r)
				} else {
					fmt.Fprint(w, `{"host_active_actors":0,"host_max_active_actors":32,"host_draining":false,"host_accepting_actors":true,"bridge_active_actors":0,"quiescent":true,"workerd_admission":{"in_flight":0,"queued":0,"max_in_flight":32}}`)
				}
			}))
			defer server.Close()
			address, _ := url.Parse(server.URL)
			port, _ := strconv.Atoi(address.Port())
			transport := server.Client().Transport.(*http.Transport).Clone()
			transport.DialContext = func(ctx context.Context, network, _ string) (net.Conn, error) {
				return (&net.Dialer{}).DialContext(ctx, network, address.Host)
			}
			defer transport.CloseIdleConnections()
			controller.HTTPClient = &http.Client{Transport: transport, Timeout: 2 * time.Second}
			controller.Now = func() time.Time { return snapshot.Now }
			controller.Config.StatefulSetName, controller.Config.HPAName, controller.Config.PodSelector = "runtime", "runtime-capacity", "app=runtime"
			controller.Config.Token, controller.Config.ManagementPort = "0123456789abcdef", port
			controller.Config.MinReplicas, controller.Config.MaxRemainingUsagePct = 4, 70
			controller.Config.TopologyMaxSkew = 2
			result, err := controller.ReconcileOnce(context.Background())
			if mode == "authorized" {
				if err != nil || !result.Applied || result.Decision.Action.Kind != ActionEvictHost {
					t.Fatalf("full reconcile=%#v err=%v", result, err)
				}
			} else if err == nil {
				t.Fatal("changed action boundary was accepted")
			}
			var evictions int
			for _, a := range client.Actions() {
				if a.GetSubresource() == "eviction" {
					evictions++
				}
				if a.GetVerb() == "delete" {
					t.Fatal("reconcile used direct Delete")
				}
			}
			want := 0
			if mode == "authorized" {
				want = 1
			}
			if evictions != want {
				t.Fatalf("evictions=%d want=%d", evictions, want)
			}
		})
	}
}
