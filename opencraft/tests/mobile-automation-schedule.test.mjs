import assert from 'node:assert/strict';
import { buildMobileSchedule, initialMobileSchedule, localDateTomorrow } from '../apps/workbench-expo/src/runtime/mobile-automation-schedule.ts';

assert.equal(buildMobileSchedule({ mode: 'daily', time: '09:30' }), '30 9 * * *');
assert.equal(buildMobileSchedule({ mode: 'interval', count: '2', unit: 'h' }), 'every 2h');
assert.equal(buildMobileSchedule({ mode: 'interval', count: '0', unit: 'h' }), null);
assert.deepEqual(initialMobileSchedule('30 9 * * *'), { mode: 'daily', time: '09:30' });
assert.deepEqual(initialMobileSchedule('custom schedule', 'Existing plan'), { mode: 'keep', source: 'custom schedule', label: 'Existing plan' });
assert.equal(buildMobileSchedule({ mode: 'once', date: '2026-02-30', time: '09:00' }, new Date('2026-01-01T00:00:00Z')), null);
assert.equal(localDateTomorrow(new Date(2026, 11, 31)).slice(0, 10), '2027-01-01');
process.stdout.write('Native schedule validation passed.\n');
