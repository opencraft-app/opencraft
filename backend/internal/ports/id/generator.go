// Package id 定义应用层可替换的逻辑 ID 生成器。
package id

import systemid "chatserver/internal/id"

// Generator 生成全局唯一逻辑 ID。
type Generator interface {
	New() (string, error)
}

// UUIDv7 使用平台统一的 UUIDv7 生成器。
type UUIDv7 struct{}

// New 生成 RFC 9562 UUIDv7。
func (UUIDv7) New() (string, error) {
	return systemid.New()
}
