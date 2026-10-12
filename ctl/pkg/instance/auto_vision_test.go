package instance

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestPlatformAutoVisionCommand(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, cli, config string
		restart           bool
	}{
		{"acli", "acli", `{"providers":{"custom":{"models":{"auto":{"context_length":1234}},"key_env":"KEEP"}},"other":{"keep":true}}`, false},
		{"harness", "harness", `{"providers":{"custom":{"models":[{"id":"auto","context_length":1234},"other"]}},"other":{"keep":true}}`, false},
		{"legacy", "harness", `{"custom_providers":[{"name":"custom","models":{"auto":{"context_length":1234}}}],"other":{"keep":true}}`, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			bin := filepath.Join(root, "bin")
			pkg := filepath.Join(root, "hermes_cli")
			for _, dir := range []string{bin, pkg} {
				if err := os.MkdirAll(dir, 0700); err != nil {
					t.Fatal(err)
				}
			}
			if err := os.Symlink(python, filepath.Join(bin, "python3")); err != nil {
				t.Fatal(err)
			}
			files := map[string]string{
				filepath.Join(root, "config.json"): tc.config,
				filepath.Join(pkg, "__init__.py"):  "",
				filepath.Join(pkg, "config.py"): `import json, os
from pathlib import Path
path = Path(os.environ["HERMES_HOME"]) / "config.json"
def load_config(): return json.loads(path.read_text())
def save_config(config): path.write_text(json.dumps(config))
`,
				filepath.Join(bin, tc.cli): "#!/bin/bash\nprintf '%s\\n' '{\"data\":{\"provider\":\"custom\",\"model\":\"auto\"}}'\n",
			}
			for path, contents := range files {
				if err := os.WriteFile(path, []byte(contents), 0700); err != nil {
					t.Fatal(err)
				}
			}
			cmd := exec.Command("/bin/bash", "-c", renderHermesModelCommand("auto", "custom", "https://gateway.test/v1", "test-key", "openai", tc.restart))
			cmd.Env = append(os.Environ(), "PATH="+bin, "HERMES_HOME="+root, "PYTHONPATH="+root)
			// Run twice to verify that applying the capability is idempotent.
			for i := 0; i < 2; i++ {
				if out, err := cmd.CombinedOutput(); err != nil {
					t.Fatalf("command failed: %v: %s", err, out)
				}
				cmd = exec.Command("/bin/bash", "-c", renderHermesModelCommand("auto", "custom", "https://gateway.test/v1", "test-key", "openai", tc.restart))
				cmd.Env = append(os.Environ(), "PATH="+bin, "HERMES_HOME="+root, "PYTHONPATH="+root)
			}
			data, err := os.ReadFile(filepath.Join(root, "config.json"))
			if err != nil {
				t.Fatal(err)
			}
			var cfg map[string]any
			if err := json.Unmarshal(data, &cfg); err != nil {
				t.Fatal(err)
			}
			var provider map[string]any
			if providers, ok := cfg["providers"].(map[string]any); ok {
				provider = providers["custom"].(map[string]any)
			} else {
				provider = cfg["custom_providers"].([]any)[0].(map[string]any)
			}
			meta := provider["models"].(map[string]any)["auto"].(map[string]any)
			if meta["supports_vision"] != true || meta["context_length"] != float64(1234) || cfg["other"].(map[string]any)["keep"] != true {
				t.Fatalf("capability merge lost metadata: %s", data)
			}
		})
	}
}

func TestPlatformAutoVisionScope(t *testing.T) {
	for _, tc := range []struct{ model, provider string }{{"kimi-k2.5", "custom"}, {"auto", "user-provider"}} {
		if strings.Contains(renderHermesModelSetCommand(tc.model, tc.provider, "https://gateway.test/v1", "test-key", "openai"), "supports_vision") {
			t.Fatalf("declared vision for unrelated route %s/%s", tc.provider, tc.model)
		}
	}
}
