package scripts

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestVelaReleasePackagesSingleEmbeddedIMHost(t *testing.T) {
	t.Parallel()

	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot resolve release script path")
	}
	script := filepath.Join(filepath.Dir(sourceFile), "build-vela-release.sh")
	root := t.TempDir()
	agent := filepath.Join(root, "canonical-agent")
	agentContent := "#!/bin/sh\nprintf '%s\\n' '{\"mode\":\"vela\",\"name\":\"vela-computer\",\"version\":\"v0.1.0\"}'\n"
	writeExecutable(t, agent, agentContent)
	output := filepath.Join(root, "release")

	command := exec.Command(
		"sh",
		script,
		"--version",
		"v0.1.0",
		"--agent-binary",
		agent,
		"--out-dir",
		output,
	)
	if combined, err := command.CombinedOutput(); err != nil {
		t.Fatalf("build release: %v: %s", err, combined)
	}

	assertReleaseFile(t, output, "vela-computer", agentContent)
	if _, err := os.Stat(filepath.Join(output, "chatserver-im-bridge")); !os.IsNotExist(err) {
		t.Fatal("release still contains the obsolete IM Bridge")
	}
	if _, err := os.Stat(filepath.Join(output, "chatserver-agent")); !os.IsNotExist(err) {
		t.Fatal("release still contains the duplicate chatserver-agent host")
	}
	manifest, err := os.ReadFile(filepath.Join(output, "SHA256SUMS"))
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range []struct {
		name    string
		content string
	}{
		{"vela-computer", agentContent},
	} {
		sum := sha256.Sum256([]byte(item.content))
		expected := hex.EncodeToString(sum[:]) + "  " + item.name
		if !strings.Contains(string(manifest), expected) {
			t.Fatalf("SHA256SUMS missing %q: %s", expected, manifest)
		}
	}
	version, err := os.ReadFile(filepath.Join(output, "VERSION"))
	if err != nil || string(version) != "v0.1.0\n" {
		t.Fatalf("VERSION = %q, %v", version, err)
	}
}

func TestVelaReleaseRejectsUnsafeInputs(t *testing.T) {
	t.Parallel()

	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot resolve release script path")
	}
	script := filepath.Join(filepath.Dir(sourceFile), "build-vela-release.sh")
	root := t.TempDir()
	agent := filepath.Join(root, "agent")
	writeExecutable(t, agent, "agent")
	for index, version := range []string{"latest", "v1.x.1", "v1.2.3/escape"} {
		command := exec.Command(
			"sh",
			script,
			"--version",
			version,
			"--agent-binary",
			agent,
			"--out-dir",
			filepath.Join(root, "release-"+string(rune('a'+index))),
		)
		output, err := command.CombinedOutput()
		if err == nil || !strings.Contains(string(output), "invalid version") {
			t.Fatalf(
				"unsafe version %q result: err=%v output=%s",
				version,
				err,
				output,
			)
		}
	}
}

func TestVelaReleaseRequiresNativeComputerBinary(t *testing.T) {
	t.Parallel()

	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot resolve release script path")
	}
	script := filepath.Join(filepath.Dir(sourceFile), "build-vela-release.sh")
	command := exec.Command(
		"sh",
		script,
		"--version",
		"v0.1.0",
		"--out-dir",
		filepath.Join(t.TempDir(), "release"),
	)
	output, err := command.CombinedOutput()
	if err == nil || !strings.Contains(string(output), "--agent-binary is required") {
		t.Fatalf("missing native binary result: err=%v output=%s", err, output)
	}
}

func TestVelaReleaseRejectsBinaryWithDifferentVersion(t *testing.T) {
	t.Parallel()

	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot resolve release script path")
	}
	script := filepath.Join(filepath.Dir(sourceFile), "build-vela-release.sh")
	root := t.TempDir()
	agent := filepath.Join(root, "canonical-agent")
	writeExecutable(t, agent, "#!/bin/sh\nprintf '%s\\n' '{\"mode\":\"vela\",\"name\":\"vela-computer\",\"version\":\"v9.9.9\"}'\n")
	command := exec.Command(
		"sh", script,
		"--version", "v0.1.0",
		"--agent-binary", agent,
		"--out-dir", filepath.Join(root, "release"),
	)
	output, err := command.CombinedOutput()
	if err == nil || !strings.Contains(string(output), "binary version does not match") {
		t.Fatalf("mismatched binary result: err=%v output=%s", err, output)
	}
}

func writeExecutable(t *testing.T, path string, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o700); err != nil {
		t.Fatal(err)
	}
}

func assertReleaseFile(
	t *testing.T,
	directory string,
	name string,
	expected string,
) {
	t.Helper()
	path := filepath.Join(directory, name)
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if !info.Mode().IsRegular() || info.Mode().Perm() != 0o755 {
		t.Fatalf("%s mode = %s", name, info.Mode())
	}
	content, err := os.ReadFile(path)
	if err != nil || string(content) != expected {
		t.Fatalf("%s content = %q, %v", name, content, err)
	}
}
