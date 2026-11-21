/** Conditional GET uses weak comparison; dynamic/no-store documents stay network-only. */
export function serveNotModified(request, response) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  if (/\bno-store\b/i.test(String(response.getHeader('cache-control') ?? ''))) return false;
  const etag = response.getHeader('etag');
  const condition = request.headers['if-none-match'];
  if (typeof etag !== 'string' || typeof condition !== 'string') return false;
  const tags = condition.match(/(?:W\/)?"[^"\r\n]*"|\*/g) ?? [];
  if (!tags.some(tag => tag === '*' || tag.replace(/^W\//, '') === etag.replace(/^W\//, ''))) return false;
  response.statusCode = 304;
  response.removeHeader('content-length');
  response.end();
  return true;
}
