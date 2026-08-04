// Package runtimeauth 定义 Agent 长期凭据的数据库 currentness 边界。
package runtimeauth

import (
	"context"
	"errors"
)

var (
	// ErrInvalidRoute 表示凭据内的路由信息不合法。
	ErrInvalidRoute = errors.New("Agent credential 路由无效")
	// ErrCredentialNotCurrent 表示凭据或 Agent 已不再是当前可运行状态。
	ErrCredentialNotCurrent = errors.New("Agent credential 已失效")
)

// Route 是从凭据中解析出的非秘密精确查询键。
type Route struct {
	ServerID string
	AgentID  string
	Version  uint64
}

// LaunchRoute 是 Runtime 短期令牌绑定的完整、不可拆分的 Launch Fence。
type LaunchRoute struct {
	ServerID          string
	ComputerID        string
	AgentID           string
	LaunchID          string
	AssignmentEpoch   string
	ConfigGeneration  int64
	CredentialVersion uint64
	Attempt           int64
}

// Credential 是按 Route 点查得到的当前凭据摘要。
type Credential struct {
	Route
	SecretDigest [32]byte
}

// Repository 只允许按 server/agent/version 点查，不提供按 Secret 全局扫描。
type Repository interface {
	FindCurrent(context.Context, Route) (Credential, error)
	ConfirmCurrent(context.Context, Route) (bool, error)
	ConfirmCurrentLaunch(context.Context, LaunchRoute) (bool, error)
}
