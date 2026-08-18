package pass

import (
	"errors"
	"testing"
	"time"

	"ctl/pkg/errcode"
	bundlemodel "ctl/pkg/model/bundle"
	passmodel "ctl/pkg/model/pass"
)

func TestRenewPassParentRetryBudget(t *testing.T) {
	const renewInstanceRetryWindowSeconds = int64(60 * 60)

	if renewPassParentMaxExecuteCount != 1<<30 {
		t.Fatalf("renew parent max execute count = %d, want %d", renewPassParentMaxExecuteCount, 1<<30)
	}
	if retryWindow := renewPassParentExecuteIntervalSeconds * int64(renewPassParentMaxExecuteCount); retryWindow <= renewInstanceRetryWindowSeconds {
		t.Fatalf("renew parent retry window = %ds, must exceed child retry window %ds", retryWindow, renewInstanceRetryWindowSeconds)
	}
}

// TestCalcExpiredTime 表驱动覆盖 m/d/y 三个 time_unit 分支 + 边界
//
// trade-pass-renew §12 Q19=b 关闭后（2026-05-15 v3.8），CalcExpiredTime 必须支持 'y' 单位；
// 本测试用例特别覆盖闰年边界（2024-02-29 + 1y → 2025-02-28）保证 time.AddDate 范式无副作用。
func TestCalcExpiredTime(t *testing.T) {
	loc := time.UTC
	cases := []struct {
		name    string
		start   time.Time
		span    int
		unit    string
		want    time.Time
		wantErr bool
	}{
		// === m (month) 分支 ===
		{
			name:  "month_simple",
			start: time.Date(2026, 1, 15, 12, 0, 0, 0, loc),
			span:  1,
			unit:  bundlemodel.TimeUnitMonth,
			want:  time.Date(2026, 2, 15, 12, 0, 0, 0, loc),
		},
		{
			name:  "month_overflow_31_to_30",
			start: time.Date(2026, 3, 31, 0, 0, 0, 0, loc),
			span:  1,
			unit:  bundlemodel.TimeUnitMonth,
			want:  time.Date(2026, 4, 30, 0, 0, 0, 0, loc), // 4月没有31日 → 取月末30
		},
		{
			name:  "month_year_rollover",
			start: time.Date(2026, 11, 5, 0, 0, 0, 0, loc),
			span:  3,
			unit:  bundlemodel.TimeUnitMonth,
			want:  time.Date(2027, 2, 5, 0, 0, 0, 0, loc),
		},
		// === d (day) 分支 ===
		{
			name:  "day_simple",
			start: time.Date(2026, 5, 15, 0, 0, 0, 0, loc),
			span:  7,
			unit:  bundlemodel.TimeUnitDay,
			want:  time.Date(2026, 5, 22, 0, 0, 0, 0, loc),
		},
		{
			name:  "day_month_rollover",
			start: time.Date(2026, 5, 28, 0, 0, 0, 0, loc),
			span:  10,
			unit:  bundlemodel.TimeUnitDay,
			want:  time.Date(2026, 6, 7, 0, 0, 0, 0, loc),
		},
		// === y (year) 分支 — trade-pass-renew §12 Q19=b 落地 ===
		{
			name:  "year_simple",
			start: time.Date(2026, 5, 15, 0, 0, 0, 0, loc),
			span:  1,
			unit:  bundlemodel.TimeUnitYear,
			want:  time.Date(2027, 5, 15, 0, 0, 0, 0, loc),
		},
		{
			name:  "year_multi",
			start: time.Date(2026, 5, 15, 0, 0, 0, 0, loc),
			span:  3,
			unit:  bundlemodel.TimeUnitYear,
			want:  time.Date(2029, 5, 15, 0, 0, 0, 0, loc),
		},
		{
			// 闰年 → 非闰年边界：time.AddDate 自动溢出到 3-1（Go 标准库语义）
			// trade-pass-renew §12 Q19=b 注释明确依赖此行为，与 m 分支 addMonthsNatural 月末截断风格不一致
			// 但符合 time.AddDate 文档"normalize result"的本意。
			name:  "year_leap_to_nonleap_feb29",
			start: time.Date(2024, 2, 29, 0, 0, 0, 0, loc),
			span:  1,
			unit:  bundlemodel.TimeUnitYear,
			want:  time.Date(2025, 3, 1, 0, 0, 0, 0, loc), // Go time.AddDate normalize：Feb 29 + 1y → Mar 1
		},
		{
			name:  "year_leap_to_leap_feb29",
			start: time.Date(2024, 2, 29, 0, 0, 0, 0, loc),
			span:  4,
			unit:  bundlemodel.TimeUnitYear,
			want:  time.Date(2028, 2, 29, 0, 0, 0, 0, loc), // 4 年后还是闰年 → 保留 Feb 29
		},
		// === 错误分支 ===
		{
			name:    "invalid_span_zero",
			start:   time.Date(2026, 1, 1, 0, 0, 0, 0, loc),
			span:    0,
			unit:    bundlemodel.TimeUnitMonth,
			wantErr: true,
		},
		{
			name:    "invalid_span_negative",
			start:   time.Date(2026, 1, 1, 0, 0, 0, 0, loc),
			span:    -1,
			unit:    bundlemodel.TimeUnitDay,
			wantErr: true,
		},
		{
			name:    "invalid_unit_unknown",
			start:   time.Date(2026, 1, 1, 0, 0, 0, 0, loc),
			span:    1,
			unit:    "p", // p 不在 {m, d, y} 集合中（trade-pass-renew §12 Q12=a 严格校验）
			wantErr: true,
		},
		{
			name:    "invalid_unit_empty",
			start:   time.Date(2026, 1, 1, 0, 0, 0, 0, loc),
			span:    1,
			unit:    "",
			wantErr: true,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := CalcExpiredTime(c.start, c.span, c.unit)
			if c.wantErr {
				if err == nil {
					t.Fatalf("CalcExpiredTime(%v, %d, %q) expected error, got nil; result=%v",
						c.start, c.span, c.unit, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("CalcExpiredTime(%v, %d, %q) unexpected error: %v", c.start, c.span, c.unit, err)
			}
			if !got.Equal(c.want) {
				t.Fatalf("CalcExpiredTime(%v, %d, %q) = %v, want %v", c.start, c.span, c.unit, got, c.want)
			}
		})
	}
}

// TestClassifyRenewStatusError 覆盖 RenewPass 异常分支的 status → errcode 映射
//
// 与设计稿 §3.1 异常分支表对齐：renewing → ErrPassRenewing / isolating → ErrPassIsolating /
// 未知 → ErrPassNotRenewable / active+isolated 走兜底（理论不到这）
func TestClassifyRenewStatusError(t *testing.T) {
	cases := []struct {
		name      string
		status    string
		wantErrIs error // errors.Is 目标（nil 表示不做 Is 校验，仅断言非 nil）
	}{
		{name: "renewing_returns_renewing_err", status: passmodel.StatusRenewing, wantErrIs: errcode.ErrPassRenewing},
		{name: "isolating_returns_isolating_err", status: passmodel.StatusIsolating, wantErrIs: errcode.ErrPassIsolating},
		{name: "active_returns_invalid_param", status: passmodel.StatusActive, wantErrIs: errcode.ErrPassInvalidParam},
		{name: "isolated_returns_invalid_param", status: passmodel.StatusIsolated, wantErrIs: errcode.ErrPassInvalidParam},
		{name: "unknown_returns_not_renewable", status: "deleting", wantErrIs: errcode.ErrPassNotRenewable},
		{name: "empty_returns_not_renewable", status: "", wantErrIs: errcode.ErrPassNotRenewable},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := classifyRenewStatusError(c.status)
			if err == nil {
				t.Fatalf("classifyRenewStatusError(%q) expected non-nil err", c.status)
			}
			if c.wantErrIs != nil && !errors.Is(err, c.wantErrIs) {
				t.Fatalf("classifyRenewStatusError(%q) = %v, want errors.Is %v", c.status, err, c.wantErrIs)
			}
		})
	}
}

// TestRenewPassParamValidation 覆盖 RenewPass 入口参数校验的纯路径（不打 DB 桩）
//
// 仅覆盖参数校验失败的 case — 这些 case 在 GetByPassID 之前就 short-circuit 返错，
// 无需 mock dao；valid 参数路径的"分支 A 同步 / 分支 B 异步占位"留 R-D 集成测试覆盖
// （届时 sandbox-bj-7 测试集群有真实 DB，无需 dao mock）。
func TestRenewPassParamValidation(t *testing.T) {
	l := &logic{}
	cases := []struct {
		name     string
		passID   string
		span     int
		unit     string
		wantErrs []error
	}{
		{name: "empty_pass_id", passID: "", span: 1, unit: bundlemodel.TimeUnitMonth, wantErrs: []error{errcode.ErrPassInvalidParam}},
		{name: "whitespace_pass_id", passID: "   ", span: 1, unit: bundlemodel.TimeUnitDay, wantErrs: []error{errcode.ErrPassInvalidParam}},
		{name: "zero_span", passID: "pass-12345678", span: 0, unit: bundlemodel.TimeUnitMonth, wantErrs: []error{errcode.ErrPassInvalidParam}},
		{name: "negative_span", passID: "pass-12345678", span: -3, unit: bundlemodel.TimeUnitYear, wantErrs: []error{errcode.ErrPassInvalidParam}},
		{name: "invalid_unit_p", passID: "pass-12345678", span: 1, unit: "p", wantErrs: []error{errcode.ErrPassInvalidParam}},
		{name: "invalid_unit_empty", passID: "pass-12345678", span: 1, unit: "", wantErrs: []error{errcode.ErrPassInvalidParam}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, _, err := l.RenewPass(c.passID, 0, c.span, c.unit)
			if err == nil {
				t.Fatalf("RenewPass(%q, %d, %q) expected non-nil err", c.passID, c.span, c.unit)
			}
			for _, want := range c.wantErrs {
				if !errors.Is(err, want) {
					t.Fatalf("RenewPass(%q, %d, %q) = %v, want errors.Is %v", c.passID, c.span, c.unit, err, want)
				}
			}
		})
	}
}

// TestFormatCurDeadlineForJifei 验证：不论输入 time.Time 处于哪个 location，
// formatCurDeadlineForJifei 输出永远是北京时间（UTC+8）字面值，与 trade
// jifeiproto.FormatCurDeadline / jifei 协议契约一致。
//
// v1.7.32 BUG（2026-05-23 sandbox-bj-7 实测）：
//
//	续费下单 ExpiredTime.Format("2006-01-02 15:04:05") 不指定 location，
//	输出跟随容器 time.Local —— ctl-api TZ=Asia/Shanghai 时输出 CST，trade 容器
//	TZ=UTC 解析时按 CST 解析却得到 UTC 字面值，jifei.checkRenew 严格字符串比对
//	失败 → 600404 CurDeadlineMismatch。本 helper 强制 .In(CST) 后 Format，
//	让结果与 ctl/trade 容器 TZ env 完全解耦。
func TestFormatCurDeadlineForJifei(t *testing.T) {
	// 同一绝对时刻，先后用 UTC / CST / America/New_York 三种 location 表达，
	// 期望 helper 输出永远等于北京时间字面值 "2026-06-23 17:06:00"。
	wantBeijing := "2026-06-23 17:06:00"

	utcTime := time.Date(2026, 6, 23, 9, 6, 0, 0, time.UTC)
	cstLoc := time.FixedZone("CST", 8*3600)
	cstTime := time.Date(2026, 6, 23, 17, 6, 0, 0, cstLoc)
	nyLoc := time.FixedZone("EST", -5*3600)
	nyTime := time.Date(2026, 6, 23, 4, 6, 0, 0, nyLoc)

	cases := []struct {
		name string
		in   time.Time
	}{
		{"UTC", utcTime},
		{"CST", cstTime},
		{"EST", nyTime},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := formatCurDeadlineForJifei(c.in)
			if got != wantBeijing {
				t.Fatalf("formatCurDeadlineForJifei(%v) = %q, want %q",
					c.in, got, wantBeijing)
			}
		})
	}
}
