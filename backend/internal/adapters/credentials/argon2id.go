package credentials

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"golang.org/x/crypto/argon2"
)

const argon2Version = 19

// Argon2idConfig 明确控制密码摘要成本。
type Argon2idConfig struct {
	MemoryKiB   uint32
	Iterations  uint32
	Parallelism uint8
	SaltLength  uint32
	KeyLength   uint32
}

// ProductionArgon2idConfig 返回生产默认成本。
func ProductionArgon2idConfig() Argon2idConfig {
	return Argon2idConfig{
		MemoryKiB:   64 * 1024,
		Iterations:  3,
		Parallelism: 1,
		SaltLength:  16,
		KeyLength:   32,
	}
}

// TestArgon2idConfig 返回仅供测试使用的低成本参数。
func TestArgon2idConfig() Argon2idConfig {
	return Argon2idConfig{
		MemoryKiB:   8 * 1024,
		Iterations:  1,
		Parallelism: 1,
		SaltLength:  16,
		KeyLength:   32,
	}
}

// Argon2id 实现 PHC 格式密码摘要。
type Argon2id struct {
	config    Argon2idConfig
	dummyHash string
}

// NewArgon2id 创建密码摘要器，并预生成不存在账号使用的假摘要。
func NewArgon2id(config Argon2idConfig) (*Argon2id, error) {
	if err := validateArgon2idConfig(config); err != nil {
		return nil, err
	}
	hasher := &Argon2id{config: config}
	dummy, err := hasher.hash(context.Background(), "chatserver-dummy-password")
	if err != nil {
		return nil, err
	}
	hasher.dummyHash = dummy
	return hasher, nil
}

// Hash 生成随机 salt 的 Argon2id PHC 字符串。
func (h *Argon2id) Hash(ctx context.Context, raw string) (string, error) {
	if h == nil {
		return "", errors.New("Argon2id 未初始化")
	}
	return h.hash(ctx, raw)
}

func (h *Argon2id) hash(ctx context.Context, raw string) (string, error) {
	if err := contextError(ctx); err != nil {
		return "", err
	}
	salt := make([]byte, h.config.SaltLength)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key := argon2.IDKey(
		[]byte(raw),
		salt,
		h.config.Iterations,
		h.config.MemoryKiB,
		h.config.Parallelism,
		h.config.KeyLength,
	)
	if err := contextError(ctx); err != nil {
		return "", err
	}
	return fmt.Sprintf(
		"$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2Version,
		h.config.MemoryKiB,
		h.config.Iterations,
		h.config.Parallelism,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(key),
	), nil
}

// Verify 以 PHC 中记录的参数校验密码。
func (h *Argon2id) Verify(
	ctx context.Context,
	encoded string,
	raw string,
) (bool, error) {
	if h == nil {
		return false, errors.New("Argon2id 未初始化")
	}
	if err := contextError(ctx); err != nil {
		return false, err
	}
	config, salt, expected, err := parseArgon2id(encoded)
	if err != nil {
		return false, err
	}
	actual := argon2.IDKey(
		[]byte(raw),
		salt,
		config.Iterations,
		config.MemoryKiB,
		config.Parallelism,
		uint32(len(expected)),
	)
	if err := contextError(ctx); err != nil {
		return false, err
	}
	return subtle.ConstantTimeCompare(actual, expected) == 1, nil
}

// DummyVerify 为不存在账号执行相同类别的昂贵校验。
func (h *Argon2id) DummyVerify(ctx context.Context, raw string) error {
	_, err := h.Verify(ctx, h.dummyHash, raw)
	return err
}

func validateArgon2idConfig(config Argon2idConfig) error {
	if config.MemoryKiB < 8*1024 ||
		config.Iterations < 1 ||
		config.Parallelism < 1 ||
		config.SaltLength < 16 ||
		config.KeyLength < 32 {
		return errors.New("Argon2id 参数不安全")
	}
	return nil
}

func parseArgon2id(encoded string) (Argon2idConfig, []byte, []byte, error) {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[0] != "" || parts[1] != "argon2id" ||
		parts[2] != "v=19" {
		return Argon2idConfig{}, nil, nil, errors.New("Argon2id PHC 格式无效")
	}
	var config Argon2idConfig
	for _, value := range strings.Split(parts[3], ",") {
		pair := strings.SplitN(value, "=", 2)
		if len(pair) != 2 {
			return Argon2idConfig{}, nil, nil, errors.New("Argon2id 参数无效")
		}
		number, err := strconv.ParseUint(pair[1], 10, 32)
		if err != nil {
			return Argon2idConfig{}, nil, nil, errors.New("Argon2id 参数无效")
		}
		switch pair[0] {
		case "m":
			config.MemoryKiB = uint32(number)
		case "t":
			config.Iterations = uint32(number)
		case "p":
			if number > 255 {
				return Argon2idConfig{}, nil, nil, errors.New("Argon2id 参数无效")
			}
			config.Parallelism = uint8(number)
		default:
			return Argon2idConfig{}, nil, nil, errors.New("Argon2id 参数无效")
		}
	}
	salt, err := base64.RawStdEncoding.Strict().DecodeString(parts[4])
	if err != nil {
		return Argon2idConfig{}, nil, nil, errors.New("Argon2id salt 无效")
	}
	key, err := base64.RawStdEncoding.Strict().DecodeString(parts[5])
	if err != nil {
		return Argon2idConfig{}, nil, nil, errors.New("Argon2id key 无效")
	}
	config.SaltLength = uint32(len(salt))
	config.KeyLength = uint32(len(key))
	if err := validateArgon2idConfig(config); err != nil {
		return Argon2idConfig{}, nil, nil, err
	}
	return config, salt, key, nil
}

func contextError(ctx context.Context) error {
	if ctx == nil {
		return errors.New("context 不能为空")
	}
	return ctx.Err()
}
