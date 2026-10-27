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
