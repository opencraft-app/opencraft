import assert from 'node:assert/strict';
import test from 'node:test';
import { subscriptionProxyTarget } from '../../apps/codex-core/src/subscription-proxy-target.js';
const path = '/personal/' + 'a'.repeat(64) + '/v1/responses';
test('subscription forwarding remains bound to the owned literal loopback proxy', () => {
  assert.equal(subscriptionProxyTarget('http://127.0.0.1:4321/v1', path).href, 'http://127.0.0.1:4321' + path);
  for (const base of ['https://example.com', 'http://localhost:4321', 'http://169.254.169.254:80', 'http://127.0.0.1',
    'http://u:p@127.0.0.1:4321', 'http://127.0.0.1:4321/?key=value', 'http://127.0.0.1:4321/#fragment']) {
    assert.throws(() => subscriptionProxyTarget(base, path), /Invalid local account proxy/);
  }
});
test('subscription forwarding rejects absolute URLs, traversal and non-API paths', () => {
  for (const route of ['https://example.com', '//example.com', '/health', path + '?url=https://example.com',
    path + '#fragment', path.replace('/v1/', '/../v1/'), path.replace('/v1/', '/%2f/v1/')]) {
    assert.throws(() => subscriptionProxyTarget('http://127.0.0.1:4321', route), /Invalid subscription route/);
  }
});
