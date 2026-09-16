// Package accountauth 定义自然人账号认证的数据与密码边界。
package accountauth

import (
	"context"
	"errors"
	"time"
)

var (
	// ErrLoginConflict 表示登录标识已被占用。
	ErrLoginConflict = errors.New("登录标识已存在")
	// ErrLoginNotFound 表示登录标识不存在；不得直接暴露给外部调用者。
	ErrLoginNotFound = errors.New("登录标识不存在")
	// ErrInvalidRefreshToken 表示 refresh token 无法解析或校验。
	ErrInvalidRefreshToken = errors.New("refresh token 无效")
)

// LoginIdentity 是全局登录注册表中的可路由标识。
type LoginIdentity struct {
	Kind       string
	Hash       string
	Normalized string
}

// Account 是认证流程需要的账号快照。
type Account struct {
	ID           string
	Email        string
	DisplayName  string
	IMUserID     string
	IMState      string
	TokenVersion uint64
	Revision     uint64
}

// AccountDraft 是注册事务创建的账号数据。
type AccountDraft struct {
	Account
	EmailNormalized string
	PasswordHash    string
}

// CredentialAccount 是登录校验需要的账号和密码摘要。
type CredentialAccount struct {
	Account
	PasswordHash string
}

// SessionDraft 是待创建的 refresh token 会话。
type SessionDraft struct {
	ID          string
	FamilyID    string
	TokenDigest [32]byte
	ExpiresAt   time.Time
}

// Registration 是必须原子写入的注册事实。
type Registration struct {
	OccurredAt time.Time
	Login      LoginIdentity
	Account    AccountDraft
	Session    SessionDraft
}

// IssuedRefreshToken 只在一次应用调用中持有 refresh token 明文及其摘要。
type IssuedRefreshToken struct {
	Plaintext string
	Digest    [32]byte
}

// RefreshTokenRoute 是从明文前缀解析出的路由提示和完整摘要。
type RefreshTokenRoute struct {
	AccountID string
	SessionID string
	Digest    [32]byte
}

// RotationStatus 是 refresh token 原子轮换结果。
type RotationStatus string

const (
	RotationSucceeded RotationStatus = "succeeded"
	RotationInvalid   RotationStatus = "invalid"
	RotationRevoked   RotationStatus = "revoked"
	RotationReplayed  RotationStatus = "replayed"
)

// Rotation 描述旧 token 到新 session 的 CAS 轮换。
type Rotation struct {
	AccountID       string
	SessionID       string
	PresentedDigest [32]byte
	Next            SessionDraft
	RotatedAt       time.Time
}

// RotationResult 返回轮换状态与用于签发 access token 的账号快照。
type RotationResult struct {
	Status  RotationStatus
	Account Account
}

// SessionStatus 是 access token 数据库当前性结果。
type SessionStatus string

const (
	SessionCurrent SessionStatus = "current"
	SessionInvalid SessionStatus = "invalid"
	SessionRevoked SessionStatus = "revoked"
	SessionExpired SessionStatus = "expired"
)

// CurrentSession 是当前性查询的最小账号与会话快照。
type CurrentSession struct {
	Status  SessionStatus
	Account Account
}

// SessionCurrentnessStore 校验 access token 绑定的 session 与账号版本。
type SessionCurrentnessStore interface {
	FindCurrentSession(
		context.Context,
		string,
		string,
		time.Time,
	) (CurrentSession, error)
}

// Repository 隔离应用认证流程与 Ent/TDSQL 实现。
type Repository interface {
	Register(context.Context, Registration) error
	FindCredentialByLogin(context.Context, LoginIdentity) (CredentialAccount, error)
	CreateSession(context.Context, string, SessionDraft) error
	RotateSession(context.Context, Rotation) (RotationResult, error)
	RevokeSession(context.Context, string, string, time.Time) error
}

// PasswordHasher 提供昂贵密码摘要，并为不存在账号执行等价成本的假校验。
type PasswordHasher interface {
	Hash(context.Context, string) (string, error)
	Verify(context.Context, string, string) (bool, error)
	DummyVerify(context.Context, string) error
}

// RefreshTokenCodec 生成随机 refresh token，并解析其非授权路由前缀。
type RefreshTokenCodec interface {
	Issue(context.Context, string, string) (IssuedRefreshToken, error)
	Parse(context.Context, string) (RefreshTokenRoute, error)
}
