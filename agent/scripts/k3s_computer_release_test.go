package scripts_test

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestIndependentK3sComputerReleaseContract(t *testing.T) {
	_, current, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve current file")
	}
	repositoryRoot := filepath.Clean(filepath.Join(filepath.Dir(current), "../.."))
	script := filepath.Join(repositoryRoot, "agent/deploy/k3s/release.sh")
	source, err := os.ReadFile(script)
	if err != nil {
		t.Fatalf("read release script: %v", err)
	}
	text := string(source)
	for _, required := range []string{
		"-o BatchMode=yes",
		"-o IdentitiesOnly=yes",
		"builder_identity",
		"target_identity",
		"computer_identity",
		"git status --porcelain",
		"@{upstream}",
		"check:tui",
		"test:tui",
		"test:tui-build",
		"go test -p 1 ./... -count=1",
		"build-vela-macos-arm64.sh",
		"build-vela-linux-amd64-buildx.sh",
		"computer-release build-set",
		"computer-release verify-set",
		"computer-release publish-set",
		"catalog-write-policy",
		"immutable",
		"target_kubectl",
		"rollback_catalog",
		"rollback_computer",
		"release-evidence.json",
		"daemon.state.json",
		"programSha256",
	} {
		if !strings.Contains(text, required) {
			t.Errorf("release script missing %q", required)
		}
	}
	for _, forbidden := range []string{
		"kubectl config use-context",
		"PasswordAuthentication=yes",
		"deploy-computer-canary.sh",
		"replicas == 3",
	} {
		if strings.Contains(text, forbidden) {
			t.Errorf("release script contains forbidden %q", forbidden)
		}
	}
	if output, err := exec.Command("/bin/sh", "-n", script).CombinedOutput(); err != nil {
		t.Fatalf("release script syntax: %v\n%s", err, output)
	}
	output, err := exec.Command(script, "--help").CombinedOutput()
	if err != nil {
		t.Fatalf("release script help: %v\n%s", err, output)
	}
	for _, required := range []string{
		"--builder", "--target", "--computer", "--version", "--evidence",
	} {
		if !strings.Contains(string(output), required) {
			t.Errorf("release help missing %q", required)
		}
	}
}
