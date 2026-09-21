package computerrelease

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
)

// SigningKeyConfig 指定一个已存在且仅当前用户可访问的密钥目录中的两个新文件。
type SigningKeyConfig struct {
	KeyID          string
	PrivateKeyFile string
	PublicKeyFile  string
}

// SigningKeyResult 只返回非敏感发布元数据。
type SigningKeyResult struct {
	KeyID           string
	PrivateKeyFile  string
	PublicKeyFile   string
	PublicKeySHA256 [32]byte
}

// GenerateSigningKey 生成不可覆盖的 Ed25519 发布密钥对。
func GenerateSigningKey(config SigningKeyConfig) (SigningKeyResult, error) {
	privatePath := filepath.Clean(config.PrivateKeyFile)
	publicPath := filepath.Clean(config.PublicKeyFile)
	if !validComponent(config.KeyID) || !filepath.IsAbs(privatePath) ||
		!filepath.IsAbs(publicPath) || privatePath == publicPath ||
		filepath.Dir(privatePath) != filepath.Dir(publicPath) {
		return SigningKeyResult{}, errors.New("Computer release signing key 配置无效")
	}
	parentInfo, err := os.Lstat(filepath.Dir(privatePath))
	if err != nil || !parentInfo.IsDir() || parentInfo.Mode()&os.ModeSymlink != 0 ||
		parentInfo.Mode().Perm()&0o077 != 0 {
		return SigningKeyResult{}, errors.New("Computer release signing key 目录不安全")
	}
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return SigningKeyResult{}, errors.New("无法生成 Computer release signing key")
	}
	defer wipeSigningKey(privateKey)
	privateContent := append(
		[]byte(base64.RawStdEncoding.EncodeToString(privateKey)), '\n',
	)
	defer wipeSigningKey(privateContent)
	publicContent := append(
		[]byte(base64.RawStdEncoding.EncodeToString(publicKey)), '\n',
	)
	if err := writeSigningKeyExclusive(privatePath, privateContent, 0o600); err != nil {
		return SigningKeyResult{}, errors.New("无法写入 Computer release private key")
	}
	if err := writeSigningKeyExclusive(publicPath, publicContent, 0o644); err != nil {
		_ = os.Remove(privatePath)
		return SigningKeyResult{}, errors.New("无法写入 Computer release public key")
	}
	return SigningKeyResult{
		KeyID: config.KeyID, PrivateKeyFile: privatePath, PublicKeyFile: publicPath,
		PublicKeySHA256: sha256.Sum256(publicKey),
	}, nil
}

func writeSigningKeyExclusive(path string, content []byte, mode os.FileMode) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return err
	}
	ok := false
	defer func() {
		_ = file.Close()
		if !ok {
			_ = os.Remove(path)
		}
	}()
	if err := file.Chmod(mode); err != nil {
		return err
	}
	if _, err := file.Write(content); err != nil {
		return err
	}
	if err := file.Sync(); err != nil || file.Close() != nil {
		return errors.New("无法持久化 Computer release signing key")
	}
	ok = true
	return nil
}

func wipeSigningKey(content []byte) {
	for index := range content {
		content[index] = 0
	}
}
