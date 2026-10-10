package k8s_test

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestComputerUpdateWorkloadIsIndependentSingleWriterAndFailClosed(t *testing.T) {
	root := filepath.Join(deploymentRoot(t), "computer-update")
	kustomization := read(t, filepath.Join(root, "kustomization.yaml"))
	for _, resource := range []string{
		"service-account.yaml", "persistent-volume-claim.yaml", "deployment.yaml",
		"service.yaml", "network-policy.yaml",
	} {
		if !strings.Contains(kustomization, "- "+resource) {
			t.Errorf("Computer Update kustomization 缺少 %q", resource)
		}
	}
	deployment := read(t, filepath.Join(root, "deployment.yaml"))
	for _, want := range []string{
		"replicas: 1", "type: Recreate", "serviceAccountName: chatserver-computer-update",
		"- computer-update", "- serve", "- --state-dir", "- --release-root",
		"- --release-public-key-file", "- --channel-private-key-file",
		"- --trusted-proxy-cidr", "192.0.2.0/32", "computer-update.invalid",
		"runAsNonRoot: true", "readOnlyRootFilesystem: true", "allowPrivilegeEscalation: false",
		"path: /healthz", "path: /readyz", "claimName: chatserver-computer-update-data",
		"secretName: chatserver-computer-update-secrets",
	} {
		if !strings.Contains(deployment, want) {
			t.Errorf("Computer Update deployment 缺少 %q", want)
		}
	}
	for _, forbidden := range []string{
		"- --database", "- --im-", "- --jwt-key-file", "- --managed-tat-region",
		"TENCENTCLOUD_SECRET", "kind: Ingress",
	} {
		if strings.Contains(deployment+kustomization, forbidden) {
			t.Errorf("Computer Update 独立部署不应包含 %q", forbidden)
		}
	}
}

func TestComputerUpdateNetworkAndStorageAreExplicit(t *testing.T) {
	root := filepath.Join(deploymentRoot(t), "computer-update")
	pvc := read(t, filepath.Join(root, "persistent-volume-claim.yaml"))
	for _, want := range []string{"ReadWriteOnce", "storage: 2Gi"} {
		if !strings.Contains(pvc, want) {
			t.Errorf("Computer Update PVC 缺少 %q", want)
		}
	}
	service := read(t, filepath.Join(root, "service.yaml"))
	if !strings.Contains(service, "type: ClusterIP") || strings.Contains(service, "LoadBalancer") {
		t.Fatal("Computer Update 只能由共享 Ingress 访问，不得创建独立 LoadBalancer")
	}
	policy := read(t, filepath.Join(root, "network-policy.yaml"))
	for _, want := range []string{
		"policyTypes:", "- Ingress", "- Egress", "cidr: 192.0.2.0/32", "port: 8090", "port: 443",
	} {
		if !strings.Contains(policy, want) {
			t.Errorf("Computer Update NetworkPolicy 缺少 %q", want)
		}
	}
	readme := read(t, filepath.Join(root, "README.md"))
	for _, want := range []string{
		"qcloud_ca_cert_id", "X-Vela-Operator-Fingerprint", "覆盖而不是透传", "不会直接部署",
	} {
		if !strings.Contains(readme, want) {
			t.Errorf("Computer Update 部署说明缺少 %q", want)
		}
	}
}
