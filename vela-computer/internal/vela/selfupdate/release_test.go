package selfupdate

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

type testArtifact struct {
	ObjectKey string `json:"objectKey"`
	SHA256    string `json:"sha256"`
	Size      int64  `json:"size"`
}

type testCatalogTarget struct {
	Target       string       `json:"target"`
	OSType       string       `json:"osType"`
	Architecture string       `json:"architecture"`
	SigningKeyID string       `json:"signingKeyId"`
	Manifest     testArtifact `json:"manifest"`
	Signature    testArtifact `json:"signature"`
	Installer    testArtifact `json:"installer"`
	Program      testArtifact `json:"program"`
}

func TestVerifyReleaseFilesBindsCatalogOfflineSignatureAndProgram(t *testing.T) {
	t.Parallel()
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	program := []byte("linux-v0.1.52-program")
	programDigest := sha256.Sum256(program)
	manifestDocument := struct {
		Schema       string `json:"schema"`
		Version      string `json:"version"`
		Target       string `json:"target"`
		SigningKeyID string `json:"signingKeyId"`
		Files        []struct {
			Name      string `json:"name"`
			ObjectKey string `json:"objectKey"`
			SHA256    string `json:"sha256"`
			Size      int64  `json:"size"`
		} `json:"files"`
	}{
		Schema: "agent-network-computer-release/v1", Version: "v0.1.52",
		Target: "linux-amd64", SigningKeyID: "release-key-2026-08",
	}
	manifestDocument.Files = append(manifestDocument.Files, struct {
		Name      string `json:"name"`
		ObjectKey string `json:"objectKey"`
		SHA256    string `json:"sha256"`
		Size      int64  `json:"size"`
	}{
		Name: "vela-computer", ObjectKey: "computer/releases/v0.1.52/linux-amd64/vela-computer",
		SHA256: hex.EncodeToString(programDigest[:]), Size: int64(len(program)),
	})
	manifest, err := json.Marshal(manifestDocument)
	if err != nil {
		t.Fatal(err)
	}
	manifest = append(manifest, '\n')
	signature := ed25519.Sign(privateKey, manifest)
	manifestDigest := sha256.Sum256(manifest)
	signatureDigest := sha256.Sum256(signature)
	installerDigest := sha256.Sum256([]byte("installer"))
	dummyDigest := sha256.Sum256([]byte("darwin"))
	catalogDocument := struct {
		Schema  string              `json:"schema"`
		Version string              `json:"version"`
		Targets []testCatalogTarget `json:"targets"`
	}{Schema: "agent-network-computer-release-set/v1", Version: "v0.1.52"}
	catalogDocument.Targets = []testCatalogTarget{
		{
			Target: "darwin-arm64", OSType: "macos", Architecture: "arm64", SigningKeyID: "release-key-2026-08",
			Manifest:  testArtifact{ObjectKey: "computer/releases/v0.1.52/darwin-arm64/manifest.json", SHA256: hex.EncodeToString(dummyDigest[:]), Size: 10},
			Signature: testArtifact{ObjectKey: "computer/releases/v0.1.52/darwin-arm64/manifest.sig", SHA256: hex.EncodeToString(dummyDigest[:]), Size: 64},
			Installer: testArtifact{ObjectKey: "computer/releases/v0.1.52/darwin-arm64/install.sh", SHA256: hex.EncodeToString(dummyDigest[:]), Size: 10},
			Program:   testArtifact{ObjectKey: "computer/releases/v0.1.52/darwin-arm64/vela-computer", SHA256: hex.EncodeToString(dummyDigest[:]), Size: 10},
		},
		{
			Target: "linux-amd64", OSType: "linux", Architecture: "amd64", SigningKeyID: "release-key-2026-08",
			Manifest:  testArtifact{ObjectKey: "computer/releases/v0.1.52/linux-amd64/manifest.json", SHA256: hex.EncodeToString(manifestDigest[:]), Size: int64(len(manifest))},
			Signature: testArtifact{ObjectKey: "computer/releases/v0.1.52/linux-amd64/manifest.sig", SHA256: hex.EncodeToString(signatureDigest[:]), Size: int64(len(signature))},
			Installer: testArtifact{ObjectKey: "computer/releases/v0.1.52/linux-amd64/install.sh", SHA256: hex.EncodeToString(installerDigest[:]), Size: 9},
			Program:   testArtifact{ObjectKey: "computer/releases/v0.1.52/linux-amd64/vela-computer", SHA256: hex.EncodeToString(programDigest[:]), Size: int64(len(program))},
		},
	}
	catalog, err := json.Marshal(catalogDocument)
	if err != nil {
		t.Fatal(err)
	}
	catalog = append(catalog, '\n')
	paths := ReleasePaths{
		Catalog:           filepath.Join(root, "release.catalog.json"),
		Manifest:          filepath.Join(root, "manifest.json"),
		ManifestSignature: filepath.Join(root, "manifest.sig"),
		Program:           filepath.Join(root, "vela-computer"),
	}
	for path, content := range map[string][]byte{
		paths.Catalog: catalog, paths.Manifest: manifest,
		paths.ManifestSignature: signature, paths.Program: program,
	} {
		if err := os.WriteFile(path, content, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	verified, err := VerifyReleaseFiles(VerifyReleaseFilesConfig{
		Channel: VerifiedChannel{Descriptor: ChannelDescriptor{
			SchemaVersion: 1, Channel: "stable", Target: "linux-amd64", Sequence: 7,
			ExpectedVersion: "v0.1.52", CatalogSHA256: sha256.Sum256(catalog),
		}},
		Paths:             paths,
		ReleasePublicKeys: map[string]ed25519.PublicKey{"release-key-2026-08": publicKey},
	})
	if err != nil {
		t.Fatal(err)
	}
	if verified.Version != "v0.1.52" || verified.Target != "linux-amd64" ||
		verified.ProgramSHA256 != programDigest || verified.ProgramSize != int64(len(program)) {
		t.Fatalf("verified release = %#v", verified)
	}
	if err := os.WriteFile(paths.Program, []byte("tampered"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := VerifyReleaseFiles(VerifyReleaseFilesConfig{
		Channel: VerifiedChannel{Descriptor: ChannelDescriptor{
			SchemaVersion: 1, Channel: "stable", Target: "linux-amd64", Sequence: 7,
			ExpectedVersion: "v0.1.52", CatalogSHA256: sha256.Sum256(catalog),
		}},
		Paths:             paths,
		ReleasePublicKeys: map[string]ed25519.PublicKey{"release-key-2026-08": publicKey},
	}); err == nil {
		t.Fatal("tampered program was accepted")
	}
}
