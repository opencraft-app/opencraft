package crypto

import (
	"testing"
)

func TestEncryptDecryptRoundtrip(t *testing.T) {
	key := []byte("01234567890123456789012345678901") // 32 bytes
	plaintext := "super-secret-api-key-sk-1234567890"

	ciphertext, err := Encrypt(plaintext, key)
	if err != nil {
		t.Fatalf("Encrypt failed: %v", err)
	}

	if ciphertext == plaintext {
		t.Fatal("ciphertext should differ from plaintext")
	}

	decrypted, err := Decrypt(ciphertext, key)
	if err != nil {
		t.Fatalf("Decrypt failed: %v", err)
	}

	if decrypted != plaintext {
		t.Errorf("roundtrip mismatch: got %q, want %q", decrypted, plaintext)
	}
}

func TestEncryptProducesDifferentCiphertexts(t *testing.T) {
	key := []byte("01234567890123456789012345678901")
	plaintext := "same-input"

	c1, err := Encrypt(plaintext, key)
	if err != nil {
		t.Fatalf("Encrypt 1 failed: %v", err)
	}
	c2, err := Encrypt(plaintext, key)
	if err != nil {
		t.Fatalf("Encrypt 2 failed: %v", err)
	}

	if c1 == c2 {
		t.Error("two encryptions of the same plaintext should produce different ciphertexts (random nonce)")
	}
}

func TestDecryptWithWrongKeyFails(t *testing.T) {
	keyA := []byte("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
	keyB := []byte("BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB")
	plaintext := "sensitive-data"

	ciphertext, err := Encrypt(plaintext, keyA)
	if err != nil {
		t.Fatalf("Encrypt failed: %v", err)
	}

	_, err = Decrypt(ciphertext, keyB)
	if err == nil {
		t.Fatal("expected error when decrypting with wrong key")
	}
}

func TestEncryptEmptyPlaintext(t *testing.T) {
	key := []byte("01234567890123456789012345678901")

	ciphertext, err := Encrypt("", key)
	if err != nil {
		t.Fatalf("Encrypt empty plaintext failed: %v", err)
	}

	decrypted, err := Decrypt(ciphertext, key)
	if err != nil {
		t.Fatalf("Decrypt empty plaintext failed: %v", err)
	}

	if decrypted != "" {
		t.Errorf("expected empty string, got %q", decrypted)
	}
}

func TestEncryptInvalidKeyLength(t *testing.T) {
	shortKey := []byte("too-short")

	_, err := Encrypt("data", shortKey)
	if err == nil {
		t.Fatal("expected error for invalid key length")
	}
}

func TestDecryptKeyRotation(t *testing.T) {
	oldKey := []byte("OLDKEYOLDKEYOLDKEYOLDKEYOLDKEYOL") // 32 bytes
	newKey := []byte("NEWKEYNEWKEYNEWKEYNEWKEYNEWKEYNO") // 32 bytes

	// Encrypt with old key
	ciphertext, err := Encrypt("rotating-secret", oldKey)
	if err != nil {
		t.Fatalf("Encrypt failed: %v", err)
	}

	// Decrypt trying new key first, then old key
	decrypted, err := DecryptWithRotation(ciphertext, newKey, oldKey)
	if err != nil {
		t.Fatalf("DecryptWithRotation failed: %v", err)
	}

	if decrypted != "rotating-secret" {
		t.Errorf("expected 'rotating-secret', got %q", decrypted)
	}
}

func TestDecryptInvalidCiphertext(t *testing.T) {
	key := []byte("01234567890123456789012345678901")

	_, err := Decrypt("not-valid-base64!!!", key)
	if err == nil {
		t.Fatal("expected error for invalid ciphertext")
	}
}
