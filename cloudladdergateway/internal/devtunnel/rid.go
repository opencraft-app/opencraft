package devtunnel

import (
	"crypto/rand"
	"encoding/hex"
)

// newRID 生成一次请求的唯一标识（16 字节随机 hex）。
// 用随机而非自增，避免 hub 重启后 rid 复用导致 reply 错配到新请求。
func newRID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		// crypto/rand 在正常系统上不会失败；真失败时用零值也不影响正确性
		// （rid 只需在在途集合内唯一，Dispatch 结束即摘除）。
		return "rid-fallback"
	}
	return hex.EncodeToString(b[:])
}
