package computerrelease

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"os"
	"path/filepath"
	"testing"
)

func TestVerifyBundleAuthenticatesEveryCatalogArtifact(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	program := filepath.Join(root, "program")
	if err := os.WriteFile(program, []byte("real-program"), 0o700); err != nil {
		t.Fatal(err)
	}
	bundle, err := Build(BuildConfig{
		Version: "0.1.0", Target: "darwin-arm64", OSType: "macos", Architecture: "arm64",
		SigningKeyID: "computer-release-2026-08", PrivateKey: privateKey,
		ProgramPath: program, OutputDirectory: filepath.Join(root, "release"),
	})
	if err != nil {
		t.Fatal(err)
	}
	publicKeyFile := filepath.Join(root, "release.public")
	if err := os.WriteFile(
		publicKeyFile,
		append([]byte(base64.RawStdEncoding.EncodeToString(publicKey)), '\n'),
		0o644,
	); err != nil {
		t.Fatal(err)
	}
	verified, err := VerifyBundle(BundleVerificationConfig{
		Directory: bundleDirectory(bundle), PublicKeyFile: publicKeyFile,
	})
	if err != nil {
		t.Fatal(err)
	}
	if verified != bundle.Release {
		t.Fatalf("verified = %#v, want %#v", verified, bundle.Release)
	}

	if err := os.WriteFile(bundle.InstallerPath, []byte("tampered"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := VerifyBundle(BundleVerificationConfig{
		Directory: bundleDirectory(bundle), PublicKeyFile: publicKeyFile,
	}); err == nil {
		t.Fatal("VerifyBundle() accepted a tampered installer")
	}
}

func TestOpenVerifiedBundleReturnsOnlyAuthenticatedPublishPaths(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	program := filepath.Join(root, "program")
	if err := os.WriteFile(program, []byte("publishable-program"), 0o700); err != nil {
		t.Fatal(err)
	}
	want, err := Build(BuildConfig{
		Version: "0.1.2", Target: "darwin-arm64", OSType: "macos", Architecture: "arm64",
		SigningKeyID: "computer-release-2026-08-http", PrivateKey: privateKey,
		ProgramPath: program, OutputDirectory: filepath.Join(root, "release"),
	})
	if err != nil {
		t.Fatal(err)
	}
	publicKeyFile := filepath.Join(root, "release.public")
	if err := os.WriteFile(
		publicKeyFile,
		append([]byte(base64.RawStdEncoding.EncodeToString(publicKey)), '\n'),
		0o644,
	); err != nil {
		t.Fatal(err)
	}
	got, err := OpenVerifiedBundle(BundleVerificationConfig{
		Directory: bundleDirectory(want), PublicKeyFile: publicKeyFile,
	})
	if err != nil {
		t.Fatal(err)
	}
	if got.Release != want.Release || got.ProgramPath != want.ProgramPath ||
		got.InstallerPath != want.InstallerPath || got.ManifestPath != want.ManifestPath ||
		got.SignaturePath != want.SignaturePath || got.CatalogPath != want.CatalogPath {
		t.Fatalf("opened=%#v want=%#v", got, want)
	}
}

func bundleDirectory(bundle Bundle) string {
	return filepath.Dir(bundle.ManifestPath)
}
