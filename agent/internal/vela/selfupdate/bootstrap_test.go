package selfupdate

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"testing"
)

func TestBootstrapPinsSeparateChannelAndReleaseTrustDomains(t *testing.T) {
	t.Parallel()
	channelKey := bytes.Repeat([]byte{0x31}, ed25519.PublicKeySize)
	releaseKey := bytes.Repeat([]byte{0x42}, ed25519.PublicKeySize)
	resolved, enabled, err := ResolveBootstrap(BootstrapConfig{
		ChannelURL: "https://updates.internal.example", Channel: "stable",
		ChannelKeyID:     "channel-key-2026-08",
		ChannelPublicKey: base64.RawStdEncoding.EncodeToString(channelKey),
		ReleaseKeyID:     "release-key-2026-08",
		ReleasePublicKey: base64.RawStdEncoding.EncodeToString(releaseKey),
	})
	if err != nil || !enabled {
		t.Fatalf("ResolveBootstrap = (%#v, %t, %v)", resolved, enabled, err)
	}
	if !bytes.Equal(resolved.ChannelPublicKey, channelKey) ||
		!bytes.Equal(resolved.ReleasePublicKeys["release-key-2026-08"], releaseKey) {
		t.Fatalf("resolved trust = %#v", resolved)
	}
	if _, enabled, err := ResolveBootstrap(BootstrapConfig{}); err != nil || enabled {
		t.Fatalf("disabled bootstrap = (%t, %v)", enabled, err)
	}
	if _, _, err := ResolveBootstrap(BootstrapConfig{ChannelURL: "https://partial.invalid"}); err == nil {
		t.Fatal("partial trust bootstrap was accepted")
	}
}
