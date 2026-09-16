package computerrelease

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"os"
	"path/filepath"
	"testing"
)

func TestGenerateSigningKeyCreatesExclusiveRestrictedKeyPair(t *testing.T) {
	root := t.TempDir()
	if err := os.Chmod(root, 0o700); err != nil {
		t.Fatal(err)
	}
	privateKeyFile := filepath.Join(root, "computer-release.private")
	publicKeyFile := filepath.Join(root, "computer-release.public")
	result, err := GenerateSigningKey(SigningKeyConfig{
		KeyID:          "computer-release-2026-08",
		PrivateKeyFile: privateKeyFile,
		PublicKeyFile:  publicKeyFile,
	})
	if err != nil {
		t.Fatal(err)
	}
	privateInfo, err := os.Lstat(privateKeyFile)
	if err != nil {
		t.Fatal(err)
	}
	publicInfo, err := os.Lstat(publicKeyFile)
	if err != nil {
		t.Fatal(err)
	}
	if !privateInfo.Mode().IsRegular() || privateInfo.Mode().Perm() != 0o600 {
		t.Fatalf("private key mode = %v", privateInfo.Mode())
	}
	if !publicInfo.Mode().IsRegular() || publicInfo.Mode().Perm() != 0o644 {
		t.Fatalf("public key mode = %v", publicInfo.Mode())
	}
	privateEncoded, err := os.ReadFile(privateKeyFile)
	if err != nil {
		t.Fatal(err)
	}
	publicEncoded, err := os.ReadFile(publicKeyFile)
	if err != nil {
		t.Fatal(err)
	}
	privateKey, err := base64.RawStdEncoding.DecodeString(string(bytes.TrimSpace(privateEncoded)))
	if err != nil || len(privateKey) != ed25519.PrivateKeySize {
		t.Fatalf("private key decode = %d, %v", len(privateKey), err)
	}
	publicKey, err := base64.RawStdEncoding.DecodeString(string(bytes.TrimSpace(publicEncoded)))
	if err != nil || len(publicKey) != ed25519.PublicKeySize {
		t.Fatalf("public key decode = %d, %v", len(publicKey), err)
	}
	derived := ed25519.PrivateKey(privateKey).Public().(ed25519.PublicKey)
	if !bytes.Equal(derived, publicKey) {
		t.Fatal("public key does not match private key")
	}
	wantFingerprint := sha256.Sum256(publicKey)
	if result.KeyID != "computer-release-2026-08" ||
		result.PublicKeySHA256 != wantFingerprint {
		t.Fatalf("result = %#v", result)
	}

	if _, err := GenerateSigningKey(SigningKeyConfig{
		KeyID:          "computer-release-2026-08",
		PrivateKeyFile: privateKeyFile,
		PublicKeyFile:  publicKeyFile,
	}); err == nil {
		t.Fatal("GenerateSigningKey() overwrote an existing key pair")
	}
}

func TestGenerateSigningKeyRejectsRelativeAndAliasedPaths(t *testing.T) {
	root := t.TempDir()
	if err := os.Chmod(root, 0o700); err != nil {
		t.Fatal(err)
	}
	privateKeyFile := filepath.Join(root, "private")
	publicKeyFile := filepath.Join(root, "public")
	if _, err := GenerateSigningKey(SigningKeyConfig{
		KeyID: "key-1", PrivateKeyFile: "relative", PublicKeyFile: publicKeyFile,
	}); err == nil {
		t.Fatal("GenerateSigningKey() accepted a relative private key path")
	}
	if _, err := GenerateSigningKey(SigningKeyConfig{
		KeyID: "key-1", PrivateKeyFile: privateKeyFile, PublicKeyFile: privateKeyFile,
	}); err == nil {
		t.Fatal("GenerateSigningKey() accepted the same private and public path")
	}
}
