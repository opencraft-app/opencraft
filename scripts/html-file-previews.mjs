import { createHash, randomBytes } from 'node:crypto';
import { posix } from 'node:path';
import { parse, serialize } from 'parse5';

const PREFIX = '/__opencraft_preview';
const MAX_REPORT = 25 * 1024 * 1024;
const MAX_SNAPSHOT = 32 * 1024 * 1024;
const mime = new Map(Object.entries({ '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.gif':'image/gif', '.webp':'image/webp', '.avif':'image/avif', '.svg':'image/svg+xml', '.ico':'image/x-icon', '.css':'text/css', '.js':'text/javascript', '.mjs':'text/javascript', '.woff':'font/woff', '.woff2':'font/woff2', '.ttf':'font/ttf', '.mp3':'audio/mpeg', '.mp4':'video/mp4', '.webm':'video/webm' }));
const reportPolicy = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' data:; style-src 'unsafe-inline' data:; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
const digest = value => createHash('sha256').update(value).digest('hex');
const random = () => randomBytes(24).toString('base64url');
function headers(response) {
  response.setHeader('cache-control', 'private, no-store');
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader('x-content-type-options', 'nosniff');
}
function json(response, status, value) {
  headers(response); response.writeHead(status, { 'content-type':'application/json; charset=utf-8' }); response.end(JSON.stringify(value));
}
function html(response, status, content, policy) {
  headers(response); response.writeHead(status, { 'content-type':'text/html; charset=utf-8', 'content-security-policy':policy }); response.end(content);
}
const shellPolicy = "default-src 'none'; style-src 'unsafe-inline'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
const unavailable = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>预览不可用</title><body><p>预览链接无效、已过期或访问权限已变化，请回到文件页面重新打开。</p></body></html>';

// Only statically referenced, relative assets under this report's directory are
// read. The snapshot cannot become an arbitrary path or live-directory endpoint.
async function snapshot(read, hostId, path, signal) {
  if (typeof path !== 'string' || !posix.isAbsolute(path) || !/\.html?$/iu.test(path) || /[\0\r\n]/u.test(path)) throw new Error('Invalid HTML path');
  const root = posix.dirname(path), entry = await read(hostId, path, signal, MAX_REPORT);
  let size = entry.length;
  const assets = new Map();
  async function asset(reference, directory) {
    if (/^data:/iu.test(reference)) return reference;
    if (!reference || /^(?:[a-z][a-z0-9+.-]*:|[\/\\#])/iu.test(reference)) return null;
    const relative = decodeURIComponent(reference.split(/[?#]/u)[0]);
    if (!relative || /[\0\r\n\\]/u.test(relative)) throw new Error('Invalid resource path');
    const target = posix.resolve(directory, relative), boundary = root === '/' ? '/' : root + '/';
    if (!target.startsWith(boundary)) throw new Error('Resource outside report');
    const type = mime.get(posix.extname(target).toLowerCase());
    if (!type) return null;
    if (assets.has(target)) return assets.get(target);
    if (assets.size >= 64) throw new Error('Too many resources');
    // A cycle is rejected rather than traversing arbitrary CSS import graphs.
    assets.set(target, null);
    const bytes = await read(hostId, target, signal, MAX_SNAPSHOT - size, root);
    size += bytes.length;
    const value = type === 'text/css' ? Buffer.from(await css(bytes.toString('utf8'), posix.dirname(target))) : bytes;
    const data = `data:${type};base64,${value.toString('base64')}`;
    assets.set(target, data); return data;
  }
  async function css(source, directory) {
    const matches = [...source.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/giu)];
    let result = '', previous = 0;
    for (const match of matches) {
      result += source.slice(previous, match.index);
      const data = await asset(match[2], directory);
      result += `url("${data ?? ''}")`; previous = match.index + match[0].length;
    }
    return result + source.slice(previous);
  }
  const document = parse(entry.toString('utf8')), pending = [document];
  while (pending.length) {
    const node = pending.pop();
    if ('childNodes' in node) {
      node.childNodes = node.childNodes.filter(child => !('tagName' in child) || !(child.tagName === 'base'
        || (child.tagName === 'meta' && child.attrs.some(a => a.name === 'http-equiv' && a.value.toLowerCase().trim() === 'refresh'))
        || ['animate','animateMotion','animateTransform','set','discard'].includes(child.tagName)));
      pending.push(...node.childNodes);
    }
    if ('content' in node) pending.push(node.content);
    if (!('tagName' in node)) continue;
    const attrs = [];
    for (const attr of node.attrs) {
      if (['a','area'].includes(node.tagName) && ['href','target','ping'].includes(attr.name)) continue;
      if (['srcset','action','formaction'].includes(attr.name)) continue;
      if (attr.name === 'style') attr.value = await css(attr.value, root);
      if (['src','poster'].includes(attr.name) || (node.tagName === 'link' && attr.name === 'href')) {
        const value = await asset(attr.value, root);
        if (!value) continue;
        attr.value = value;
      }
      attrs.push(attr);
    }
    node.attrs = attrs;
    if (node.tagName === 'style') for (const child of node.childNodes ?? []) if ('value' in child) child.value = await css(child.value, root);
  }
  signal.throwIfAborted();
  const source = serialize(document);
  if (Buffer.byteLength(source) > MAX_SNAPSHOT) throw new Error('Preview too large');
  return source;
}

/** Installation-owned, ephemeral capabilities. No user token is put in a URL. */
export class HtmlFilePreviews {
  records = new Map();
  active = new Set();
  closed = false;
  constructor(read, { now = Date.now, ticketMs = 60_000, sessionMs = 15 * 60_000 } = {}) {
    this.read = read; this.now = now; this.ticketMs = ticketMs; this.sessionMs = sessionMs;
    this.timer = setInterval(() => this.prune(), 30_000); this.timer.unref();
  }
  prune() { for (const [id, record] of this.records) if (record.expiresAt <= this.now() || !record.authorize()) this.records.delete(id); }
  close() { this.closed = true; clearInterval(this.timer); this.records.clear(); for (const c of this.active) c.abort(); }
  async issue(request, response, authorize) {
    headers(response);
    if (request.method !== 'POST') { json(response, 405, { error:'method_not_allowed' }); return; }
    this.prune();
    const total = [...this.records.values()].reduce((n, r) => n + r.bytes, 0);
    if (this.closed || this.active.size >= 2 || this.records.size >= 16 || total >= 64 * 1024 * 1024) { json(response, 503, { error:'preview_busy' }); return; }
    const controller = new AbortController(); this.active.add(controller);
    const abort = () => controller.abort(); response.once('close', abort); request.once('aborted', abort);
    const deadline = setTimeout(abort, 30_000);
    try {
      let length = 0; const chunks = [];
      for await (const chunk of request) { length += chunk.length; if (length > 16_384) throw new Error('Invalid request'); chunks.push(chunk); }
      const { hostId, path } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (typeof hostId !== 'string' || !authorize(hostId)) { json(response, 403, { error:'preview_access_denied' }); return; }
      const allowed = () => !this.closed && authorize(hostId);
      const source = await snapshot(async (...args) => {
        if (!allowed()) throw new Error('Access expired');
        const result = await this.read(...args);
        if (!allowed()) throw new Error('Access expired');
        return result;
      }, hostId, path, controller.signal);
      controller.signal.throwIfAborted();
      if (!allowed()) throw new Error('Access expired');
      const bytes = Buffer.byteLength(source);
      if ([...this.records.values()].reduce((n,r) => n+r.bytes,0) + bytes > 64 * 1024 * 1024) throw new Error('Capacity exceeded');
      const id = randomBytes(12).toString('hex'), ticket = random(), expiresAt = this.now() + this.ticketMs;
      this.records.set(id, { source, bytes, ticketHash:digest(ticket), expiresAt, authorize:allowed });
      json(response, 201, { path:`${PREFIX}/#ticket=${ticket}`, expiresAt });
    } catch {
      if (!response.headersSent && !response.destroyed) json(response, 400, { error:'preview_unavailable' });
    } finally {
      clearTimeout(deadline); response.off('close', abort); request.off('aborted', abort); this.active.delete(controller);
    }
  }
  async handlePublic(request, response, sameOrigin) {
    const path = new URL(request.url ?? '/', 'http://invalid').pathname;
    if (!(path === PREFIX || path.startsWith(PREFIX + '/')) || path === PREFIX + '/tickets') return false;
    headers(response); this.prune();
    if (this.closed) { html(response, 503, unavailable, shellPolicy); return true; }
    if (path === PREFIX || path === PREFIX + '/') {
      if (request.method !== 'GET') { json(response,405,{error:'method_not_allowed'}); return true; }
      const nonce = random();
      const script = `const params=new URLSearchParams(location.hash.slice(1));history.replaceState(null,'',location.pathname+location.search);(async()=>{
        let ticket=params.get('ticket');
        if(!ticket&&params.has('open')){
          const source=JSON.parse(params.get('open'));
          if(!source||typeof source.hostId!=='string'||typeof source.path!=='string')throw Error();
          const issued=await fetch(new URL('tickets',location.href),{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({hostId:source.hostId,path:source.path})});
          if(!issued.ok)throw Error();
          const entry=await issued.json();
          if(typeof entry.path!=='string'||!/^\\/__opencraft_preview\\/#ticket=[A-Za-z0-9_-]{32}$/.test(entry.path))throw Error();
          ticket=entry.path.split('#ticket=')[1];
        }
        if(!ticket)throw Error();
        const response=await fetch(new URL('redeem',location.href),{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({ticket})});
        if(!response.ok)throw Error();const result=await response.json();if(!/^\\.\\/s\\/[a-f0-9]{24}\\/$/.test(result.path))throw Error();location.replace(new URL(result.path,location.href));
      })().catch(()=>{document.getElementById('state').textContent='预览无法打开：链接无效、已过期或没有文件访问权限，请回到文件页面重试。'});`;
      // A fragment is never sent to the server, referrer or ordinary HTTP log.
      html(response, 200, `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>打开预览</title><body><p id="state">正在打开预览…</p><script nonce="${nonce}">${script}</script></body></html>`, `${shellPolicy}; connect-src 'self'; script-src 'nonce-${nonce}'`);
      return true;
    }
    if (path === PREFIX + '/redeem') {
      if (request.method !== 'POST') { json(response,405,{error:'method_not_allowed'}); return true; }
      if (!sameOrigin(request, true)) { json(response,403,{error:'same_origin_required'}); return true; }
      try {
        let text = ''; for await (const chunk of request) { text += chunk; if (text.length > 256) throw new Error('Too large'); }
        const { ticket } = JSON.parse(text);
        if (typeof ticket !== 'string' || !/^[A-Za-z0-9_-]{32}$/u.test(ticket)) throw new Error('Invalid ticket');
        const hash = digest(ticket), pair = [...this.records].find(([,r]) => r.ticketHash === hash);
        if (!pair || !pair[1].authorize() || pair[1].expiresAt <= this.now()) throw new Error('Expired ticket');
        // No async boundary between lookup and consumption: one redemption wins.
        const [id, record] = pair, secret = random();
        delete record.ticketHash; record.cookieHash = digest(secret); record.expiresAt = this.now() + this.sessionMs;
        const origin = new URL(request.headers.origin);
        const loopback = origin.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(origin.hostname);
        response.setHeader('set-cookie', `opencraft_preview_${id}=${secret}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(this.sessionMs/1000)}${loopback ? '' : '; Secure'}`);
        json(response, 200, { path:`./s/${id}/`, expiresAt:record.expiresAt });
      } catch { json(response,410,{error:'preview_ticket_expired_or_used'}); }
      return true;
    }
    const match = /^\/__opencraft_preview\/s\/([a-f0-9]{24})\/(document)?$/u.exec(path);
    if (!match) { json(response,404,{error:'missing'}); return true; }
    if (request.method !== 'GET') { json(response,405,{error:'method_not_allowed'}); return true; }
    const [ , id, document ] = match, record = this.records.get(id);
    const cookie = String(request.headers.cookie ?? '').split(';').map(v=>v.trim()).find(v=>v.startsWith(`opencraft_preview_${id}=`))?.slice(`opencraft_preview_${id}=`.length);
    if (!record?.cookieHash || !cookie || digest(cookie) !== record.cookieHash || !record.authorize() || record.expiresAt <= this.now()) {
      html(response,403,unavailable,shellPolicy); return true;
    }
    if (document) html(response,200,record.source,reportPolicy);
    else html(response,200,'<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HTML 预览</title><style>html,body,iframe{margin:0;width:100%;height:100%;border:0;display:block}</style><iframe title="HTML report" sandbox="allow-scripts" referrerpolicy="no-referrer" src="./document"></iframe></html>',shellPolicy);
    return true;
  }
}
