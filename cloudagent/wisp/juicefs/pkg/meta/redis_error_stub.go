//go:build noredis

package meta

func isRedisNil(error) bool {
	return false
}
