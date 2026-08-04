package clock

import (
	"testing"
	"time"
)

type fixedClock struct {
	value time.Time
}

func (c fixedClock) Now() time.Time {
	return c.value
}

func TestClockCanBeReplacedByDeterministicFake(t *testing.T) {
	want := time.Date(2026, time.July, 30, 12, 0, 0, 0, time.UTC)
	var subject Clock = fixedClock{value: want}

	if got := subject.Now(); !got.Equal(want) {
		t.Fatalf("Now() = %v, want %v", got, want)
	}
}

func TestSystemClockUsesDatabaseTimeConvention(t *testing.T) {
	var subject Clock = System{}
	got := subject.Now()

	if got.Location() != time.UTC {
		t.Fatalf("Now() location = %v, want UTC", got.Location())
	}
	if got.Nanosecond()%int(time.Millisecond) != 0 {
		t.Fatalf("Now() = %v, want millisecond precision", got)
	}
}
