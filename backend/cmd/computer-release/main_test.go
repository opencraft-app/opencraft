package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"

	cosadapter "chatserver/internal/adapters/tencent/cos"
	"chatserver/internal/computerrelease"
)

func TestDecodePrivateKeyAcceptsOnlyCanonicalEd25519Size(t *testing.T) {
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	encoded := base64.RawStdEncoding.EncodeToString(privateKey)
	decoded, err := decodePrivateKey([]byte(encoded + "\n"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(decoded, privateKey) {
		t.Fatal("decoded private key differs")
	}
	if _, err := decodePrivateKey([]byte("not-a-private-key")); err == nil {
		t.Fatal("decodePrivateKey() accepted invalid content")
	}
}

func TestRunVerifyAuthenticatesBuiltBundle(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	program := filepath.Join(root, "program")
	if err := os.WriteFile(program, []byte("program"), 0o700); err != nil {
		t.Fatal(err)
	}
	releaseDirectory := filepath.Join(root, "release")
	if _, err := computerrelease.Build(computerrelease.BuildConfig{
		Version: "0.1.0", Target: "darwin-arm64", OSType: "macos", Architecture: "arm64",
		SigningKeyID: "computer-release-2026-08", PrivateKey: privateKey,
		ProgramPath: program, OutputDirectory: releaseDirectory,
	}); err != nil {
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
	var output bytes.Buffer
	if err := runVerify([]string{
		"--release-directory", releaseDirectory,
		"--public-key-file", publicKeyFile,
	}, &output); err != nil {
		t.Fatal(err)
	}
	for _, value := range []string{
		"version=0.1.0", "target=darwin-arm64",
		"signingKeyId=computer-release-2026-08",
	} {
		if !strings.Contains(output.String(), value) {
			t.Fatalf("verify output missing %q: %s", value, output.String())
		}
	}
}

func TestRunKeygenPrintsOnlyNonSensitiveMetadata(t *testing.T) {
	root := t.TempDir()
	if err := os.Chmod(root, 0o700); err != nil {
		t.Fatal(err)
	}
	privateKeyFile := filepath.Join(root, "release.private")
	publicKeyFile := filepath.Join(root, "release.public")
	var output bytes.Buffer
	if err := runKeygen([]string{
		"--key-id", "computer-release-2026-08",
		"--private-key-file", privateKeyFile,
		"--public-key-file", publicKeyFile,
	}, &output); err != nil {
		t.Fatal(err)
	}
	privateKey, err := os.ReadFile(privateKeyFile)
	if err != nil {
		t.Fatal(err)
	}
	text := output.String()
	if strings.Contains(text, strings.TrimSpace(string(privateKey))) {
		t.Fatal("keygen output contains the private key")
	}
	for _, value := range []string{
		"computer-release-2026-08", privateKeyFile, publicKeyFile,
		"publicKeySHA256",
	} {
		if !strings.Contains(text, value) {
			t.Fatalf("keygen output missing %q: %s", value, text)
		}
	}
}

type fakeExistingBundlePublisher struct {
	keys []string
}

func (publisher *fakeExistingBundlePublisher) PublishFile(
	_ context.Context,
	key string,
	_ string,
	_ string,
	_ [sha256.Size]byte,
	_ int64,
) error {
	publisher.keys = append(publisher.keys, key)
	return nil
}

func TestRunPublishVerifiesExistingBundleWithoutPrivateKey(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	program := filepath.Join(root, "program")
	if err := os.WriteFile(program, []byte("publish-program"), 0o700); err != nil {
		t.Fatal(err)
	}
	bundle, err := computerrelease.Build(computerrelease.BuildConfig{
		Version: "0.1.2", Target: "darwin-arm64", OSType: "macos", Architecture: "arm64",
		SigningKeyID: "computer-release-http", PrivateKey: privateKey,
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
	secretIDFile := writeReleaseSecret(t, root, "secret-id", "test-secret-id")
	secretKeyFile := writeReleaseSecret(t, root, "secret-key", "test-secret-key")
	publisher := &fakeExistingBundlePublisher{}
	factoryCalls := 0
	var output bytes.Buffer
	err = runPublish(context.Background(), []string{
		"--release-directory", filepath.Dir(bundle.ManifestPath),
		"--public-key-file", publicKeyFile,
		"--bucket", "computer-test-1250000000",
		"--region", "ap-beijing",
		"--secret-id-file", secretIDFile,
		"--secret-key-file", secretKeyFile,
	}, &output, func(config cosadapter.Config) (computerrelease.ObjectPublisher, error) {
		factoryCalls++
		if config.SecretID != "test-secret-id" || config.SecretKey != "test-secret-key" {
			t.Fatalf("publisher config = %#v", config)
		}
		return publisher, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if factoryCalls != 1 || len(publisher.keys) != 4 ||
		!strings.Contains(output.String(), "published version=0.1.2 target=darwin-arm64") ||
		strings.Contains(output.String(), "test-secret") {
		t.Fatalf("publish calls=%d keys=%v output=%q", factoryCalls, publisher.keys, output.String())
	}
}

func writeReleaseSecret(t *testing.T, root string, name string, value string) string {
	t.Helper()
	filename := filepath.Join(root, name)
	if err := os.WriteFile(filename, []byte(value+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return filename
}
