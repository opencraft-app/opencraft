// Package token 定义访问令牌签发与验证边界。
package token

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
)

// ErrInvalidClaims 表示令牌身份或有效期不合法。
var ErrInvalidClaims = errors.New("无效的令牌声明")

var (
	// ErrInvalidToken 表示 access token 格式、签名或声明无效。
	ErrInvalidToken = errors.New("访问令牌无效")
	// ErrExpiredToken 表示 access token 已经过期。
	ErrExpiredToken = errors.New("访问令牌已过期")
)

// ClaimsKind 标识访问令牌用途。
type ClaimsKind string

const (
	ClaimsHumanAccess    ClaimsKind = "human_access"
	ClaimsRuntimeAccess  ClaimsKind = "runtime_access"
	ClaimsComputerAccess ClaimsKind = "computer_access"
)

// Claims 是经过基础结构校验的访问令牌声明。
type Claims struct {
	kind             ClaimsKind
	accountID        string
	sessionID        string
	serverID         string
	agentID          string
	computerID       string
	launchID         string
	assignmentEpoch  string
	configGeneration int64
	attempt          int64
	version          uint64
	issuedAt         time.Time
	expiresAt        time.Time
}

// NewRuntimeLaunchClaims creates a short-lived Runtime token bound to the
// complete current Agent Launch Fence.
func NewRuntimeLaunchClaims(
	serverID string,
	computerID string,
	agentID string,
	launchID string,
	assignmentEpoch string,
	configGeneration int64,
	credentialVersion uint64,
	attempt int64,
	issuedAt time.Time,
	expiresAt time.Time,
) (Claims, error) {
	if !validID(serverID) || !validID(computerID) || !validID(agentID) ||
		!validID(launchID) || !validID(assignmentEpoch) ||
		configGeneration < 1 || credentialVersion == 0 || attempt < 1 ||
		!validLifetime(issuedAt, expiresAt) {
		return Claims{}, ErrInvalidClaims
	}
	return Claims{
		kind: ClaimsRuntimeAccess, serverID: serverID, computerID: computerID,
		agentID: agentID, launchID: launchID, assignmentEpoch: assignmentEpoch,
		configGeneration: configGeneration, version: credentialVersion,
		attempt: attempt, issuedAt: issuedAt.UTC(), expiresAt: expiresAt.UTC(),
	}, nil
}

// NewHumanClaims 创建自然人访问令牌声明。
func NewHumanClaims(
	accountID string,
	sessionID string,
	tokenVersion uint64,
	issuedAt time.Time,
	expiresAt time.Time,
) (Claims, error) {
	if !validID(accountID) || !validID(sessionID) || tokenVersion == 0 ||
		!validLifetime(issuedAt, expiresAt) {
		return Claims{}, ErrInvalidClaims
	}
	return Claims{
		kind:      ClaimsHumanAccess,
		accountID: accountID,
		sessionID: sessionID,
		version:   tokenVersion,
		issuedAt:  issuedAt.UTC(),
		expiresAt: expiresAt.UTC(),
	}, nil
}

// NewRuntimeClaims 创建 Agent Runtime 访问令牌声明。
func NewRuntimeClaims(
	serverID string,
	agentID string,
	credentialVersion uint64,
	issuedAt time.Time,
	expiresAt time.Time,
) (Claims, error) {
	if !validID(serverID) || !validID(agentID) || credentialVersion == 0 ||
		!validLifetime(issuedAt, expiresAt) {
		return Claims{}, ErrInvalidClaims
	}
	return Claims{
		kind:      ClaimsRuntimeAccess,
		serverID:  serverID,
		agentID:   agentID,
		version:   credentialVersion,
		issuedAt:  issuedAt.UTC(),
		expiresAt: expiresAt.UTC(),
	}, nil
}

// NewComputerClaims 创建 Computer daemon 的短期访问令牌声明。
func NewComputerClaims(
	serverID string,
	computerID string,
	credentialVersion uint64,
	issuedAt time.Time,
	expiresAt time.Time,
) (Claims, error) {
	if !validID(serverID) || !validID(computerID) || credentialVersion == 0 ||
		!validLifetime(issuedAt, expiresAt) {
		return Claims{}, ErrInvalidClaims
	}
	return Claims{
		kind:       ClaimsComputerAccess,
		serverID:   serverID,
		computerID: computerID,
		version:    credentialVersion,
		issuedAt:   issuedAt.UTC(),
		expiresAt:  expiresAt.UTC(),
	}, nil
}

// Kind 返回令牌用途。
func (c Claims) Kind() ClaimsKind {
	return c.kind
}

func (c Claims) AccountID() string {
	return c.accountID
}

func (c Claims) SessionID() string {
	return c.sessionID
}

func (c Claims) ServerID() string {
	return c.serverID
}

func (c Claims) AgentID() string {
	return c.agentID
}

func (c Claims) ComputerID() string {
	return c.computerID
}

func (c Claims) LaunchID() string { return c.launchID }

func (c Claims) AssignmentEpoch() string { return c.assignmentEpoch }

func (c Claims) ConfigGeneration() int64 { return c.configGeneration }

func (c Claims) Attempt() int64 { return c.attempt }

func (c Claims) HasLaunchFence() bool {
	return c.kind == ClaimsRuntimeAccess && c.computerID != "" && c.launchID != "" &&
		c.assignmentEpoch != "" && c.configGeneration > 0 && c.attempt > 0
}

func (c Claims) Version() uint64 {
	return c.version
}

func (c Claims) IssuedAt() time.Time {
	return c.issuedAt
}

func (c Claims) ExpiresAt() time.Time {
	return c.expiresAt
}

// Signer 签发并验证访问令牌。
type Signer interface {
	Sign(context.Context, Claims) (string, error)
	Verify(context.Context, string) (Claims, error)
}

func validID(value string) bool {
	parsed, err := uuid.Parse(value)
	return err == nil && parsed != uuid.Nil
}

func validLifetime(issuedAt time.Time, expiresAt time.Time) bool {
	return !issuedAt.IsZero() && expiresAt.After(issuedAt)
}
