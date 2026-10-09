package credentials

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"io"
	"strings"

	accountauthport "chatserver/internal/ports/accountauth"

	"github.com/google/uuid"
)

const refreshTokenRandomBytes = 32

// RefreshTokens 生成和解析可按 account/session 路由的随机 token。
type RefreshTokens struct {
	random io.Reader
}

// NewRefreshTokens 创建 refresh token codec。
func NewRefreshTokens(random io.Reader) (*RefreshTokens, error) {
	if random == nil {
		return nil, errors.New("随机源不能为空")
	}
	return &RefreshTokens{random: random}, nil
}

// Issue 生成只显示一次的 refresh token。
func (c *RefreshTokens) Issue(
	ctx context.Context,
	accountID string,
	sessionID string,
) (accountauthport.IssuedRefreshToken, error) {
	if err := contextError(ctx); err != nil {
		return accountauthport.IssuedRefreshToken{}, err
	}
	if !validUUID(accountID) || !validUUID(sessionID) {
		return accountauthport.IssuedRefreshToken{},
			accountauthport.ErrInvalidRefreshToken
	}
	random := make([]byte, refreshTokenRandomBytes)
	if _, err := io.ReadFull(c.random, random); err != nil {
		return accountauthport.IssuedRefreshToken{}, err
	}
	plaintext := strings.Join([]string{
		"rt1",
		accountID,
		sessionID,
		base64.RawURLEncoding.EncodeToString(random),
	}, ".")
	return accountauthport.IssuedRefreshToken{
		Plaintext: plaintext,
		Digest:    sha256.Sum256([]byte(plaintext)),
	}, nil
}

// Parse 解析路由前缀并计算完整 token 摘要。
func (c *RefreshTokens) Parse(
	ctx context.Context,
	raw string,
) (accountauthport.RefreshTokenRoute, error) {
	if err := contextError(ctx); err != nil {
		return accountauthport.RefreshTokenRoute{}, err
	}
	parts := strings.Split(raw, ".")
	if len(parts) != 4 || parts[0] != "rt1" ||
		!validUUID(parts[1]) || !validUUID(parts[2]) {
		return accountauthport.RefreshTokenRoute{},
			accountauthport.ErrInvalidRefreshToken
	}
	random, err := base64.RawURLEncoding.Strict().DecodeString(parts[3])
	if err != nil || len(random) != refreshTokenRandomBytes {
		return accountauthport.RefreshTokenRoute{},
			accountauthport.ErrInvalidRefreshToken
	}
	return accountauthport.RefreshTokenRoute{
		AccountID: parts[1],
		SessionID: parts[2],
		Digest:    sha256.Sum256([]byte(raw)),
	}, nil
}

func validUUID(value string) bool {
	parsed, err := uuid.Parse(value)
	return err == nil && parsed != uuid.Nil
}
