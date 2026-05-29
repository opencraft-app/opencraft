//go:build noobjectencrypt

package object

import (
	"context"
	"errors"
	"fmt"
	"io"
)

const (
	AES256GCM_RSA = "aes256gcm-rsa"
	CHACHA20_RSA  = "chacha20-rsa"
	SM4GCM        = "sm4gcm"
)

var errObjectEncryptionDisabled = fmt.Errorf("object encryption is disabled by the noobjectencrypt build tag")

var ErrKeyNeedPasswd = errors.New("passphrase is required to private key")

type Encryptor interface {
	Encrypt(plaintext []byte) ([]byte, error)
	Decrypt(ciphertext []byte) ([]byte, error)
}

type disabledEncryptor struct{}

func (disabledEncryptor) Encrypt([]byte) ([]byte, error) {
	return nil, errObjectEncryptionDisabled
}

func (disabledEncryptor) Decrypt([]byte) ([]byte, error) {
	return nil, errObjectEncryptionDisabled
}

func ExportRsaPrivateKeyToPem(any, string) string {
	return ""
}

func ParsePrivateKeyFromPem([]byte, []byte) (any, error) {
	return nil, errObjectEncryptionDisabled
}

func ParseRsaPrivateKeyFromPath(string, string) (any, error) {
	return nil, errObjectEncryptionDisabled
}

func NewRSAEncryptor(any) Encryptor {
	return disabledEncryptor{}
}

func NewSM2Encryptor(any) Encryptor {
	return disabledEncryptor{}
}

func NewKeyEncryptor(any) Encryptor {
	return disabledEncryptor{}
}

func NewDataEncryptor(Encryptor, string) (Encryptor, error) {
	return nil, errObjectEncryptionDisabled
}

func NewEncrypted(o ObjectStorage, _ Encryptor) ObjectStorage {
	return &encrypted{ObjectStorage: o}
}

type encrypted struct {
	ObjectStorage
}

func (s *encrypted) Get(context.Context, string, int64, int64, ...AttrGetter) (io.ReadCloser, error) {
	return nil, errObjectEncryptionDisabled
}

func (s *encrypted) Put(context.Context, string, io.Reader, ...AttrGetter) error {
	return errObjectEncryptionDisabled
}
