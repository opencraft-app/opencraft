import assert from "node:assert/strict";
import test from "node:test";
import { BUNDLED_SOURCE, decodeContentSource, encodeContentSource, isSelfHostedNavigation, selfHostedAuthentication, selfHostedSource } from "../../apps/mobile/src/runtime/content-source";

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

test("configured web authentication can leave and return to the selected HTTPS site in the same view", () => {
  const source = selfHostedSource("https://server.example/workspace");
  const authentication = selfHostedAuthentication(" https://SERVER.example/ ", "https://login.example");
  assert.ok(authentication);
  const signIn = "https://login.example/signin?state=issued-by-server&login_hint=user@example.com";
  assert.equal(isSelfHostedNavigation(source, signIn, authentication), true);
  assert.equal(isSelfHostedNavigation(source, "https://server.example/callback?code=issued-by-server", authentication), true);
  assert.equal(isSelfHostedNavigation(source, signIn), false);
  assert.equal(isSelfHostedNavigation(selfHostedSource("https://other.example"), signIn, authentication), false);
  assert.equal(isSelfHostedNavigation(BUNDLED_SOURCE, signIn, authentication), false);
  for (const target of ["http://login.example", "https://login.example:444", "https://login.example.other.test", "https://user@login.example", "https://login.example\\@other.example", "https://other.example"]) {
    assert.equal(isSelfHostedNavigation(source, target, authentication), false, target);
  }
});

test("an incomplete or invalid authentication configuration leaves self-hosted navigation same-origin", () => {
  const source = selfHostedSource("https://server.example");
  for (const invalid of [undefined, "", "http://login.example", "https://login.example/path", "https://login.example/?", "https://login.example/#fragment", "https://user@login.example", "*"]) {
    const authentication = selfHostedAuthentication("https://server.example", invalid);
    assert.equal(authentication, undefined, String(invalid));
    assert.equal(isSelfHostedNavigation(source, "https://login.example", authentication), false);
    assert.equal(selfHostedAuthentication(invalid, "https://login.example"), undefined, String(invalid));
  }
});
