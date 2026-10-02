package cellreporter

import (
	"testing"
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/dynamic/fake"
	kubernetesfake "k8s.io/client-go/kubernetes/fake"
)

func TestDatabaseIdentityHash(t *testing.T) {
	const connection = "actor_bj_k01:D1B32JDmuygiL5zMwidlQJVTnuirLs6R@one:4500:tls,two:4500:tls"
	got := databaseIdentityHash("27dab58e-b02a-4155-bfa9-a195bfbab7c3", connection)
	const want = "sha256:d131876cd8169bd11cae6b556ab10d2f002600bb0e2080221da4b3281f0e4010"
	if got != want {
		t.Fatalf("identity hash = %q, want %q", got, want)
	}
	if got := databaseIdentityHash("", connection); got != "" {
		t.Fatalf("empty UID produced identity %q", got)
	}
}

func TestDigestSpecIsCanonical(t *testing.T) {
	first := &unstructured.Unstructured{Object: map[string]any{
		"spec": map[string]any{"runtime": map[string]any{"minWorkerdHosts": int64(3), "deploymentMode": "kubernetes"}, "region": "ap-beijing"},
	}}
	second := &unstructured.Unstructured{Object: map[string]any{
		"spec": map[string]any{"region": "ap-beijing", "runtime": map[string]any{"deploymentMode": "kubernetes", "minWorkerdHosts": int64(3)}},
	}}
	a, err := digestSpec(first)
	if err != nil {
		t.Fatal(err)
	}
	b, err := digestSpec(second)
	if err != nil {
		t.Fatal(err)
	}
	if a != b || !validDigest(a) {
		t.Fatalf("canonical digests differ or are invalid: %q %q", a, b)
	}
}

func TestWithinSkew(t *testing.T) {
	if !withinSkew(map[string]int{"z1": 3, "z2": 3, "z3": 3}, 1) {
		t.Fatal("balanced topology rejected")
	}
	if withinSkew(map[string]int{"z1": 4, "z2": 2, "z3": 3}, 1) {
		t.Fatal("skewed topology accepted")
	}
	if withinSkew(nil, 1) {
		t.Fatal("empty topology accepted")
	}
}

func TestReporterValidationFailsClosed(t *testing.T) {
	r := Reporter{
		Dynamic: fake.NewSimpleDynamicClient(runtime.NewScheme()),
		Core:    kubernetesfake.NewSimpleClientset(),
		Config:  Config{Namespace: "ns", CellName: "cell", BackupName: "backup", Interval: time.Second, CapacityRisk: "Unknown", WorkerRegistryURL: "http://registry.invalid"},
	}
	if err := r.validate(); err == nil {
		t.Fatal("invalid capacity risk accepted")
	}
	r.Config.CapacityRisk = "AdmissionClosed"
	r.Config.QualificationReady = true
	if err := r.validate(); err == nil {
		t.Fatal("ready qualification without an immutable receipt accepted")
	}
	r.Config.QualificationReceipt = "receipts/cell.json"
	r.Config.QualificationDigest = "sha256:9e7967b63d892e73a689fb4aae820b5954c294d0e988853b3122221bcdef38da"
	r.Config.QualificationReleaseDigest = "sha256:9e7967b63d892e73a689fb4aae820b5954c294d0e988853b3122221bcdef38da"
	if err := r.validate(); err != nil {
		t.Fatalf("valid fail-closed configuration rejected: %v", err)
	}
}

func TestQualificationMatchesExactRelease(t *testing.T) {
	const release = "sha256:9e7967b63d892e73a689fb4aae820b5954c294d0e988853b3122221bcdef38da"
	cfg := Config{QualificationReady: true, ReleaseDigest: release, QualificationReleaseDigest: release}
	if !qualificationMatchesRelease(cfg) {
		t.Fatal("exact release-bound qualification was rejected")
	}
	cfg.QualificationReleaseDigest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	if qualificationMatchesRelease(cfg) {
		t.Fatal("stale qualification survived a release change")
	}
}
