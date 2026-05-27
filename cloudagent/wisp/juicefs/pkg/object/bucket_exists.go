package object

import "strings"

func isExists(err error) bool {
	msg := err.Error()
	return strings.Contains(msg, "BucketAlreadyExists") || strings.Contains(msg, "BucketAlreadyOwnedByYou")
}
