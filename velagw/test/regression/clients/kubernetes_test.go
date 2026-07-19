package clients

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"git.woa.com/wisp/mono2/llmgateway/test/regression/framework"
)

func TestKubernetesClientCreatesControlledSetManagerJobFromCronJob(t *testing.T) {
	var created map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/cronjobs/llmgateway-set-manager"):
			_, _ = w.Write([]byte(`{"spec":{"suspend":false,"jobTemplate":{"spec":{"template":{"spec":{"containers":[{"name":"set-manager","env":[{"name":"EXISTING","value":"1"}]}]}}}}}}`))
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/jobs"):
			if err := json.NewDecoder(r.Body).Decode(&created); err != nil {
				t.Fatal(err)
			}
			_, _ = w.Write([]byte(`{"metadata":{"name":"manager-test"},"status":{}}`))
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer server.Close()
	client := NewKubernetesClient(server.URL, framework.Secret{}, server.Client(), framework.NewSanitizer())

	if err := client.CreateSetManagerJob(t.Context(), "llmgateway", "llmgateway-set-manager", "manager-test", "registry/llmgateway@sha256:"+strings.Repeat("a", 64), "llmgw-regression-chat", "switching", "run-1"); err != nil {
		t.Fatal(err)
	}
	metadata := created["metadata"].(map[string]any)
	if metadata["name"] != "manager-test" {
		t.Fatalf("metadata = %+v", metadata)
	}
	raw, _ := json.Marshal(created)
	text := string(raw)
	for _, expected := range []string{
		"LLMGATEWAY_SET_UPGRADE_PROBE_MODEL", "llmgw-regression-chat",
		"LLMGATEWAY_SET_UPGRADE_PROBE_INTERVAL_SECONDS", "LLMGATEWAY_SET_UPGRADE_LEASE_SECONDS",
		"LLMGATEWAY_REGRESSION_HOLD_UPGRADE_STATUS", "switching",
		"LLMGATEWAY_REGRESSION_UPGRADE_OWNER", "manager-test",
		"registry/llmgateway@sha256:", RegressionRunAnnotation, "run-1",
	} {
		if !strings.Contains(text, expected) {
			t.Fatalf("created job missing %q: %s", expected, text)
		}
	}
}

func TestKubernetesClientSuspendsAndDeletesControlledManagerJob(t *testing.T) {
	var patched, deleted bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPatch && strings.Contains(r.URL.Path, "/cronjobs/llmgateway-set-manager"):
			patched = true
			_, _ = w.Write([]byte(`{"spec":{"suspend":true}}`))
		case r.Method == http.MethodDelete && strings.Contains(r.URL.Path, "/jobs/manager-test"):
			deleted = true
			_, _ = w.Write([]byte(`{"status":"Success"}`))
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer server.Close()
	client := NewKubernetesClient(server.URL, framework.Secret{}, server.Client(), framework.NewSanitizer())

	if err := client.SetCronJobSuspended(t.Context(), "llmgateway", "llmgateway-set-manager", true); err != nil {
		t.Fatal(err)
	}
	if err := client.DeleteControlledJob(t.Context(), "llmgateway", "manager-test"); err != nil {
		t.Fatal(err)
	}
	if !patched || !deleted {
		t.Fatalf("patched=%v deleted=%v", patched, deleted)
	}
}

func TestKubernetesClientListsOnlyActiveJobsOwnedByCronJob(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || !strings.HasSuffix(r.URL.Path, "/jobs") {
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"items":[
			{"metadata":{"name":"active-target","ownerReferences":[{"kind":"CronJob","name":"llmgateway-set-manager"}]},"status":{"active":1}},
			{"metadata":{"name":"completed-target","ownerReferences":[{"kind":"CronJob","name":"llmgateway-set-manager"}]},"status":{"succeeded":1}},
			{"metadata":{"name":"active-other","ownerReferences":[{"kind":"CronJob","name":"other"}]},"status":{"active":1}}
		]}`))
	}))
	defer server.Close()
	client := NewKubernetesClient(server.URL, framework.Secret{}, server.Client(), framework.NewSanitizer())

	jobs, err := client.ListActiveCronJobJobs(t.Context(), "llmgateway", "llmgateway-set-manager")
	if err != nil {
		t.Fatal(err)
	}
	if len(jobs) != 1 || jobs[0].Metadata.Name != "active-target" {
		t.Fatalf("jobs=%+v", jobs)
	}
}

func TestPatchTrafficRolloutUsesResourceVersionJSONPatch(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPatch || r.URL.Path != "/apis/apps/v1/namespaces/llmgateway/deployments/llmgateway-traffic" {
			t.Fatalf("request = %s %s", r.Method, r.URL.Path)
		}
		if got := r.Header.Get("Content-Type"); got != "application/json-patch+json" {
			t.Fatalf("Content-Type = %q", got)
		}
		var operations []map[string]any
		if err := json.NewDecoder(r.Body).Decode(&operations); err != nil {
			t.Fatal(err)
		}
		if len(operations) != 2 || operations[0]["op"] != "test" || operations[0]["path"] != "/metadata/resourceVersion" || operations[0]["value"] != "42" {
			t.Fatalf("operations = %+v", operations)
		}
		if operations[1]["path"] != "/spec/template/metadata/annotations/llmgateway.io~1regression-run" || operations[1]["value"] != "run-42" {
			t.Fatalf("annotation operation = %+v", operations[1])
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"metadata":{"resourceVersion":"43","generation":8},"spec":{"replicas":2,"template":{"metadata":{"labels":{"app":"llmgateway-traffic"},"annotations":{"llmgateway.io/regression-run":"run-42"}},"spec":{"containers":[{"name":"traffic","ports":[{"name":"http","containerPort":18080}]}]}}}}`))
	}))
	defer server.Close()

	client := NewKubernetesClient(server.URL, framework.Secret{}, server.Client(), framework.NewSanitizer())
	result, err := client.PatchTrafficRollout(t.Context(), "llmgateway", "llmgateway-traffic", "42", true, "run-42")
	if err != nil {
		t.Fatal(err)
	}
	if result.Metadata.Generation != 8 || result.TemplateAnnotation(RegressionRunAnnotation) != "run-42" {
		t.Fatalf("deployment = %+v", result)
	}
}

func TestAcquireLeaseRejectsLiveForeignHolder(t *testing.T) {
	now := time.Date(2026, 7, 17, 10, 0, 0, 0, time.UTC)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Fatalf("unexpected write %s", r.Method)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"metadata":{"name":"llmgateway-regression-traffic-rollout","resourceVersion":"9"},"spec":{"holderIdentity":"other-run","leaseDurationSeconds":90,"renewTime":"2026-07-17T09:59:30Z"}}`))
	}))
	defer server.Close()
	client := NewKubernetesClient(server.URL, framework.Secret{}, server.Client(), framework.NewSanitizer())
	client.now = func() time.Time { return now }

	_, err := client.AcquireLease(t.Context(), "llmgateway", RegressionRolloutLease, "run-1", 90*time.Second)
	if err == nil || !strings.Contains(err.Error(), "held by another regression run") {
		t.Fatalf("AcquireLease() error = %v", err)
	}
}

func TestAcquireLeaseRejectsUnexpectedNameWithoutRequest(t *testing.T) {
	client := NewKubernetesClient("http://127.0.0.1:1", framework.Secret{}, nil, nil)
	_, err := client.AcquireLease(t.Context(), "llmgateway", "other-lease", "run-1", time.Minute)
	if err == nil || !strings.Contains(err.Error(), RegressionRolloutLease) {
		t.Fatalf("AcquireLease() error = %v", err)
	}
}

func TestAcquireLeaseCreatesTypedKubernetesResource(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		w.Header().Set("Content-Type", "application/json")
		if r.Method == http.MethodGet {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"message":"not found"}`))
			return
		}
		var lease Lease
		if err := json.NewDecoder(r.Body).Decode(&lease); err != nil {
			t.Fatal(err)
		}
		if lease.APIVersion != "coordination.k8s.io/v1" || lease.Kind != "Lease" || lease.Metadata.Name != RegressionRolloutLease {
			t.Fatalf("lease = %+v", lease)
		}
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(lease)
	}))
	defer server.Close()
	client := NewKubernetesClient(server.URL, framework.Secret{}, server.Client(), nil)
	lease, err := client.AcquireLease(t.Context(), "llmgateway", RegressionRolloutLease, "run-1", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if requests != 2 || lease.Spec.HolderIdentity != "run-1" {
		t.Fatalf("requests=%d lease=%+v", requests, lease)
	}
}

func TestAcquireLeaseSerializesKubernetesMicroTime(t *testing.T) {
	now := time.Date(2026, 7, 17, 12, 11, 16, 134870914, time.UTC)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method == http.MethodGet {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"message":"not found"}`))
			return
		}
		raw, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatal(err)
		}
		for _, want := range []string{`"acquireTime":"2026-07-17T12:11:16.134870Z"`, `"renewTime":"2026-07-17T12:11:16.134870Z"`} {
			if !bytes.Contains(raw, []byte(want)) {
				t.Fatalf("Lease payload %s does not contain %s", raw, want)
			}
		}
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write(raw)
	}))
	defer server.Close()
	client := NewKubernetesClient(server.URL, framework.Secret{}, server.Client(), nil)
	client.now = func() time.Time { return now }

	if _, err := client.AcquireLease(t.Context(), "llmgateway", RegressionRolloutLease, "run-1", time.Minute); err != nil {
		t.Fatal(err)
	}
}

func TestRenewAndReleaseLeaseKeepFixedMicrosecondPrecision(t *testing.T) {
	now := time.Date(2026, 7, 17, 12, 11, 16, 134870914, time.UTC)
	var writes [][]byte
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method == http.MethodGet {
			_, _ = w.Write([]byte(`{"metadata":{"name":"llmgateway-regression-traffic-rollout","resourceVersion":"9"},"spec":{"holderIdentity":"run-1","leaseDurationSeconds":90,"acquireTime":"2026-07-17T12:10:00.000000Z","renewTime":"2026-07-17T12:10:30.000000Z"}}`))
			return
		}
		raw, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatal(err)
		}
		writes = append(writes, raw)
		_, _ = w.Write(raw)
	}))
	defer server.Close()
	client := NewKubernetesClient(server.URL, framework.Secret{}, server.Client(), nil)
	client.now = func() time.Time { return now }

	if _, err := client.RenewLease(t.Context(), "llmgateway", RegressionRolloutLease, "run-1", time.Minute); err != nil {
		t.Fatal(err)
	}
	now = time.Date(2026, 7, 17, 12, 12, 0, 10914, time.UTC)
	if err := client.ReleaseLease(t.Context(), "llmgateway", RegressionRolloutLease, "run-1"); err != nil {
		t.Fatal(err)
	}
	if len(writes) != 2 || !bytes.Contains(writes[0], []byte(`"renewTime":"2026-07-17T12:11:16.134870Z"`)) || !bytes.Contains(writes[1], []byte(`"renewTime":"2026-07-17T12:12:00.000010Z"`)) {
		t.Fatalf("Lease writes do not use fixed microseconds: %s", writes)
	}
}

func TestCreateReportConfigMapIncludesContentHashAndRejectsOversize(t *testing.T) {
	var body map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/v1/namespaces/llmgateway/configmaps" {
			t.Fatalf("request = %s %s", r.Method, r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"metadata":{"name":"llmgateway-regression-report-run-1"}}`))
	}))
	defer server.Close()
	client := NewKubernetesClient(server.URL, framework.Secret{}, server.Client(), framework.NewSanitizer())

	digest, err := client.CreateReportConfigMap(t.Context(), "llmgateway", "run-1", []byte(`{"ok":true}`), []byte(`<testsuite/>`))
	if err != nil {
		t.Fatal(err)
	}
	metadata := body["metadata"].(map[string]any)
	annotations := metadata["annotations"].(map[string]any)
	if len(digest) != 64 || annotations[ReportHashAnnotation] != digest || annotations[ReportStatusAnnotation] != "complete" {
		t.Fatalf("digest=%q annotations=%+v", digest, annotations)
	}
	if _, err := client.CreateReportConfigMap(t.Context(), "llmgateway", "run-big", make([]byte, MaxReportConfigMapBytes+1), nil); err == nil {
		t.Fatal("oversize report error = nil")
	}
}

func TestListReplicaSetsPreservesDeploymentOwnership(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/apis/apps/v1/namespaces/llmgateway/replicasets" || r.URL.Query().Get("labelSelector") != "app=llmgateway-traffic" {
			t.Fatalf("request = %s", r.URL.String())
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"items":[{"metadata":{"name":"traffic-abc","uid":"rs-1","ownerReferences":[{"kind":"Deployment","uid":"dep-1"}]},"spec":{"replicas":2,"template":{"metadata":{"annotations":{"llmgateway.io/regression-run":"run-1"}}}},"status":{"readyReplicas":2,"availableReplicas":2}}]}`))
	}))
	defer server.Close()
	client := NewKubernetesClient(server.URL, framework.Secret{}, server.Client(), nil)
	items, err := client.ListReplicaSets(t.Context(), "llmgateway", "app=llmgateway-traffic")
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || len(items[0].Metadata.OwnerReferences) != 1 || items[0].Metadata.OwnerReferences[0].UID != "dep-1" {
		t.Fatalf("replicaSets = %+v", items)
	}
}

func TestEnsureSanitizerAcceptsNil(t *testing.T) {
	if ensureSanitizer(nil) == nil {
		t.Fatal("ensureSanitizer(nil) = nil")
	}
	existing := framework.NewSanitizer()
	if ensureSanitizer(existing) != existing {
		t.Fatal("ensureSanitizer replaced the supplied sanitizer")
	}
}

func TestScaleDeploymentUsesResourceVersionGuard(t *testing.T) {
	var calls int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Path != "/apis/apps/v1/namespaces/llmgateway/deployments/llmgateway-control" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		switch calls {
		case 1:
			if r.Method != http.MethodGet {
				t.Fatalf("method = %s", r.Method)
			}
			_, _ = w.Write([]byte(`{"metadata":{"name":"llmgateway-control","resourceVersion":"41"},"spec":{"replicas":2},"status":{"readyReplicas":2}}`))
		case 2:
			if r.Method != http.MethodPatch || r.Header.Get("Content-Type") != "application/json-patch+json" {
				t.Fatalf("method=%s content-type=%s", r.Method, r.Header.Get("Content-Type"))
			}
			raw, _ := io.ReadAll(r.Body)
			body := string(raw)
			if !strings.Contains(body, `"path":"/metadata/resourceVersion","value":"41"`) || !strings.Contains(body, `"path":"/spec/replicas","value":0`) {
				t.Fatalf("patch = %s", body)
			}
			_, _ = w.Write([]byte(`{"metadata":{"name":"llmgateway-control","resourceVersion":"42"},"spec":{"replicas":0},"status":{"readyReplicas":0}}`))
		default:
			t.Fatalf("unexpected call %d", calls)
		}
	}))
	defer server.Close()

	client := NewKubernetesClient(server.URL, framework.Secret{}, server.Client(), nil)
	before, after, err := client.ScaleDeployment(t.Context(), "llmgateway", "llmgateway-control", 0)
	if err != nil {
		t.Fatal(err)
	}
	if before.Spec.Replicas != 2 || after.Spec.Replicas != 0 || calls != 2 {
		t.Fatalf("before=%+v after=%+v calls=%d", before, after, calls)
	}
}
