package prodk8s

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestDesiredConfigAgentPlaybookIsSafeAndExecutable(t *testing.T) {
	repoRoot := filepath.Clean(filepath.Join("..", "..", ".."))
	scriptPath := filepath.Join("bootstrap", "import-desired-config.sh")
	playbookPath := filepath.Join("bootstrap", "DESIRED_CONFIG_PLAYBOOK.md")

	if out, err := exec.Command("bash", "-n", scriptPath).CombinedOutput(); err != nil {
		t.Fatalf("bootstrap script syntax: %v\n%s", err, out)
	}
	script, err := os.ReadFile(scriptPath)
	if err != nil {
		t.Fatal(err)
	}
	scriptText := string(script)
	for _, required := range []string{
		"/api/desired-config/import",
		"/api/channel-bundles/${bundle_id_uri}/revisions",
		"/api/channel-bundles/${bundle_id_uri}/releases",
		"stop_on_failure:true",
		"DESIRED_CONFIG_RELEASE",
		"ls-files --error-unmatch",
		"llmgateway.io/v1alpha1",
		"exactly one channel bundle",
	} {
		if !strings.Contains(scriptText, required) {
			t.Fatalf("bootstrap script missing %q", required)
		}
	}
	for _, forbidden := range []string{"set -x", "cat \"${CONFIG_FILE}\"", "cat \"$CONFIG_FILE\""} {
		if strings.Contains(scriptText, forbidden) {
			t.Fatalf("bootstrap script may expose DesiredConfig through %q", forbidden)
		}
	}

	playbook, err := os.ReadFile(playbookPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, required := range []string{
		"private/desired-config.json",
		"LLMGATEWAY_CONTROL_URL",
		"LLMGATEWAY_CONTROL_TOKEN",
		"DESIRED_CONFIG_RELEASE=true",
		"stop_on_failure=true",
		"Admission",
		"不要",
	} {
		if !strings.Contains(string(playbook), required) {
			t.Fatalf("agent playbook missing %q", required)
		}
	}

	privateConfig := filepath.Join("deploy", "k8s", "prod", "bootstrap", "private", "desired-config.json")
	cmd := exec.Command("git", "check-ignore", "-q", "--no-index", privateConfig)
	cmd.Dir = repoRoot
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("private DesiredConfig path is not ignored: %v\n%s", err, out)
	}
}

func TestDesiredConfigBootstrapImportsVerifiesAndExplicitlyReleases(t *testing.T) {
	if _, err := exec.LookPath("jq"); err != nil {
		t.Skip("jq is required by the production bootstrap script")
	}

	const plaintextKey = "sk-bootstrap-must-not-leak"
	releaseCalled := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-admin-token" {
			t.Errorf("unexpected authorization header")
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "POST /api/desired-config/import":
			body, err := io.ReadAll(r.Body)
			if err != nil {
				t.Error(err)
				return
			}
			if !strings.Contains(string(body), plaintextKey) {
				t.Errorf("import body did not carry the plaintext recovery key")
			}
			_, _ = io.WriteString(w, `{"success":true,"data":[{"id":"golden-channels","fingerprint":"fingerprint-1"}]}`)
		case "GET /api/channel-bundles/golden-channels/revisions":
			_, _ = io.WriteString(w, `{"success":true,"data":[{"revision_id":"rev-golden-1","fingerprint":"fingerprint-1","created_at":"2026-07-17T00:00:00Z"}]}`)
		case "POST /api/channel-bundles/golden-channels/releases":
			releaseCalled = true
			var payload struct {
				RevisionID    string   `json:"revision_id"`
				SetIDs        []string `json:"set_ids"`
				ForceDrift    bool     `json:"force_drift"`
				StopOnFailure bool     `json:"stop_on_failure"`
			}
			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
				t.Error(err)
				return
			}
			if payload.RevisionID != "rev-golden-1" || len(payload.SetIDs) != 1 || payload.SetIDs[0] != "set-a" || payload.ForceDrift || !payload.StopOnFailure {
				t.Errorf("unsafe release payload: %+v", payload)
			}
			_, _ = io.WriteString(w, `{"success":true,"data":{"id":"release-1","status":"success"}}`)
		default:
			http.Error(w, "unexpected request", http.StatusNotFound)
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer server.Close()

	configPath := filepath.Join(t.TempDir(), "desired-config.json")
	config := `{
		"api_version":"llmgateway.io/v1alpha1",
		"kind":"DesiredConfig",
		"channel_bundles":[{
			"id":"golden-channels",
			"name":"Production channels",
			"channels":[{
				"id":"provider-1","name":"Provider","type":1,
				"key":"` + plaintextKey + `","base_url":"https://provider.example.com",
				"models":"auto","group":"default","status":"enabled"
			}]
		}]
	}`
	if err := os.WriteFile(configPath, []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}

	cmd := exec.Command("bash", filepath.Join("bootstrap", "import-desired-config.sh"), configPath)
	cmd.Env = append(os.Environ(),
		"LLMGATEWAY_CONTROL_URL="+server.URL,
		"LLMGATEWAY_CONTROL_TOKEN=test-admin-token",
		"DESIRED_CONFIG_RELEASE=true",
		`DESIRED_CONFIG_SET_IDS_JSON=["set-a"]`,
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("bootstrap script failed: %v\n%s", err, out)
	}
	if !releaseCalled {
		t.Fatal("bootstrap did not release the imported revision")
	}
	if strings.Contains(string(out), plaintextKey) {
		t.Fatalf("bootstrap output leaked the provider key: %s", out)
	}
	for _, want := range []string{"bundle=golden-channels", "revision=rev-golden-1", "run=release-1", "status=success", "stop_on_failure=true"} {
		if !strings.Contains(string(out), want) {
			t.Fatalf("bootstrap output missing %q: %s", want, out)
		}
	}
}
