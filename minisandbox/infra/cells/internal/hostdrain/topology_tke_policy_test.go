//go:build integration

package hostdrain

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/version"
	"k8s.io/client-go/discovery/fake"
	clientfake "k8s.io/client-go/kubernetes/fake"
)

func validTKEEvictionIntent() tkeEvictionIntent {
	return tkeEvictionIntent{
		Schema: "minisandbox-tke-eviction-api-intent/v1", Context: "reviewed-cell",
		APIServer: "https://10.160.0.10:443", ClusterNamespaceUID: "12345678-1234-1234-1234-123456789abc",
		ServerVersion: "v1.30.0-tke.22", NodeName: "reviewed-control-node",
		NodeUID: "12345678-1234-1234-1234-123456789abd", NodeProviderID: "qcloud:///1/ins-fixture",
		CallbackIP: "10.160.0.8", FixtureImage: "reviewed.tencentcloudcr.com/fleet/observability-busybox@sha256:" + strings.Repeat("a", 64),
		AdapterHashes: map[string]string{"controller.go": strings.Repeat("a", 64),
			"topology_adapter.go": strings.Repeat("b", 64), "topology_capacity.go": strings.Repeat("c", 64)},
	}
}

func TestTKEEvictionIntentRejectsAmbiguousOrUnboundedJSON(t *testing.T) {
	payload, _ := json.Marshal(validTKEEvictionIntent())
	for _, value := range [][]byte{nil, []byte("null"), append(payload, payload...),
		[]byte(strings.Repeat(" ", 16*1024+1)),
		[]byte(strings.TrimSuffix(string(payload), "}") + `,"unexpected":true}`),
		[]byte(strings.TrimSuffix(string(payload), "}") + `,"context":"reviewed-cell"}`),
		[]byte(strings.Replace(string(payload), `"controller.go":`, `"controller.go":"`+strings.Repeat("a", 64)+`","controller.go":`, 1)),
	} {
		if _, err := parseTKEEvictionIntent(value); err == nil {
			t.Fatal("ambiguous or unbounded JSON intent accepted")
		}
	}
}

func TestTKEEvictionIntentRequiresCompletePrivateIdentity(t *testing.T) {
	mutations := map[string]func(*tkeEvictionIntent){
		"schema":     func(v *tkeEvictionIntent) { v.Schema = "unknown/v1" },
		"context":    func(v *tkeEvictionIntent) { v.Context = " " },
		"cluster":    func(v *tkeEvictionIntent) { v.ClusterNamespaceUID = "" },
		"node":       func(v *tkeEvictionIntent) { v.NodeUID = "unknown" },
		"node_name":  func(v *tkeEvictionIntent) { v.NodeName = "" },
		"provider":   func(v *tkeEvictionIntent) { v.NodeProviderID = "qcloud://" },
		"version":    func(v *tkeEvictionIntent) { v.ServerVersion = "v1.35.5+k3s1" },
		"public_api": func(v *tkeEvictionIntent) { v.APIServer = "https://1.1.1.1:443" },
		"http":       func(v *tkeEvictionIntent) { v.APIServer = "http://10.160.0.10:443" },
		"api_auth":   func(v *tkeEvictionIntent) { v.APIServer = "https://user:password@10.160.0.10:443" },
		"api_path":   func(v *tkeEvictionIntent) { v.APIServer += "/anything" },
		"api_query":  func(v *tkeEvictionIntent) { v.APIServer += "?anything" },
		"callback":   func(v *tkeEvictionIntent) { v.CallbackIP = "0.0.0.0" },
		"loopback":   func(v *tkeEvictionIntent) { v.CallbackIP = "127.0.0.1" },
		"mutable_image": func(v *tkeEvictionIntent) {
			v.FixtureImage = "reviewed.tencentcloudcr.com/fleet/observability-busybox:latest"
		},
		"public_image": func(v *tkeEvictionIntent) { v.FixtureImage = "docker.io/busybox@sha256:" + strings.Repeat("a", 64) },
		"missing_hash": func(v *tkeEvictionIntent) { delete(v.AdapterHashes, "controller.go") },
		"invalid_hash": func(v *tkeEvictionIntent) { v.AdapterHashes["controller.go"] = "invalid" },
		"extra_hash":   func(v *tkeEvictionIntent) { v.AdapterHashes["../anything"] = strings.Repeat("a", 64) },
	}
	for name, mutate := range mutations {
		t.Run(name, func(t *testing.T) {
			intent := validTKEEvictionIntent()
			mutate(&intent)
			payload, _ := json.Marshal(intent)
			if _, err := parseTKEEvictionIntent(payload); err == nil {
				t.Fatal("unsafe intent accepted")
			}
		})
	}
	payload, _ := json.Marshal(validTKEEvictionIntent())
	if _, err := parseTKEEvictionIntent(payload); err != nil {
		t.Fatal(err)
	}
}

func TestTKEEvictionTargetFailuresRemainReadOnly(t *testing.T) {
	intent := validTKEEvictionIntent()
	mutations := map[string]func(*corev1.Node, *corev1.Namespace, *version.Info){
		"matching":       func(*corev1.Node, *corev1.Namespace, *version.Info) {},
		"node_uid":       func(n *corev1.Node, _ *corev1.Namespace, _ *version.Info) { n.UID = "replacement" },
		"node_provider":  func(n *corev1.Node, _ *corev1.Namespace, _ *version.Info) { n.Spec.ProviderID = "qcloud:///different" },
		"cluster_uid":    func(_ *corev1.Node, ns *corev1.Namespace, _ *version.Info) { ns.UID = "replacement" },
		"server_version": func(_ *corev1.Node, _ *corev1.Namespace, v *version.Info) { v.GitVersion = "v1.30.0-tke.23" },
		"not_control": func(n *corev1.Node, _ *corev1.Namespace, _ *version.Info) {
			delete(n.Labels, "fleet.actor.dev/control-pool")
		},
		"compute": func(n *corev1.Node, _ *corev1.Namespace, _ *version.Info) { n.Labels["rivet.dev/compute"] = "true" },
		"hostname": func(n *corev1.Node, _ *corev1.Namespace, _ *version.Info) {
			n.Labels[corev1.LabelHostname] = "different"
		},
		"zone": func(n *corev1.Node, _ *corev1.Namespace, _ *version.Info) {
			delete(n.Labels, "topology.kubernetes.io/zone")
		},
		"not_ready": func(n *corev1.Node, _ *corev1.Namespace, _ *version.Info) { n.Status.Conditions = nil },
		"pressure": func(n *corev1.Node, _ *corev1.Namespace, _ *version.Info) {
			n.Status.Conditions = append(n.Status.Conditions, corev1.NodeCondition{Type: corev1.NodeDiskPressure, Status: corev1.ConditionTrue})
		},
		"cordon": func(n *corev1.Node, _ *corev1.Namespace, _ *version.Info) { n.Spec.Unschedulable = true },
		"taint": func(n *corev1.Node, _ *corev1.Namespace, _ *version.Info) {
			n.Spec.Taints = []corev1.Taint{{Key: "dedicated", Effect: corev1.TaintEffectNoSchedule}}
		},
		"terminating": func(n *corev1.Node, _ *corev1.Namespace, _ *version.Info) {
			timestamp := metav1.Now()
			n.DeletionTimestamp = &timestamp
		},
	}
	for name, mutate := range mutations {
		t.Run(name, func(t *testing.T) {
			node := &corev1.Node{ObjectMeta: metav1.ObjectMeta{Name: intent.NodeName, UID: intent.NodeUID,
				Labels: map[string]string{"fleet.actor.dev/control-pool": "true", corev1.LabelHostname: intent.NodeName, "topology.kubernetes.io/zone": "fixture-zone"}},
				Spec: corev1.NodeSpec{ProviderID: intent.NodeProviderID}, Status: corev1.NodeStatus{Conditions: []corev1.NodeCondition{{Type: corev1.NodeReady, Status: corev1.ConditionTrue}}}}
			namespace := &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "kube-system", UID: intent.ClusterNamespaceUID}}
			server := &version.Info{GitVersion: intent.ServerVersion}
			mutate(node, namespace, server)
			client := clientfake.NewSimpleClientset(node, namespace)
			client.Discovery().(*fake.FakeDiscovery).FakedServerVersion = server
			err := validateTKEEvictionTarget(context.Background(), client, intent)
			if (err == nil) != (name == "matching") {
				t.Fatalf("unexpected identity guard result: %v", err)
			}
			for _, action := range client.Actions() {
				if action.GetVerb() != "get" {
					t.Fatalf("target validation mutated resources: %s", action.GetVerb())
				}
			}
		})
	}
}
