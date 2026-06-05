//go:build nocos

package object

import "fmt"

func newCOS(endpoint, accessKey, secretKey, token string) (ObjectStorage, error) {
	return nil, fmt.Errorf("cos is disabled by the nocos build tag")
}
