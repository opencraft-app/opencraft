const parameter = 'opencraft-resource-recovery';
const validToken = /^[a-z0-9-]{1,64}$/;

// A new URL for the complete module graph also bypasses cached failed imports.
// Keep the application origin, route, storage and API URLs unchanged.
export function resourceRecoveryHtml(html, requestUrl) {
  const token = new URL(requestUrl, 'http://localhost').searchParams.get(parameter);
  const marked = html.replace(/<head(?:\s[^>]*)?>/iu, head =>
    `${head}<meta name="opencraft-resource-recovery" content="supported">`);
  if (!token || !validToken.test(token)) return marked;
  return marked.replace(/\b(src|href)=(['"])(?:\.\/|\/)?assets\//g,
    (_, attribute, quote) => `${attribute}=${quote}/assets/recovery-${token}/`);
}

export function resourceRecoveryPath(pathname) {
  return pathname.replace(/^\/assets\/recovery-([a-z0-9-]{1,64})\//, '/assets/');
}
