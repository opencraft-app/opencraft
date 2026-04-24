package store

import (
	"context"
	"hash/crc32"
)

type shardContextKey struct{}

type shardConfig struct {
	total int
	index int
}

// WithShard attaches worker shard ownership to the context.
func WithShard(ctx context.Context, total, index int) context.Context {
	if total <= 0 || index < 0 || index >= total {
		return ctx
	}
	return context.WithValue(ctx, shardContextKey{}, shardConfig{
		total: total,
		index: index,
	})
}

// ShardFromContext returns shard metadata when enabled.
func ShardFromContext(ctx context.Context) (total, index int, ok bool) {
	if ctx == nil {
		return 0, 0, false
	}
	cfg, ok := ctx.Value(shardContextKey{}).(shardConfig)
	if !ok || cfg.total <= 0 || cfg.index < 0 || cfg.index >= cfg.total {
		return 0, 0, false
	}
	return cfg.total, cfg.index, true
}

// ShardMatch returns whether an id belongs to a shard.
func ShardMatch(id string, total, index int) bool {
	if total <= 0 || index < 0 || index >= total {
		return true
	}
	return int(crc32.ChecksumIEEE([]byte(id))%uint32(total)) == index
}

func shardFromContext(ctx context.Context) (total, index int, ok bool) {
	return ShardFromContext(ctx)
}

func shardMatch(id string, total, index int) bool {
	return ShardMatch(id, total, index)
}
