// Cloudflare Pages advanced-mode Worker. No credentials belong in this file.
// _routes.json invokes this Worker for EVERY request, including static assets.
const SESSION = '__Host-lightvela_report';
const CSRF = '__Host-lightvela_csrf';
const SESSION_SECONDS = 8 * 60 * 60;
const encoder = new TextEncoder();
const attempts = new Map(); // Best-effort, per-isolate IP throttle; not a global WAF rule.

const now = () => Math.floor(Date.now() / 1000);
const hex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (value) => Uint8Array.from(value.match(/../g) ?? [], (s) => parseInt(s, 16));
const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (value) => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)), (c) => c.charCodeAt(0));

function cookie(request, name) {
  const part = (request.headers.get('Cookie') ?? '').split(';').map((v) => v.trim()).find((v) => v.startsWith(name + '='));
  return part?.slice(name.length + 1) ?? '';
}

function setCookie(name, value, age) {
  return `${name}=${value}; Path=/; Max-Age=${age}; HttpOnly; Secure; SameSite=None`;
}

function headers(extra = {}) {
  return new Headers({
    'Cache-Control': 'private, no-store, max-age=0',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
    'X-Content-Type-Options': 'nosniff',
    // no-referrer makes native form POSTs send Origin:null, blocking our own login.
    // same-origin preserves the site's Origin and keeps referrers off external sites.
    'Referrer-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    Vary: 'Cookie',
    ...extra,
  });
}

async function key(env) {
  // Binding the password hash invalidates old sessions when the password changes.
  return crypto.subtle.importKey('raw', encoder.encode(env.REPORT_SESSION_SECRET + ':' + env.REPORT_PASSWORD_HASH), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function token(env, audience, kind, lifetime) {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  const data = b64(encoder.encode(JSON.stringify({ aud: audience, kind, iat: now(), exp: now() + lifetime, nonce: b64(bytes) })));
  return data + '.' + b64(await crypto.subtle.sign('HMAC', await key(env), encoder.encode(data)));
}

async function validToken(env, audience, value, kind, lifetime) {
  try {
    if (value.length > 1024) return false;
    const [data, signature, extra] = value.split('.');
    if (!data || !signature || extra !== undefined) return false;
    if (!(await crypto.subtle.verify('HMAC', await key(env), unb64(signature), encoder.encode(data)))) return false;
    const payload = JSON.parse(new TextDecoder().decode(unb64(data)));
    return payload.aud === audience && payload.kind === kind && Number.isInteger(payload.exp) && Number.isInteger(payload.iat)
      && payload.exp > now() && payload.iat <= now() + 30 && payload.exp - payload.iat === lifetime;
  } catch { return false; }
}

async function correctPassword(password, encoded) {
  const [method, iterations, salt, expected] = encoded.split('$');
  if (method !== 'pbkdf2-sha256' || iterations !== '100000' || !/^[a-f0-9]{32}$/.test(salt) || !/^[a-f0-9]{64}$/.test(expected)) return false;
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const actual = hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', iterations: Number(iterations), salt: unhex(salt) }, material, 256));
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) mismatch |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return mismatch === 0;
}

function ready(env) {
  return typeof env.REPORT_SESSION_SECRET === 'string' && env.REPORT_SESSION_SECRET.length >= 32
    && /^pbkdf2-sha256\$100000\$[a-f0-9]{32}\$[a-f0-9]{64}$/.test(env.REPORT_PASSWORD_HASH ?? '');
}

function page(csrf, error = '') {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>LightVela · 受保护汇报</title><style>
*{box-sizing:border-box}body{margin:0;background:#f6f6f9;color:#25252b;font-family:system-ui,-apple-system,"PingFang SC",sans-serif;min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:24px}.card{width:420px;padding:40px;background:#fff;border:1px solid #e9e7ef;border-radius:12px;box-shadow:0 12px 50px #29223d08}.wordmark{font-weight:750;font-size:23px;letter-spacing:-.7px;margin-bottom:36px;color:#6842ff}.label{font-size:11px;letter-spacing:.12em;color:#a2a0aa;margin-bottom:10px}h1{font-size:25px;line-height:1.4;margin:0 0 12px}p{color:#8b8794;font-size:13px;line-height:1.8;margin:0 0 28px}label{display:block;font-size:12px;margin-bottom:9px}input{display:block;width:100%;height:46px;border:1px solid #dedbe7;border-radius:5px;padding:0 12px;font:inherit;outline:none}input:focus{border-color:#6842ff;box-shadow:0 0 0 3px #6842ff15}button{width:100%;height:44px;background:#6842ff;color:white;border:0;border-radius:5px;font-size:13px;margin-top:16px;cursor:pointer}button:hover{background:#5632e8}.error{font-size:12px;color:#b44954;margin:12px 0 0}.foot{border-top:1px solid #efedf3;padding-top:20px;margin-top:28px;font-size:11px;color:#aaa6b2;line-height:1.8}
</style></head><body><main class="card"><div class="wordmark">LightVela</div><div class="label">PRIVATE PRESENTATION</div><h1>产品与增长汇报</h1><p>这份材料已设置访问保护。<br>请输入访问密码后查看。</p><form method="post" action="/__auth/login"><input type="hidden" name="csrf" value="${csrf}"><label for="password">访问密码</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="256" autofocus><button type="submit">进入汇报</button>${error ? `<div class="error" role="alert">${error}</div>` : ''}</form><div class="foot">登录有效期 8 小时。请勿公开分享密码。<br>页面与所有图文素材均经过服务端校验。</div></main></body></html>`;
}

async function loginPage(request, env, status = 200, error = '') {
  const nonce = await token(env, new URL(request.url).host, 'csrf', 600);
  const h = headers({ 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'" });
  h.append('Set-Cookie', setCookie(CSRF, nonce, 600));
  return new Response(request.method === 'HEAD' ? null : page(nonce, error), { status, headers: h });
}

async function bodyText(request) {
  if (Number(request.headers.get('Content-Length')) > 4096) throw new Error('large');
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = []; let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 4096) { await reader.cancel(); throw new Error('large'); }
    chunks.push(value);
  }
  const all = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(all);
}

function denied(status = 401, message = '请登录后访问。') {
  return new Response(message, { status, headers: headers({ 'Content-Type': 'text/plain; charset=utf-8' }) });
}

export default {
  async fetch(request, env) {
    try {
      if (!ready(env)) return denied(503, '访问保护暂不可用，材料未开放。');
      const url = new URL(request.url);
      const originOK = request.headers.get('Origin') === url.origin;
      const authenticated = await validToken(env, url.host, cookie(request, SESSION), 'session', SESSION_SECONDS);
      if (url.pathname === '/__auth/login') {
        if (['GET', 'HEAD'].includes(request.method)) return loginPage(request, env);
        if (request.method !== 'POST') return denied(405, '不支持此请求方法。');
        if (!originOK) return denied(403, '请从本站登录页面提交。');
        if (!request.headers.get('Content-Type')?.startsWith('application/x-www-form-urlencoded')) return denied(415);
        let form;
        try { form = new URLSearchParams(await bodyText(request)); } catch { return denied(413); }
        const nonce = form.get('csrf') ?? '';
        if (nonce !== cookie(request, CSRF) || !(await validToken(env, url.host, nonce, 'csrf', 600))) return loginPage(request, env, 403, '登录页面已过期，请重新输入密码。');
        const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
        const bucketKey = url.host + ':' + ip;
        const previous = attempts.get(bucketKey);
        const bucket = previous && previous.until > now() ? previous : { count: 0, until: now() + 900 };
        if (attempts.size > 4096) for (const [id, entry] of attempts) if (entry.until <= now()) attempts.delete(id);
        if (bucket.count >= 10) {
          const limited = await loginPage(request, env, 429, '尝试次数较多，请 15 分钟后重试。');
          limited.headers.set('Retry-After', String(bucket.until - now()));
          return limited;
        }
        bucket.count += 1;
        if (attempts.size < 8192 || attempts.has(bucketKey)) attempts.set(bucketKey, bucket);
        const password = form.get('password') ?? '';
        if (!password || password.length > 256 || !(await correctPassword(password, env.REPORT_PASSWORD_HASH))) return loginPage(request, env, 401, '密码不正确，请重试。');
        attempts.delete(bucketKey);
        const h = headers({ Location: '/' });
        h.append('Set-Cookie', setCookie(SESSION, await token(env, url.host, 'session', SESSION_SECONDS), SESSION_SECONDS));
        h.append('Set-Cookie', setCookie(CSRF, '', 0));
        return new Response(null, { status: 303, headers: h });
      }
      if (url.pathname === '/__auth/logout') {
        if (request.method !== 'POST') return denied(405);
        if (!originOK) return denied(403);
        const h = headers({ Location: '/__auth/login' });
        h.append('Set-Cookie', setCookie(SESSION, '', 0));
        h.append('Set-Cookie', setCookie(CSRF, '', 0));
        h.set('Clear-Site-Data', '"cache", "storage"');
        return new Response(null, { status: 303, headers: h });
      }
      if (!authenticated) {
        if (['GET', 'HEAD'].includes(request.method) && (url.pathname === '/' || request.headers.get('Accept')?.includes('text/html'))) return new Response(null, { status: 303, headers: headers({ Location: '/__auth/login' }) });
        return denied();
      }
      if (!['GET', 'HEAD'].includes(request.method)) return denied(405);
      if (url.pathname.startsWith('/__auth/') || /^\/(?:_worker\.js|_routes\.json)$/.test(url.pathname) || url.pathname.endsWith('.map')) return denied(404, '未找到。');
      // No ASSETS.fetch call can happen before a valid server-signed session.
      const asset = await env.ASSETS.fetch(request);
      const h = headers();
      for (const [name, value] of asset.headers) if (!['cache-control', 'etag', 'last-modified', 'vary', 'x-robots-tag'].includes(name.toLowerCase())) h.set(name, value);
      return new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers: h });
    } catch {
      // Authentication errors must never expose the unprotected static fallback.
      return denied(503, '访问保护暂不可用，材料未开放。');
    }
  },
};
