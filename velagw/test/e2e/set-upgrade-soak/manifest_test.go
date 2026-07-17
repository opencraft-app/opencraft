package main

import (
	"os"
	"os/exec"
	"strings"
	"testing"
)

func TestRunnerBuildsAsStandaloneBinary(t *testing.T) {
	command := exec.Command("go", "build", "-o", t.TempDir()+"/runner", ".")
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("standalone build failed: %v\n%s", err, output)
	}
}

func TestManifestProvidesIsolatedRunnerAndRequiredRBAC(t *testing.T) {
	raw, err := os.ReadFile("manifest.yaml.template")
	if err != nil {
		t.Fatal(err)
	}
	content := string(raw)
	for _, required := range []string{
		"kind: ServiceAccount",
		"kind: Role",
		`resources: ["cronjobs", "jobs"]`,
		`resources: ["deployments"]`,
		"kind: Service",
		"port: 18090",
		"kind: Job",
		"serviceAccountName: llmgateway-upgrade-soak",
		"name: tcr-pull-secret",
		"/usr/local/bin/llmgateway-set-upgrade-soak",
		"LLMGATEWAY_SOAK_GENERATIONS",
		`value: "__GENERATIONS__"`,
		"LLMGATEWAY_SOAK_SOURCE",
		`value: "__SOURCE__"`,
		"LLMGATEWAY_SOAK_USERS",
		`value: "__USERS__"`,
		"LLMGATEWAY_SOAK_SSE_USERS",
		`value: "__SSE_USERS__"`,
	} {
		if !strings.Contains(content, required) {
			t.Fatalf("manifest is missing %q", required)
		}
	}
}

func TestRunScriptRequiresExplicitTargetSet(t *testing.T) {
	raw, err := os.ReadFile("run.sh")
	if err != nil {
		t.Fatal(err)
	}
	content := string(raw)
	for _, required := range []string{
		": \"${LLMGATEWAY_SOAK_TARGET_SET:?",
		"wait_for_job",
		"logs job/llmgateway-upgrade-soak",
		"LLMGATEWAY_SOAK_GENERATIONS:-4",
		"LLMGATEWAY_SOAK_USERS:-400",
		"LLMGATEWAY_SOAK_SSE_USERS:-100",
	} {
		if !strings.Contains(content, required) {
			t.Fatalf("run.sh is missing %q", required)
		}
	}
}
