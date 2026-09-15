package tencentim

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base32"
	"encoding/binary"
	"errors"

	"github.com/google/uuid"
)

const identityKeyBytes = 32

// IdentityDeriver 把平台内部 UUIDv7 映射成不包含个人信息的稳定 IM UserID。
type IdentityDeriver struct {
	key [identityKeyBytes]byte
}

// NewIdentityDeriver 创建 Human IM UserID 派生器。
func NewIdentityDeriver(key []byte) (*IdentityDeriver, error) {
	if len(key) != identityKeyBytes {
		return nil, errors.New("IM 身份派生密钥必须为 32 字节")
	}
	deriver := &IdentityDeriver{}
	copy(deriver.key[:], key)
	return deriver, nil
}

// HumanUserID 按冻结规格生成 u_ 加 29 位 Base32 后缀。
func (deriver *IdentityDeriver) HumanUserID(accountID string) (string, error) {
	if deriver == nil {
		return "", errors.New("IM 身份派生器未配置")
	}
	parsed, err := uuid.Parse(accountID)
	if err != nil || parsed == uuid.Nil || parsed.Version() != 7 {
		return "", errors.New("账号 ID 必须是 UUIDv7")
	}
	raw := []byte(accountID)
	input := make([]byte, 4+len(raw))
	binary.BigEndian.PutUint32(input[:4], uint32(len(raw)))
	copy(input[4:], raw)
	mac := hmac.New(sha256.New, deriver.key[:])
	_, _ = mac.Write(input)
	suffix := base32.StdEncoding.WithPadding(base32.NoPadding).
		EncodeToString(mac.Sum(nil))
	return "u_" + suffix[:29], nil
}

// AgentUserID 使用独立域把 Agent UUIDv7 派生为 a_ 前缀 IM UserID。
func (deriver *IdentityDeriver) AgentUserID(agentID string) (string, error) {
	if deriver == nil {
		return "", errors.New("IM 身份派生器未配置")
	}
	parsed, err := uuid.Parse(agentID)
	if err != nil || parsed == uuid.Nil || parsed.Version() != 7 {
		return "", errors.New("Agent ID 必须是 UUIDv7")
	}
	domain := []byte("agent")
	raw := []byte(agentID)
	input := make([]byte, 8+len(domain)+len(raw))
	binary.BigEndian.PutUint32(input[:4], uint32(len(domain)))
	copy(input[4:], domain)
	offset := 4 + len(domain)
	binary.BigEndian.PutUint32(input[offset:offset+4], uint32(len(raw)))
	copy(input[offset+4:], raw)
	mac := hmac.New(sha256.New, deriver.key[:])
	_, _ = mac.Write(input)
	suffix := base32.StdEncoding.WithPadding(base32.NoPadding).
		EncodeToString(mac.Sum(nil))
	return "a_" + suffix[:29], nil
}
