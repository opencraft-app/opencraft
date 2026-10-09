package computerupdate

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"errors"
	"testing"
	"time"

	computerport "chatserver/internal/ports/computer"
)

type fakeReleaseSource struct {
	bundle ReleaseBundle
	err    error
}

func (source fakeReleaseSource) Open(
	context.Context,
	string,
) (ReleaseBundle, error) {
	return source.bundle, source.err
}

type recordingURLSigner struct {
	keys []string
	ttls []time.Duration
}

func (signer *recordingURLSigner) PresignGet(
	_ context.Context,
	key string,
	ttl time.Duration,
) (string, error) {
	signer.keys = append(signer.keys, key)
	signer.ttls = append(signer.ttls, ttl)
	return "https://cos.ap-beijing.myqcloud.com/" + key + "?signature=redacted", nil
}

type fixedUpdateClock struct{ now time.Time }

func (clock fixedUpdateClock) Now() time.Time { return clock.now }

type fixedUpdateIDs struct{ value string }

func (ids fixedUpdateIDs) New() (string, error) { return ids.value, nil }

func TestServicePromotesVerifiedReleaseAndServesSignedChannel(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 8, 17, 15, 30, 0, 0, time.UTC)
	privateKey := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{0x23}, ed25519.SeedSize))
	catalog := []byte(`{"schema":"agent-network-computer-release-set/v1","version":"v0.1.51","targets":[]}`)
	catalogHash := sha256.Sum256(catalog)
	release := func(target string) computerport.ReleaseBinding {
		return computerport.ReleaseBinding{
			Version: "v0.1.51", Target: target,
			OSType:       map[string]string{"darwin-arm64": "macos", "linux-amd64": "linux"}[target],
			Architecture: map[string]string{"darwin-arm64": "arm64", "linux-amd64": "amd64"}[target],
			SigningKeyID: "release-key-1",
			Manifest: computerport.ArtifactBinding{
				ObjectKey: "computer/releases/v0.1.51/" + target + "/manifest.json",
				SHA256:    sha256.Sum256([]byte(target + "-manifest")), Size: 100,
			},
			Signature: computerport.ArtifactBinding{
				ObjectKey: "computer/releases/v0.1.51/" + target + "/manifest.sig",
				SHA256:    sha256.Sum256([]byte(target + "-signature")), Size: 64,
			},
			Program: computerport.ArtifactBinding{
				ObjectKey: "computer/releases/v0.1.51/" + target + "/vela-computer",
				SHA256:    sha256.Sum256([]byte(target + "-program")), Size: 1024,
			},
		}
	}
	bundle := ReleaseBundle{
		Version: "v0.1.51",
		Catalog: computerport.ArtifactBinding{
			ObjectKey: "computer/releases/v0.1.51/release.catalog.json",
			SHA256:    catalogHash, Size: int64(len(catalog)),
		},
		Releases: []computerport.ReleaseBinding{
			release("darwin-arm64"), release("linux-amd64"),
		},
	}
	store, err := OpenStore(context.Background(), t.TempDir()+"/state")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	urlSigner := &recordingURLSigner{}
	service, err := NewService(ServiceConfig{
		Store: store, Releases: fakeReleaseSource{bundle: bundle},
		ChannelKeyID: "channel-key-1", ChannelPrivateKey: privateKey,
		URLs: urlSigner, URLTTL: 5 * time.Minute,
		Clock: fixedUpdateClock{now: now},
		IDs:   fixedUpdateIDs{value: "0198ff01-1000-7000-8000-000000000001"},
	})
	if err != nil {
		t.Fatal(err)
	}
	views, err := service.Promote(context.Background(), PromoteCommand{
		Channel: "canary", ExpectedSequence: 0, Version: "v0.1.51",
		OperatorFingerprint: bytes.Repeat([]byte{0x31}, 32),
	})
	if err != nil || len(views) != 2 {
		t.Fatalf("Promote() = (%#v, %v)", views, err)
	}
	envelope, err := service.GetChannel(
		context.Background(), "canary", "linux-amd64",
	)
	if err != nil {
		t.Fatal(err)
	}
	verified, _, err := VerifySignedDescriptor(
		envelope.Signed,
		map[string]ed25519.PublicKey{
			"channel-key-1": privateKey.Public().(ed25519.PublicKey),
		},
		"canary", "linux-amd64",
	)
	if err != nil || verified.ExpectedVersion != "v0.1.51" ||
		envelope.ETag == "" || envelope.Downloads.ExpiresAt != now.Add(5*time.Minute) {
		t.Fatalf("GetChannel() = (%#v, %v), descriptor=%#v", envelope, err, verified)
	}
	wantKeys := []string{
		"computer/releases/v0.1.51/release.catalog.json",
		"computer/releases/v0.1.51/linux-amd64/manifest.json",
		"computer/releases/v0.1.51/linux-amd64/manifest.sig",
		"computer/releases/v0.1.51/linux-amd64/vela-computer",
	}
	if len(urlSigner.keys) != len(wantKeys) {
		t.Fatalf("presigned keys = %#v", urlSigner.keys)
	}
	for index := range wantKeys {
		if urlSigner.keys[index] != wantKeys[index] ||
			urlSigner.ttls[index] != 5*time.Minute {
			t.Fatalf("presign[%d] = %q %s", index, urlSigner.keys[index], urlSigner.ttls[index])
		}
	}
	if _, err := service.Promote(context.Background(), PromoteCommand{
		Channel: "canary", ExpectedSequence: 0, Version: "v0.1.51",
		OperatorFingerprint: bytes.Repeat([]byte{0x31}, 32),
	}); !errors.Is(err, ErrRevisionConflict) {
		t.Fatalf("stale Promote() error = %v", err)
	}
}

func TestServiceRejectsIncompleteReleaseSet(t *testing.T) {
	t.Parallel()
	store, err := OpenStore(context.Background(), t.TempDir()+"/state")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	privateKey := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{0x24}, ed25519.SeedSize))
	service, err := NewService(ServiceConfig{
		Store: store,
		Releases: fakeReleaseSource{bundle: ReleaseBundle{
			Version: "v0.1.51",
			Releases: []computerport.ReleaseBinding{{
				Version: "v0.1.51", Target: "linux-amd64",
			}},
		}},
		ChannelKeyID: "channel-key-1", ChannelPrivateKey: privateKey,
		URLs: &recordingURLSigner{}, URLTTL: 5 * time.Minute,
		Clock: fixedUpdateClock{now: time.Now().UTC()},
		IDs:   fixedUpdateIDs{value: "0198ff01-1000-7000-8000-000000000001"},
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = service.Promote(context.Background(), PromoteCommand{
		Channel: "stable", ExpectedSequence: 0, Version: "v0.1.51",
		OperatorFingerprint: bytes.Repeat([]byte{0x31}, 32),
	})
	if !errors.Is(err, ErrReleaseIncomplete) {
		t.Fatalf("Promote() error = %v", err)
	}
}
