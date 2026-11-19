import { init, parse } from 'es-module-lexer';
const base = '/grasp';
const prefix = (path: string) => path.startsWith('/') && !path.startsWith('//') && path !== base && !path.startsWith(base + '/') ? base + path : path;

export async function rewriteGrasp(source: string, type: string, path: string) {
  if (type.includes('javascript') || type.includes('ecmascript')) {
    await init;
    const [imports] = parse(source);
    for (const item of [...imports].reverse()) if (item.n?.startsWith('/') && !item.n.startsWith('//')) {
      const replacement = item.d >= 0 ? JSON.stringify(prefix(item.n)) : prefix(item.n);
      source = source.slice(0, item.s) + replacement + source.slice(item.e);
    }
    if (path.split('?')[0] === '/@vite/client') source = source.replace(/const base = [^;\n]+;/, 'const base = "/grasp/";');
    // Grasp's own guards and redirects expect a root pathname. Vue Router itself
    // still sees the real pathname and uses the injected base element.
    if (path.startsWith('/src/')) source = scopeLocation(source);
    return source.replace(/\bexport\s+default\s+(["'])(\/(?!\/)[^"']*)\1/g, (_, quote, asset) => 'export default ' + quote + prefix(asset) + quote)
      .replace(/\/\/# sourceMappingURL=data:[^\n]+/g, '');
  }
  if (type.includes('text/css')) return source.replace(/(url\(\s*['"]?)(\/(?!\/)[^)'"\s]+)/g, (_, before, url) => before + prefix(url));
  if (!type.includes('text/html')) return source;
  const bootstrap = `<base href="/grasp/"><script>(${browserScope.toString()})()</script>`;
  return source.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (_, attributes, body) => '<script' + attributes + '>' + scopeLocation(body) + '</script>')
    .replace(/<base\b[^>]*>/gi, '').replace(/(\s(?:src|href|action)=)(['"])(\/(?!\/)[^'"]*)\2/gi, (_, attr, quote, value) => attr + quote + prefix(value) + quote)
    .replace(/<head(?:\s[^>]*)?>/i, head => head + bootstrap);
}
function scopeLocation(source: string) { return source.replace(/\bwindow\.location\b/g, 'window.__graspLocation').replace(/(?<![\w.])location\./g, 'window.__graspLocation.'); }

/** Runs before Vite and Vue: native module imports are rewritten separately by the lexer. */
function browserScope() {
  const scoped = (input: string | URL) => {
    const url = new URL(String(input), location.href);
    const sameHost = url.host === location.host || url.host === '21.6.127.184:5173' || url.host === 'localhost:5173';
    if (sameHost && ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) {
      url.host = location.host;
      url.protocol = url.protocol.startsWith('ws') ? (location.protocol === 'https:' ? 'wss:' : 'ws:') : location.protocol;
      if (url.pathname !== '/grasp' && !url.pathname.startsWith('/grasp/')) url.pathname = '/grasp' + url.pathname;
    }
    return url.href;
  };
  const fetcher = window.fetch.bind(window);
  (window as any).__graspLocation = new Proxy({}, {
    get(_target, key) {
      const target = window.location;
      if (key === 'pathname') return target.pathname.replace(/^\/grasp(?=\/|$)/, '') || '/';
      if (key === 'assign' || key === 'replace') return (url: string) => target[key](scoped(url));
      const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
    },
    set(_target, key, value) { const target = window.location; return Reflect.set(target, key, key === 'href' ? scoped(value) : value, target); }
  });
  window.fetch = (input, options) => fetcher(input instanceof Request ? new Request(scoped(input.url), input) : scoped(input), options);
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (...args: any[]) { args[1] = scoped(args[1]); return Reflect.apply(open, this, args); };
  for (const name of ['WebSocket', 'EventSource', 'Worker', 'SharedWorker'] as const) {
    const Constructor = window[name];
    if (Constructor) (window as any)[name] = new Proxy(Constructor as any, { construct(Target, args) { args[0] = scoped(args[0]); return Reflect.construct(Target, args); } });
  }
  const css = (value: string) => value.replace(/(url\(\s*['"]?)(\/(?!\/)[^)'"\s]+)/g, (_, before, path) => before + (path.startsWith('/grasp/') ? path : '/grasp' + path));
  const text = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent')!;
  Object.defineProperty(Node.prototype, 'textContent', { ...text, set(value) { text.set!.call(this, this instanceof HTMLStyleElement && typeof value === 'string' ? css(value) : value); } });
  const attribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) { return attribute.call(this, name, ['src', 'href', 'action', 'poster'].includes(name.toLowerCase()) && value.startsWith('/') && !value.startsWith('//') ? scoped(value) : value); };
  for (const [Constructor, property] of [[HTMLImageElement, 'src'], [HTMLScriptElement, 'src'], [HTMLLinkElement, 'href'], [HTMLMediaElement, 'src'], [HTMLSourceElement, 'src']] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(Constructor.prototype, property);
    if (descriptor?.set) Object.defineProperty(Constructor.prototype, property, { ...descriptor, set(value) { descriptor.set!.call(this, typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') ? scoped(value) : value); } });
  }
  // Root-only service workers would otherwise control Join outside this application.
  if (navigator.serviceWorker) navigator.serviceWorker.register = () => Promise.reject(new Error('Service workers are disabled in the Grasp proxy'));
}
