//go:build !noredis

package meta

import "github.com/redis/go-redis/v9"

func isRedisNil(err error) bool {
	return err == redis.Nil
}
