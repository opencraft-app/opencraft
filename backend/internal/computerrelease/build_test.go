package computerrelease

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestBuildCreatesSignedImmutableBundleAndLoadableCatalog(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	program := filepath.Join(root, "vela-computer")
	installer := filepath.Join(root, "install.sh")
	if err := os.WriteFile(program, []byte("program-bytes"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(installer, []byte("#!/bin/sh\nexit 0\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	bundle, err := Build(BuildConfig{
		Version: "0.1.0", Target: "darwin-arm64", OSType: "macos", Architecture: "arm64",
		SigningKeyID: "computer-release-2026-01", PrivateKey: privateKey,
		ProgramPath: program, InstallerPath: installer,
		OutputDirectory: filepath.Join(root, "output"),
	})
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := os.ReadFile(bundle.ManifestPath)
	if err != nil {
		t.Fatal(err)
	}
	signature, err := os.ReadFile(bundle.SignaturePath)
	if err != nil {
		t.Fatal(err)
	}
	if !ed25519.Verify(publicKey, manifest, signature) {
		t.Fatal("manifest signature is invalid")
	}
	release, err := LoadCatalog(bundle.CatalogPath)
	if err != nil {
		t.Fatal(err)
	}
	if release != bundle.Release {
		t.Fatalf("catalog release = %#v, bundle = %#v", release, bundle.Release)
	}
	if _, err := Build(BuildConfig{
		Version: "0.1.0", Target: "darwin-arm64", OSType: "macos", Architecture: "arm64",
		SigningKeyID: "computer-release-2026-01", PrivateKey: privateKey,
		ProgramPath: program, InstallerPath: installer,
		OutputDirectory: filepath.Join(root, "output"),
	}); err == nil {
		t.Fatal("Build() overwrote an existing immutable bundle")
	}
}

func TestBuildRendersTrustedInstallerWhenNoInstallerPathIsProvided(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	program := filepath.Join(root, "vela-computer")
	if err := os.WriteFile(program, []byte("program-bytes"), 0o700); err != nil {
		t.Fatal(err)
	}
	bundle, err := Build(BuildConfig{
		Version: "0.2.0", Target: "darwin-arm64", OSType: "macos", Architecture: "arm64",
		SigningKeyID: "computer-release-2026-02", PrivateKey: privateKey,
		ProgramPath: program, OutputDirectory: filepath.Join(root, "output"),
	})
	if err != nil {
		t.Fatal(err)
	}
	installer, err := os.ReadFile(bundle.InstallerPath)
	if err != nil {
		t.Fatal(err)
	}
	checks := []string{
		"#!/bin/sh", "set -eu", "/usr/bin/curl -q", "max-redirs = 1",
		"Authorization: Enrollment", "vela-computer", "--token-file",
		"--manifest-file", "--signature-file", "--signing-public-key",
		base64.RawStdEncoding.EncodeToString(publicKey),
		hex.EncodeToString(bundle.Release.Program.SHA256[:]),
		hex.EncodeToString(bundle.Release.Manifest.SHA256[:]),
		hex.EncodeToString(bundle.Release.Signature.SHA256[:]),
	}
	for _, check := range checks {
		if !bytes.Contains(installer, []byte(check)) {
			t.Fatalf("generated installer missing %q\n%s", check, installer)
		}
	}
	if bytes.Contains(installer, privateKey) || bytes.Contains(installer, []byte("curl | sh")) {
		t.Fatal("generated installer contains private key or pipe execution")
	}
	if bytes.Contains(installer, []byte("${TMPDIR:-/tmp}/")) ||
		!bytes.Contains(installer, []byte("tmp_root=${TMPDIR:-/tmp}")) ||
		!bytes.Contains(installer, []byte("tmp_root=${tmp_root%/}")) {
		t.Fatalf("generated installer does not normalize TMPDIR:\n%s", installer)
	}
}

func TestGeneratedInstallerRequiresExplicitHTTPOptIn(t *testing.T) {
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	program := filepath.Join(root, "vela-computer")
	if err := os.WriteFile(program, []byte("program-bytes"), 0o700); err != nil {
		t.Fatal(err)
	}
	bundle, err := Build(BuildConfig{
		Version: "0.1.2", Target: "darwin-arm64", OSType: "macos", Architecture: "arm64",
		SigningKeyID: "computer-release-2026-08", PrivateKey: privateKey,
		ProgramPath: program, OutputDirectory: filepath.Join(root, "output"),
	})
	if err != nil {
		t.Fatal(err)
	}
	missingToken := filepath.Join(root, "missing-token")
	withoutOptIn := exec.Command(
		"/bin/sh", bundle.InstallerPath,
		"--token-file", missingToken,
		"--platform-url", "http://9.135.236.64",
	)
	output, err := withoutOptIn.CombinedOutput()
	if exitCode(err) != 64 || !strings.Contains(string(output), "平台地址无效") {
		t.Fatalf("HTTP without opt-in exit=%d output=%q err=%v", exitCode(err), output, err)
	}
	withOptIn := exec.Command(
		"/bin/sh", bundle.InstallerPath,
		"--token-file", missingToken,
		"--platform-url", "http://9.135.236.64",
		"--allow-insecure-platform-http",
	)
	output, err = withOptIn.CombinedOutput()
	if exitCode(err) != 66 || !strings.Contains(string(output), "接入凭证文件不存在") {
		t.Fatalf("HTTP with opt-in exit=%d output=%q err=%v", exitCode(err), output, err)
	}
	httpsWithOptIn := exec.Command(
		"/bin/sh", bundle.InstallerPath,
		"--token-file", missingToken,
		"--platform-url", "https://platform.example.com",
		"--allow-insecure-platform-http",
	)
	output, err = httpsWithOptIn.CombinedOutput()
	if exitCode(err) != 64 || !strings.Contains(string(output), "平台地址无效") {
		t.Fatalf("HTTPS with opt-in exit=%d output=%q err=%v", exitCode(err), output, err)
	}
	installer, err := os.ReadFile(bundle.InstallerPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, required := range []string{
		"allowed_protocols='=http,https'",
		`'proto-redir = "=https"'`,
	} {
		if !bytes.Contains(installer, []byte(required)) {
			t.Fatalf("installer missing %q:\n%s", required, installer)
		}
	}
	if bytes.Count(installer, []byte("--allow-insecure-platform-http")) < 2 {
		t.Fatalf("installer does not propagate the HTTP opt-in:\n%s", installer)
	}
}

func exitCode(err error) int {
	if err == nil {
		return 0
	}
	var exitError *exec.ExitError
	if errors.As(err, &exitError) {
		return exitError.ExitCode()
	}
	return -1
}

type recordingPublisher struct {
	keys []string
}

func (publisher *recordingPublisher) PublishFile(
	_ context.Context,
	key string,
	filename string,
	_ string,
	hash [32]byte,
	size int64,
) error {
	bytes, err := os.ReadFile(filename)
	if err != nil {
		return err
	}
	if int64(len(bytes)) != size || sha256.Sum256(bytes) != hash {
		return os.ErrInvalid
	}
	publisher.keys = append(publisher.keys, key)
	return nil
}

func TestPublishUploadsDataBeforeManifestAndSignature(t *testing.T) {
	_, privateKey, _ := ed25519.GenerateKey(rand.Reader)
	root := t.TempDir()
	program := filepath.Join(root, "program")
	installer := filepath.Join(root, "installer")
	_ = os.WriteFile(program, []byte("program"), 0o700)
	_ = os.WriteFile(installer, []byte("installer"), 0o700)
	bundle, err := Build(BuildConfig{
		Version: "0.1.0", Target: "darwin-arm64", OSType: "macos", Architecture: "arm64",
		SigningKeyID: "key-1", PrivateKey: privateKey,
		ProgramPath: program, InstallerPath: installer,
		OutputDirectory: filepath.Join(root, "output"),
	})
	if err != nil {
		t.Fatal(err)
	}
	publisher := &recordingPublisher{}
	if err := Publish(context.Background(), publisher, bundle); err != nil {
		t.Fatal(err)
	}
	want := []string{
		bundle.Release.Program.ObjectKey,
		bundle.Release.Installer.ObjectKey,
		bundle.Release.Manifest.ObjectKey,
		bundle.Release.Signature.ObjectKey,
	}
	for index := range want {
		if publisher.keys[index] != want[index] {
			t.Fatalf("publish order = %v", publisher.keys)
		}
	}
}
