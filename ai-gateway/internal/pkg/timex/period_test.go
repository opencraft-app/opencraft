package timex

import (
	"testing"
	"time"
)

func mustDate(t *testing.T, year int, month time.Month, day int) time.Time {
	t.Helper()
	return time.Date(year, month, day, 12, 34, 56, 789, time.UTC)
}

func TestAddMonthsNatural_BasicForward(t *testing.T) {
	cases := []struct {
		name     string
		start    time.Time
		months   int
		wantYear int
		wantMon  time.Month
		wantDay  int
	}{
		{"plain_jan15_plus1", mustDate(t, 2026, time.January, 15), 1, 2026, time.February, 15},
		{"plain_jan15_plus3", mustDate(t, 2026, time.January, 15), 3, 2026, time.April, 15},
		{"cross_year_dec15_plus1", mustDate(t, 2026, time.December, 15), 1, 2027, time.January, 15},
		{"cross_year_oct31_plus3", mustDate(t, 2026, time.October, 31), 3, 2027, time.January, 31},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := AddMonthsNatural(tc.start, tc.months)
			if got.Year() != tc.wantYear || got.Month() != tc.wantMon || got.Day() != tc.wantDay {
				t.Errorf("AddMonthsNatural(%v, %d) = %v; want %d-%s-%d",
					tc.start.Format("2006-01-02"), tc.months, got, tc.wantYear, tc.wantMon, tc.wantDay)
			}
		})
	}
}

func TestAddMonthsNatural_MonthEndOverflow(t *testing.T) {
	// Q2=b3 拍板：1/31 + 1m → 2/28（非闰年）/ 2/29（闰年）；3/31 + 1m → 4/30。
	cases := []struct {
		name     string
		start    time.Time
		months   int
		wantYear int
		wantMon  time.Month
		wantDay  int
	}{
		{"jan31_plus1_nonleap", mustDate(t, 2026, time.January, 31), 1, 2026, time.February, 28},
		{"jan31_plus1_leap", mustDate(t, 2024, time.January, 31), 1, 2024, time.February, 29},
		{"jan30_plus1_nonleap", mustDate(t, 2026, time.January, 30), 1, 2026, time.February, 28},
		{"mar31_plus1", mustDate(t, 2026, time.March, 31), 1, 2026, time.April, 30},
		{"may31_plus1", mustDate(t, 2026, time.May, 31), 1, 2026, time.June, 30},
		{"jul31_plus1", mustDate(t, 2026, time.July, 31), 1, 2026, time.August, 31},
		{"oct31_plus1", mustDate(t, 2026, time.October, 31), 1, 2026, time.November, 30},
		{"dec31_plus1", mustDate(t, 2026, time.December, 31), 1, 2027, time.January, 31},
		{"feb29_leap_plus1", mustDate(t, 2024, time.February, 29), 1, 2024, time.March, 29},
		{"feb29_leap_plus12", mustDate(t, 2024, time.February, 29), 12, 2025, time.February, 28},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := AddMonthsNatural(tc.start, tc.months)
			if got.Year() != tc.wantYear || got.Month() != tc.wantMon || got.Day() != tc.wantDay {
				t.Errorf("AddMonthsNatural(%v, %d) = %v; want %d-%s-%d",
					tc.start.Format("2006-01-02"), tc.months, got, tc.wantYear, tc.wantMon, tc.wantDay)
			}
		})
	}
}

func TestAddMonthsNatural_PreservesTimeOfDay(t *testing.T) {
	start := time.Date(2026, time.January, 15, 23, 45, 12, 0, time.UTC)
	got := AddMonthsNatural(start, 1)
	if got.Hour() != 23 || got.Minute() != 45 || got.Second() != 12 {
		t.Errorf("time-of-day not preserved: got %v", got)
	}
}

func TestAddMonthsNatural_Zero(t *testing.T) {
	start := mustDate(t, 2026, time.May, 18)
	got := AddMonthsNatural(start, 0)
	if !got.Equal(start) {
		t.Errorf("AddMonthsNatural(_, 0) should be no-op; got %v", got)
	}
}

func TestDaysInMonth(t *testing.T) {
	cases := []struct {
		year  int
		month time.Month
		want  int
	}{
		{2026, time.January, 31},
		{2026, time.February, 28},
		{2024, time.February, 29}, // leap
		{2000, time.February, 29}, // 400-divisible leap
		{1900, time.February, 28}, // 100-divisible non-leap
		{2026, time.April, 30},
	}
	for _, tc := range cases {
		got := DaysInMonth(tc.year, tc.month)
		if got != tc.want {
			t.Errorf("DaysInMonth(%d, %s) = %d; want %d", tc.year, tc.month, got, tc.want)
		}
	}
}

func TestAddPeriod(t *testing.T) {
	start := mustDate(t, 2026, time.January, 31)
	cases := []struct {
		name     string
		value    int
		unit     string
		wantYear int
		wantMon  time.Month
		wantDay  int
	}{
		{"months_short", 1, "m", 2026, time.February, 28},
		{"months_long", 1, "months", 2026, time.February, 28},
		{"months_uppercase", 1, "Month", 2026, time.February, 28},
		{"days_short", 7, "d", 2026, time.February, 7},
		{"days_long", 30, "days", 2026, time.March, 2},
		{"years_short", 1, "y", 2027, time.January, 31},
		{"years_long", 1, "years", 2027, time.January, 31},
		{"zero_value", 0, "months", 2026, time.January, 31},
		{"unknown_unit", 5, "weeks", 2026, time.January, 31},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := AddPeriod(start, tc.value, tc.unit)
			if got.Year() != tc.wantYear || got.Month() != tc.wantMon || got.Day() != tc.wantDay {
				t.Errorf("AddPeriod(%v, %d, %q) = %v; want %d-%s-%d",
					start.Format("2006-01-02"), tc.value, tc.unit, got,
					tc.wantYear, tc.wantMon, tc.wantDay)
			}
		})
	}
}

func TestNormalisePeriodUnit(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"m", "months"},
		{"M", "months"},
		{"month", "months"},
		{"  Months  ", "months"},
		{"d", "days"},
		{"DAY", "days"},
		{"y", "years"},
		{"Year", "years"},
		{"", ""},
		{"weeks", ""},
	}
	for _, tc := range cases {
		got := NormalisePeriodUnit(tc.in)
		if got != tc.want {
			t.Errorf("NormalisePeriodUnit(%q) = %q; want %q", tc.in, got, tc.want)
		}
	}
}
