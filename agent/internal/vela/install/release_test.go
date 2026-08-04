package install

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"

	"github.com/QuantumNous/new-api/common"
)

func TestVerifyReleaseAuthenticatesCanonicalGoClientArtifact(t *testing.T) {
	t.Parallel()

	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	programPath := filepath.Join(root, ProgramName)
	program := []byte("go-client-computer")
	if err := os.WriteFile(programPath, program, 0o700); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(program)
	manifest, err := common.Marshal(map[string]any{
		"schema":       ManifestSchema,
		"version":      "0.2.0",
		"target":       "darwin-arm64",
		"signingKeyId": "key-2026-08",
		"files": []map[string]any{{
			"name":      ProgramName,
			"objectKey": "computer/releases/0.2.0/darwin-arm64/" + ProgramName,
			"sha256":    hex.EncodeToString(digest[:]),
			"size":      len(program),
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	manifest = append(manifest, '\n')
	manifestPath := filepath.Join(root, "manifest.json")
	signaturePath := filepath.Join(root, "manifest.sig")
	if err := os.WriteFile(manifestPath, manifest, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(signaturePath, ed25519.Sign(privateKey, manifest), 0o600); err != nil {
		t.Fatal(err)
	}

	release, err := VerifyRelease(VerifyConfig{
		ManifestPath:  manifestPath,
		SignaturePath: signaturePath,
		ProgramPath:   programPath,
		PublicKey:     base64.RawStdEncoding.EncodeToString(publicKey),
		Version:       "0.2.0",
		Target:        "darwin-arm64",
	})
	if err != nil {
		t.Fatal(err)
	}
	if release.ProgramSHA256 != digest || release.ProgramSize != int64(len(program)) ||
		release.ProgramObject != "computer/releases/0.2.0/darwin-arm64/"+ProgramName {
		t.Fatalf("release = %#v", release)
	}

	if err := os.WriteFile(programPath, []byte("tampered"), 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := VerifyRelease(VerifyConfig{
		ManifestPath:  manifestPath,
		SignaturePath: signaturePath,
		ProgramPath:   programPath,
		PublicKey:     base64.RawStdEncoding.EncodeToString(publicKey),
		Version:       "0.2.0",
		Target:        "darwin-arm64",
	}); err == nil {
		t.Fatal("VerifyRelease accepted a tampered program")
	}
}
