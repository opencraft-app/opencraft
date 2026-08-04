package scripts_test

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestSecretScan接受脱敏内容并拒绝真实形态凭证(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "clean.txt"), "SDKAppID=0000000000\nSecretId=<从环境变量读取>\n")

	script := scriptPath(t, "scan-secrets.sh")
	command := exec.Command(script, root)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("脱敏 fixture 扫描失败：%v\n%s", err, output)
	}

	token := "eyJhbGciOiJIUzI1NiJ9" + "." + "payload" + "." + "signature"
	writeTestFile(t, filepath.Join(root, "leaked.txt"), "Authorization: Bearer "+token+"\n")
	command = exec.Command(script, root)
	output, err := command.CombinedOutput()
	if err == nil {
		t.Fatalf("凭证形态未被拒绝：%s", output)
	}
	if !strings.Contains(string(output), "疑似真实凭证") {
		t.Fatalf("扫描错误不清晰：%s", output)
	}
}

func TestGeneratedCheck检测漂移且不修改源目录(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "go.mod"), "module fixture\n\ngo 1.25.0\n")
	writeTestFile(t, filepath.Join(root, "generated.txt"), "clean")
	writeTestFile(t, filepath.Join(root, "generate.go"), `package fixture

//go:generate sh -c "printf changed > generated.txt"
`)

	script := scriptPath(t, "check-generated.sh")
	command := exec.Command(script, root)
	command.Env = append(os.Environ(), "CHATSERVER_GENERATED_PATHS=generated.txt")
	output, err := command.CombinedOutput()
	if err == nil {
		t.Fatalf("生成漂移未被拒绝：%s", output)
	}
	if !strings.Contains(string(output), "生成产物不一致") {
		t.Fatalf("生成漂移错误不清晰：%s", output)
	}
	data, readErr := os.ReadFile(filepath.Join(root, "generated.txt"))
	if readErr != nil {
		t.Fatal(readErr)
	}
	if string(data) != "clean" {
		t.Fatalf("检查脚本修改了源目录：%q", data)
	}
}

func TestGeneratedCheck包含可信Migration发布锁门禁(t *testing.T) {
	content, err := os.ReadFile(scriptPath(t, "check-generated.sh"))
	if err != nil {
		t.Fatal(err)
	}
	text := string(content)
	for _, required := range []string{
		"check-migration-release.sh",
		"CHATSERVER_MIGRATION_TRUSTED_RELEASE_LOCK",
	} {
		if !strings.Contains(text, required) {
			t.Errorf("check-generated.sh 缺少 %q", required)
		}
	}
}

func TestOpenAPI兼容门禁使用当前主版本基线(t *testing.T) {
	content, err := os.ReadFile(scriptPath(t, "check-openapi-compatibility.sh"))
	if err != nil {
		t.Fatal(err)
	}
	text := string(content)
	for _, required := range []string{
		"4.0.0.openapi.yaml",
		"4.0.0.computer-bootstrap.openapi.yaml",
	} {
		if !strings.Contains(text, required) {
			t.Errorf("check-openapi-compatibility.sh 缺少 %q", required)
		}
	}
	for _, stale := range []string{
		"3.0.0.openapi.yaml",
		"3.0.0.computer-bootstrap.openapi.yaml",
	} {
		if strings.Contains(text, stale) {
			t.Errorf("check-openapi-compatibility.sh 仍使用旧主版本 %q", stale)
		}
	}
}

func TestWebReleaseScan覆盖静态产物和最终二进制(t *testing.T) {
	root := t.TempDir()
	assets := filepath.Join(root, "dist")
	if err := os.MkdirAll(filepath.Join(assets, "static", "js"), 0o700); err != nil {
		t.Fatal(err)
	}
	writeTestFile(t, filepath.Join(assets, "index.html"), `<div id="root"></div>`)
	javascript := filepath.Join(assets, "static", "js", "app.1234abcd.js")
	writeTestFile(t, javascript, `console.log("clean release")`)
	binary := filepath.Join(root, "chatserver")
	writeTestFile(t, binary, "clean-binary")

	script := scriptPath(t, "scan-web-release.sh")
	command := exec.Command(script, assets, binary)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("干净发布物扫描失败：%v\n%s", err, output)
	}

	writeTestFile(t, filepath.Join(assets, "static", "js", "app.js.map"), "{}")
	command = exec.Command(script, assets, binary)
	output, err := command.CombinedOutput()
	if err == nil || !strings.Contains(string(output), "source map") {
		t.Fatalf("source map 未被拒绝：err=%v output=%s", err, output)
	}
	if err := os.Remove(filepath.Join(assets, "static", "js", "app.js.map")); err != nil {
		t.Fatal(err)
	}

	writeTestFile(t, javascript, `fetch("http://127.0.0.1:18080/v1/me")`)
	command = exec.Command(script, assets, binary)
	output, err = command.CombinedOutput()
	if err == nil || !strings.Contains(string(output), "固定开发地址") {
		t.Fatalf("固定开发地址未被拒绝：err=%v output=%s", err, output)
	}
}

func TestRelease只发布内嵌IM的CanonicalGoHost(t *testing.T) {
	t.Parallel()

	content, err := os.ReadFile(scriptPath(t, "build-release.sh"))
	if err != nil {
		t.Fatal(err)
	}
	script := string(content)
	for _, forbidden := range []string{
		"./cmd/chatserver-agent",
		"CHATSERVER_NODE_BINARY",
		"build-sea.mjs",
		"verify-sea.mjs",
		"chatserver-im-bridge",
		"$release_directory/chatserver-agent",
		"$release_directory/bridge/chatserver-im-bridge",
	} {
		if strings.Contains(script, forbidden) {
			t.Errorf("build-release.sh still contains %q", forbidden)
		}
	}
	for _, required := range []string{
		"CHATSERVER_AGENT_BINARY",
		`"$release_directory/raft-computer-go"`,
		`"$release_directory/SHA256SUMS"`,
	} {
		if !strings.Contains(script, required) {
			t.Errorf("build-release.sh is missing %q", required)
		}
	}
	for _, forbiddenArtifact := range []string{
		`$release_directory/bundle.cjs`,
		`$release_directory/sea-prep.blob`,
		`$release_directory/manifest.json`,
		`$release_directory/sea-config.generated.json`,
	} {
		if strings.Contains(script, forbiddenArtifact) {
			t.Errorf(
				"build-release.sh publishes intermediate %q",
				forbiddenArtifact,
			)
		}
	}
}

func Test后台不再构建端侧Computer(t *testing.T) {
	t.Parallel()

	path := scriptPath(t, "build-computer.sh")
	if _, err := os.Lstat(path); err == nil {
		t.Fatalf("后台仍保留端侧 Computer 构建脚本：%s", path)
	} else if !os.IsNotExist(err) {
		t.Fatal(err)
	}
}

func Test正式后台不再包含重复AgentHost源码(t *testing.T) {
	t.Parallel()

	root := filepath.Dir(filepath.Dir(scriptPath(t, "build-release.sh")))
	for _, legacy := range []string{
		"cmd/chatserver-agent",
		"internal/agentapi",
		"internal/agentcli",
		"internal/agentgateway",
		"internal/agenthost",
		"internal/agentmanager",
		"internal/codex",
		"internal/filelock",
		"internal/gatedsteering",
		"internal/hermes",
		"internal/hermesgateway",
		"internal/jsonx",
		"internal/protocol",
		"internal/runtimeapi",
		"internal/runtimecatalog",
		"internal/runtimehost",
		"internal/runtimeprompt",
		"internal/runtimes",
		"internal/state",
	} {
		path := filepath.Join(root, filepath.FromSlash(legacy))
		if _, err := os.Stat(path); err == nil {
			t.Errorf("重复 Agent Host 源码仍存在：%s", legacy)
		} else if !os.IsNotExist(err) {
			t.Fatalf("检查 %s 失败：%v", legacy, err)
		}
	}
}

func TestCanary发布脚本固定全新数据库和安全Rollout合同(t *testing.T) {
	t.Parallel()

	path := scriptPath(t, "deploy-canary.sh")
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("缺少 Canary 发布脚本：%v", err)
	}
	text := string(content)
	for _, required := range []string{
		"--kubeconfig",
		"--fresh-database",
		"--source-secret",
		"docker buildx build",
		"docker buildx imagetools inspect",
		"database migrate",
		"database verify",
		"rollout status",
		"--for=condition=complete",
		"wait_for_job",
		"runAsNonRoot: true",
		"fsGroup: 65532",
		"deploy/k8s/deployment.yaml",
		"canonical_args",
		"original_args",
		"deploy/k8s/computer-release-configmap.yaml",
		"canonical_computer_release_configmap",
		"original_computer_release_configmap",
		"Computer 发布目录已存在且内容不同",
		"sha256:",
		"go test -p 1",
		"mktemp -d",
		"umask 077",
		"trap cleanup",
	} {
		if !strings.Contains(text, required) {
			t.Errorf("deploy-canary.sh 缺少安全合同 %q", required)
		}
	}
	for _, forbidden := range []string{
		"kubectl config use-context",
		"kubectl delete secret",
		"DROP DATABASE",
		"--database-auto-migrate=true",
	} {
		if strings.Contains(text, forbidden) {
			t.Errorf("deploy-canary.sh 包含禁止行为 %q", forbidden)
		}
	}
	command := exec.Command("/bin/sh", "-n", path)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("deploy-canary.sh 语法无效：%v\n%s", err, output)
	}
	command = exec.Command(path, "--help")
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("deploy-canary.sh 帮助入口不可执行：%v\n%s", err, output)
	}
	if !strings.Contains(string(output), "--fresh-database") {
		t.Fatalf("deploy-canary.sh 帮助缺少全新数据库参数：%s", output)
	}
}

func TestComputerCanary发布脚本构建验签发布并安全切换Catalog(t *testing.T) {
	t.Parallel()

	path := scriptPath(t, "deploy-computer-canary.sh")
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("缺少 Computer Canary 发布脚本：%v", err)
	}
	text := string(content)
	for _, required := range []string{
		"--kubeconfig",
		"--agent-source",
		"--version",
		"--signing-key-id",
		"--signing-private-key",
		"--signing-public-key",
		"build-vela-macos-arm64.sh",
		"computer-release verify",
		"computer-release publish",
		"kubectl create configmap",
		"rollout status",
		"original_computer_release_configmap",
		"mktemp -d",
		"umask 077",
		"trap cleanup",
		"sha256:",
		"go test -p 1",
	} {
		if !strings.Contains(text, required) {
			t.Errorf("deploy-computer-canary.sh 缺少安全合同 %q", required)
		}
	}
	for _, forbidden := range []string{
		"set -x",
		"kubectl config use-context",
		"kubectl delete configmap",
		"kubectl delete secret",
		"x-cos-acl: public-read",
	} {
		if strings.Contains(text, forbidden) {
			t.Errorf("deploy-computer-canary.sh 包含禁止行为 %q", forbidden)
		}
	}
	command := exec.Command("/bin/sh", "-n", path)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("deploy-computer-canary.sh 语法无效：%v\n%s", err, output)
	}
	command = exec.Command(path, "--help")
	output, err := command.CombinedOutput()
	if err != nil || !strings.Contains(string(output), "--signing-private-key") {
		t.Fatalf("deploy-computer-canary.sh 帮助入口无效：err=%v output=%s", err, output)
	}
}

func scriptPath(t *testing.T, name string) string {
	t.Helper()
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("无法定位测试文件")
	}
	return filepath.Join(filepath.Dir(currentFile), name)
}

func writeTestFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}
