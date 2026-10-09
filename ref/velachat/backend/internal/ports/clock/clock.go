// Package clock 定义应用层可替换的时间来源。
package clock

import (
	"time"

	systemclock "chatserver/internal/clock"
)

// Clock 为应用服务提供当前时间。
type Clock interface {
	Now() time.Time
}

// System 使用平台统一的 UTC 毫秒时间。
type System struct{}

// Now 返回符合数据库时间约定的当前时间。
func (System) Now() time.Time {
	return systemclock.Now()
}
