//go:build integration

package hostdrain

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/validation"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/tools/clientcmd"
)

const tkeEvictionScope = "tke-real-api-primitives-with-sleep-and-management-double-not-actor-or-cloud-admission"

// This is explicit operator intent, not credentials or an assertion that the
// target is qualified. Live target identities and source hashes are rechecked
// before creating any fixture. The local test has its own unchanged guard.
type tkeEvictionIntent struct {
	Schema              string            `json:"schema"`
	Context             string            `json:"context"`
	APIServer           string            `json:"apiServer"`
	ClusterNamespaceUID types.UID         `json:"clusterNamespaceUid"`
	ServerVersion       string            `json:"serverVersion"`
	NodeName            string            `json:"nodeName"`
	NodeUID             types.UID         `json:"nodeUid"`
	NodeProviderID      string            `json:"nodeProviderId"`
	CallbackIP          string            `json:"callbackIp"`
	FixtureImage        string            `json:"fixtureImage"`
	AdapterHashes       map[string]string `json:"adapterHashes"`
}

var fixtureDigestPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
var fixtureUIDPattern = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`)
var tkeFixtureImagePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9.-]*\.tencentcloudcr\.com/[a-z0-9][a-z0-9_-]*/observability-busybox@sha256:[a-f0-9]{64}$`)
var tkeFixtureVersionPattern = regexp.MustCompile(`^v1\.[0-9]+\.[0-9]+-tke\.[0-9]+$`)

func validateFixtureJSONValue(decoder *json.Decoder, depth int) error {
	if depth > 8 {
		return fmt.Errorf("intent nesting exceeds bound")
	}
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	delimiter, composite := token.(json.Delim)
	if !composite {
		return nil
	}
	seen := map[string]bool{}
	for decoder.More() {
		if delimiter == '{' {
			key, err := decoder.Token()
			if err != nil {
				return err
			}
			name, ok := key.(string)
			if !ok || seen[name] {
				return fmt.Errorf("duplicate intent key")
			}
			seen[name] = true
		}
		if err := validateFixtureJSONValue(decoder, depth+1); err != nil {
			return err
		}
	}
	_, err = decoder.Token()
	return err
}

func parseTKEEvictionIntent(payload []byte) (tkeEvictionIntent, error) {
	var intent tkeEvictionIntent
	if len(payload) == 0 || len(payload) > 16*1024 {
		return intent, fmt.Errorf("intent must be a nonempty bounded JSON document")
	}
	keys := json.NewDecoder(bytes.NewReader(payload))
	if err := validateFixtureJSONValue(keys, 0); err != nil {
		return intent, fmt.Errorf("ambiguous or deeply nested intent")
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&intent); err != nil {
		return intent, fmt.Errorf("invalid intent schema")
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return intent, fmt.Errorf("intent has trailing data")
	}
	if intent.Schema != "minisandbox-tke-eviction-api-intent/v1" ||
		strings.TrimSpace(intent.Context) != intent.Context || intent.Context == "" || len(intent.Context) > 128 ||
		!fixtureUIDPattern.MatchString(string(intent.ClusterNamespaceUID)) || !fixtureUIDPattern.MatchString(string(intent.NodeUID)) ||
		!tkeFixtureVersionPattern.MatchString(intent.ServerVersion) ||
		len(validation.IsDNS1123Subdomain(intent.NodeName)) != 0 ||
		!strings.HasPrefix(intent.NodeProviderID, "qcloud://") || len(intent.NodeProviderID) > 256 ||
		len(intent.NodeProviderID) <= len("qcloud://") || !tkeFixtureImagePattern.MatchString(intent.FixtureImage) {
		return intent, fmt.Errorf("intent target identity is incomplete or not TKE")
	}
	endpoint, err := url.Parse(intent.APIServer)
	if err != nil || endpoint.Scheme != "https" || endpoint.User != nil || endpoint.Path != "" ||
		endpoint.RawQuery != "" || endpoint.Fragment != "" ||
		net.ParseIP(endpoint.Hostname()) == nil || !net.ParseIP(endpoint.Hostname()).IsPrivate() {
		return intent, fmt.Errorf("explicit private HTTPS API endpoint required")
	}
	callback := net.ParseIP(intent.CallbackIP)
	if callback == nil || !callback.IsPrivate() {
		return intent, fmt.Errorf("explicit private callback IP required")
	}
	if len(intent.AdapterHashes) != 3 {
		return intent, fmt.Errorf("exact adapter source hashes required")
	}
	for _, name := range []string{"controller.go", "topology_adapter.go", "topology_capacity.go"} {
		if !fixtureDigestPattern.MatchString(intent.AdapterHashes[name]) {
			return intent, fmt.Errorf("exact adapter source hashes required")
		}
	}
	return intent, nil
}

func validateTKEEvictionSource(intent tkeEvictionIntent) error {
	for name, expected := range intent.AdapterHashes {
		payload, err := os.ReadFile(name)
		if err != nil {
			return fmt.Errorf("cannot validate adapter source")
		}
		digest := sha256.Sum256(payload)
		if hex.EncodeToString(digest[:]) != expected {
			return fmt.Errorf("adapter source does not match reviewed intent")
		}
	}
	return nil
}

func validateTKEEvictionTarget(ctx context.Context, client kubernetes.Interface, intent tkeEvictionIntent) error {
	version, err := client.Discovery().ServerVersion()
	if err != nil || version == nil || version.GitVersion != intent.ServerVersion {
		return fmt.Errorf("TKE API server version differs from reviewed intent")
	}
	cluster, err := client.CoreV1().Namespaces().Get(ctx, "kube-system", metav1.GetOptions{})
	if err != nil || cluster.UID != intent.ClusterNamespaceUID || cluster.DeletionTimestamp != nil {
		return fmt.Errorf("TKE cluster identity differs from reviewed intent")
	}
	node, err := client.CoreV1().Nodes().Get(ctx, intent.NodeName, metav1.GetOptions{})
	if err != nil || node.UID != intent.NodeUID || node.Spec.ProviderID != intent.NodeProviderID ||
		node.DeletionTimestamp != nil || node.Spec.Unschedulable ||
		node.Labels["fleet.actor.dev/control-pool"] != "true" || node.Labels["rivet.dev/compute"] == "true" ||
		node.Labels[corev1.LabelHostname] != intent.NodeName || node.Labels["topology.kubernetes.io/zone"] == "" {
		return fmt.Errorf("TKE control node identity differs from reviewed intent")
	}
	ready := false
	for _, condition := range node.Status.Conditions {
		if condition.Type == corev1.NodeReady && condition.Status == corev1.ConditionTrue {
			ready = true
		}
		if (condition.Type == corev1.NodeDiskPressure || condition.Type == corev1.NodeMemoryPressure ||
			condition.Type == corev1.NodePIDPressure) && condition.Status == corev1.ConditionTrue {
			return fmt.Errorf("TKE control node has resource pressure")
		}
	}
	if !ready {
		return fmt.Errorf("TKE control node is not Ready")
	}
	for _, taint := range node.Spec.Taints {
		if taint.Effect == corev1.TaintEffectNoSchedule || taint.Effect == corev1.TaintEffectNoExecute {
			return fmt.Errorf("TKE fixture must not bypass node scheduling taints")
		}
	}
	return nil
}

func TestTKEKubernetesFencedEviction(t *testing.T) {
	intentPath := os.Getenv("HOST_DRAIN_TKE_EVICTION_INTENT")
	if intentPath == "" {
		t.Skip("explicit reviewed TKE intent required")
	}
	if os.Getenv("AUTONOMY_OPERATION_LOCK_HELD") != "1" {
		t.Fatal("TKE fixture requires the whole-operation wrapper")
	}
	kubeconfig := os.Getenv("HOST_DRAIN_TKE_EVICTION_KUBECONFIG")
	receiptPath := os.Getenv("HOST_DRAIN_TKE_EVICTION_RECEIPT")
	for _, path := range []string{intentPath, kubeconfig, receiptPath} {
		if !strings.HasPrefix(filepath.Clean(path), "/data/") {
			t.Fatal("explicit /data input/output paths required")
		}
	}
	stat, err := os.Lstat(intentPath)
	if err != nil || !stat.Mode().IsRegular() || stat.Size() > 16*1024 {
		t.Fatal("reviewed intent must be a bounded regular file")
	}
	payload, err := os.ReadFile(intentPath)
	if err != nil {
		t.Fatal("cannot read reviewed TKE intent")
	}
	intent, err := parseTKEEvictionIntent(payload)
	if err != nil {
		t.Fatal(err)
	}
	if err := validateTKEEvictionSource(intent); err != nil {
		t.Fatal(err)
	}
	loader := clientcmd.NewNonInteractiveDeferredLoadingClientConfig(&clientcmd.ClientConfigLoadingRules{ExplicitPath: kubeconfig}, &clientcmd.ConfigOverrides{CurrentContext: intent.Context})
	config, err := loader.ClientConfig()
	if err != nil {
		t.Fatal("cannot load explicit TKE kubeconfig")
	}
	if config.Host != intent.APIServer || config.Insecure {
		t.Fatal("TKE endpoint/TLS differs from reviewed intent")
	}
	config.Timeout = 15 * time.Second
	client, err := kubernetes.NewForConfig(config)
	if err != nil {
		t.Fatal("cannot initialize TKE client")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Minute)
	defer cancel()
	if err := validateTKEEvictionTarget(ctx, client, intent); err != nil {
		t.Fatal(err)
	}
	// Bind before any API writes. A missing local interface does not authorize
	// opening a public listener, changing routes, or disabling webhook TLS.
	callback := net.ParseIP(intent.CallbackIP)
	listener, err := net.Listen("tcp", net.JoinHostPort(callback.String(), "0"))
	if err != nil {
		t.Fatal("reviewed private callback interface is unavailable")
	}
	listener.Close()
	digest := sha256.Sum256(payload)
	runEvictionAPIFixture(t, ctx, client, evictionAPIFixtureTarget{
		ClusterUID: string(intent.ClusterNamespaceUID), ServerVersion: intent.ServerVersion,
		NodeName: intent.NodeName, NodeUID: intent.NodeUID, CallbackIP: callback,
		Image: intent.FixtureImage, Command: []string{"/bin/sleep", "600"}, PullPolicy: corev1.PullIfNotPresent,
		ReceiptPath: receiptPath, Scope: tkeEvictionScope, IntentSHA256: hex.EncodeToString(digest[:]),
	})
}
