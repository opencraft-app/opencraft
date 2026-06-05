//go:build !noobjectencrypt && !nogmsm

package object

import (
	"crypto/cipher"
	"crypto/rand"

	"github.com/emmansun/gmsm/pkcs8"
	"github.com/emmansun/gmsm/sm2"
	"github.com/emmansun/gmsm/sm4"
)

func parsePKCS8PrivateKey(der []byte) (any, error) {
	return pkcs8.ParsePKCS8PrivateKey(der)
}

func parsePKCS8PrivateKeyWithPassphrase(der []byte, passphrase []byte) (any, error) {
	return pkcs8.ParsePKCS8PrivateKey(der, passphrase)
}

type sm2Encryptor struct {
	privKey *sm2.PrivateKey
}

func NewSM2Encryptor(privKey *sm2.PrivateKey) Encryptor {
	return &sm2Encryptor{privKey}
}

func (e *sm2Encryptor) Encrypt(plaintext []byte) ([]byte, error) {
	return sm2.EncryptASN1(rand.Reader, &e.privKey.PublicKey, plaintext)
}

func (e *sm2Encryptor) Decrypt(ciphertext []byte) ([]byte, error) {
	return sm2.Decrypt(e.privKey, ciphertext)
}

func newGMSMKeyEncryptor(privKey any) (Encryptor, bool) {
	key, ok := privKey.(*sm2.PrivateKey)
	if !ok {
		return nil, false
	}
	return NewSM2Encryptor(key), true
}

func newSM4DataEncryptor(keyEncryptor Encryptor) (Encryptor, error) {
	// TODO: support other modes?
	// GCM not in [GB/T 17964-2021](http://c.gb688.cn/bzgk/gb/showGb?type=online&hcno=4F89D833626340B1F71068D25EAC737D)
	aead := func(key []byte) (cipher.AEAD, error) {
		block, err := sm4.NewCipher(key)
		if err != nil {
			return nil, err
		}
		return cipher.NewGCM(block)
	}
	return &dataEncryptor{keyEncryptor, 16, aead}, nil
}
