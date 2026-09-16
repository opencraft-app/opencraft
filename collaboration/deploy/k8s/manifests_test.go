package k8s_test

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestCanaryManifest固定三副本迁移Job与非Root健康检查(t *testing.T) {
	root := deploymentRoot(t)
	deployment := read(t, filepath.Join(root, "deployment.yaml"))
	for _, want := range []string{
		"replicas: 3",
		"type: Recreate",
		"runAsNonRoot: true",
		"readOnlyRootFilesystem: true",
		"path: /healthz",
		"path: /readyz",
		"--database-auto-migrate=false",
		"--database-driver",
		"tdsql",
		"/var/run/secrets/chatserver/tdsql.dsn",
		"secretName: chatserver-canary-20260804-clean-v4-secrets",
		"--cors-origin",
		"http://127.0.0.1:51838",
		"http://localhost:51838",
		"--computer-release-file",
		"/etc/chatserver/computer-release/release.catalog.json",
		"--computer-artifact-bucket",
		"an-computer-1388575217",
		"--computer-artifact-region",
		"ap-beijing",
		"name: computer-release",
		"mountPath: /etc/chatserver/computer-release/release.catalog.json",
		"subPath: release.catalog.json",
		"name: chatserver-computer-release-v0-1-31",
	} {
		if !strings.Contains(deployment, want) {
			t.Errorf("deployment.yaml 缺少 %q", want)
		}
	}
	for _, forbidden := range []string{"TENCENTCLOUD_SECRET_ID", "TENCENTCLOUD_SECRET_KEY", "valueFrom:"} {
		if strings.Contains(deployment, forbidden) {
			t.Errorf("deployment.yaml 不应通过环境变量注入 %q", forbidden)
		}
	}

	job := read(t, filepath.Join(root, "migration-job.yaml"))
	for _, want := range []string{
		"kind: Job",
		"name: chatserver-canary-20260804-clean-v4-migrate-template",
		"backoffLimit: 1",
		"initContainers:",
		"mysql-bootstrap.cnf",
		"CREATE DATABASE IF NOT EXISTS chatserver_canary_20260804_clean_v4",
		"database",
		"migrate",
		"--database-driver",
		"tdsql",
		"/var/run/secrets/chatserver/tdsql.dsn",
		"secretName: chatserver-canary-20260804-clean-v4-secrets",
	} {
		if !strings.Contains(job, want) {
			t.Errorf("migration-job.yaml 缺少 %q", want)
		}
	}
	for _, forbidden := range []string{
		"--database-driver\n            - mysql",
		"CREATE DATABASE IF NOT EXISTS chatserver_canary CHARACTER",
		"secretName: chatserver-canary-secrets",
	} {
		if strings.Contains(deployment+job, forbidden) {
			t.Errorf("分片发布清单不应包含旧配置 %q", forbidden)
		}
	}

	service := read(t, filepath.Join(root, "service.yaml"))
	if !strings.Contains(service, "service.kubernetes.io/qcloud-loadbalancer-internal-subnetid") ||
		!strings.Contains(service, "subnet-o7o7hnas") {
		t.Fatal("Service 没有固定到已验证的内网 CLB 子网")
	}
}

func TestCanaryComputerReleaseCatalogIsNonSecretAndImmutable(t *testing.T) {
	root := deploymentRoot(t)
	catalog := read(t, filepath.Join(root, "computer-release-configmap.yaml"))
	for _, want := range []string{
		"kind: ConfigMap",
		"name: chatserver-computer-release-v0-1-31",
		"immutable: true",
		`"version": "v0.1.31"`,
		`"target": "darwin-arm64"`,
		`"signingKeyId": "computer-release-2026-08-04-v031"`,
		`"objectKey": "computer/releases/v0.1.31/manifest.json"`,
		`"sha256": "02247d702fe08d24717e7bcf7a0956a481e784806c26dbcfabb835ea1a000410"`,
		`"sha256": "8da8583d3c5d668c0ecfdbfe9c88209e21159bfa20457d3695412950997092b9"`,
		`"sha256": "01f533c74b0d8577a93101d0ddb338cf172cb66e5808ae77cd34d7f2d5040a25"`,
	} {
		if !strings.Contains(catalog, want) {
			t.Errorf("computer-release-configmap.yaml 缺少 %q", want)
		}
	}
	for _, forbidden := range []string{
		"private", "SecretId", "SecretKey", "ed25519.private",
	} {
		if strings.Contains(catalog, forbidden) {
			t.Errorf("Computer release ConfigMap 泄漏 %q", forbidden)
		}
	}
	kustomization := read(t, filepath.Join(root, "kustomization.yaml"))
	if !strings.Contains(kustomization, "computer-release-configmap.yaml") {
		t.Fatal("kustomization.yaml 未包含 Computer release ConfigMap")
	}
}

func TestCanaryManifest允许真实浏览器入口(t *testing.T) {
	root := deploymentRoot(t)
	deployment := read(t, filepath.Join(root, "deployment.yaml"))

	const publicOrigin = "- --cors-origin\n            - http://9.135.236.64"
	if !strings.Contains(deployment, publicOrigin) {
		t.Errorf("deployment.yaml 缺少已验证的 Canary 浏览器入口配置 %q", publicOrigin)
	}

	for _, want := range []string{
		"- --computer-install-public-url\n            - http://9.135.236.64",
		"- --allow-insecure-computer-install-http",
	} {
		if !strings.Contains(deployment, want) {
			t.Errorf("deployment.yaml 缺少 Computer 内网安装配置 %q", want)
		}
	}
}

func TestDockerfile使用Go125多阶段和DistrolessNonroot(t *testing.T) {
	root := filepath.Dir(filepath.Dir(deploymentRoot(t)))
	dockerfile := read(t, filepath.Join(root, "Dockerfile"))
	for _, want := range []string{
		"golang:1.25.12-bookworm@sha256:",
		"CGO_ENABLED=0",
		"distroless/static-debian12:nonroot@sha256:",
		"USER nonroot:nonroot",
	} {
		if !strings.Contains(dockerfile, want) {
			t.Errorf("Dockerfile 缺少 %q", want)
		}
	}
	dockerignore := read(t, filepath.Join(root, ".dockerignore"))
	if strings.Contains(dockerignore, "!internal/webui/dist/**") {
		t.Fatal("API 镜像不应再把 Web 发布目录加入构建上下文")
	}
	if !strings.Contains(dockerignore, "internal/webui/dist") {
		t.Fatal("API 镜像必须排除遗留 Web 发布目录")
	}
}

func deploymentRoot(t *testing.T) string {
	t.Helper()
	_, current, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("无法定位测试文件")
	}
	return filepath.Dir(current)
}

func read(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}
