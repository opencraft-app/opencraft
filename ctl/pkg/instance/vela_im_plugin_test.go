package instance

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func velaIMPluginFixture(t *testing.T, adapter string) ([]byte, string) {
	t.Helper()
	var archive bytes.Buffer
	zipped := gzip.NewWriter(&archive)
	writer := tar.NewWriter(zipped)
	for name, body := range map[string]string{
		"plugin.yaml":                        "name: vela-im\n",
		"adapter.py":                         adapter,
		"vela_im/_worker/vela-im-worker.mjs": "// worker\n",
	} {
		if err := writer.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(body))}); err != nil {
			t.Fatal(err)
		}
		if _, err := writer.Write([]byte(body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := zipped.Close(); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(archive.Bytes())
	return archive.Bytes(), hex.EncodeToString(sum[:])
}

// runVelaIMPluginInstall runs the rendered command with a fake HERMES_HOME; curl serves the given archive and node
// reports a supported version, so only the script's own logic is under test.
func runVelaIMPluginInstall(t *testing.T, home string, archive []byte, pkg velaIMPluginPackage) (string, error) {
	t.Helper()
	bin := t.TempDir()
	source := filepath.Join(bin, "plugin.tgz")
	if err := os.WriteFile(source, archive, 0o644); err != nil {
		t.Fatal(err)
	}
	fakeCurl := "#!/bin/sh\nwhile [ $# -gt 0 ]; do if [ \"$1\" = -o ]; then out=$2; shift; fi; shift; done\ncp " + source + " \"$out\"\n"
	for name, body := range map[string]string{"curl": fakeCurl, "node": "#!/bin/sh\nexit 0\n"} {
		if err := os.WriteFile(filepath.Join(bin, name), []byte(body), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	command := exec.Command("bash", "-c", renderVelaIMPluginInstallCommand(pkg))
	command.Env = append(os.Environ(), "HERMES_HOME="+home, "PATH="+bin+":"+os.Getenv("PATH"))
	output, err := command.CombinedOutput()
	return strings.TrimSpace(string(output)), err
}

func TestVelaIMPluginInstallCommandInstallsOnceAndKeepsThePluginOnBadDownloads(t *testing.T) {
	for _, tool := range []string{"bash", "tar", "sha256sum"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skipf("%s not available", tool)
		}
	}
	home := t.TempDir()
	if err := os.MkdirAll(filepath.Join(home, "hermes-agent", "venv", "bin"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "hermes-agent", "venv", "bin", "python"), []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	archive, sum := velaIMPluginFixture(t, "# v1\n")
	pkg := velaIMPluginPackage{URL: "https://example.test/vela-im.tgz", SHA256: sum}

	if output, err := runVelaIMPluginInstall(t, home, archive, pkg); err != nil || !strings.HasSuffix(output, VelaIMPluginInstalled) {
		t.Fatalf("first install = %q, %v", output, err)
	}
	installed := filepath.Join(home, "plugins", "vela-im")
	if body, _ := os.ReadFile(filepath.Join(installed, "adapter.py")); string(body) != "# v1\n" {
		t.Fatalf("installed adapter = %q", body)
	}
	if output, err := runVelaIMPluginInstall(t, home, archive, pkg); err != nil || output != VelaIMPluginUpToDate {
		t.Fatalf("second install = %q, %v", output, err)
	}

	tampered, _ := velaIMPluginFixture(t, "# tampered\n")
	next := velaIMPluginPackage{URL: pkg.URL, SHA256: strings.Repeat("0", 64)}
	if output, err := runVelaIMPluginInstall(t, home, tampered, next); err == nil {
		t.Fatalf("checksum mismatch installed anyway: %q", output)
	}
	if body, _ := os.ReadFile(filepath.Join(installed, "adapter.py")); string(body) != "# v1\n" {
		t.Fatalf("a failed download replaced the plugin: %q", body)
	}
	if leftovers, _ := filepath.Glob(filepath.Join(home, "plugins", ".vela-im-install.*")); len(leftovers) != 0 {
		t.Fatalf("install left temporary directories: %v", leftovers)
	}

	upgrade, upgradeSum := velaIMPluginFixture(t, "# v2\n")
	if output, err := runVelaIMPluginInstall(t, home, upgrade, velaIMPluginPackage{URL: pkg.URL, SHA256: upgradeSum}); err != nil ||
		!strings.HasSuffix(output, VelaIMPluginInstalled) {
		t.Fatalf("upgrade = %q, %v", output, err)
	}
	if body, _ := os.ReadFile(filepath.Join(installed+".previous", "adapter.py")); string(body) != "# v1\n" {
		t.Fatalf("previous version not kept: %q", body)
	}
}

func TestVelaIMPluginInstallCommandSkipsInstancesWithoutHermes(t *testing.T) {
	if _, err := exec.LookPath("bash"); err != nil {
		t.Skip("bash not available")
	}
	archive, sum := velaIMPluginFixture(t, "# v1\n")
	output, err := runVelaIMPluginInstall(t, t.TempDir(), archive, velaIMPluginPackage{URL: "https://example.test/p.tgz", SHA256: sum})
	if err != nil || output != VelaIMPluginNoHermes {
		t.Fatalf("no hermes = %q, %v", output, err)
	}
}

func TestVelaIMPluginInstallCommandQuotesThePackageLocation(t *testing.T) {
	command := renderVelaIMPluginInstallCommand(velaIMPluginPackage{URL: "https://example.test/a'b.tgz", SHA256: strings.Repeat("a", 64)})
	if !strings.Contains(command, `'https://example.test/a'"'"'b.tgz'`) {
		t.Fatalf("package URL is not shell-quoted:\n%s", command)
	}
}
