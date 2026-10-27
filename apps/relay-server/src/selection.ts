import { createHash } from 'node:crypto';
export const SERVERS_PATH = '/servers';
export const LEGACY_SERVERS_PATH = '/__opencraft_servers';
export const isServerPath = (path: string): boolean => [SERVERS_PATH, LEGACY_SERVERS_PATH].some(base => path === base || path.startsWith(base + '/') || path.startsWith(base + '?'));
export function serverBase(id: string): string { return SERVERS_PATH + '/' + encodeURIComponent(id); }
export interface ServerPaths { readonly aliases?: Readonly<Record<string, string>>; readonly defaultServer?: string; }
/** Operator-owned routing labels. Stable instance IDs remain the authorization/storage key. */
export function parseServerPaths(input: unknown): ServerPaths {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid server paths');
  const value = input as Record<string, unknown>;
  const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9._-]{1,128}$/u.test(v) && !['.', '..'].includes(v);
  if (Object.keys(value).some(k => !['aliases', 'defaultServer'].includes(k)) || (value.defaultServer !== undefined && !id(value.defaultServer))) throw new Error('Invalid server paths');
  const aliases = value.aliases;
  if (aliases !== undefined && (!aliases || typeof aliases !== 'object' || Array.isArray(aliases))) throw new Error('Invalid server aliases');
  const entries = Object.entries(aliases ?? {});
  if (entries.length > 1000 || entries.some(([key, label]) => !id(key) || typeof label !== 'string' || !/^[a-z][a-z0-9-]{0,62}$/u.test(label))
    || new Set(entries.map(([, label]) => label)).size !== entries.length
    || entries.some(([key, label]) => entries.some(([other]) => other === label && other !== key))) throw new Error('Invalid or duplicate server alias');
  return Object.freeze({ ...(aliases ? { aliases: Object.freeze(Object.fromEntries(entries)) as Readonly<Record<string, string>> } : {}), ...(value.defaultServer ? { defaultServer: value.defaultServer as string } : {}) });
}
function cookiePrefix(id: string): string { return 'opencraft-server-' + createHash('sha256').update(id).digest('hex').slice(0,32) + '-'; }
/** Namespace installation cookies; root login and other installations never cross the tunnel. */
export function targetCookies(header: string | undefined, id: string): string | undefined {
  const prefixes=[cookiePrefix(id),'__Host-'+cookiePrefix(id),'__Secure-'+cookiePrefix(id)], cookies: string[]=[];
  for(const part of (header ?? '').split(';')) {
    const item=part.trim(), equal=item.indexOf('='),prefix=prefixes.find(p=>item.startsWith(p)); if(equal<0 || !prefix) continue;
    const encoded=item.slice(prefix.length,equal);
    if(!/^[A-Za-z0-9_-]+$/u.test(encoded)) continue;
    const name=Buffer.from(encoded,'base64url').toString('utf8');
    if(/^[!#$%&'*+.^_`|~A-Za-z0-9-]+$/u.test(name)) cookies.push(name+item.slice(equal));
  }
  return cookies.length ? cookies.join('; ') : undefined;
}
export function scopedCookies(cookies: readonly string[] | undefined, id: string, base: string): string[] | undefined {
  return cookies?.flatMap(cookie=>{
    const [pair,...attributes]=cookie.split(';'), equal=pair!.indexOf('=');if(equal<1)return [];
    const name=pair!.slice(0,equal).trim();if(!/^[!#$%&'*+.^_`|~A-Za-z0-9-]+$/u.test(name))return [];
    let path='/';const keep=attributes.filter(attribute=>{
      if(/^\s*domain\s*=/iu.test(attribute))return false;
      if(/^\s*path\s*=/iu.test(attribute)){const value=attribute.slice(attribute.indexOf('=')+1).trim();if(value.startsWith('/')&&!value.startsWith('//'))path=value;return false;}
      return true;
    });
    const securePrefix=name.startsWith('__Host-')?'__Host-':name.startsWith('__Secure-')?'__Secure-':'';
    // __Host- requires Path=/; retain that browser guarantee and isolate by name.
    return [securePrefix+cookiePrefix(id)+Buffer.from(name).toString('base64url')+pair!.slice(equal)+'; Path='+(securePrefix==='__Host-'?'/':base+path)+keep.map(a=>';'+a).join('')];
  });
}
export function selectedPath(path: string): { id: string; path: string; base: string } | null {
  const match = /^(\/servers|\/__opencraft_servers)\/([A-Za-z0-9._-]{1,128})(\/.*|\?.*)?$/u.exec(path);
  return match ? { id: match[2]!, path: match[3]?.startsWith('/') ? match[3] : '/' + (match[3] ?? ''), base: match[1]! + '/' + encodeURIComponent(match[2]!) } : null;
}
const escape = (value: string) => value.replace(/[&<>"']/gu, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const json = (value: unknown) => JSON.stringify(value).replace(/</gu, '\\u003c');
export function selectionIdentity(principal: { provider: string; subject: string }): string {
  return createHash('sha256').update(JSON.stringify([principal.provider, principal.subject])).digest('hex');
}
const preferenceKey = (principal: { provider: string; subject: string }) => 'opencraft.last-server.v1:' + selectionIdentity(principal);
export function selectionDefault(principal: { provider: string; subject: string; aliases?: readonly string[] }, defaults?: ReadonlyMap<string, string>): string | undefined {
  const stable=defaults?.get(selectionIdentity(principal));
  if(stable) return stable;
  // Only provider-verified aliases can supply a migration hint. Preference and
  // authorization identities always remain the current stable subject.
  for(const subject of principal.aliases??[]) {
    const value=defaults?.get(selectionIdentity({provider:principal.provider,subject}));
    if(value) return value;
  }
  return undefined;
}
/** Operator-owned migration hints. They never grant membership or override a saved choice. */
export function parseSelectionDefaults(input: unknown): ReadonlyMap<string, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid selection defaults');
  const value=input as Record<string, unknown>;
  if (value.schemaVersion!==1 || Object.keys(value).some(k=>!['schemaVersion','defaults'].includes(k))
    || !value.defaults || typeof value.defaults!=='object' || Array.isArray(value.defaults)) throw new Error('Invalid selection defaults');
  const entries=Object.entries(value.defaults);
  if(entries.length>10_000 || entries.some(([identity,id])=>!/^[a-f0-9]{64}$/u.test(identity)
    || typeof id!=='string' || !/^[A-Za-z0-9._-]{1,128}$/u.test(id))) throw new Error('Invalid selection defaults');
  return new Map(entries as [string,string][]);
}
export function selectorPage(principal: { provider: string; subject: string }, servers: readonly { id: string; name: string; route?: string }[], automatic: boolean, defaultServer?: string): string {
  const key = preferenceKey(principal);
  const destinations = servers.map(s => ({ id: s.id, path: serverBase(s.route ?? s.id) + '/' }));
  // Resolve before the chooser can paint. Keep the choices available without JS.
  const entry = `<script>const key=${json(key)},automatic=${automatic},initial=${json(defaultServer ?? null)};let previous=null;try{previous=localStorage.getItem(key)}catch{}let unavailable=false,destinationPath=null;if(automatic){const target=previous===null?initial:previous;if(target){const destination=${json(destinations)}.find(server=>server.id===target);if(destination){document.documentElement.dataset.serverNavigation='true';document.title='OpenCraft';destinationPath=destination.path}else unavailable=true}}</script>`;
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>选择服务器 · OpenCraft</title>${entry}<style>:root{color-scheme:light dark;font:15px system-ui;background:#f9f9f9;color:#262626}body{max-width:480px;margin:10vh auto;padding:24px}h1{font-size:24px}p{color:#737373;line-height:1.7}ul{padding:0;list-style:none}a{display:block;padding:18px;margin:12px 0;border:1px solid #8885;border-radius:12px;color:inherit;text-decoration:none;background:#fff}@media(any-hover:hover) and (any-pointer:fine){:root:not([data-touch-interaction]) a:hover{background:#eee}}a:focus-visible{outline:2px solid currentColor;outline-offset:3px}@media(prefers-color-scheme:dark){:root{background:#161616;color:#eee}a{background:#222}@media(any-hover:hover) and (any-pointer:fine){:root:not([data-touch-interaction]) a:hover{background:#333}}}:root[data-server-navigation] #server-choices{display:none}</style><body><main id="server-choices"><h1>选择服务器</h1><p>各服务器独立管理访问权限。选择后会记住，下次直接进入。</p><ul>${servers.map(s => `<li><a data-server="${escape(s.id)}" href="${serverBase(s.route ?? s.id)}/">${escape(s.name)}</a></li>`).join('')}</ul>${servers.length ? '' : '<p>暂时没有可访问的服务器，请联系服务器管理员。</p>'}</main><script>document.addEventListener('pointerdown',event=>{if(event.pointerType==='touch'||event.pointerType==='pen')document.documentElement.dataset.touchInteraction='true'},true);document.addEventListener('pointermove',event=>{if(event.pointerType==='mouse')delete document.documentElement.dataset.touchInteraction},true);if(destinationPath){try{location.replace(destinationPath)}catch{delete document.documentElement.dataset.serverNavigation}}if(unavailable)document.querySelector('#server-choices p').textContent='上次使用的服务器当前不可用，请重新选择。'</script></body></html>`;
}
export function scopedHtml(html: string, server: { id: string; name: string; base: string; targetOrigin?: string; canonicalPath?: string }, principal?: { provider: string; subject: string }): string {
  // Only an admitted top-level document commits the preference. The URL remains
  // this tab's authority; neither other tabs nor a stored choice can retarget it.
  const remember = principal ? `<script>try{if(window===window.top)localStorage.setItem(${json(preferenceKey(principal))},${json(server.id)})}catch{}</script>` : '';
  const canonical = server.canonicalPath ? `<script>if(window===window.top)history.replaceState(history.state,"",${json(server.canonicalPath)}+location.hash)</script>` : '';
  const baseMatch = /<base\b[^>]*?\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/iu.exec(html);
  const upstreamBase = baseMatch?.[1] ?? baseMatch?.[2] ?? baseMatch?.[3];
  let documentBase = server.base + '/';
  if (upstreamBase?.startsWith('/') && !upstreamBase.startsWith('//')) {
    try {
      const parsed = new URL(upstreamBase, 'https://relay.invalid');
      if (parsed.origin === 'https://relay.invalid') documentBase = parsed.pathname === server.base || parsed.pathname.startsWith(server.base + '/') ? parsed.pathname : server.base + parsed.pathname;
    } catch { /* Invalid bases retain the installation root. */ }
  }
  const context = `<base href="${escape(documentBase)}"><script id="opencraft-server-context" type="application/json">${json({ id: server.id, name: server.name, targetOrigin: server.targetOrigin, basePath: server.base, selectorPath: server.base.startsWith(LEGACY_SERVERS_PATH + '/') ? LEGACY_SERVERS_PATH : SERVERS_PATH })}</script>${canonical}${remember}`;
  // Only the bounded HTML document is rewritten. Uploads, SSE and other bodies stream unchanged.
  return html.replace(/(\s(?:href|src)=)(['"])(\/(?!\/)[^'"]*)\2/gu, (match, attribute, quote, path) =>
    path === server.base || path.startsWith(server.base + '/') ? match : attribute + quote + server.base + path + quote)
    .replace(/<base\b[^>]*>/giu, '').replace(/<head(?:\s[^>]*)?>/iu, head => head + context);
}
