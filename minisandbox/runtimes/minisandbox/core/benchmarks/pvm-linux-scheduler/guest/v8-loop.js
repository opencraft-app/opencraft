// SPDX-License-Identifier: MIT OR Apache-2.0

"use strict";

const durationNs = BigInt(process.argv[2]);
let value = 0x12345678 | 0;

// Give V8 time to optimize the loop before the measured interval.
const warmDeadline = process.hrtime.bigint() + 100_000_000n;
while (process.hrtime.bigint() < warmDeadline) {
  for (let index = 0; index < 10000; index++) {
    value = (Math.imul(value, 1664525) + 1013904223) | 0;
  }
}

const started = process.hrtime.bigint();
const deadline = started + durationNs;
let operations = 0;
while (process.hrtime.bigint() < deadline) {
  for (let index = 0; index < 10000; index++) {
    value = (Math.imul(value, 1664525) + 1013904223) | 0;
  }
  operations += 10000;
}
const elapsed = process.hrtime.bigint() - started;
console.log(
  `MSBENCH_RESULT mode=cpu-v8 ops=${operations} elapsed_ns=${elapsed} checksum=${value >>> 0}`,
);
