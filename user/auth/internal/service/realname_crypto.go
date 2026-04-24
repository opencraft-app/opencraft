package service

import (
	"crypto/aes"
	"crypto/cipher"
	cryptorand "crypto/rand"
	"encoding/base64"
	"fmt"
	"io"
	"strings"
)

type AESGCMRealnameCipher struct {
	aead cipher.AEAD
}

func NewAESGCMRealnameCipher(base64Key string) (*AESGCMRealnameCipher, error) {
	key, err := base64.StdEncoding.DecodeString(strings.TrimSpace(base64Key))
	if err != nil {
		return nil, fmt.Errorf("decode realname encryption key: %w", err)
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("create realname cipher: %w", err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("create realname gcm: %w", err)
	}
	return &AESGCMRealnameCipher{aead: aead}, nil
}

func (c *AESGCMRealnameCipher) Encrypt(plaintext string) (string, error) {
	nonce := make([]byte, c.aead.NonceSize())
	if _, err := io.ReadFull(cryptorand.Reader, nonce); err != nil {
		return "", fmt.Errorf("generate realname nonce: %w", err)
	}
	sealed := c.aead.Seal(nonce, nonce, []byte(plaintext), nil)
	return base64.StdEncoding.EncodeToString(sealed), nil
}
