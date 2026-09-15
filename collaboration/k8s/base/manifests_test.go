package base_test

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestCollaborationComponentManifestHasOneInternalServiceAndSlimRuntime(t *testing.T) {
	root := manifestRoot(t)
	deployment := readManifest(t, filepath.Join(root, "deployment.yaml"))
	for _, want := range []string{
		"kind: Deployment",
		"name: collaboration",
		"--collaboration-only",
		"--database-driver",
		"tdsql",
		"--database-auto-migrate=false",
		"/var/run/secrets/collaboration/database.dsn",
		"/var/run/secrets/collaboration/gateway.token",
		"runAsNonRoot: true",
		"readOnlyRootFilesystem: true",
		"path: /healthz",
		"path: /readyz",
	} {
		if !strings.Contains(deployment, want) {
			t.Errorf("deployment.yaml missing %q", want)
		}
	}
	for _, forbidden := range []string{
		"--tencent-cloud-secret-id-file",
		"--managed-tat-region",
		"--computer-release-file",
		"--computer-install-public-url",
	} {
		if strings.Contains(deployment, forbidden) {
			t.Errorf("slim deployment unexpectedly contains %q", forbidden)
		}
	}

	service := readManifest(t, filepath.Join(root, "service.yaml"))
	if !strings.Contains(service, "kind: Service") ||
		!strings.Contains(service, "name: collaboration") ||
		!strings.Contains(service, "type: ClusterIP") {
		t.Fatalf("service.yaml is not the internal Collaboration service:\n%s", service)
	}
	if strings.Contains(service, "LoadBalancer") || strings.Contains(service, "NodePort") {
		t.Fatal("Collaboration must only be reachable through service-gateway")
	}
}

func TestCollaborationMigrationUsesSameLogicalDatabaseSecret(t *testing.T) {
	root := manifestRoot(t)
	job := readManifest(t, filepath.Join(root, "migration-job.yaml"))
	for _, want := range []string{
		"kind: Job",
		"name: collaboration-migrate-template",
		"database",
		"migrate",
		"--database-driver",
		"tdsql",
		"/var/run/secrets/collaboration/database.dsn",
		"secretName: collaboration-runtime-secrets",
	} {
		if !strings.Contains(job, want) {
			t.Errorf("migration-job.yaml missing %q", want)
		}
	}

	kustomization := readManifest(t, filepath.Join(root, "kustomization.yaml"))
	if strings.Contains(kustomization, "migration-job.yaml") {
		t.Fatal("release-time migration Job must not become a long-lived Argo resource")
	}
	for _, resource := range []string{"namespace.yaml", "deployment.yaml", "service.yaml"} {
		if !strings.Contains(kustomization, resource) {
			t.Errorf("kustomization.yaml missing %q", resource)
		}
	}
}

func manifestRoot(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot resolve manifest test path")
	}
	return filepath.Dir(file)
}

func readManifest(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}
