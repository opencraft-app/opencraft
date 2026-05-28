//go:build !nogmsm

package meta

import (
	"crypto/cipher"
	"fmt"

	"github.com/emmansun/gmsm/sm3"
	"github.com/emmansun/gmsm/sm4"
	"github.com/juicedata/juicefs/pkg/object"
)

func newGMSMCipher(algo string, key string) (cipher.AEAD, bool, error) {
	if algo != object.SM4GCM {
		return nil, false, nil
	}
	block, err := sm4.NewCipher(sm3.Kdf([]byte(key), 16))
	if err != nil {
		return nil, true, fmt.Errorf("new sm4 cipher: %s", err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, true, fmt.Errorf("new sm4 GCM: %s", err)
	}
	return aead, true, nil
}
