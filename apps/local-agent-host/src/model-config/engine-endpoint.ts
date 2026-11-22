/** Endpoint admission shared by engine model sources and the proxy-mode projection. No storage access. */
const LAN_SUFFIXES = [".localhost", ".local", ".lan", ".internal", ".home.arpa"];

function privateIPv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (m.slice(1).some(part => Number(part) > 255)) return false;
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

function privateIPv6(host: string): boolean {
  if (!host.startsWith("[") || !host.endsWith("]")) return false;
  const address = host.slice(1, -1).toLowerCase();
  if (address === "::1") return true;
  // WHATWG URL serializes IPv4-mapped addresses as two hex groups: [::ffff:c0a8:102].
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(address);
  if (mapped) {
    const high = parseInt(mapped[1]!, 16), low = parseInt(mapped[2]!, 16);
    return privateIPv4([high >> 8, high & 255, low >> 8, low & 255].join("."));
  }
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/u.exec(address);
  if (dotted) return privateIPv4(dotted[1]!);
  const first = parseInt(address.split(":")[0] || "0", 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
}

/** Hosts on this machine or the local network: loopback, RFC 1918, link-local, CGNAT/Tailscale, IPv6 ULA and
 *  link-local literals, single-label names and reserved local suffixes. Names are judged as written, not resolved. */
export function localNetworkHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/u, "");
  if (host.startsWith("[")) return privateIPv6(host);
  if (/^[\d.]+$/u.test(host)) return privateIPv4(host);
  return host === "localhost" || !host.includes(".") || LAN_SUFFIXES.some(suffix => host.endsWith(suffix));
}

/** Credentials go to HTTPS anywhere; plaintext HTTP defaults to loopback; local-network hosts require explicit opt-in. */
export function engineEndpointAllowed(baseUrl: string, allowInsecureLocalNetwork = false): boolean {
  let url: URL;
  try { url = new URL(baseUrl); } catch { return false; }
  if (url.username || url.password || url.search || url.hash) return false;
  return url.protocol === "https:" || (url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "[::1]" || /^127\./u.test(url.hostname) || (allowInsecureLocalNetwork && localNetworkHost(url.hostname))));
}

