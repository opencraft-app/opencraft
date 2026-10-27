/** Browser deployment context only. Authorization always remains at the target. */
export interface BrowserServerContext { readonly id: string; readonly name: string; readonly basePath: string; readonly selectorPath: string; readonly targetOrigin?: string; }
export function parseServerContext(raw: string | null): BrowserServerContext | null {
  if (!raw) return null;
  const value = JSON.parse(raw) as BrowserServerContext;
  if (!value || !/^[A-Za-z0-9._-]{1,128}$/u.test(value.id) || typeof value.name !== 'string'
    || !['/servers', '/__opencraft_servers'].includes(value.selectorPath)
    || (value.basePath !== '' && (typeof value.basePath !== 'string' || !value.basePath.startsWith(value.selectorPath + '/')
      || !/^[A-Za-z0-9._-]{1,128}$/u.test(value.basePath.slice(value.selectorPath.length + 1))
      || ['.', '..'].includes(value.basePath.slice(value.selectorPath.length + 1))))) throw new Error('Invalid server context');
  if (value.targetOrigin !== undefined) {
    const origin = new URL(value.targetOrigin);
    if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== value.targetOrigin || origin.username || origin.password) throw new Error('Invalid server context');
  }
  return Object.freeze(value);
}
export function browserServerContext(): BrowserServerContext | null {
  return typeof document === 'undefined' || typeof document.getElementById !== 'function' ? null : parseServerContext(document.getElementById('opencraft-server-context')?.textContent ?? null);
}
export function serverUrl(path: string): string {
  const base = browserServerContext()?.basePath ?? '';
  return base && path.startsWith('/') && !path.startsWith('//') && !path.startsWith(base + '/') ? base + path : path;
}
export function serverPath(path: string): string {
  const base = browserServerContext()?.basePath ?? '';
  return base && path === base ? '/' : base && path.startsWith(base + '/') ? path.slice(base.length) : path;
}
export const serverFetch: typeof fetch = (input, init) => {
  if (typeof input === 'string' && !/^(?:https?:)?\/\//u.test(input)) return globalThis.fetch(serverUrl(input), init);
  if (typeof window !== 'undefined') {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, window.location.origin);
    if (url.origin === window.location.origin) {
      const scoped = new URL(serverUrl(url.pathname) + url.search + url.hash, url.origin);
      return globalThis.fetch(typeof input === 'string' || input instanceof URL ? scoped : new Request(scoped, input), init);
    }
  }
  return globalThis.fetch(input, init);
};
export function serverStorageKey(key: string): string {
  const id = browserServerContext()?.id;
  return id ? `server:${id}:${key}` : key;
}

/** A saved deployment recipe may outlive its public route. Match only the
 * current instance's old stable-ID AppServer path, never another Host's URL. */
export function serverEndpointNeedsRefresh(previous: string, current: string): boolean {
  const context = browserServerContext();
  if (!context || typeof window === 'undefined') return false;
  try {
    const page = new URL(window.location.href), before = new URL(previous), after = new URL(current);
    const protocol = page.protocol === 'https:' ? 'wss:' : page.protocol === 'http:' ? 'ws:' : null;
    const oldPaths = ['/__opencraft_servers/', '/servers/'].map(base => base + context.id + '/appserver');
    return protocol !== null && before.protocol === protocol && after.protocol === protocol
      && before.host === page.host && after.host === page.host
      && !before.username && !before.password && !after.username && !after.password
      && !before.search && !before.hash && !after.search && !after.hash
      && oldPaths.includes(before.pathname) && after.pathname === serverUrl('/appserver')
      && before.href !== after.href;
  } catch { return false; }
}

/** The enrolled target owns installation sessions; the browser entry owns URLs. */
export function serverAdmissionOrigin(): string {
  return browserServerContext()?.targetOrigin ?? window.location.origin;
}
