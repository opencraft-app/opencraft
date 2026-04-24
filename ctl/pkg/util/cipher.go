// Package util ...
package util

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/md5"
	"encoding/base64"
	"encoding/hex"
)

func md5String(data []byte) string {
	h := md5.Sum(data)
	return hex.EncodeToString(h[:])
}

var cipherKey = md5String([]byte("lighthouse"))
var cipherIV = md5String([]byte("lightglobal"))[:aes.BlockSize]

// EncryptString ...
func EncryptString(str string) string {
	encrypted := aesEncrypt([]byte(str), []byte(cipherKey), []byte(cipherIV))
	return base64.StdEncoding.EncodeToString(encrypted)
}

// DecryptString ...
func DecryptString(crypted string) string {
	data, err := base64.StdEncoding.DecodeString(crypted)
	if err != nil {
		return ""
	}
	decrypted := aesDecrypt(data, []byte(cipherKey), []byte(cipherIV))
	return string(decrypted)
}

func aesEncrypt(plaintext, key, iv []byte) []byte {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil
	}
	// PKCS7 padding
	padding := aes.BlockSize - len(plaintext)%aes.BlockSize
	padText := make([]byte, len(plaintext)+padding)
	copy(padText, plaintext)
	for i := len(plaintext); i < len(padText); i++ {
		padText[i] = byte(padding)
	}
	ciphertext := make([]byte, len(padText))
	mode := cipher.NewCBCEncrypter(block, iv)
	mode.CryptBlocks(ciphertext, padText)
	return ciphertext
}

func aesDecrypt(ciphertext, key, iv []byte) []byte {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil
	}
	if len(ciphertext) == 0 || len(ciphertext)%aes.BlockSize != 0 {
		return nil
	}
	plaintext := make([]byte, len(ciphertext))
	mode := cipher.NewCBCDecrypter(block, iv)
	mode.CryptBlocks(plaintext, ciphertext)
	// PKCS7 unpadding
	if len(plaintext) == 0 {
		return nil
	}
	padding := int(plaintext[len(plaintext)-1])
	if padding > aes.BlockSize || padding == 0 {
		return plaintext
	}
	return plaintext[:len(plaintext)-padding]
}
