import assert from "node:assert/strict";
import test from "node:test";
import {
  sidebarCalendarDay,
  sidebarNextCalendarDay,
} from "../../apps/workbench-web/src/components/use-sidebar-calendar-day";

test("calendar snapshot is stable intra-day and advances at local midnight", () => {
  const first = new Date(2026, 10, 18, 0, 0).getTime();
  assert.equal(sidebarCalendarDay(first + 1234), first);
  assert.equal(sidebarCalendarDay(new Date(2026, 10, 18, 23, 59, 59).getTime()), first);
  const next = new Date(2026, 10, 19).getTime();
  assert.equal(sidebarNextCalendarDay(first), next);
  assert.equal(sidebarCalendarDay(next), next);
  assert.equal(sidebarNextCalendarDay(next - 1) - (next - 1), 1);
});

test("local midnight scheduling follows 23/25-hour DST days, not a fixed 24h interval", () => {
  const previous = process.env.TZ;
  try {
    process.env.TZ = "America/New_York";
    for (const [month, day, hours] of [
      [2, 8, 23],
      [10, 1, 25],
    ] as const) {
      const midnight = new Date(2026, month, day).getTime();
      assert.equal(sidebarNextCalendarDay(midnight) - midnight, hours * 3600000);
      assert.equal(sidebarCalendarDay(midnight + hours * 3600000 - 1), midnight);
    }
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});
