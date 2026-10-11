package computerupdate

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func TestStoreFencesSecondWriterAndPersistsAtomicPromotion(t *testing.T) {
	t.Parallel()
	root := filepath.Join(t.TempDir(), "computer-update")
	store, err := OpenStore(context.Background(), root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := OpenStore(context.Background(), root); !errors.Is(err, ErrStoreInUse) {
		t.Fatalf("second OpenStore() error = %v", err)
	}
	privateKey := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{0x11}, ed25519.SeedSize))
	now := time.Date(2026, 8, 17, 15, 0, 0, 0, time.UTC)
	digest := bytes.Repeat([]byte{0xaa}, 32)
	signed := make(map[string]SignedDescriptor, 2)
	for _, target := range []string{"darwin-arm64", "linux-amd64"} {
		value, err := SignDescriptor(ChannelDescriptor{
			SchemaVersion: 1, Channel: "canary", Target: target,
			Sequence: 1, ExpectedVersion: "v0.1.51",
			CatalogSHA256: digest, IssuedAt: now,
		}, "channel-key-1", privateKey)
		if err != nil {
			t.Fatal(err)
		}
		signed[target] = value
	}
	commit := ChannelCommit{
		Channel: "canary", ExpectedSequence: 0,
		Version: "v0.1.51", CatalogSHA256: digest,
		IssuedAt: now, Signed: signed,
		AuditID:             "0198ff01-0001-7000-8000-000000000001",
		OperatorFingerprint: bytes.Repeat([]byte{0xbb}, 32),
	}
	views, err := store.Commit(commit)
	if err != nil {
		t.Fatal(err)
	}
	if len(views) != 2 || views[0].Sequence != 1 || views[1].Sequence != 1 {
		t.Fatalf("Commit() views = %#v", views)
	}
	before, err := store.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Commit(commit); !errors.Is(err, ErrRevisionConflict) {
		t.Fatalf("stale Commit() error = %v", err)
	}
	after, err := store.Snapshot()
	if err != nil || !reflect.DeepEqual(before, after) {
		t.Fatalf("stale commit changed state: before=%#v after=%#v err=%v", before, after, err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := OpenStore(context.Background(), root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = reopened.Close() })
	persisted, err := reopened.Snapshot()
	if err != nil || persisted.Channels["canary"]["linux-amd64"].Sequence != 1 ||
		len(persisted.Audit) != 1 ||
		persisted.Audit[0].OperatorFingerprint !=
			"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" {
		t.Fatalf("reopened snapshot = %#v err=%v", persisted, err)
	}
}

func TestStoreRejectsUnsafeRootAndCorruptState(t *testing.T) {
	t.Parallel()
	unsafeRoot := filepath.Join(t.TempDir(), "unsafe")
	if err := os.Mkdir(unsafeRoot, 0o777); err != nil {
		t.Fatal(err)
	}
	if _, err := OpenStore(context.Background(), unsafeRoot); !errors.Is(err, ErrUnsafeStore) {
		t.Fatalf("unsafe OpenStore() error = %v", err)
	}

	root := filepath.Join(t.TempDir(), "corrupt")
	if err := os.Mkdir(root, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "channels.json"), []byte(`{"schemaVersion":2}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := OpenStore(context.Background(), root); !errors.Is(err, ErrCorruptStore) {
		t.Fatalf("corrupt OpenStore() error = %v", err)
	}
}
