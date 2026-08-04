// Package humanaccount 定义当前自然人账号的查询边界。
package humanaccount

import (
	"context"
	"errors"
)

// ErrNotFound 表示当前认证主体对应的账号事实不存在。
var ErrNotFound = errors.New("账号不存在")

// Account 是 /me 和 Human IM Session 需要的最小账号快照。
type Account struct {
	ID           string
	Email        string
	DisplayName  string
	IMUserID     string
	IMState      string
	TokenVersion uint64
	Revision     uint64
}

// Repository 按当前已认证 accountId 点查账号事实。
type Repository interface {
	FindByID(context.Context, string) (Account, error)
}
