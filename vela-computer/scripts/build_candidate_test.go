package scripts

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func candidateScript(t *testing.T) (string, string) {
	t.Helper()
	_, source, _, _ := runtime.Caller(0)
	project := filepath.Dir(filepath.Dir(source))
	sha, err := exec.Command("git", "-C", project, "rev-parse", "HEAD").Output()
	if err != nil {
		t.Fatal(err)
	}
	return filepath.Join(filepath.Dir(source), "build-vela-candidate.sh"), strings.TrimSpace(string(sha))
}

func TestCandidateBuildIsCredentialFreeAndUnqualified(t *testing.T) {
	script, sha := candidateScript(t)
	if _, err := os.Stat(script); err != nil {
		t.Fatalf("missing candidate build entrypoint: %v", err)
	}
	root := t.TempDir()
	tools := filepath.Join(root, "tools")
	if err := os.Mkdir(tools, 0755); err != nil {
		t.Fatal(err)
	}
	observation := filepath.Join(root, "observed")
	fakeGo := fmt.Sprintf(`#!/bin/sh
set -eu
if [ "$1" = env ]; then
  case "$2" in GOHOSTOS) echo linux;; GOHOSTARCH) echo amd64;; *) exit 2;; esac
  exit 0
fi
[ "$1" = build ] || exit 2
printf 'CGO=%%s\nGOFLAGS=%%s\nGOWORK=%%s\n' "$CGO_ENABLED" "$GOFLAGS" "$GOWORK" > "$CANDIDATE_TEST_OBSERVATION"
output=
while [ "$#" -gt 0 ]; do
  if [ "$1" = -o ]; then output=$2; shift 2; else shift; fi
done
cat > "$output" <<'BINARY'
#!/bin/sh
printf '%%s\n' '{"mode":"vela","name":"vela-computer","version":"v0.0.0-ci.%s"}'
BINARY
chmod 0755 "$output"
`, sha)
	writeExecutable(t, filepath.Join(tools, "go"), fakeGo)
	output := filepath.Join(root, "candidate")
	command := exec.Command("sh", script, "--source-sha", sha, "--out-dir", output)
	command.Env = append(os.Environ(), "PATH="+tools+string(os.PathListSeparator)+os.Getenv("PATH"),
		"CGO_ENABLED=1", "GOFLAGS=-tags=vela_tat_cgo", "CANDIDATE_TEST_OBSERVATION="+observation)
	if data, err := command.CombinedOutput(); err != nil {
		t.Fatalf("candidate build: %v: %s", err, data)
	}
	observed, err := os.ReadFile(observation)
	if err != nil || string(observed) != "CGO=0\nGOFLAGS=\nGOWORK=off\n" {
		t.Fatalf("build inherited native/update options: %q, %v", observed, err)
	}
	var metadata struct {
		SchemaVersion       int    `json:"schemaVersion"`
		Kind                string `json:"kind"`
		SourceSHA           string `json:"sourceSha"`
		Platform            string `json:"platform"`
		BakedUpdateChannel  bool   `json:"bakedUpdateChannel"`
		DeploymentQualified bool   `json:"deploymentQualified"`
	}
	data, err := os.ReadFile(filepath.Join(output, "CANDIDATE.json"))
	if err != nil || json.Unmarshal(data, &metadata) != nil {
		t.Fatalf("invalid candidate metadata: %v", err)
	}
	if metadata.SchemaVersion != 1 || metadata.Kind != "candidate" || metadata.SourceSHA != sha ||
		metadata.Platform != "linux-amd64" || metadata.BakedUpdateChannel || metadata.DeploymentQualified {
		t.Fatalf("candidate overclaims qualification: %+v", metadata)
	}
	var fields map[string]any
	if err := json.Unmarshal(data, &fields); err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"bakedUpdateChannel", "deploymentQualified", "compiledCgo", "sourceDirty"} {
		if _, exists := fields[field]; !exists {
			t.Fatalf("candidate metadata missing %s", field)
		}
	}
	files, err := os.ReadDir(output)
	if err != nil || len(files) != 4 {
		t.Fatalf("candidate contains state or extra executables: %v, %v", files, err)
	}
	sums, err := os.ReadFile(filepath.Join(output, "SHA256SUMS"))
	if err != nil || !strings.Contains(string(sums), "  CANDIDATE.json") || !strings.Contains(string(sums), "  VERSION") {
		t.Fatalf("metadata/version are not checksummed: %q, %v", sums, err)
	}
	check := exec.Command("shasum", "-a", "256", "-c", "SHA256SUMS")
	if _, err := exec.LookPath("shasum"); err != nil {
		check = exec.Command("sha256sum", "-c", "SHA256SUMS")
	}
	check.Dir = output
	if data, err := check.CombinedOutput(); err != nil {
		t.Fatalf("checksum verify: %v: %s", err, data)
	}
}

func TestCandidateBuildRejectsAmbiguousSourceOrExistingOutput(t *testing.T) {
	script, sha := candidateScript(t)
	for index, source := range []string{"latest", strings.Repeat("0", 40)} {
		command := exec.Command("sh", script, "--source-sha", source, "--out-dir", filepath.Join(t.TempDir(), "out"))
		data, err := command.CombinedOutput()
		if err == nil {
			t.Fatalf("accepted ambiguous source %q: %s", source, data)
		}
		expected := []string{"invalid source sha", "source sha does not match checkout"}[index]
		if !strings.Contains(string(data), expected) {
			t.Fatalf("wrong source rejection: %s", data)
		}
	}
	output := t.TempDir()
	command := exec.Command("sh", script, "--source-sha", sha, "--out-dir", output)
	if data, err := command.CombinedOutput(); err == nil || !strings.Contains(string(data), "already exists") {
		t.Fatalf("overwrote candidate output: %s", data)
	}
}
