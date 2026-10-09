package computerupdate

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"os"
	"path/filepath"
	"testing"

	"chatserver/internal/computerrelease"
)

func TestFilesystemReleaseSourceOpensVerifiedCompleteSet(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	privateKey := ed25519.NewKeyFromSeed(make([]byte, ed25519.SeedSize))
	publicKeyFile := filepath.Join(root, "release.public")
	if err := os.WriteFile(
		publicKeyFile,
		[]byte(base64.RawStdEncoding.EncodeToString(privateKey.Public().(ed25519.PublicKey))),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	macProgram := filepath.Join(root, "mac-program")
	linuxProgram := filepath.Join(root, "linux-program")
	if err := os.WriteFile(macProgram, []byte("mac-v0.1.51"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(linuxProgram, []byte("linux-v0.1.51"), 0o700); err != nil {
		t.Fatal(err)
	}
	releasesRoot := filepath.Join(root, "releases")
	if err := os.Mkdir(releasesRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	output := filepath.Join(releasesRoot, "v0.1.51-build")
	if _, err := computerrelease.BuildReleaseSet(computerrelease.ReleaseSetBuildConfig{
		Version: "v0.1.51", SigningKeyID: "release-key-1",
		PrivateKey: privateKey, OutputDirectory: output,
		Targets: []computerrelease.ReleaseTargetBuildConfig{
			{Target: "darwin-arm64", OSType: "macos", Architecture: "arm64", ProgramPath: macProgram},
			{Target: "linux-amd64", OSType: "linux", Architecture: "amd64", ProgramPath: linuxProgram},
		},
	}); err != nil {
		t.Fatal(err)
	}
	source, err := NewFilesystemReleaseSource(releasesRoot, publicKeyFile)
	if err != nil {
		t.Fatal(err)
	}
	bundle, err := source.Open(context.Background(), "v0.1.51")
	if err != nil {
		t.Fatal(err)
	}
	if bundle.Version != "v0.1.51" || len(bundle.Releases) != 2 ||
		bundle.Catalog.ObjectKey != "computer/releases/v0.1.51/release.catalog.json" ||
		bundle.Catalog.Size <= 0 {
		t.Fatalf("Open() = %#v", bundle)
	}
}
