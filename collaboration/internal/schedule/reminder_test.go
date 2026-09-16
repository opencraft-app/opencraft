package schedule

import (
	"testing"
	"time"
)

func TestNextReminderFireSupportsOnceAndStandardCron(t *testing.T) {
	now := time.Date(2026, 7, 30, 12, 0, 0, 0, time.UTC)

	once, err := NextReminderFire(
		"once",
		"2026-07-30T12:05:00+00:00",
		"Asia/Shanghai",
		now,
	)
	if err != nil || !once.Equal(time.Date(2026, 7, 30, 12, 5, 0, 0, time.UTC)) {
		t.Fatalf("once = (%s, %v)", once, err)
	}

	cronFire, err := NextReminderFire("cron", "30 20 * * *", "Asia/Shanghai", now)
	if err != nil ||
		!cronFire.Equal(time.Date(2026, 7, 30, 12, 30, 0, 0, time.UTC)) {
		t.Fatalf("cron = (%s, %v)", cronFire, err)
	}
}

func TestNextReminderFireRejectsInvalidAndExpiredSchedules(t *testing.T) {
	now := time.Date(2026, 7, 30, 12, 0, 0, 0, time.UTC)
	for _, test := range []struct {
		name     string
		kind     string
		schedule string
		timezone string
	}{
		{name: "expired once", kind: "once", schedule: "2026-07-30T11:59:00Z", timezone: "UTC"},
		{name: "invalid once", kind: "once", schedule: "tomorrow", timezone: "UTC"},
		{name: "seconds cron", kind: "cron", schedule: "0 30 20 * * *", timezone: "UTC"},
		{name: "invalid timezone", kind: "cron", schedule: "30 20 * * *", timezone: "Mars/Olympus"},
		{name: "unknown kind", kind: "interval", schedule: "5m", timezone: "UTC"},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := NextReminderFire(
				test.kind,
				test.schedule,
				test.timezone,
				now,
			); err == nil {
				t.Fatal("expected validation error")
			}
		})
	}
}
