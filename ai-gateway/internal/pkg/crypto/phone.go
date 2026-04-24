package crypto

import (
	"crypto/sha256"
	"fmt"
)

// MaskPhone 脱敏手机号: "13812341234" → "138****1234"
func MaskPhone(phone string) string {
	if len(phone) < 7 {
		return phone
	}
	return phone[:3] + "****" + phone[len(phone)-4:]
}

// HashPhone 返回手机号的 SHA-256 哈希（hex）
func HashPhone(phone string) string {
	h := sha256.Sum256([]byte(phone))
	return fmt.Sprintf("%x", h)
}

// IsFullPhone 判断是否为完整手机号（11位纯数字）
func IsFullPhone(s string) bool {
	if len(s) != 11 {
		return false
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}
