package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
)

// Encrypt encrypts plaintext using AES-256-GCM.
// Key must be exactly 32 bytes. Returns base64-encoded nonce+ciphertext.
func Encrypt(plaintext string, key []byte) (string, error) {
	if len(key) != 32 {
		return "", fmt.Errorf("invalid key length: got %d, want 32", len(key))
	}

	block, err := aes.NewCipher(key)
	if err != nil {
		return "", fmt.Errorf("create cipher: %w", err)
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("create GCM: %w", err)
	}

	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", fmt.Errorf("generate nonce: %w", err)
	}

	// nonce is prepended to ciphertext
	sealed := gcm.Seal(nonce, nonce, []byte(plaintext), nil)
	return base64.StdEncoding.EncodeToString(sealed), nil
}

// Decrypt decrypts a base64-encoded AES-256-GCM ciphertext with the given key.
func Decrypt(encoded string, key []byte) (string, error) {
	if len(key) != 32 {
		return "", fmt.Errorf("invalid key length: got %d, want 32", len(key))
	}

	data, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return "", fmt.Errorf("base64 decode: %w", err)
	}

	block, err := aes.NewCipher(key)
	if err != nil {
		return "", fmt.Errorf("create cipher: %w", err)
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("create GCM: %w", err)
	}

	nonceSize := gcm.NonceSize()
	if len(data) < nonceSize {
		return "", errors.New("ciphertext too short")
	}

	nonce, ciphertext := data[:nonceSize], data[nonceSize:]
	plaintext, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return "", fmt.Errorf("decrypt: %w", err)
	}

	return string(plaintext), nil
}

// DecryptWithRotation tries each key in order until one succeeds.
// Supports key rotation: try new key first, fall back to old key.
func DecryptWithRotation(encoded string, keys ...[]byte) (string, error) {
	var lastErr error
	for _, key := range keys {
		plaintext, err := Decrypt(encoded, key)
		if err == nil {
			return plaintext, nil
		}
		lastErr = err
	}
	return "", fmt.Errorf("all keys failed: %w", lastErr)
}
