package reactvaxis

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"testing"
	"time"
)

func TestRuntimeAcceptsVersionedVerifiedApplicationBundle(t *testing.T) {
	source := `
globalThis.__velaTui = {
  start() { __velaNative.commit({type: "View", testId: "root"}); },
  dispatch() {},
  resize() {}
};`
	hash := sha256.Sum256([]byte(source))
	runtime, err := NewRuntime(RuntimeConfig{
		Bundle: Bundle{
			Name:     "contract-test",
			Protocol: ProtocolV1,
			SHA256:   hex.EncodeToString(hash[:]),
			Source:   source,
		},
	})
	if err != nil {
		t.Fatalf("NewRuntime() error = %v", err)
	}
	defer runtime.Close()

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	tree, err := runtime.NextCommit(ctx)
	if err != nil {
		t.Fatalf("NextCommit() error = %v", err)
	}
	if tree.Type != "View" || tree.TestID != "root" {
		t.Fatalf("commit = %#v", tree)
	}
}

func TestRuntimeRejectsBundleHashAndProtocolMismatch(t *testing.T) {
	for name, bundle := range map[string]Bundle{
		"hash": {
			Name: "bad-hash", Protocol: ProtocolV1,
			SHA256: "00", Source: "globalThis.__velaTui = {};",
		},
		"protocol": {
			Name: "bad-protocol", Protocol: "reactvaxis/v3",
			SHA256: hashString("globalThis.__velaTui = {};"),
			Source: "globalThis.__velaTui = {};",
		},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := NewRuntime(RuntimeConfig{Bundle: bundle}); err == nil {
				t.Fatal("NewRuntime() error = nil")
			}
		})
	}
}

func TestRuntimeAcceptsV2OnlyWhenBundleSelfDeclaresMatchingProtocol(t *testing.T) {
	source := `
globalThis.__velaTui = {
  protocol: "reactvaxis/v2",
  start() { __velaNative.commit({type: "View", testId: "v2-root"}); },
  dispatch() {},
  resize() {}
};`
	runtime, err := NewRuntime(RuntimeConfig{Bundle: Bundle{
		Name: "v2-contract", Protocol: ProtocolV2,
		SHA256: hashString(source), Source: source,
	}})
	if err != nil {
		t.Fatalf("NewRuntime(v2) error = %v", err)
	}
	defer runtime.Close()

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	tree, err := runtime.NextCommit(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if tree.TestID != "v2-root" {
		t.Fatalf("v2 commit = %#v", tree)
	}
}

func TestRuntimeRejectsV2MissingOrMismatchedSelfDeclaration(t *testing.T) {
	for name, source := range map[string]string{
		"missing":  `globalThis.__velaTui = {start() {}, dispatch() {}, resize() {}};`,
		"mismatch": `globalThis.__velaTui = {protocol: "reactvaxis/v1", start() {}, dispatch() {}, resize() {}};`,
	} {
		t.Run(name, func(t *testing.T) {
			_, err := NewRuntime(RuntimeConfig{Bundle: Bundle{
				Name: "v2-" + name, Protocol: ProtocolV2,
				SHA256: hashString(source), Source: source,
			}})
			if err == nil {
				t.Fatal("NewRuntime(v2 mismatch) error = nil")
			}
		})
	}
}

func hashString(value string) string {
	hash := sha256.Sum256([]byte(value))
	return hex.EncodeToString(hash[:])
}
