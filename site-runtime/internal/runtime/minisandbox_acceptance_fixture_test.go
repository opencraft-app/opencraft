package runtime

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// This opt-in only emits credential-free source fixtures. It does not call the
// cloud or qualify persistence. The cloud harness must preserve its own ledger.
func TestMinisandboxEmitAcceptanceFixtures(t *testing.T) {
	root := os.Getenv("MINISANDBOX_ACCEPTANCE_FIXTURE_DIR")
	if root == "" {
		t.Skip("explicit source-fixture output required")
	}
	if !filepath.IsAbs(root) {
		t.Fatal("absolute fixture directory required")
	}
	code, err := os.ReadFile("../../../.agents/skills/website-builder/templates/todo-backend.mjs")
	if err != nil {
		t.Fatal(err)
	}
	one := Bundle{Code: string(code), SHA256: sha256Hex(code)}
	two := Bundle{Code: string(code) + "\n// acceptance release two\n"}
	two.SHA256 = sha256Hex([]byte(two.Code))
	site, scope := "ws-minisandbox-20261002", "cn-accept-20261002"
	if configured := os.Getenv("MINISANDBOX_ACCEPTANCE_SCOPE"); configured != "" {
		scope = configured
	}
	if !scopePattern.MatchString(scope) {
		t.Fatal("invalid fixture scope")
	}
	packageIDs := map[string]string{}
	client, _ := newMinisandboxClient("http://127.0.0.1:6688", scope, nil)
	worker, _ := client.workerPath(site)
	object, _ := client.objectPath(site)
	if err = os.MkdirAll(root, 0700); err != nil {
		t.Fatal(err)
	}
	for name, bundles := range map[string]map[string]Bundle{
		"one": {"wr-one": one}, "two": {"wr-one": one, "wr-two": two},
	} {
		p, err := buildMinisandboxPackage(bundles)
		if err != nil {
			t.Fatal(err)
		}
		packageIDs[name] = p.PackageID
		data, err := json.Marshal(p)
		if err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(filepath.Join(root, name+".json"), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	data, _ := json.Marshal(map[string]string{"worker_path": worker, "object_path": object, "site": site, "scope": scope, "sha_one": one.SHA256, "sha_two": two.SHA256, "package_one": packageIDs["one"], "package_two": packageIDs["two"]})
	if err = os.WriteFile(filepath.Join(root, "identity.json"), data, 0600); err != nil {
		t.Fatal(err)
	}
}
