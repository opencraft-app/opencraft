import assert from "node:assert/strict";
import test from "node:test";

import { installRandomUuidFallback } from "../apps/workbench-web/src/runtime/web-crypto-compat.js";

test("ordinary HTTP browsers derive UUID v4 from getRandomValues", () => {
  let seed = 0;
  const crypto = {
    getRandomValues(bytes: Uint8Array) {
      for (let index = 0; index < bytes.length; index += 1) bytes[index] = seed++ & 0xff;
      return bytes;
    },
  };
  assert.equal(installRandomUuidFallback({ crypto }), true);
  const first = (crypto as typeof crypto & { randomUUID(): string }).randomUUID();
  const second = (crypto as typeof crypto & { randomUUID(): string }).randomUUID();
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.notEqual(first, second);
  assert.equal(installRandomUuidFallback({ crypto }), false);
});

test("UUID compatibility never falls back to Math.random", () => {
  assert.throws(() => installRandomUuidFallback({ crypto: undefined }), /secure random values/u);
});
