//go:build nogmsm

package meta

import (
	"crypto/cipher"
	"fmt"

	"github.com/juicedata/juicefs/pkg/object"
)

func newGMSMCipher(algo string, key string) (cipher.AEAD, bool, error) {
	if algo != object.SM4GCM {
		return nil, false, nil
	}
	return nil, true, fmt.Errorf("%s is disabled by the nogmsm build tag", object.SM4GCM)
}
