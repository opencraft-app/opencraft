import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeUtf8,
  encodeUtf8,
  Utf8StreamDecoder,
} from "../plugins/lightvela-hermes/src/lib/utf8";

test("AppServer transports own UTF-8 encoding across host runtimes", () => {
  const value = "你好，Hermes 👋 — UTF-8";
  assert.equal(decodeUtf8(encodeUtf8(value), { fatal: true }), value);

  const bytes = encodeUtf8(value);
  const decoder = new Utf8StreamDecoder();
  assert.equal(
    decoder.decode(bytes.slice(0, 2), { stream: true })
      + decoder.decode(bytes.slice(2, 7), { stream: true })
      + decoder.decode(bytes.slice(7)),
    value,
  );
});

test("AppServer UTF-8 rejects or replaces invalid byte sequences deterministically", () => {
  assert.throws(() => decodeUtf8(Uint8Array.of(0xc3, 0x28), { fatal: true }), /Invalid UTF-8/u);
  assert.equal(decodeUtf8(Uint8Array.of(0xc3, 0x28)), "�(");
});
