// Package clock 统一数据库时间精度与时区。
package clock

import "time"

// Normalize 把时间转换为 UTC，并截断到与 datetime(3) 一致的毫秒精度。
func Normalize(value time.Time) time.Time {
	return value.UTC().Truncate(time.Millisecond)
}

// Now 返回适合写入数据库的当前 UTC 毫秒时间。
func Now() time.Time {
	return Normalize(time.Now())
}
