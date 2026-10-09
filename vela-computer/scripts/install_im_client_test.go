package scripts

import (
	"crypto/sha256"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestIMClientFirstInstall(t *testing.T) {
	_, source, _, _ := runtime.Caller(0)
	script := filepath.Join(filepath.Dir(source), "install-im-client.sh")
	for _, scenario := range []string{"success", "checksum", "version", "existing", "download"} {
		t.Run(scenario, func(t *testing.T) {
			root := t.TempDir()
			tools := filepath.Join(root, "tools")
			if err := os.Mkdir(tools, 0700); err != nil {
				t.Fatal(err)
			}
			payload := []byte("#!/bin/sh\necho '{\"mode\":\"vela\",\"name\":\"vela-computer\",\"version\":\"v0.1.0-test\"}'\n")
			checksum := fmt.Sprintf("%x", sha256.Sum256(payload))
			fixture := filepath.Join(root, "payload")
			if err := os.WriteFile(fixture, payload, 0700); err != nil {
				t.Fatal(err)
			}
			writeExecutable(t, filepath.Join(tools, "uname"), "#!/bin/sh\ncase \"$1\" in -s) echo Linux;; -m) echo x86_64;; esac\n")
			writeExecutable(t, filepath.Join(tools, "curl"), "#!/bin/sh\nset -eu\n[ \"$IM_TEST_SCENARIO\" != download ] || exit 22\necho called >> \"$IM_TEST_DOWNLOAD_LOG\"\nwhile [ \"$#\" -gt 0 ]; do if [ \"$1\" = --output ]; then cp \"$IM_TEST_PAYLOAD\" \"$2\"; exit; fi; shift; done\nexit 2\n")
			installRoot := filepath.Join(root, "install")
			binDir := filepath.Join(root, "bin")
			if scenario == "existing" {
				if err := os.MkdirAll(binDir, 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(binDir, "vela-computer"), []byte("preserve"), 0700); err != nil {
					t.Fatal(err)
				}
			}
			version := "v0.1.0-test"
			if scenario == "checksum" {
				checksum = strings.Repeat("0", 64)
			}
			if scenario == "version" {
				version = "v0.1.0-other"
			}
			run := func() ([]byte, error) {
				command := exec.Command("sh", script, "--binary-url", "https://example.test/vela-computer", "--sha256", checksum, "--version", version)
				command.Env = append(os.Environ(), "PATH="+tools+":"+os.Getenv("PATH"), "VELA_IM_INSTALL_ROOT="+installRoot, "VELA_IM_BIN_DIR="+binDir,
					"IM_TEST_PAYLOAD="+fixture, "IM_TEST_DOWNLOAD_LOG="+filepath.Join(root, "downloads"), "IM_TEST_SCENARIO="+scenario)
				return command.CombinedOutput()
			}
			out, err := run()
			if scenario != "success" {
				if err == nil || strings.Contains(string(out), "VELA_IM_CLIENT_INSTALLED") {
					t.Fatalf("failure reported success: %s", out)
				}
				if _, err := os.Stat(filepath.Join(installRoot, "vela-computer")); !os.IsNotExist(err) {
					t.Fatal("failed candidate activated")
				}
				if scenario == "existing" {
					data, err := os.ReadFile(filepath.Join(binDir, "vela-computer"))
					if err != nil || string(data) != "preserve" {
						t.Fatal("existing entry changed")
					}
				}
				return
			}
			if err != nil || !strings.Contains(string(out), "VELA_IM_CLIENT_INSTALLED v0.1.0-test") {
				t.Fatalf("install: %v %s", err, out)
			}
			if out, err = run(); err != nil {
				t.Fatalf("repeat: %v %s", err, out)
			}
			data, err := os.ReadFile(filepath.Join(root, "downloads"))
			if err != nil || string(data) != "called\n" {
				t.Fatal("repeat downloaded again")
			}
			link, err := os.Readlink(filepath.Join(binDir, "vela-computer"))
			if err != nil || link != filepath.Join(installRoot, "vela-computer") {
				t.Fatal("client not exposed")
			}
		})
	}
}
