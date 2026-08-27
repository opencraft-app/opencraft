package pass

import "testing"

func TestParseDianshiTimeSpanUnit(t *testing.T) {
	tests := []struct {
		name      string
		input     string
		period    int
		timeUnit  string
		wantError bool
	}{
		{name: "one month", input: "1m", period: 1, timeUnit: "m"},
		{name: "fourteen days", input: "14D", period: 14, timeUnit: "d"},
		{name: "missing period", input: "m", wantError: true},
		{name: "zero period", input: "0m", wantError: true},
		{name: "missing unit", input: "1", wantError: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			period, timeUnit, err := parseDianshiTimeSpanUnit(tt.input)
			if tt.wantError {
				if err == nil {
					t.Fatalf("parseDianshiTimeSpanUnit(%q) expected error", tt.input)
				}
				return
			}
			if err != nil {
				t.Fatalf("parseDianshiTimeSpanUnit(%q): %v", tt.input, err)
			}
			if period != tt.period || timeUnit != tt.timeUnit {
				t.Fatalf("parseDianshiTimeSpanUnit(%q)=(%d,%q), want (%d,%q)", tt.input, period, timeUnit, tt.period, tt.timeUnit)
			}
		})
	}
}
