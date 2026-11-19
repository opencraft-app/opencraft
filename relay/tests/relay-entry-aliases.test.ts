import test from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { joinEntryOrigin } from '../relay-entry-aliases.js';
test('Join derives approved browser authorities without trusting forwarded hosts or schemes', () => {
  const resolve = joinEntryOrigin('https://join.devcloud.woa.com');
  const origin = (host: string, extra = {}) => resolve({ headers: { host, ...extra } } as IncomingMessage);
  for (const host of ['join.woa.com', 'lighthouse.join.woa.com', 'a.b.join.woa.com', 'JOIN.WOA.COM', 'join.woa.com:443']) assert.equal(origin(host), new URL('https://' + host).origin);
  for (const host of ['join.woa.com.evil.test', 'eviljoin.woa.com', 'join.woa.com:8080', 'join.woa.com:80', 'join.woa.com@evil.test', '-bad.join.woa.com', 'bad..join.woa.com', '127.0.0.1', 'join.woa.com.', 'join.woa.com/path']) assert.equal(origin(host), null, host);
  assert.equal(origin('evil.test', { 'x-forwarded-host': 'join.woa.com' }), null);
  assert.equal(origin('join.woa.com', { 'x-forwarded-proto': 'http' }), 'https://join.woa.com');
  assert.throws(() => joinEntryOrigin('https://join.woa.com/path'));
});
