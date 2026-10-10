package servermember

import (
	"crypto/sha256"
	"encoding/base32"
	"encoding/binary"
	"errors"

	"github.com/google/uuid"
)

// DeriveHumanHandle 从不透明逻辑 ID 派生 Server 内稳定 Human handle。
func DeriveHumanHandle(accountID, memberID string) (string, error) {
	if !isUUIDv7(accountID) || !isUUIDv7(memberID) {
		return "", errors.New("Account ID 和 Member ID 必须是 UUIDv7")
	}
	input := appendLP(nil, "human-member")
	input = appendLP(input, accountID)
	input = appendLP(input, memberID)
	digest := sha256.Sum256(input)
	encoded := base32.StdEncoding.WithPadding(base32.NoPadding).
		EncodeToString(digest[:])
	return "u_" + encoded[:20], nil
}

func isUUIDv7(value string) bool {
	parsed, err := uuid.Parse(value)
	return err == nil && parsed != uuid.Nil && parsed.Version() == 7
}

func appendLP(dst []byte, value string) []byte {
	offset := len(dst)
	dst = append(dst, 0, 0, 0, 0)
	binary.BigEndian.PutUint32(dst[offset:], uint32(len(value)))
	return append(dst, value...)
}
