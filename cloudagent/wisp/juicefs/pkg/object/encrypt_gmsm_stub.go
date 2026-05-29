//go:build !noobjectencrypt && nogmsm

package object

import (
	"crypto/x509"
	"fmt"
)

func parsePKCS8PrivateKey(der []byte) (any, error) {
	return x509.ParsePKCS8PrivateKey(der)
}

func parsePKCS8PrivateKeyWithPassphrase([]byte, []byte) (any, error) {
	return nil, fmt.Errorf("encrypted PKCS#8/SM2 support is disabled by the nogmsm build tag")
}

func newGMSMKeyEncryptor(any) (Encryptor, bool) {
	return nil, false
}

func newSM4DataEncryptor(Encryptor) (Encryptor, error) {
	return nil, fmt.Errorf("%s is disabled by the nogmsm build tag", SM4GCM)
}
