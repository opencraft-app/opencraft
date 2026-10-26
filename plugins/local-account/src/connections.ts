/** A connection stores a server authority; Human login is always verified by that server. */
export function remoteServerOrigin(input: unknown): string {
  if (typeof input !== 'string' || input.length > 2048) throw new Error('Invalid server address');
  const url = new URL(input);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/'
    || !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Error('Use an HTTPS server origin or a loopback HTTP origin');
  }
  return url.origin;
}
