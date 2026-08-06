// Package origin 从 COS 读取站点对象。
package origin

import (
	"context"
	"errors"
	"io"
)

// ErrNotFound 表示对象不存在，调用方据此尝试下一个候选 key 或返回 404。
var ErrNotFound = errors.New("object not found")

// Object 是一次回源的结果。Body 由调用方负责关闭。
type Object struct {
	Body          io.ReadCloser
	ContentType   string
	ContentLength int64
	ETag          string
	LastModified  string
	CacheControl  string
}

// Fetcher 抽象对象读取，便于在不依赖真实 COS 的情况下测试网关逻辑。
type Fetcher interface {
	Get(ctx context.Context, key string) (*Object, error)
}
