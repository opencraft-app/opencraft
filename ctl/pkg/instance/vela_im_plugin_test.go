package instance

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/base64"
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
	// Same shape as CTL's TAT execution: a login shell whose ~/.bash_logout ends with a failing command, as on instances.
	userHome := t.TempDir()
	if err := os.WriteFile(filepath.Join(userHome, ".bash_logout"), []byte("false\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	command := exec.Command("bash", "-lc", renderVelaIMPluginInstallCommand(pkg))
	command.Env = append(os.Environ(), "HOME="+userHome, "HERMES_HOME="+home, "PATH="+bin+":"+os.Getenv("PATH"))
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
	previous := filepath.Join(home, ".vela-im.previous")
	if body, _ := os.ReadFile(filepath.Join(previous, "adapter.py")); string(body) != "# v1\n" {
		t.Fatalf("previous version not kept: %q", body)
	}
	if plugins, _ := filepath.Glob(filepath.Join(home, "plugins", "*")); len(plugins) != 1 {
		t.Fatalf("Hermes loads every directory under plugins/ as a plugin, only vela-im may be there: %v", plugins)
	}

	// Instances upgraded before the backup moved out still have plugins/vela-im.previous; any run moves it.
	if err := os.Rename(previous, installed+".previous"); err != nil {
		t.Fatal(err)
	}
	if output, err := runVelaIMPluginInstall(t, home, upgrade, velaIMPluginPackage{URL: pkg.URL, SHA256: upgradeSum}); err != nil || output != VelaIMPluginUpToDate {
		t.Fatalf("re-check = %q, %v", output, err)
	}
	if _, err := os.Stat(installed + ".previous"); !os.IsNotExist(err) {
		t.Fatalf("old in-plugins backup must be moved out: %v", err)
	}
	if body, _ := os.ReadFile(filepath.Join(previous, "adapter.py")); string(body) != "# v1\n" {
		t.Fatalf("moved backup = %q", body)
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

func TestDeliverVelaIMScriptLinksSharedPluginIntoProfile(t *testing.T) {
	requireWeixinPython(t)
	home := t.TempDir()
	if err := os.MkdirAll(filepath.Join(home, "plugins", "vela-im"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(home, "profiles", "profile-2"), 0o700); err != nil {
		t.Fatal(err)
	}
	payload := base64.StdEncoding.EncodeToString([]byte(`{"credential":"cred","owner":"u_owner","config":{"apiBaseUrl":"https://example.test"}}`))
	deliver := func(profileID string) string {
		t.Helper()
		command := exec.Command(weixinTestPython(), "-c", deliverVelaIMScript, profileID, payload)
		command.Env = append(os.Environ(), "HERMES_HOME="+home)
		output, err := command.CombinedOutput()
		if err != nil {
			t.Fatalf("deliver %s: %v\n%s", profileID, err, output)
		}
		return string(output)
	}

	if output := deliver("profile-2"); !velaIMOutputHas(output, velaIMPluginLinked) {
		t.Fatalf("first delivery must link the shared plugin: %s", output)
	}
	link := filepath.Join(home, "profiles", "profile-2", "plugins", "vela-im")
	if target, err := os.Readlink(link); err != nil || target != filepath.Join(home, "plugins", "vela-im") {
		t.Fatalf("profile plugin link = %q, %v", target, err)
	}
	if output := deliver("profile-2"); velaIMOutputHas(output, velaIMPluginLinked) {
		t.Fatalf("re-delivery must reuse the existing link: %s", output)
	}
	if output := deliver("default"); velaIMOutputHas(output, velaIMPluginLinked) {
		t.Fatalf("the default profile owns the shared plugin directory: %s", output)
	}
	config, err := os.ReadFile(filepath.Join(home, "profiles", "profile-2", "config.yaml"))
	if err != nil || !strings.Contains(string(config), "vela-im") {
		t.Fatalf("profile config must enable vela-im: %s %v", config, err)
	}
	for _, quiet := range []string{"tool_progress: 'off'", "long_running_notifications: false", "interim_assistant_messages: false"} {
		if !strings.Contains(string(config), quiet) {
			t.Fatalf("IM must only carry replies, missing %q:\n%s", quiet, config)
		}
	}
}

func TestVelaIMRestartIfServingRestartsOnlyInstancesWithIMAgents(t *testing.T) {
	requireWeixinPython(t)
	home, bin := t.TempDir(), t.TempDir()
	python, err := exec.LookPath(weixinTestPython())
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(home, "hermes-agent", "venv", "bin"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(python, filepath.Join(home, "hermes-agent", "venv", "bin", "python")); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(t.TempDir(), "restarted")
	if err := os.WriteFile(filepath.Join(bin, "acli"), []byte("#!/bin/sh\necho \"$*\" >> "+marker+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	run := func() string {
		t.Helper()
		command := exec.Command("bash", "-c", velaIMRestartIfServingCommand)
		command.Env = append(os.Environ(), "HERMES_HOME="+home, "PATH="+bin+":"+os.Getenv("PATH"))
		output, err := command.CombinedOutput()
		if err != nil {
			t.Fatalf("restart-if-serving: %v\n%s", err, output)
		}
		return string(output)
	}

	if output := run(); velaIMOutputHas(output, velaIMGatewayRestarted) {
		t.Fatalf("no Agent has IM yet, gateway must keep running: %s", output)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatalf("acli must not run without an IM Agent: %v", err)
	}
	data := filepath.Join(home, "profiles", "profile-2", "plugin-data", "vela-im")
	if err := os.MkdirAll(data, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(data, "credential"), []byte("cred\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "profiles", "profile-2", "config.yaml"), []byte("display:\n  platforms:\n    vela_im:\n      show_reasoning: false\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if output := run(); !velaIMOutputHas(output, velaIMGatewayRestarted) {
		t.Fatalf("an IM Agent needs the new plugin loaded: %s", output)
	}
	if config, _ := os.ReadFile(filepath.Join(home, "profiles", "profile-2", "config.yaml")); !strings.Contains(string(config), "long_running_notifications: false") {
		t.Fatalf("Agents delivered before the upgrade get the quiet IM display:\n%s", config)
	}
	if calls, _ := os.ReadFile(marker); strings.TrimSpace(string(calls)) != "gateway restart" {
		t.Fatalf("acli calls = %q", calls)
	}
}
