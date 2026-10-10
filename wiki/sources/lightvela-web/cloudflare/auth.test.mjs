import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pbkdf2Sync, createHmac } from 'node:crypto';
import worker from './worker.mjs';

const host = 'https://test.pages.dev';
const password = 'this-is-only-a-test-password-1234';
const salt = '0123456789abcdef0123456789abcdef';
const hash = `pbkdf2-sha256$100000$${salt}$${pbkdf2Sync(password, Buffer.from(salt, 'hex'), 100000, 32, 'sha256').toString('hex')}`;
function environment() {
  let reads = 0;
  return { REPORT_PASSWORD_HASH: hash, REPORT_SESSION_SECRET: 'a-test-only-signing-secret-at-least-32-bytes',
    ASSETS: { fetch: async (request) => { reads++; return new Response('PRIVATE DECK AND IMAGE', { headers: { 'Content-Type': new URL(request.url).pathname.endsWith('.png') ? 'image/png' : 'text/html', 'Cache-Control': 'public, max-age=31536000' } }); } },
    get reads() { return reads; },
  };
}
function req(path, options = {}) { return new Request(host + path, options); }
function cookies(response) { return response.headers.getSetCookie().map((c) => c.split(';')[0]).join('; '); }
async function login(env, supplied = password, ip = '192.0.2.1') {
  const start = await worker.fetch(req('/__auth/login'), env);
  const csrf = (await start.text()).match(/name="csrf" value="([^"]+)"/)[1];
  const response = await worker.fetch(req('/__auth/login', { method: 'POST', headers: { Cookie: cookies(start), Origin: host, 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': ip }, body: new URLSearchParams({ csrf, password: supplied }) }), env);
  return response;
}
function signed(env, payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return data + '.' + createHmac('sha256', env.REPORT_SESSION_SECRET + ':' + env.REPORT_PASSWORD_HASH).update(data).digest('base64url');
}

test('missing or malformed secrets fail closed, including all assets', async () => {
  for (const path of ['/', '/assets/image.png', '/assets/app.js', '/manus-routes.json']) {
    const env = environment(); delete env.REPORT_SESSION_SECRET;
    const res = await worker.fetch(req(path), env);
    assert.equal(res.status, 503); assert.equal(env.reads, 0);
  }
});

test('unauthenticated navigation only redirects to login', async () => {
  const env = environment(); const res = await worker.fetch(req('/'), env);
  assert.equal(res.status, 303); assert.equal(res.headers.get('Location'), '/__auth/login'); assert.equal(env.reads, 0);
});

for (const path of ['/index.html', '/assets/app.js', '/assets/image.png', '/assets/font.woff2', '/manus-routes.json', '/_worker.js', '/anything.json']) {
  test(`unauthenticated ${path} returns no private material`, async () => {
    const env = environment(); const res = await worker.fetch(req(path), env);
    assert.equal(res.status, 401); assert.equal(env.reads, 0);
    assert(!((await res.text()).includes('PRIVATE DECK')));
    assert.equal(res.headers.get('Cache-Control'), 'private, no-store, max-age=0');
  });
}

test('login page contains neither material nor secrets and issues CSRF cookie', async () => {
  const env = environment(); const res = await worker.fetch(req('/__auth/login'), env);
  const text = await res.text(); assert.equal(res.status, 200); assert.equal(env.reads, 0);
  assert(!text.includes(password)); assert(!text.includes(env.REPORT_SESSION_SECRET)); assert(!text.includes(hash));
  assert.match(res.headers.get('Set-Cookie'), /HttpOnly; Secure; SameSite=None/);
  // Browser-native form POSTs need the real Origin for strict same-origin checks.
  assert.equal(res.headers.get('Referrer-Policy'), 'same-origin');
});

test('incorrect password grants no session', async () => {
  const env = environment(); const res = await login(env, 'wrong');
  assert.equal(res.status, 401); assert(!cookies(res).includes('__Host-lightvela_report=')); assert.equal(env.reads, 0);
});

test('valid password creates 8-hour signed session; content and images can then load privately', async () => {
  const env = environment(); const response = await login(env);
  assert.equal(response.status, 303); assert.equal(response.headers.get('Location'), '/');
  assert.match(response.headers.get('Set-Cookie'), /Max-Age=28800; HttpOnly; Secure; SameSite=None/);
  for (const path of ['/', '/assets/image.png', '/assets/app.js']) {
    const res = await worker.fetch(req(path, { headers: { Cookie: cookies(response) } }), env);
    assert.equal(res.status, 200); assert.equal(await res.text(), 'PRIVATE DECK AND IMAGE');
    assert.equal(res.headers.get('Cache-Control'), 'private, no-store, max-age=0');
    assert.equal(res.headers.get('Referrer-Policy'), 'same-origin');
  }
  assert.equal(env.reads, 3);
});

test('tampered cookie is rejected', async () => {
  const env = environment(); const loginRes = await login(env);
  const session = cookies(loginRes).split(';')[0];
  const res = await worker.fetch(req('/assets/image.png', { headers: { Cookie: session + 'tampered' } }), env);
  assert.equal(res.status, 401); assert.equal(env.reads, 0);
});

for (const [label, overrides] of [['expired', { iat: 0, exp: 28800 }], ['wrong host', { aud: 'other.pages.dev' }], ['wrong purpose', { kind: 'csrf' }], ['overlong lifetime', { exp: Math.floor(Date.now() / 1000) + 999999 }]]) {
  test(`${label} session is rejected even with correct signature`, async () => {
    const env = environment(); const at = Math.floor(Date.now() / 1000);
    const value = signed(env, { aud: 'test.pages.dev', kind: 'session', iat: at, exp: at + 28800, ...overrides });
    const res = await worker.fetch(req('/assets/app.js', { headers: { Cookie: '__Host-lightvela_report=' + value } }), env);
    assert.equal(res.status, 401); assert.equal(env.reads, 0);
  });
}

test('cross-site or missing-origin login and logout are rejected', async () => {
  const env = environment();
  for (const path of ['/__auth/login', '/__auth/logout']) for (const origin of ['', 'null', 'https://evil.example']) {
    const res = await worker.fetch(req(path, { method: 'POST', headers: { Origin: origin } }), env);
    assert.equal(res.status, 403);
  }
});

test('CSRF cookie and form token are both required', async () => {
  const env = environment(); const res = await worker.fetch(req('/__auth/login', { method: 'POST', headers: { Origin: host, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'password=' + password }), env);
  assert.equal(res.status, 403); assert.equal(env.reads, 0);
});

test('large login bodies are rejected before password verification', async () => {
  const env = environment(); const res = await worker.fetch(req('/__auth/login', { method: 'POST', headers: { Origin: host, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'a'.repeat(5000) }), env);
  assert.equal(res.status, 413);
});

test('per-isolate failed-login throttle rejects repeated attempts', async () => {
  const env = environment();
  for (let i = 0; i < 10; i++) assert.equal((await login(env, 'wrong', '192.0.2.99')).status, 401);
  const res = await login(env, 'wrong', '192.0.2.99'); assert.equal(res.status, 429); assert(res.headers.get('Retry-After'));
});

test('logout clears host-only session and browser cache', async () => {
  const env = environment(); const res = await worker.fetch(req('/__auth/logout', { method: 'POST', headers: { Origin: host } }), env);
  assert.equal(res.status, 303); assert.match(res.headers.get('Set-Cookie'), /Max-Age=0/);
  assert.equal(res.headers.get('Clear-Site-Data'), '"cache", "storage"');
});

test('secret rotation invalidates previous sessions', async () => {
  const env = environment(); const previous = await login(env);
  env.REPORT_PASSWORD_HASH = hash.replace(salt, 'fedcba9876543210fedcba9876543210');
  const res = await worker.fetch(req('/assets/image.png', { headers: { Cookie: cookies(previous) } }), env);
  assert.equal(res.status, 401);
});

test('an asset fetch failure fails closed instead of falling back', async () => {
  const env = environment(); const previous = await login(env);
  env.ASSETS.fetch = async () => { throw new Error('upstream error'); };
  const res = await worker.fetch(req('/', { headers: { Cookie: cookies(previous) } }), env);
  assert.equal(res.status, 503);
});
