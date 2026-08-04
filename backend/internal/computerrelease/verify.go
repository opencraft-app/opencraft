package computerrelease

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"

	computerport "chatserver/internal/ports/computer"
)

type BundleVerificationConfig struct {
	Directory     string
	PublicKeyFile string
}

// OpenVerifiedBundle 从独立公钥验证现有发布目录，并只返回经过验证的固定发布路径。
func OpenVerifiedBundle(config BundleVerificationConfig) (Bundle, error) {
	release, err := VerifyBundle(config)
	if err != nil {
		return Bundle{}, err
	}
	directory := filepath.Clean(config.Directory)
	return Bundle{
		Release:       release,
		ProgramPath:   filepath.Join(directory, release.Target, "raft-computer-go"),
		InstallerPath: filepath.Join(directory, release.Target, "install.sh"),
		ManifestPath:  filepath.Join(directory, "manifest.json"),
		SignaturePath: filepath.Join(directory, "manifest.sig"),
		CatalogPath:   filepath.Join(directory, "release.catalog.json"),
	}, nil
}

// VerifyBundle 从独立公钥出发验证 catalog、四个制品字节及签名清单。
func VerifyBundle(config BundleVerificationConfig) (computerport.ReleaseBinding, error) {
	directory := filepath.Clean(config.Directory)
	if !filepath.IsAbs(directory) || !filepath.IsAbs(config.PublicKeyFile) {
		return computerport.ReleaseBinding{}, errors.New("Computer release verification 配置无效")
	}
	info, err := os.Lstat(directory)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return computerport.ReleaseBinding{}, errors.New("Computer release verification 目录无效")
	}
	release, err := LoadCatalog(filepath.Join(directory, "release.catalog.json"))
	if err != nil {
		return computerport.ReleaseBinding{}, err
	}
	paths := []struct {
		binding computerport.ArtifactBinding
		path    string
	}{
		{release.Program, filepath.Join(directory, release.Target, "raft-computer-go")},
		{release.Installer, filepath.Join(directory, release.Target, "install.sh")},
		{release.Manifest, filepath.Join(directory, "manifest.json")},
		{release.Signature, filepath.Join(directory, "manifest.sig")},
	}
	for _, artifact := range paths {
		if err := verifyBundleArtifact(artifact.path, artifact.binding); err != nil {
			return computerport.ReleaseBinding{}, err
		}
	}
	publicKey, err := readPublicKey(config.PublicKeyFile)
	if err != nil {
		return computerport.ReleaseBinding{}, err
	}
	if err := verifySignedManifest(directory, publicKey, release); err != nil {
		return computerport.ReleaseBinding{}, errors.New("Computer release bundle 签名验证失败")
	}
	return release, nil
}

func verifySignedManifest(
	directory string,
	publicKey ed25519.PublicKey,
	release computerport.ReleaseBinding,
) error {
	manifest, err := os.ReadFile(filepath.Join(directory, "manifest.json"))
	if err != nil {
		return err
	}
	signature, err := os.ReadFile(filepath.Join(directory, "manifest.sig"))
	if err != nil || len(signature) != ed25519.SignatureSize ||
		!ed25519.Verify(publicKey, manifest, signature) {
		return errors.New("manifest signature invalid")
	}
	var document manifestDocument
	if err := json.Unmarshal(manifest, &document); err != nil ||
		document.Schema != manifestSchema || document.Version != release.Version ||
		document.Target != release.Target || document.SigningKeyID != release.SigningKeyID ||
		len(document.Files) != 1 {
		return errors.New("manifest invalid")
	}
	program := document.Files[0]
	wantObject := "computer/releases/" + release.Version + "/" +
		release.Target + "/raft-computer-go"
	if program.Name != "raft-computer-go" || program.ObjectKey != wantObject ||
		path.Clean(program.ObjectKey) != program.ObjectKey ||
		program.Size != release.Program.Size ||
		strings.ToLower(program.SHA256) != program.SHA256 {
		return errors.New("manifest program invalid")
	}
	digest, err := hex.DecodeString(program.SHA256)
	if err != nil || len(digest) != sha256.Size ||
		subtle.ConstantTimeCompare(digest, release.Program.SHA256[:]) != 1 {
		return errors.New("manifest digest invalid")
	}
	return nil
}

func readPublicKey(filename string) (ed25519.PublicKey, error) {
	info, err := os.Lstat(filename)
	if err != nil || !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > 256 {
		return nil, errors.New("Computer release public key 文件无效")
	}
	content, err := os.ReadFile(filename)
	if err != nil {
		return nil, errors.New("无法读取 Computer release public key")
	}
	decoded, err := base64.RawStdEncoding.Strict().DecodeString(string(bytes.TrimSpace(content)))
	if err != nil || len(decoded) != ed25519.PublicKeySize {
		return nil, errors.New("Computer release public key 无效")
	}
	return ed25519.PublicKey(decoded), nil
}

func verifyBundleArtifact(filename string, binding computerport.ArtifactBinding) error {
	info, err := os.Lstat(filename)
	if err != nil || !info.Mode().IsRegular() || info.Size() != binding.Size {
		return errors.New("Computer release bundle 制品无效")
	}
	file, err := os.Open(filename)
	if err != nil {
		return errors.New("无法读取 Computer release bundle 制品")
	}
	defer file.Close()
	digest := sha256.New()
	written, err := io.Copy(digest, file)
	if err != nil || written != binding.Size ||
		subtle.ConstantTimeCompare(digest.Sum(nil), binding.SHA256[:]) != 1 {
		return errors.New("Computer release bundle 制品摘要无效")
	}
	return nil
}
