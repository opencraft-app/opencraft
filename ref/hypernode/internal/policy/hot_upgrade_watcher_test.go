package policy

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

type recordingHotUpgradeActivator struct {
	calls     int
	source    []byte
	id        string
	revision  string
	digest    string
	rollbacks []string
	failID    string
}

func (r *recordingHotUpgradeActivator) ActivateHotUpgrade(source []byte, revision, digest string) error {
	return r.ActivateRuntimePlugin(source, "evolution", revision, digest)
}

func (r *recordingHotUpgradeActivator) ActivateRuntimePlugin(source []byte, id, revision, digest string) error {
	r.calls++
	r.source = append([]byte(nil), source...)
	r.id = id
	r.revision = revision
	r.digest = digest
	if id == r.failID {
		return fmt.Errorf("activation failed for %s", id)
	}
	return nil
}

func (r *recordingHotUpgradeActivator) RollbackRuntimePlugin(id string) error {
	r.rollbacks = append(r.rollbacks, id)
	return nil
}

func TestHotUpgradeWatcherVerifiesAndActivatesRelease(t *testing.T) {
	directory := t.TempDir()
	source := []byte(`globalThis.hypernodeHotCandidate = {slot:"evolution",revision:"r1",apply(){}}`)
	digest := sha256.Sum256(source)
	digestText := hex.EncodeToString(digest[:])
	if err := os.WriteFile(filepath.Join(directory, "r1.js"), source, 0o640); err != nil {
		t.Fatal(err)
	}
	recorder := &recordingHotUpgradeActivator{}
	watcher := &HotUpgradeWatcher{Directory: directory, Engine: recorder}
	if err := watcher.activate(HotUpgradeManifest{
		Version: 1, Slot: "evolution", Revision: "r1", Bundle: "r1.js", SHA256: digestText,
	}); err != nil {
		t.Fatal(err)
	}
	if recorder.calls != 1 || recorder.id != "evolution" || recorder.revision != "r1" || recorder.digest != "sha256:"+digestText {
		t.Fatalf("unexpected activation: %#v", recorder)
	}
}

func TestRuntimePluginCatalogActivatesIndependentPluginsAndStopsOnFailure(t *testing.T) {
	directory := t.TempDir()
	manifestFor := func(id string) RuntimePluginManifest {
		source := []byte(`globalThis.hypernodeRuntimePluginCandidate = {id:"` + id + `",revision:"r1",apply(){}}`)
		digest := sha256.Sum256(source)
		bundle := id + ".js"
		if err := os.WriteFile(filepath.Join(directory, bundle), source, 0o640); err != nil {
			t.Fatal(err)
		}
		return RuntimePluginManifest{
			APIVersion: runtimePluginAPI, ID: id, Name: id, Version: "1.0.0",
			Revision: "r1", Bundle: bundle, SHA256: hex.EncodeToString(digest[:]), Enabled: true,
		}
	}
	recorder := &recordingHotUpgradeActivator{failID: "second"}
	watcher := &HotUpgradeWatcher{Directory: directory, Engine: recorder}
	err := watcher.applyCatalog(RuntimePluginCatalog{
		APIVersion: runtimePluginCatalogAPI, Generation: 1,
		Plugins: []RuntimePluginManifest{manifestFor("first"), manifestFor("second")},
	})
	if err == nil {
		t.Fatal("expected catalog activation failure")
	}
	if recorder.calls != 2 || !reflect.DeepEqual(recorder.rollbacks, []string(nil)) {
		t.Fatalf("unexpected catalog behavior: %#v", recorder)
	}
}

func TestRuntimePluginCatalogRejectsDuplicateIDs(t *testing.T) {
	recorder := &recordingHotUpgradeActivator{}
	watcher := &HotUpgradeWatcher{Directory: t.TempDir(), Engine: recorder}
	plugin := RuntimePluginManifest{ID: "duplicate"}
	err := watcher.applyCatalog(RuntimePluginCatalog{
		APIVersion: runtimePluginCatalogAPI, Generation: 1,
		Plugins: []RuntimePluginManifest{plugin, plugin},
	})
	if err == nil || recorder.calls != 0 {
		t.Fatalf("duplicate catalog should fail before activation: err=%v calls=%d", err, recorder.calls)
	}
}

func TestHotUpgradeWatcherRejectsTraversalAndDigestMismatch(t *testing.T) {
	directory := t.TempDir()
	recorder := &recordingHotUpgradeActivator{}
	watcher := &HotUpgradeWatcher{Directory: directory, Engine: recorder}
	if err := watcher.activate(HotUpgradeManifest{
		Version: 1, Slot: "evolution", Revision: "r1", Bundle: "../candidate.js", SHA256: string(make([]byte, 64)),
	}); err == nil {
		t.Fatal("expected path traversal rejection")
	}
	if err := os.WriteFile(filepath.Join(directory, "r1.js"), []byte("candidate"), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := watcher.activate(HotUpgradeManifest{
		Version: 1, Slot: "evolution", Revision: "r1", Bundle: "r1.js", SHA256: string(make([]byte, 64)),
	}); err == nil {
		t.Fatal("expected invalid digest rejection")
	}
	if recorder.calls != 0 {
		t.Fatal("invalid release reached the engine")
	}
}

func TestHotUpgradeManifestShape(t *testing.T) {
	encoded, err := json.Marshal(HotUpgradeManifest{
		Version: 1, Slot: "evolution", Revision: "r1", Bundle: "r1.js", SHA256: "abc",
	})
	if err != nil || string(encoded) == "" {
		t.Fatalf("manifest marshal failed: %v", err)
	}
}
