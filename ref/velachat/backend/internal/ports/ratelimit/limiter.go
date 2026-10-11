// Package ratelimit 定义与存储实现无关的应用限流边界。
package ratelimit

import (
	"context"
	"encoding/hex"
	"errors"
	"net/netip"
	"strings"
	"time"

	"github.com/google/uuid"
)

// ErrInvalidSubject 表示限流主体无法形成稳定、规范的键。
var ErrInvalidSubject = errors.New("无效的限流主体")

// SubjectKind 标识限流主体类型。
type SubjectKind string

const (
	SubjectIP        SubjectKind = "ip"
	SubjectLoginHash SubjectKind = "login_hash"
	SubjectAccountID SubjectKind = "account_id"
	SubjectAgentID   SubjectKind = "agent_id"
)

// Subject 是经过校验的限流主体。
type Subject struct {
	kind SubjectKind
	key  string
}

// Kind 返回主体类型。
func (s Subject) Kind() SubjectKind {
	return s.kind
}

// Key 返回类型内稳定、规范的键。
func (s Subject) Key() string {
	return s.key
}

// NewIPSubject 创建规范化 IP 主体。
func NewIPSubject(address netip.Addr) (Subject, error) {
	if !address.IsValid() {
		return Subject{}, ErrInvalidSubject
	}
	return Subject{kind: SubjectIP, key: address.Unmap().String()}, nil
}

// NewLoginHashSubject 创建规范化登录标识哈希主体。
func NewLoginHashSubject(value string) (Subject, error) {
	if len(value) != 64 || value != strings.ToLower(value) {
		return Subject{}, ErrInvalidSubject
	}
	decoded, err := hex.DecodeString(value)
	if err != nil || len(decoded) != 32 {
		return Subject{}, ErrInvalidSubject
	}
	return Subject{kind: SubjectLoginHash, key: value}, nil
}

// NewAccountSubject 创建自然人账号主体。
func NewAccountSubject(accountID string) (Subject, error) {
	if !validID(accountID) {
		return Subject{}, ErrInvalidSubject
	}
	return Subject{kind: SubjectAccountID, key: accountID}, nil
}

// NewAgentSubject 创建 Server 内 Agent 主体。
func NewAgentSubject(serverID string, agentID string) (Subject, error) {
	if !validID(serverID) || !validID(agentID) {
		return Subject{}, ErrInvalidSubject
	}
	return Subject{
		kind: SubjectAgentID,
		key:  serverID + "/" + agentID,
	}, nil
}

// Request 描述一次应用级限流判定。
type Request struct {
	Subjects       []Subject
	ServerID       string
	OperationClass string
	Cost           uint64
}

// Decision 是限流判定结果。
type Decision struct {
	Allowed    bool
	RetryAfter time.Duration
}

// Limiter 对多个主体进行一次原子判定。
type Limiter interface {
	Allow(context.Context, Request) (Decision, error)
}

func validID(value string) bool {
	parsed, err := uuid.Parse(value)
	return err == nil && parsed != uuid.Nil
}
