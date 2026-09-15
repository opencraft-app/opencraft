package policy

import (
	"path/filepath"
	"runtime"
	"testing"
)

func defaultPolicyPath(t *testing.T) string {
	t.Helper()
	_, filename, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("could not locate policy test")
	}
	return filepath.Join(filepath.Dir(filename), "..", "..", "policy", "default.js")
}

func TestHotUpgradeActivatesAndRollsBackInsideStablePolicyRuntime(t *testing.T) {
	engine, err := NewWithStoreConfig(defaultPolicyPath(t), "", newMemoryStore(), RuntimeConfig{
		AuthenticationMode: "debug",
		UsersRoot:          t.TempDir(),
	})
	if err != nil {
		t.Fatal(err)
	}
	defer engine.Close()
	stableRuntime := engine.vm
	stableHost := engine.host

	source := []byte(`
globalThis.hypernodeHotCandidate = {
  slot: "evolution",
  revision: "test-r1",
  apply(ctx) {
    ctx.effect(() => {
      globalThis.__hotUpgradeSentinel = "test-r1";
      return () => { globalThis.__hotUpgradeSentinel = "disposed"; };
    });
  },
};`)
	if err := engine.ActivateHotUpgrade(source, "test-r1", "sha256:test"); err != nil {
		t.Fatal(err)
	}
	if engine.vm != stableRuntime || engine.host != stableHost {
		t.Fatal("hot upgrade replaced the stable VM or host runtime")
	}
	status, err := engine.HotUpgradeStatus()
	if err != nil {
		t.Fatal(err)
	}
	active, _ := status["active"].(map[string]any)
	if active["revision"] != "test-r1" || active["status"] != "active" {
		t.Fatalf("unexpected active revision: %#v", active)
	}
	if err := engine.RollbackHotUpgrade(); err != nil {
		t.Fatal(err)
	}
	status, err = engine.HotUpgradeStatus()
	if err != nil {
		t.Fatal(err)
	}
	active, _ = status["active"].(map[string]any)
	if active["revision"] != "builtin" || active["status"] != "active" {
		t.Fatalf("unexpected rollback revision: %#v", active)
	}
}

func TestHotUpgradeRejectsManifestBundleRevisionMismatch(t *testing.T) {
	engine, err := NewWithStoreConfig(defaultPolicyPath(t), "", newMemoryStore(), RuntimeConfig{
		AuthenticationMode: "debug",
		UsersRoot:          t.TempDir(),
	})
	if err != nil {
		t.Fatal(err)
	}
	defer engine.Close()

	err = engine.ActivateHotUpgrade([]byte(`globalThis.hypernodeHotCandidate = {
  slot: "evolution", revision: "bundle-r1", apply() {}
};`), "manifest-r2", "sha256:test")
	if err == nil {
		t.Fatal("expected a revision mismatch")
	}
}

func TestHotUpgradeActivationFailureRestoresPreviousFiber(t *testing.T) {
	engine, err := NewWithStoreConfig(defaultPolicyPath(t), "", newMemoryStore(), RuntimeConfig{
		AuthenticationMode: "debug",
		UsersRoot:          t.TempDir(),
	})
	if err != nil {
		t.Fatal(err)
	}
	defer engine.Close()

	err = engine.ActivateHotUpgrade([]byte(`globalThis.hypernodeHotCandidate = {
  slot: "evolution",
  revision: "broken-r1",
  apply() { throw new Error("candidate exploded"); },
};`), "broken-r1", "sha256:broken")
	if err == nil {
		t.Fatal("expected candidate activation to fail")
	}
	status, statusErr := engine.HotUpgradeStatus()
	if statusErr != nil {
		t.Fatal(statusErr)
	}
	active, _ := status["active"].(map[string]any)
	if active["revision"] != "builtin" || active["status"] != "active" {
		t.Fatalf("previous fiber was not restored: %#v", active)
	}
}

func TestRuntimePluginsActivateAndRollbackIndependently(t *testing.T) {
	engine, err := NewWithStoreConfig(defaultPolicyPath(t), "", newMemoryStore(), RuntimeConfig{
		AuthenticationMode: "debug",
		UsersRoot:          t.TempDir(),
	})
	if err != nil {
		t.Fatal(err)
	}
	defer engine.Close()

	plugin := func(id, revision, sentinel string) []byte {
		return []byte(`globalThis.hypernodeRuntimePluginCandidate = {
  apiVersion: "hypernode.runtime-plugin/v1",
  id: "` + id + `",
  name: "` + id + `",
  version: "1.0.0",
  revision: "` + revision + `",
  capabilities: ["events"],
  apply(ctx) { ctx.effect(() => { globalThis.` + sentinel + ` = "` + revision + `"; }); },
};`)
	}
	if err := engine.ActivateRuntimePlugin(plugin("alpha", "r1", "__alpha"), "alpha", "r1", "sha256:alpha-r1"); err != nil {
		t.Fatal(err)
	}
	if err := engine.ActivateRuntimePlugin(plugin("beta", "r1", "__beta"), "beta", "r1", "sha256:beta-r1"); err != nil {
		t.Fatal(err)
	}
	if err := engine.ActivateRuntimePlugin(plugin("alpha", "r2", "__alpha"), "alpha", "r2", "sha256:alpha-r2"); err != nil {
		t.Fatal(err)
	}
	if err := engine.RollbackRuntimePlugin("alpha"); err != nil {
		t.Fatal(err)
	}
	status, err := engine.HotUpgradeStatus()
	if err != nil {
		t.Fatal(err)
	}
	plugins, ok := status["plugins"].([]any)
	if !ok || len(plugins) != 3 {
		t.Fatalf("expected builtin plus two independent plugins: %#v", status["plugins"])
	}
	active := map[string]string{}
	for _, raw := range plugins {
		entry, _ := raw.(map[string]any)
		revision, _ := entry["active"].(map[string]any)
		active[entry["id"].(string)] = revision["revision"].(string)
	}
	if active["alpha"] != "r1" || active["beta"] != "r1" || active["evolution"] != "builtin" {
		t.Fatalf("unexpected independent plugin state: %#v", active)
	}
}
