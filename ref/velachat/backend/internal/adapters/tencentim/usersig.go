package tencentim

import (
	"context"
	"errors"
	"fmt"
	"io"
	"math"
	"regexp"
	"time"

	clockport "chatserver/internal/ports/clock"
	tencentimport "chatserver/internal/ports/tencentim"

	"github.com/tencentyun/tls-sig-api-v2-golang/tencentyun"
)

var imUserIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,32}$`)

// UserSigIssuer 使用部署级腾讯云密钥在服务端签发 UserSig。
type UserSigIssuer struct {
	sdkAppID int
	secret   string
	clock    clockport.Clock
}

// Format 只提供无状态诊断标签，不暴露签名密钥。
func (*UserSigIssuer) Format(state fmt.State, _ rune) {
	_, _ = io.WriteString(state, "TencentUserSigIssuer([REDACTED])")
}

// NewUserSigIssuer 创建服务端 UserSig 签发器。
func NewUserSigIssuer(
	sdkAppID int,
	secret string,
	clock clockport.Clock,
) (*UserSigIssuer, error) {
	if sdkAppID <= 0 || secret == "" || clock == nil {
		return nil, errors.New("腾讯云 UserSig 配置无效")
	}
	return &UserSigIssuer{
		sdkAppID: sdkAppID,
		secret:   secret,
		clock:    clock,
	}, nil
}

// Issue 为指定 IM UserID 签发短期 UserSig。
func (issuer *UserSigIssuer) Issue(
	ctx context.Context,
	userID string,
	ttl time.Duration,
) (tencentimport.UserSig, error) {
	if issuer == nil || !imUserIDPattern.MatchString(userID) ||
		ttl <= 0 || ttl%time.Second != 0 ||
		ttl/time.Second > time.Duration(math.MaxInt) {
		return tencentimport.UserSig{}, errors.New("腾讯云 UserSig 签发参数无效")
	}
	if ctx == nil {
		return tencentimport.UserSig{}, errors.New("腾讯云 UserSig 上下文无效")
	}
	if err := ctx.Err(); err != nil {
		return tencentimport.UserSig{}, err
	}
	value, err := tencentyun.GenUserSig(
		issuer.sdkAppID,
		issuer.secret,
		userID,
		int(ttl/time.Second),
	)
	if err != nil {
		return tencentimport.UserSig{}, errors.New("腾讯云 UserSig 签发失败")
	}
	return tencentimport.UserSig{
		Value:     value,
		ExpiresAt: issuer.clock.Now().UTC().Add(ttl),
	}, nil
}

var _ tencentimport.UserSigIssuer = (*UserSigIssuer)(nil)
