import assert from "node:assert/strict";
import test from "node:test";
import { BUNDLED_SOURCE, decodeContentSource, encodeContentSource, isSelfHostedNavigation, selfHostedSource } from "../../apps/mobile/src/runtime/content-source";

test("source defaults to packaged code and persists only an explicitly selected HTTPS website", () => {
  assert.deepEqual(decodeContentSource(null), BUNDLED_SOURCE);
  const source = selfHostedSource(" https://my.opencraft.example/workspace/ ");
  assert.deepEqual(decodeContentSource(encodeContentSource(source)), source);
  assert.deepEqual(decodeContentSource(encodeContentSource(BUNDLED_SOURCE)), BUNDLED_SOURCE);
});

test("source settings reject executable schemes, embedded credentials and secret-bearing URLs", () => {
  for (const value of ["http://server.example/", "file:///private/data", "javascript:alert(1)", "data:text/html,test", "https://user:secret@server.example", "https://server.example/?token=secret", "https://server.example/#secret", "", "https://" + "a".repeat(2050)]) {
    assert.throws(() => selfHostedSource(value), value);
  }
});

test("unknown or damaged stored choices cannot silently load a remote or bundled replacement", () => {
  for (const value of ["{", "null", "[]", '{}', '{"version":2,"kind":"bundled"}', '{"version":1,"kind":"unknown"}', '{"version":1,"kind":"self-hosted","url":"http://server.example"}']) {
    assert.throws(() => decodeContentSource(value), value);
  }
});

test("self-hosted view admits only its own HTTPS origin; credentials and foreign origin never inherit it", () => {
  const source = selfHostedSource("https://server.example/prefix/");
  assert.equal(isSelfHostedNavigation(source, "https://server.example/prefix/thread/1"), true);
  assert.equal(isSelfHostedNavigation(source, "https://server.example/login?flow=1"), true);
  for (const url of ["http://server.example", "https://other.example", "https://server.example.attacker.test", "https://name:secret@server.example", "file:///private", "about:blank", "invalid"]) {
    assert.equal(isSelfHostedNavigation(source, url), false, url);
  }
  assert.equal(isSelfHostedNavigation(BUNDLED_SOURCE, "https://server.example/"), false);
});
