// Package placeorder 测试文件：jifei curDeadline 时区契约的 BUG-34 回归保护。
//
// 设计稿：.tmp/trade-pass-renew-design.md §4.3 / §4.4 / R-D-3
//
// 关键不变量（与 trade/internal/logic/resourcequery/mapper.go::passToResourceMap
// 和 trade/internal/logic/checkrenew/handler.go::verifyCurDeadline 三处时区契约对齐）：
// 输入是 ctl 提供的 UTC time.Time（ctl 全栈 UTC 存储），输出必须是北京时间字面值字符串
// （jifei 协议层 curDeadline 字段的契约），与 trade pod 本身的时区配置无关。
package placeorder

import (
	"strings"
	"testing"
	"time"

	"git.woa.com/wisp/mono/trade/internal/jifei"
)

// TestFormatJifeiDeadline_BUG34_UTCInputMustOutputBeijingLiteral BUG-34 核心回归：
//
// 真实生产形态复现：
//   - 输入：ctl pass.ExpiredTime = UTC time.Time（ctl 全栈 UTC 存储）
//     例如 2026-06-22T07:22:50Z（北京时间 15:22:50）
//   - 期望输出：jifei 协议层 curDeadline = "2026-06-22 15:22:50"（北京时间字面值）
//
// 修复前实现 t.Format(layout) 依赖 trade pod 的 time.Local —— pod 跑 UTC 时
// 会输出 "2026-06-22 07:22:50"（UTC 字面值），与 jifei 协议契约不符，
// jifei 后续在 checkRenew 回调原样回传该字面值，触发 600404 CurDeadlineMismatch。
//
// 修复后必须：无论 trade pod 时区如何，UTC 输入都稳定输出北京时间字面值。
func TestFormatJifeiDeadline_BUG34_UTCInputMustOutputBeijingLiteral(t *testing.T) {
	// ctl 给的 pass.ExpiredTime：UTC 形态（与 ctl 全栈 UTC 规范一致）。
	expiredUTC := time.Date(2026, 6, 22, 7, 22, 50, 0, time.UTC)

	got := formatJifeiDeadline(expiredUTC)
	want := "2026-06-22 15:22:50" // 北京时间字面值

	if got != want {
		t.Fatalf("formatJifeiDeadline(UTC %s) = %q, want %q (Beijing wall-clock literal)",
			expiredUTC.Format(time.RFC3339), got, want)
	}
}

// TestFormatJifeiDeadline_BUG34_CSTInputAlsoOutputsBeijingLiteral 等价性保护：
//
// 同一绝对时刻的 time.Time 无论 location 是 UTC 还是 CST，formatJifeiDeadline 都必须
// 输出同一个北京时间字面值（time.Time.In() 不改变绝对时刻）。
// 防止"修复"后又退化成依赖输入 location 的实现。
func TestFormatJifeiDeadline_BUG34_CSTInputAlsoOutputsBeijingLiteral(t *testing.T) {
	// 同一绝对时刻，但 location 是 CST（开发机本地形态）。
	cst := time.FixedZone("CST", 8*3600)
	expiredCST := time.Date(2026, 6, 22, 15, 22, 50, 0, cst)

	got := formatJifeiDeadline(expiredCST)
	want := "2026-06-22 15:22:50"

	if got != want {
		t.Fatalf("formatJifeiDeadline(CST %s) = %q, want %q (Beijing wall-clock literal)",
			expiredCST.Format(time.RFC3339), got, want)
	}
}

// TestFormatJifeiDeadline_BUG34_RoundTripWithCheckRenew 端到端契约保护：
//
// 模拟完整 trade 内部的 producer/consumer 链路：
//  1. trade.PlaceRenewOrder 用 formatJifeiDeadline 把 UTC time.Time 拼成 jifei 字符串
//  2. jifei 收到字符串后存盘，下次 checkRenew 回调时原样回传
//  3. 回调端按 PDF §2.2 layout + jifei 协议时区（北京时间）解析为 time.Time
//  4. 解析得到的 time.Time 与最初的 UTC time.Time 必须 Equal（绝对时刻一致）
//
// 这是 BUG-33 + BUG-34 修复合力保证的核心契约：跨 pod 时区、跨 producer/consumer 仍能精确等价。
func TestFormatJifeiDeadline_BUG34_RoundTripWithCheckRenew(t *testing.T) {
	expiredUTC := time.Date(2026, 6, 22, 7, 22, 50, 0, time.UTC)

	// (1) producer：trade.PlaceRenewOrder 拼字符串。
	jifeiStr := formatJifeiDeadline(expiredUTC)

	// (2) jifei 透传 — 由本测试用 strings.Contains 模拟（非空 + 包含日期）。
	if jifeiStr == "" || !strings.Contains(jifeiStr, "2026-06-22") {
		t.Fatalf("formatJifeiDeadline produced unexpected literal %q", jifeiStr)
	}

	// (3) consumer：模拟 verifyCurDeadline 的解析逻辑（与 checkrenew/handler.go 对齐）。
	jifeiTZ := time.FixedZone("CST", 8*3600)
	parsed, err := time.ParseInLocation(jifei.CurDeadlineLayout, jifeiStr, jifeiTZ)
	if err != nil {
		t.Fatalf("ParseInLocation(%q) failed: %v", jifeiStr, err)
	}

	// (4) 绝对时刻必须等价。
	if !parsed.Equal(expiredUTC) {
		t.Fatalf("round-trip lost absolute instant: original=%s, parsed=%s, jifeiStr=%q",
			expiredUTC.Format(time.RFC3339Nano),
			parsed.Format(time.RFC3339Nano),
			jifeiStr)
	}
}
