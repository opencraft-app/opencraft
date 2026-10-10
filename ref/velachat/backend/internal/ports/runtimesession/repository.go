// Package runtimesession 定义 Runtime Session 所需的 Agent 当前事实边界。
package runtimesession

import (
	"context"
	"errors"
	"time"
)

// ErrNotCurrent 表示 Agent 或其 credential version 已不再是当前事实。
var ErrNotCurrent = errors.New("Runtime Agent 当前事实不存在")

// Agent 是 Runtime Session 与 /runtime/me 所需的最小数据库快照。
type Agent struct {
	ID                string
	ServerID          string
	IMUserID          string
	IMState           string
	ComputerID        string
	ComputerReady     bool
	RuntimeKind       string
	RuntimeModel      string
	ReplyPolicy       string
	DesiredState      string
	ObservedState     string
	CredentialVersion uint64
}

// Repository 只按 server/agent/version 读取并确认 Runtime 当前事实。
type Repository interface {
	FindCurrentAgent(
		context.Context,
		string,
		string,
		uint64,
	) (Agent, error)
	MarkCredentialUsed(
		context.Context,
		string,
		string,
		uint64,
		time.Time,
	) (bool, error)
}
