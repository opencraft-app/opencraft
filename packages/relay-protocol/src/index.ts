export const RELAY_PROTOCOL = "opencraft-relay.v1";
export const CONTROL_PATH = "/__opencraft_relay/control";
export const DATA_PATH = "/__opencraft_relay/data";
export const STREAM_HEADER = "x-opencraft-relay-stream";
export const MAX_STREAMS = 128;
/** Ordinary relay tunnels have a separate budget from Hub peer links. */
export const MAX_RELAY_STREAMS = 512;
export function parseOpen(input: unknown): { type: "open"; id: string; token: string } {
  if (!input || typeof input !== "object") throw new Error("Invalid relay message");
  const m = input as Record<string, unknown>;
  if (m.type !== "open" || typeof m.id !== "string" || !/^[0-9a-f-]{36}$/u.test(m.id)
    || typeof m.token !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(m.token)) throw new Error("Invalid relay message");
  return { type: "open", id: m.id, token: m.token };
}
/** Deployment/update authority is never exported through a business relay. */
export function relayPathAllowed(path: string): boolean {
  if (!path.startsWith('/') || path.startsWith('//') || /[\r\n\\]/u.test(path)) return false;
  try {
    const pathname = decodeURIComponent(new URL(path, 'http://relay.invalid').pathname);
    return !pathname.startsWith('/__opencraft_relay') && !pathname.startsWith('/__opencraft_update')
      && !pathname.startsWith('/__opencraft_web_update');
  } catch { return false; }
}

/** Literal RFC 1918 IPv4 only; a hostname is not proof of private-network scope. */
export function isPrivateIpv4Address(host:string):boolean {
  const parts=host.split('.');
  if(parts.length!==4||parts.some(part=>!/^\d{1,3}$/.test(part)||String(Number(part))!==part||Number(part)>255))return false;
  const [a=0,b=0]=parts.map(Number);
  return a===10||a===172&&b>=16&&b<=31||a===192&&b===168;
}

/** Dedicated owner publication; distinct from enrolled machine control/data. */
export const MACHINE_GATEWAY_CONTROL_PATH = '/__opencraft_machine_gateway/control';
export const MACHINE_GATEWAY_DATA_PATH = '/__opencraft_machine_gateway/data';
export const MACHINE_ENROLLMENT_PATHS = ['/__opencraft_machines/install.sh', '/__opencraft_machines/source.tgz', '/__opencraft_machines/enroll', CONTROL_PATH, DATA_PATH, '/__opencraft_machines/bootstrap'] as const;
export function machineEnrollmentRequest(path: string, method: string, upgrade = false): boolean {
  try {
    if (!path.startsWith('/') || path.startsWith('//') || /[\r\n\\]/.test(path)) return false;
    const url = new URL(path, 'http://gateway.invalid');
    if (upgrade) return method === 'GET' && (url.pathname === CONTROL_PATH || url.pathname === DATA_PATH) && url.search === '';
    return (method === 'GET' && (url.pathname === MACHINE_ENROLLMENT_PATHS[0] || url.pathname === MACHINE_ENROLLMENT_PATHS[1] || url.pathname === MACHINE_ENROLLMENT_PATHS[5])) || method === 'POST' && url.pathname === MACHINE_ENROLLMENT_PATHS[2];
  } catch { return false; }
}
