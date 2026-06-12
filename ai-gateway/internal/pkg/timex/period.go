// Package timex provides time-arithmetic helpers shared across ai-gateway.
//
// The semantics here are intentionally aligned with ctl/pkg/logic/pass/logic.go's
// addMonthsNatural / daysInMonth helpers, so that ctl-side `CalcExpiredTime`
// and ai-gateway-side `AddPeriod` produce identical PeriodEnd values when given
// the same (start, value, unit) tuple. Q9=i1 in the monthly-token-refresh
// design (.tmp/aigateway-monthly-token-refresh-design.md) requires this.
package timex

import (
	"strings"
	"time"
)

// AddMonthsNatural advances start by `months` calendar months. When the target
// month does not have a corresponding day-of-month (e.g. Jan 31 + 1m), the
// result is clamped to the LAST day of the target month (Feb 28 or Feb 29 in a
// leap year). This matches the ctl helper of the same name and the product
// rule pinned in Q2=b3 (2026-05-18 user decision).
func AddMonthsNatural(start time.Time, months int) time.Time {
	if months == 0 {
		return start
	}
	y, m, d := start.Date()

	totalMonths := int(m) + months
	// Normalise into [1, 12]; works for both forward and backward shifts.
	targetYear := y + (totalMonths-1)/12
	targetMonth := time.Month(((totalMonths-1)%12 + 12) % 12 + 1)
	if totalMonths <= 0 {
		// Re-normalise for the negative case where the modulo above already
		// pushed us forward by 12.
		targetYear = y + totalMonths/12
		if totalMonths%12 != 0 {
			targetYear--
		}
		targetMonth = time.Month(((totalMonths%12)+12-1)%12 + 1)
	}

	maxDay := DaysInMonth(targetYear, targetMonth)
	if d > maxDay {
		d = maxDay
	}
	return time.Date(targetYear, targetMonth, d,
		start.Hour(), start.Minute(), start.Second(), start.Nanosecond(),
		start.Location())
}

// DaysInMonth returns the number of days in the given year+month, accounting
// for leap years (Feb 29).
func DaysInMonth(year int, month time.Month) int {
	return time.Date(year, month+1, 0, 0, 0, 0, 0, time.UTC).Day()
}

// AddPeriod advances start by (value, unit). Supported units (case-insensitive):
//
//	"m" / "month"  / "months"   → AddMonthsNatural (clamps to last day of month)
//	"d" / "day"    / "days"     → time.AddDate(0, 0, value)
//	"y" / "year"   / "years"    → time.AddDate(value, 0, 0)
//
// Returns start unchanged for value==0 or unsupported units; callers MUST
// validate `unit` separately if they want to reject unknowns.
func AddPeriod(start time.Time, value int, unit string) time.Time {
	if value == 0 {
		return start
	}
	switch normaliseUnit(unit) {
	case "months":
		return AddMonthsNatural(start, value)
	case "days":
		return start.AddDate(0, 0, value)
	case "years":
		return start.AddDate(value, 0, 0)
	default:
		return start
	}
}

// NormalisePeriodUnit returns the canonical lowercase unit string for the
// supported set, or empty string for unknown inputs. Exposed for callers that
// want to validate input early (e.g. handler layer).
func NormalisePeriodUnit(unit string) string {
	return normaliseUnit(unit)
}

func normaliseUnit(unit string) string {
	switch strings.ToLower(strings.TrimSpace(unit)) {
	case "m", "month", "months":
		return "months"
	case "d", "day", "days":
		return "days"
	case "y", "year", "years":
		return "years"
	default:
		return ""
	}
}
