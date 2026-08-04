package computermanagement

import (
	"crypto/sha256"
	"encoding/base32"
	"errors"
	"io"
	"strconv"
	"strings"
)

const (
	setupCodeAlphabet  = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
	setupCodeByteCount = 10
	setupCodeLength    = 16
)

var setupCodeEncoding = base32.NewEncoding(setupCodeAlphabet).
	WithPadding(base32.NoPadding)

func generateSetupCode(random io.Reader) (string, string, error) {
	if random == nil {
		return "", "", errors.New("setup code 随机源为空")
	}
	secret := make([]byte, setupCodeByteCount)
	if _, err := io.ReadFull(random, secret); err != nil {
		return "", "", err
	}
	canonical := setupCodeEncoding.EncodeToString(secret)
	if len(canonical) != setupCodeLength {
		return "", "", errors.New("setup code 编码长度无效")
	}
	return strings.Join([]string{
		canonical[0:4], canonical[4:8], canonical[8:12], canonical[12:16],
	}, "-"), canonical, nil
}

func normalizeSetupCode(value string) (string, error) {
	if value == "" || strings.TrimSpace(value) != value {
		return "", errors.New("setup code 格式无效")
	}
	if len(value) == 19 {
		if value[4] != '-' || value[9] != '-' || value[14] != '-' {
			return "", errors.New("setup code 分组无效")
		}
		value = value[0:4] + value[5:9] + value[10:14] + value[15:19]
	}
	if len(value) != setupCodeLength {
		return "", errors.New("setup code 长度无效")
	}
	canonical := strings.ToUpper(value)
	for _, character := range canonical {
		if !strings.ContainsRune(setupCodeAlphabet, character) {
			return "", errors.New("setup code 字符无效")
		}
	}
	return canonical, nil
}

func deriveEnrollmentSecret(
	canonical string,
	serverID string,
	computerID string,
	generation uint64,
) [32]byte {
	return sha256.Sum256([]byte(strings.Join([]string{
		"chatserver-computer-enrollment-v1",
		canonical,
		serverID,
		computerID,
		strconv.FormatUint(generation, 10),
	}, "\x00")))
}

func setupCodeHash(canonical string) string {
	digest := sha256.Sum256([]byte(canonical))
	const hexAlphabet = "0123456789abcdef"
	encoded := make([]byte, len(digest)*2)
	for index, value := range digest {
		encoded[index*2] = hexAlphabet[value>>4]
		encoded[index*2+1] = hexAlphabet[value&0x0f]
	}
	return string(encoded)
}
