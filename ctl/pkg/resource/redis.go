// Package resource ...
package resource

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
	"go.uber.org/zap"

	"ctl/pkg/config"
)

// RedisClient 全局 Redis 客户端（主）
var RedisMainClient *redis.Client

// RedisMQClient 全局 Redis 客户端（MQ）
var RedisMQClient *redis.Client

// InitRedis 初始化 Redis 连接
func InitRedis(conf *config.RedisConfig) {
	RedisMainClient = newRedisClient(conf, conf.RWTimeout)
	RedisMQClient = newRedisClient(conf, conf.MQRWTimeout)

	// 验证连接
	ctx := context.Background()
	if err := RedisMainClient.Ping(ctx).Err(); err != nil {
		if ZapLogger != nil {
			ZapLogger.Warn("Redis main client ping failed (may be expected in dev)", zap.Error(err))
		}
	}
}

func newRedisClient(conf *config.RedisConfig, rwTimeout time.Duration) *redis.Client {
	poolSize := conf.PoolSize
	if poolSize <= 0 {
		poolSize = 10
	}
	minIdleConns := conf.MinIdleConns
	if minIdleConns <= 0 {
		minIdleConns = 5
	}

	return redis.NewClient(&redis.Options{
		Addr:         fmt.Sprintf("%s:%d", conf.Host, conf.Port),
		Password:     conf.Pass,
		DB:           0,
		DialTimeout:  conf.ConnectTimeout,
		ReadTimeout:  rwTimeout,
		WriteTimeout: rwTimeout,
		PoolSize:     poolSize,
		MinIdleConns: minIdleConns,
	})
}
