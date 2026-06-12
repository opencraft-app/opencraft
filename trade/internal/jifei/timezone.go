// Package jifei 包含 jifei CGW 协议层的共享常量与小工具。
//
// 本文件汇总 jifei 协议层"字符串时间字段"的 layout 与时区契约：
//
// 设计稿（综合 BUG-33 / BUG-34 修复 + .tmp/jifei_pdf_txt/*.md 协议字面值证据）：
//   - PDF §2.2 / §4.4 / §4.4.1.1.2 等所有时间字段（curDeadline / newDeadline /
//     expireTime / createTime / isolatedTimestamp）形态均为 "YYYY-MM-DD HH:MM:SS"，
//     无时区前缀、无 T 分隔，与 ISO8601 不同。
//   - jifei 历史协议的字面值都按北京时间（UTC+8）解读；但 trade pod 跑 UTC 是符合
//     项目"全 UTC"规范（见 docs/agent-guides/ctl-agent-guide.md），故必须显式
//     `time.FixedZone("CST", 8*3600)` 锚定，不能依赖 pod time.Local。
//
// 历史教训：
//   - 早期 trade/internal/logic/{checkrenew,placeorder,resourcequery} 三处各自定义
//     CST FixedZone / 直接用 time.Local，导致 producer/consumer 跨方法时区不一致，
//     表现为 600404 CurDeadlineMismatch（BUG-33）和 jifei 拿到 UTC 字面值（BUG-34）。
//   - 本文件作为唯一权威常量；所有 jifei 协议层时间字段格式化 / 解析都必须引用此处，
//     禁止再各自调 time.FixedZone（grep "time.FixedZone" 应只命中本文件）。
package jifei

import "time"

// CurDeadlineLayout 是 jifei 所有协议层"字符串时间字段"的 layout。
//
// PDF §2.2 / §4.4 / §4.4.1.1.2 / isolateResource §2.2 line "newDeadline":
// "2016-10-22 12:00:00" 决定性证据 — 形态为 "YYYY-MM-DD HH:MM:SS"。
//
// 适用字段（非穷举）：
//   - goodsDetail.curDeadline (placeRenewOrder 出向 / checkRenew 入向)
//   - newDeadline             (isolateResource 入向，退费场景)
//   - expireTime              (queryResource 出向)
//   - createTime              (queryResource 出向)
//   - isolatedTimestamp       (queryResource 出向)
const CurDeadlineLayout = "2006-01-02 15:04:05"

// CurDeadlineLocation 是 jifei 协议层时间字段的时区契约（北京时间 UTC+8）。
//
// 用法：
//
//	// 出向 — 把 ctl UTC time.Time 转为 jifei 期望的北京时间字面值字符串
//	str := t.In(jifei.CurDeadlineLocation).Format(jifei.CurDeadlineLayout)
//
//	// 入向 — 把 jifei 北京时间字面值字符串解析为绝对时刻 time.Time
//	t, err := time.ParseInLocation(jifei.CurDeadlineLayout, str, jifei.CurDeadlineLocation)
//
// 关键不变量：所有出向格式化 + 入向解析必须使用同一个 location 才能保证语义自洽
// （否则 producer/consumer 跨方法会出现 8h 错位，回到 BUG-33/34 原型）。
//
// 注意：不要用 time.LoadLocation("Asia/Shanghai")，因为依赖 IANA tzdata，
// 在 trade 镜像 alpine + tzdata 已就位时虽可用，但 FixedZone 是无外部依赖的更稳实现。
var CurDeadlineLocation = time.FixedZone("CST", 8*3600)

// FormatCurDeadline 把任意 time.Time 转换为 jifei 协议层北京时间字面值字符串。
//
// 注意 t 的 Location 不影响输出（time.Time.In() 不改变绝对时刻），
// 因此 ctl 给的 UTC time.Time 与开发机的 CST time.Time 输出结果一致。
func FormatCurDeadline(t time.Time) string {
	return t.In(CurDeadlineLocation).Format(CurDeadlineLayout)
}

// ParseCurDeadline 把 jifei 协议层北京时间字面值字符串解析为绝对时刻 time.Time。
//
// 解析失败返非空 error；调用方按业务码归因（curDeadline 不一致 / newDeadline 格式错 等）。
func ParseCurDeadline(s string) (time.Time, error) {
	return time.ParseInLocation(CurDeadlineLayout, s, CurDeadlineLocation)
}
