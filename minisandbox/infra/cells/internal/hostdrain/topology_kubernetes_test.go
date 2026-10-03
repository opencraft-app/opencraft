//go:build integration

package hostdrain

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	admissionv1 "k8s.io/api/admission/v1"
	registrationv1 "k8s.io/api/admissionregistration/v1"
	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	policyv1 "k8s.io/api/policy/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/intstr"
	"k8s.io/apimachinery/pkg/util/wait"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/tools/clientcmd"
	"k8s.io/client-go/util/retry"
)

const apiFixtureLabel = "fleet.actor.dev/host-eviction-api-fixture"
const cachedPauseImage = "docker.io/rancher/mirrored-pause@sha256:74c4244427b7312c5b901fe0f67cbc53683d06f4f24c6faee65d4182bf0fa893"

type evictionAPIReceipt struct {
	Schema                       string            `json:"schema"`
	Verdict                      string            `json:"verdict"`
	ClaimEligible                bool              `json:"claimEligible"`
	ServerVersion                string            `json:"serverVersion"`
	ClusterNamespaceUID          string            `json:"clusterNamespaceUid"`
	Namespace                    string            `json:"namespace"`
	NamespaceUID                 types.UID         `json:"namespaceUid"`
	WorkloadUID                  types.UID         `json:"workloadUid"`
	WebhookUID                   types.UID         `json:"webhookUid"`
	OriginalPodUID               types.UID         `json:"originalPodUid"`
	OriginalRV                   string            `json:"originalRv"`
	CancellationRV               string            `json:"cancellationRv"`
	ConditionRV                  string            `json:"conditionRv"`
	AfterConditionCancellationRV string            `json:"afterConditionCancellationRv"`
	ReplacementPodUID            types.UID         `json:"replacementPodUid"`
	Image                        string            `json:"image"`
	AdapterHashes                map[string]string `json:"adapterHashes"`
	Checks                       map[string]bool   `json:"checks"`
	IntraServerWindowObserved    bool              `json:"intraServerConditionDeleteWindowObserved"`
	Scope                        string            `json:"scope"`
}

type evictionAdmissionGate struct {
	hold      atomic.Bool
	seen      atomic.Int32
	blocked   chan *policyv1.Eviction
	released  chan struct{}
	once      sync.Once
	namespace string
}

func (gate *evictionAdmissionGate) release() {
	gate.hold.Store(false)
	gate.once.Do(func() { close(gate.released) })
}

func (gate *evictionAdmissionGate) serve(response http.ResponseWriter, request *http.Request) {
	var review admissionv1.AdmissionReview
	if err := json.NewDecoder(io.LimitReader(request.Body, 64*1024)).Decode(&review); err != nil || review.Request == nil {
		http.Error(response, "invalid AdmissionReview", 400)
		return
	}
	input := review.Request
	if input.Namespace != gate.namespace || input.Resource.Group != "" || input.Resource.Resource != "pods" || input.SubResource != "eviction" || input.Operation != admissionv1.Create {
		http.Error(response, "outside fixture scope", 400)
		return
	}
	gate.seen.Add(1)
	if gate.hold.Load() && input.Name == "host-0" {
		var eviction policyv1.Eviction
		if err := json.Unmarshal(input.Object.Raw, &eviction); err != nil {
			http.Error(response, "invalid eviction", 400)
			return
		}
		select {
		case gate.blocked <- &eviction:
		default:
		}
		select {
		case <-gate.released:
		case <-request.Context().Done():
			return
		case <-time.After(8 * time.Second):
			http.Error(response, "fixture barrier expired", 504)
			return
		}
	}
	response.Header().Set("Content-Type", "application/json")
	json.NewEncoder(response).Encode(admissionv1.AdmissionReview{
		TypeMeta: metav1.TypeMeta{APIVersion: "admission.k8s.io/v1", Kind: "AdmissionReview"},
		Response: &admissionv1.AdmissionResponse{UID: input.UID, Allowed: true},
	})
}

func realEvictionTLSGate(t *testing.T, gate *evictionAdmissionGate, ip net.IP) (*httptest.Server, []byte) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		t.Fatal(err)
	}
	certificate := &x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: "host-eviction-api-fixture"},
		NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().Add(15 * time.Minute), IPAddresses: []net.IP{ip},
		IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	der, err := x509.CreateCertificate(rand.Reader, certificate, certificate, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", net.JoinHostPort(ip.String(), "0"))
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewUnstartedServer(http.HandlerFunc(gate.serve))
	server.Listener.Close()
	server.Listener = listener
	server.TLS = &tls.Config{MinVersion: tls.VersionTLS12, Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}}}
	server.StartTLS()
	return server, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
}

func TestRealKubernetesFencedEviction(t *testing.T) {
	kubeconfig := os.Getenv("HOST_DRAIN_EVICTION_E2E_KUBECONFIG")
	if kubeconfig == "" {
		t.Skip("explicit local kubeconfig required")
	}
	if os.Getenv("HOST_DRAIN_EVICTION_E2E_CONTEXT") != "k3d-rivet-mesh-hub" {
		t.Fatal("only the isolated local hub context is allowed")
	}
	receiptPath := os.Getenv("HOST_DRAIN_EVICTION_E2E_RECEIPT")
	if !strings.HasPrefix(filepath.Clean(receiptPath), "/data/tmp/") {
		t.Fatal("receipt must live under /data/tmp")
	}
	ip := net.ParseIP(os.Getenv("HOST_DRAIN_EVICTION_E2E_BRIDGE_IP"))
	if ip == nil || !ip.IsPrivate() {
		t.Fatal("explicit private local Docker bridge IP required")
	}
	loader := clientcmd.NewNonInteractiveDeferredLoadingClientConfig(&clientcmd.ClientConfigLoadingRules{ExplicitPath: kubeconfig}, &clientcmd.ConfigOverrides{CurrentContext: "k3d-rivet-mesh-hub"})
	config, err := loader.ClientConfig()
	if err != nil {
		t.Fatal(err)
	}
	endpoint, err := url.Parse(config.Host)
	if err != nil {
		t.Fatal(err)
	}
	if endpoint.Hostname() == "0.0.0.0" {
		endpoint.Host = net.JoinHostPort("127.0.0.1", endpoint.Port())
		config.Host = endpoint.String()
	}
	if net.ParseIP(endpoint.Hostname()) == nil || !net.ParseIP(endpoint.Hostname()).IsLoopback() || config.Insecure {
		t.Fatal("local loopback API with verified TLS required")
	}
	config.Timeout = 15 * time.Second
	client, err := kubernetes.NewForConfig(config)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	version, err := client.Discovery().ServerVersion()
	if err != nil {
		t.Fatal(err)
	}
	nodes, err := client.CoreV1().Nodes().List(ctx, metav1.ListOptions{Limit: 2})
	if err != nil {
		t.Fatal(err)
	}
	if len(nodes.Items) != 1 || nodes.Items[0].Name != "k3d-rivet-mesh-hub-server-0" {
		t.Fatal("not the expected isolated hub substrate")
	}
	clusterNS, err := client.CoreV1().Namespaces().Get(ctx, "kube-system", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	namespace, err := client.CoreV1().Namespaces().Create(ctx, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{GenerateName: "host-eviction-api-"}}, metav1.CreateOptions{})
	if err != nil {
		t.Fatal(err)
	}
	runID := string(namespace.UID)
	receipt := evictionAPIReceipt{Schema: "minisandbox-host-eviction-api/v1", Verdict: "failed", ServerVersion: version.GitVersion,
		ClusterNamespaceUID: string(clusterNS.UID), Namespace: namespace.Name, NamespaceUID: namespace.UID, Image: cachedPauseImage,
		AdapterHashes: map[string]string{}, Checks: map[string]bool{}, Scope: "local-real-api-primitives-with-pause-and-management-double-not-cloud-admission"}
	webhookName := namespace.Name + "-eviction"
	gate := &evictionAdmissionGate{namespace: namespace.Name, blocked: make(chan *policyv1.Eviction, 1), released: make(chan struct{})}
	var tlsServer *httptest.Server
	t.Cleanup(func() {
		gate.release()
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 90*time.Second)
		defer cleanupCancel()
		webhooks := client.AdmissionregistrationV1().ValidatingWebhookConfigurations()
		current, err := webhooks.Get(cleanupCtx, webhookName, metav1.GetOptions{})
		if err == nil {
			if current.Labels[apiFixtureLabel] != runID {
				t.Error("refuse foreign webhook cleanup")
			} else {
				uid := current.UID
				err = webhooks.Delete(cleanupCtx, current.Name, metav1.DeleteOptions{Preconditions: &metav1.Preconditions{UID: &uid}})
				if err != nil && !apierrors.IsNotFound(err) {
					t.Errorf("cleanup exact webhook: %v", err)
				}
			}
		} else if !apierrors.IsNotFound(err) {
			t.Errorf("read fixture webhook for cleanup: %v", err)
		}
		uid := namespace.UID
		err = client.CoreV1().Namespaces().Delete(cleanupCtx, namespace.Name, metav1.DeleteOptions{Preconditions: &metav1.Preconditions{UID: &uid}})
		if err != nil && !apierrors.IsNotFound(err) {
			t.Errorf("cleanup exact namespace: %v", err)
		}
		err = wait.PollUntilContextTimeout(cleanupCtx, 250*time.Millisecond, 60*time.Second, true, func(ctx context.Context) (bool, error) {
			_, err := client.CoreV1().Namespaces().Get(ctx, namespace.Name, metav1.GetOptions{})
			if apierrors.IsNotFound(err) {
				return true, nil
			}
			return false, err
		})
		receipt.Checks["own_namespace_removed"] = err == nil
		if err != nil {
			t.Errorf("fixture namespace not removed: %v", err)
		}
		_, err = webhooks.Get(cleanupCtx, webhookName, metav1.GetOptions{})
		receipt.Checks["own_webhook_removed"] = apierrors.IsNotFound(err)
		if err == nil {
			t.Error("fixture webhook remained")
		}
		if tlsServer != nil {
			tlsServer.Close()
		}
		if !t.Failed() {
			receipt.Verdict = "passed"
		}
		payload, err := json.MarshalIndent(receipt, "", "  ")
		if err != nil {
			t.Error(err)
			return
		}
		if err := os.WriteFile(receiptPath, append(payload, '\n'), 0600); err != nil {
			t.Error(err)
		}
	})
	// Install cleanup immediately after creation, before any fallible fixture
	// setup, so an update conflict or source-read failure cannot leak resources.
	if err := retry.RetryOnConflict(retry.DefaultBackoff, func() error {
		live, err := client.CoreV1().Namespaces().Get(ctx, namespace.Name, metav1.GetOptions{})
		if err != nil {
			return err
		}
		if live.UID != namespace.UID {
			return fmt.Errorf("fixture namespace UID changed")
		}
		if live.Labels == nil {
			live.Labels = map[string]string{}
		}
		live.Labels[apiFixtureLabel] = runID
		_, err = client.CoreV1().Namespaces().Update(ctx, live, metav1.UpdateOptions{})
		return err
	}); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"controller.go", "topology_adapter.go", "topology_capacity.go"} {
		payload, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		digest := sha256.Sum256(payload)
		receipt.AdapterHashes[path] = hex.EncodeToString(digest[:])
	}
	replicas, grace := int32(1), int64(30)
	automount := false
	nonroot := true
	user := int64(65534)
	labels := map[string]string{apiFixtureLabel: runID}
	workload, err := client.AppsV1().StatefulSets(namespace.Name).Create(ctx, &appsv1.StatefulSet{
		ObjectMeta: metav1.ObjectMeta{Name: "host", Labels: labels}, Spec: appsv1.StatefulSetSpec{Replicas: &replicas, ServiceName: "fixture", Selector: &metav1.LabelSelector{MatchLabels: labels},
			Template: corev1.PodTemplateSpec{ObjectMeta: metav1.ObjectMeta{Labels: labels}, Spec: corev1.PodSpec{
				AutomountServiceAccountToken: &automount, TerminationGracePeriodSeconds: &grace, NodeSelector: map[string]string{corev1.LabelHostname: nodes.Items[0].Name},
				Containers: []corev1.Container{{Name: "pause", Image: cachedPauseImage, ImagePullPolicy: corev1.PullNever,
					Resources:       corev1.ResourceRequirements{Requests: corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("10m"), corev1.ResourceMemory: resource.MustParse("16Mi")}},
					SecurityContext: &corev1.SecurityContext{RunAsNonRoot: &nonroot, RunAsUser: &user, ReadOnlyRootFilesystem: &nonroot, Capabilities: &corev1.Capabilities{Drop: []corev1.Capability{"ALL"}}}}},
			}},
		},
	}, metav1.CreateOptions{})
	if err != nil {
		t.Fatal(err)
	}
	receipt.WorkloadUID = workload.UID
	readyPod := func(previous types.UID) *corev1.Pod {
		var observed *corev1.Pod
		err := wait.PollUntilContextTimeout(ctx, 250*time.Millisecond, 60*time.Second, true, func(ctx context.Context) (bool, error) {
			pod, err := client.CoreV1().Pods(namespace.Name).Get(ctx, "host-0", metav1.GetOptions{})
			if apierrors.IsNotFound(err) {
				return false, nil
			}
			if err != nil {
				return false, err
			}
			observed = pod
			return pod.UID != previous && pod.DeletionTimestamp == nil && podReady(pod), nil
		})
		if err != nil {
			t.Fatal("fixture Pod did not become Ready:", err)
		}
		if err := validateHostOwner(observed, workload); err != nil {
			t.Fatal(err)
		}
		return observed
	}
	pod := readyPod("")
	minimum := intstr.FromInt32(1)
	pdb, err := client.PolicyV1().PodDisruptionBudgets(namespace.Name).Create(ctx, &policyv1.PodDisruptionBudget{
		ObjectMeta: metav1.ObjectMeta{Name: "fixture", Labels: labels}, Spec: policyv1.PodDisruptionBudgetSpec{MinAvailable: &minimum, Selector: &metav1.LabelSelector{MatchLabels: labels}},
	}, metav1.CreateOptions{})
	if err != nil {
		t.Fatal(err)
	}
	waitPDB := func(allowed int32, timeout time.Duration) {
		var status policyv1.PodDisruptionBudgetStatus
		err := wait.PollUntilContextTimeout(ctx, 500*time.Millisecond, timeout, true, func(ctx context.Context) (bool, error) {
			live, err := client.PolicyV1().PodDisruptionBudgets(namespace.Name).Get(ctx, pdb.Name, metav1.GetOptions{})
			if err != nil {
				return false, err
			}
			status = live.Status
			return live.Status.ObservedGeneration == live.Generation && live.Status.CurrentHealthy == 1 && live.Status.DisruptionsAllowed == allowed, nil
		})
		if err != nil {
			t.Fatalf("PDB did not reconcile to allowed=%d (last healthy=%d, allowed=%d, reserved=%d): %v", allowed, status.CurrentHealthy, status.DisruptionsAllowed, len(status.DisruptedPods), err)
		}
	}
	waitPDB(0, 30*time.Second)
	stats := httptest.NewServer(http.HandlerFunc(quiescentResponse))
	defer stats.Close()
	statsURL, _ := url.Parse(stats.URL)
	statsPort, _ := strconvPort(statsURL)
	transport := stats.Client().Transport.(*http.Transport).Clone()
	defer transport.CloseIdleConnections()
	transport.DialContext = func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, statsURL.Host)
	}
	controller := &Controller{Kubernetes: client, HTTPClient: &http.Client{Transport: transport, Timeout: 2 * time.Second}, Now: time.Now,
		Config: ControllerConfig{Namespace: namespace.Name, Token: "0123456789abcdef", ManagementPort: statsPort, DrainTimeout: 10 * time.Minute}}
	newState := func(pod *corev1.Pod, epoch int64) State {
		return State{Phase: PhaseRebalanceEvicting, Epoch: epoch, TargetName: pod.Name, TargetUID: string(pod.UID), FromReplicas: 1, StartedAt: time.Now().UTC(), TransitionAt: time.Now().UTC(), RepairWorkloadUID: string(workload.UID), RepairSourceZone: "fixture-source", RepairDestinationZone: "fixture-destination", RepairPrefixScore: 1, EvictionResourceVersion: pod.ResourceVersion}
	}
	pod, err = client.CoreV1().Pods(namespace.Name).Get(ctx, pod.Name, metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	state := newState(pod, 1)
	err = controller.evictHost(ctx, pod, state)
	if !apierrors.IsTooManyRequests(err) {
		t.Fatalf("real PDB did not reject eviction with 429: %v", err)
	}
	live, err := client.CoreV1().Pods(namespace.Name).Get(ctx, pod.Name, metav1.GetOptions{})
	if err != nil || live.UID != pod.UID || live.DeletionTimestamp != nil {
		t.Fatal("PDB rejection did not preserve exact Pod")
	}
	receipt.Checks["real_pdb_429_preserves_pod"] = true
	minimum = intstr.FromInt32(0)
	pdbUID := pdb.UID
	if err := retry.RetryOnConflict(retry.DefaultBackoff, func() error {
		live, err := client.PolicyV1().PodDisruptionBudgets(namespace.Name).Get(ctx, pdb.Name, metav1.GetOptions{})
		if err != nil {
			return err
		}
		if live.UID != pdbUID {
			return fmt.Errorf("fixture PDB UID changed")
		}
		live.Spec.MinAvailable = &minimum
		_, err = client.PolicyV1().PodDisruptionBudgets(namespace.Name).Update(ctx, live, metav1.UpdateOptions{})
		return err
	}); err != nil {
		t.Fatal(err)
	}
	waitPDB(1, 30*time.Second)
	tlsServer, ca := realEvictionTLSGate(t, gate, ip)
	sideEffects, failure, match, scope, timeout := registrationv1.SideEffectClassNone, registrationv1.Fail, registrationv1.Exact, registrationv1.NamespacedScope, int32(10)
	webhookURL := tlsServer.URL + "/validate"
	webhook, err := client.AdmissionregistrationV1().ValidatingWebhookConfigurations().Create(ctx, &registrationv1.ValidatingWebhookConfiguration{
		ObjectMeta: metav1.ObjectMeta{Name: webhookName, Labels: labels}, Webhooks: []registrationv1.ValidatingWebhook{{Name: "host-eviction.fixture.local",
			ClientConfig: registrationv1.WebhookClientConfig{URL: &webhookURL, CABundle: ca}, AdmissionReviewVersions: []string{"v1"}, SideEffects: &sideEffects, FailurePolicy: &failure, MatchPolicy: &match, TimeoutSeconds: &timeout,
			NamespaceSelector: &metav1.LabelSelector{MatchLabels: labels}, Rules: []registrationv1.RuleWithOperations{{Operations: []registrationv1.OperationType{registrationv1.Create}, Rule: registrationv1.Rule{APIGroups: []string{""}, APIVersions: []string{"v1"}, Resources: []string{"pods/eviction"}, Scope: &scope}}},
		}},
	}, metav1.CreateOptions{})
	if err != nil {
		t.Fatal(err)
	}
	receipt.WebhookUID = webhook.UID
	// Confirm actual admission registration/TLS before enabling the barrier.
	err = wait.PollUntilContextTimeout(ctx, 250*time.Millisecond, 15*time.Second, true, func(ctx context.Context) (bool, error) {
		latest, err := client.CoreV1().Pods(namespace.Name).Get(ctx, pod.Name, metav1.GetOptions{})
		if err != nil {
			return false, err
		}
		uid, rv := latest.UID, latest.ResourceVersion
		err = client.CoreV1().Pods(namespace.Name).EvictV1(ctx, &policyv1.Eviction{ObjectMeta: metav1.ObjectMeta{Name: latest.Name, Namespace: namespace.Name}, DeleteOptions: &metav1.DeleteOptions{DryRun: []string{metav1.DryRunAll}, Preconditions: &metav1.Preconditions{UID: &uid, ResourceVersion: &rv}}})
		return gate.seen.Load() > 0, err
	})
	if err != nil {
		t.Fatal("real namespace-scoped admission gate unavailable:", err)
	}
	receipt.Checks["namespace_scoped_webhook_tls_verified"] = true
	pod, err = client.CoreV1().Pods(namespace.Name).Get(ctx, pod.Name, metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	state = newState(pod, 2)
	receipt.OriginalPodUID, receipt.OriginalRV = pod.UID, pod.ResourceVersion
	gate.hold.Store(true)
	result := make(chan error, 1)
	go func() { result <- controller.evictHost(ctx, pod, state) }()
	select {
	case eviction := <-gate.blocked:
		if eviction.DeleteOptions == nil || eviction.DeleteOptions.Preconditions == nil || eviction.DeleteOptions.Preconditions.UID == nil || eviction.DeleteOptions.Preconditions.ResourceVersion == nil || *eviction.DeleteOptions.Preconditions.UID != pod.UID || *eviction.DeleteOptions.Preconditions.ResourceVersion != state.EvictionResourceVersion || eviction.DeleteOptions.GracePeriodSeconds != nil {
			t.Fatal("actual admission received unsafe eviction options")
		}
	case err := <-result:
		t.Fatal("eviction completed before actual admission barrier:", err)
	case <-time.After(5 * time.Second):
		t.Fatal("actual admission barrier not reached")
	}
	live, err = client.CoreV1().Pods(namespace.Name).Get(ctx, pod.Name, metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	state.Phase = PhaseRebalanceCancelling
	if err := controller.cancelEviction(ctx, live, Action{ResourceVersion: live.ResourceVersion}, state); err != nil {
		t.Fatal(err)
	}
	live, err = client.CoreV1().Pods(namespace.Name).Get(ctx, pod.Name, metav1.GetOptions{})
	if err != nil || !evictionCancellationObserved(state, live) {
		t.Fatal("authoritative GET did not prove cancellation")
	}
	receipt.CancellationRV = live.ResourceVersion
	gate.release()
	select {
	case err := <-result:
		if !apierrors.IsConflict(err) {
			t.Fatalf("late real eviction did not conflict after cancellation CAS: %v", err)
		}
	case <-time.After(12 * time.Second):
		t.Fatal("eviction never returned after gate release")
	}
	live, err = client.CoreV1().Pods(namespace.Name).Get(ctx, pod.Name, metav1.GetOptions{})
	if err != nil || live.DeletionTimestamp != nil || live.UID != pod.UID {
		t.Fatal("cancelled real eviction changed the Pod")
	}
	receipt.Checks["late_eviction_after_cancellation_returns_409"] = true
	// Internal eviction Update/Delete bypass external admission. Exercise the
	// exact post-condition storage precondition using real status + metadata
	// CAS + DELETE APIs, but do NOT call this an intercepted in-server race.
	live.Status.Conditions = append(live.Status.Conditions, corev1.PodCondition{Type: corev1.DisruptionTarget, Status: corev1.ConditionTrue, Reason: "EvictionByEvictionAPI", Message: "fixture storage-precondition check", LastTransitionTime: metav1.Now()})
	conditionPod, err := client.CoreV1().Pods(namespace.Name).UpdateStatus(ctx, live, metav1.UpdateOptions{})
	if err != nil {
		t.Fatal(err)
	}
	receipt.ConditionRV = conditionPod.ResourceVersion
	state = newState(conditionPod, 3)
	state.EvictionResourceVersion = receipt.OriginalRV
	state.Phase = PhaseRebalanceCancelling
	if err := controller.cancelEviction(ctx, conditionPod, Action{ResourceVersion: conditionPod.ResourceVersion}, state); err != nil {
		t.Fatal(err)
	}
	live, err = client.CoreV1().Pods(namespace.Name).Get(ctx, pod.Name, metav1.GetOptions{})
	if err != nil || !evictionCancellationObserved(state, live) {
		t.Fatal("post-condition cancellation proof missing")
	}
	receipt.AfterConditionCancellationRV = live.ResourceVersion
	uid, rv := conditionPod.UID, conditionPod.ResourceVersion
	err = client.CoreV1().Pods(namespace.Name).Delete(ctx, pod.Name, metav1.DeleteOptions{Preconditions: &metav1.Preconditions{UID: &uid, ResourceVersion: &rv}})
	if !apierrors.IsConflict(err) {
		t.Fatalf("post-condition stale DELETE storage primitive did not conflict: %v", err)
	}
	receipt.Checks["post_condition_stale_delete_rv_rejected"] = true
	// A fresh authorized eviction is allowed, respects PDB and ordinary grace,
	// then StatefulSet supplies a new UID. No old action may transfer to it.
	// Eviction reserves PDB capacity before its internal Pod precondition
	// failure. Do not clear DisruptedPods or loosen the PDB to accelerate this
	// test: the real disruption controller expires that reservation after two
	// minutes. This is a liveness delay, not authorization to bypass PDB.
	reserved, err := client.PolicyV1().PodDisruptionBudgets(namespace.Name).Get(ctx, pdb.Name, metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if _, found := reserved.Status.DisruptedPods[pod.Name]; !found {
		t.Fatal("expected real PDB reservation after conflicted eviction")
	}
	receipt.Checks["cancelled_eviction_retains_pdb_reservation"] = true
	t.Log("waiting for the real PDB controller to expire its cancelled-eviction reservation")
	waitPDB(1, 150*time.Second)
	receipt.Checks["pdb_capacity_recovers_without_status_mutation"] = true
	live, err = client.CoreV1().Pods(namespace.Name).Get(ctx, pod.Name, metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	state = newState(live, 4)
	if err := controller.evictHost(ctx, live, state); err != nil {
		t.Fatal("fresh real eviction failed:", err)
	}
	replacement := readyPod(pod.UID)
	if replacement.Annotations[EvictionCancellationAnnotation] != "" {
		t.Fatal("successor inherited Pod-only cancellation token")
	}
	receipt.ReplacementPodUID = replacement.UID
	oldUID, newRV := pod.UID, replacement.ResourceVersion
	err = client.CoreV1().Pods(namespace.Name).EvictV1(ctx, &policyv1.Eviction{ObjectMeta: metav1.ObjectMeta{Name: replacement.Name, Namespace: namespace.Name}, DeleteOptions: &metav1.DeleteOptions{Preconditions: &metav1.Preconditions{UID: &oldUID, ResourceVersion: &newRV}}})
	if !apierrors.IsConflict(err) {
		t.Fatalf("same-name successor accepted old UID: %v", err)
	}
	state.Phase = PhaseRebalanceCancelling
	if err := controller.cancelEviction(ctx, replacement, Action{ResourceVersion: replacement.ResourceVersion}, state); err == nil {
		t.Fatal("adapter transferred cancellation to successor")
	}
	live, err = client.CoreV1().Pods(namespace.Name).Get(ctx, replacement.Name, metav1.GetOptions{})
	if err != nil || live.UID != replacement.UID || live.DeletionTimestamp != nil {
		t.Fatal("old operation changed the successor")
	}
	receipt.Checks["fresh_eviction_creates_new_uid"] = true
	receipt.Checks["successor_rejects_old_eviction_uid"] = true
	receipt.Checks["successor_rejects_old_cancellation"] = true
	t.Logf("real API fixture passed: server=%s namespace=%s original=%s successor=%s; in-server condition/delete window was not intercepted", version.GitVersion, namespace.Name, pod.UID, replacement.UID)
}

func strconvPort(address *url.URL) (int, error) {
	var port int
	_, err := fmt.Sscan(address.Port(), &port)
	return port, err
}
