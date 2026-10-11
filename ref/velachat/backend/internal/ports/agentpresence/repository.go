// Package agentpresence 定义 Agent 在线事实的持久化边界。
package agentpresence

import (
	"context"
	"time"
)

// IMObservation 是腾讯 IM 状态回调确认的单个在线事实。
type IMObservation struct {
	IMUserID   string
	Presence   string
	ObservedAt time.Time
	Reason     string
}

type Repository interface {
	ApplyIMPresence(context.Context, IMObservation) (bool, error)
}
