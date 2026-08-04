// Package id 生成 Chatserver 全局唯一逻辑 ID。
package id

import "github.com/google/uuid"

// New 使用系统安全随机源生成 RFC 9562 UUIDv7。
func New() (string, error) {
	value, err := uuid.NewV7()
	if err != nil {
		return "", err
	}
	return value.String(), nil
}

// MustNew 供不支持 error 返回值的 Ent DefaultFunc 使用。
// 安全随机源失败时直接停止当前写入，绝不回退到其他 ID 算法。
func MustNew() string {
	value, err := New()
	if err != nil {
		panic(err)
	}
	return value
}
