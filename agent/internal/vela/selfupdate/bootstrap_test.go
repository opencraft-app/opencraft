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

func TestBootstrapAllowsOnlyPinnedDevcloudHTTPWhenBuiltIn(t *testing.T) {
	t.Parallel()
	channelKey := base64.RawStdEncoding.EncodeToString(bytes.Repeat([]byte{0x31}, ed25519.PublicKeySize))
	releaseKey := base64.RawStdEncoding.EncodeToString(bytes.Repeat([]byte{0x42}, ed25519.PublicKeySize))
	base := BootstrapConfig{
		ChannelURL: "http://9.135.236.64", Channel: "stable",
		ChannelKeyID: "channel-key-2026-08", ChannelPublicKey: channelKey,
		ReleaseKeyID: "release-key-2026-08", ReleasePublicKey: releaseKey,
	}
	if _, enabled, err := ResolveBootstrap(BootstrapConfig{AllowInsecureHTTP: true}); err == nil || enabled {
		t.Fatalf("standalone insecure HTTP bit = enabled %t, error %v", enabled, err)
	}
	if _, _, err := ResolveBootstrap(base); err == nil {
		t.Fatal("DevCloud HTTP bootstrap was accepted without the build-time opt-in")
	}
	base.AllowInsecureHTTP = true
	resolved, enabled, err := ResolveBootstrap(base)
	if err != nil || !enabled || !resolved.AllowInsecureHTTP || resolved.ChannelURL != base.ChannelURL {
		t.Fatalf("DevCloud HTTP bootstrap = (%#v, %t, %v)", resolved, enabled, err)
	}
	for _, invalid := range []string{
		"http://9.135.236.65",
		"http://9.135.236.64:80",
		"http://user@9.135.236.64",
		"http://9.135.236.64/computer-releases",
		"http://9.135.236.64?channel=stable",
		"http://9.135.236.64#channel",
	} {
		candidate := base
		candidate.ChannelURL = invalid
		if _, _, err := ResolveBootstrap(candidate); err == nil {
			t.Fatalf("insecure update URL %q was accepted", invalid)
		}
	}
	https := base
	https.ChannelURL = "https://updates.internal.example"
	if _, _, err := ResolveBootstrap(https); err == nil {
		t.Fatal("HTTPS bootstrap retained the insecure HTTP build bit")
	}
}
