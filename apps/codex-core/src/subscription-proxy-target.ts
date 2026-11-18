/** Forward only the authenticated personal API into the owned loopback proxy.
 * The caller must use redirect:error so a local response cannot move credentials
 * to another origin. Never use arbitrary request paths as proxy destinations. */
export function subscriptionProxyTarget(baseUrl: string, requestPath: string): URL {
  if (!/^\/personal\/[a-f0-9]{64}\/v1\/(responses|models)$/.test(requestPath)) throw new Error('Invalid subscription route');
  const base = new URL(baseUrl);
  if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || !base.port
    || base.username || base.password || base.search || base.hash) throw new Error('Invalid local account proxy');
  return new URL(requestPath, `http://127.0.0.1:${Number(base.port)}`);
}
