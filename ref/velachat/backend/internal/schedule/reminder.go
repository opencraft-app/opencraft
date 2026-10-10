// Package schedule 统一解释平台支持的 Reminder 调度表达式。
package schedule

import (
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/robfig/cron/v3"
)

var standardCronParser = cron.NewParser(
	cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow | cron.Descriptor,
)

// NextReminderFire 返回 strictly after 基准时间之后的下一次 UTC 触发时间。
//
// cron 使用标准五字段格式；时区由独立字段指定，避免表达式内时区覆盖平台配置。
func NextReminderFire(
	kind string,
	expression string,
	timezone string,
	after time.Time,
) (time.Time, error) {
	kind = strings.TrimSpace(kind)
	expression = strings.TrimSpace(expression)
	timezone = strings.TrimSpace(timezone)
	if expression == "" || timezone == "" || after.IsZero() {
		return time.Time{}, errors.New("Reminder 调度参数不完整")
	}
	location, err := time.LoadLocation(timezone)
	if err != nil {
		return time.Time{}, fmt.Errorf("Reminder 时区无效: %w", err)
	}
	switch kind {
	case "once":
		fireAt, err := time.Parse(time.RFC3339, expression)
		if err != nil {
			return time.Time{}, fmt.Errorf("Reminder 一次性时间无效: %w", err)
		}
		if !fireAt.After(after) {
			return time.Time{}, errors.New("Reminder 一次性时间必须在未来")
		}
		return fireAt.UTC(), nil
	case "cron":
		parsed, err := standardCronParser.Parse(expression)
		if err != nil {
			return time.Time{}, fmt.Errorf("Reminder cron 无效: %w", err)
		}
		next := parsed.Next(after.In(location))
		if next.IsZero() || !next.After(after) {
			return time.Time{}, errors.New("Reminder cron 没有可用的下一次时间")
		}
		return next.UTC(), nil
	default:
		return time.Time{}, errors.New("Reminder 调度类型无效")
	}
}
