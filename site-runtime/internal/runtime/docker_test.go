package runtime

import (
	"strings"
	"testing"
)

func TestDockerRunnerRequiresPinnedImageAndHardIsolation(t *testing.T) {
	for _, image := range []string{"workerd:latest", "workerd:v1", "", "x@sha256:bad"} {
		if _, err := NewDockerRunner(image, t.TempDir()); err == nil {
			t.Fatalf("accepted unpinned image %q", image)
		}
	}
	image := "registry.example/runtime@sha256:" + strings.Repeat("a", 64)
	runner, err := NewDockerRunner(image, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	args, err := runner.createArgs("site-test", "/tmp/bundle", "/tmp/socket")
	if err != nil {
		t.Fatal(err)
	}
	all := strings.Join(args, " ")
	for _, required := range []string{"--runtime=runsc", "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--user=65532:65532", "--memory=128m", "--memory-swap=128m", "--cpus=1", "--pids-limit=64", "readonly", image} {
		if !strings.Contains(all, required) {
			t.Errorf("missing hard gate %s", required)
		}
	}
	if strings.Contains(all, "--privileged") || strings.Contains(all, "docker.sock") {
		t.Fatal("unsafe container capabilities")
	}
	if _, err := runner.createArgs("site-test", "/tmp/bundle,ro=false", "/tmp/socket"); err == nil {
		t.Fatal("mount option injection accepted")
	}
}
