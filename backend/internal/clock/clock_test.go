package clock

import (
	"testing"
	"time"
)

func TestNormalize转为UTC并截断到毫秒(t *testing.T) {
	location := time.FixedZone("CST", 8*60*60)
	input := time.Date(2026, 7, 30, 19, 22, 33, 987654321, location)

	got := Normalize(input)
	want := time.Date(2026, 7, 30, 11, 22, 33, 987000000, time.UTC)
	if !got.Equal(want) {
		t.Fatalf("Normalize() = %s，期望 %s", got, want)
	}
	if got.Location() != time.UTC {
		t.Fatalf("Normalize() location = %s，期望 UTC", got.Location())
	}
}
