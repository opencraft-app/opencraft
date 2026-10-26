/** Native owns server cookies; renderer recipes contain public routing and scope only. */
export const CONNECT_DESKTOP_SERVER = 'opencraft:connect-desktop-server';
export interface DesktopServerConnection { readonly origin: string; readonly accountKey: string; }
export interface DesktopServerPort {
  prepare(id: string, origin: string): Promise<DesktopServerConnection | null>;
  cancel(id: string): Promise<void>;
  validate(connection: DesktopServerConnection): Promise<DesktopServerConnection | null>;
  onRevoked(listener: (connection: DesktopServerConnection) => void): () => void;
}
export function parseDesktopServerConnection(value: unknown): DesktopServerConnection {
  if (!value || typeof value !== 'object' || !('origin' in value) || typeof value.origin !== 'string'
    || !('accountKey' in value) || typeof value.accountKey !== 'string' || !/^[a-f0-9]{64}$/u.test(value.accountKey)) throw new Error('Invalid desktop server connection');
  const url = new URL(value.origin);
  if (url.origin !== value.origin || url.username || url.password
    || !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('Invalid desktop server origin');
  return { origin: url.origin, accountKey: value.accountKey };
}
export function isDesktopServerConnectMessage(value: unknown): value is DesktopServerConnection & { type: typeof CONNECT_DESKTOP_SERVER } {
  try { if (!value || typeof value !== 'object' || !('type' in value) || value.type !== CONNECT_DESKTOP_SERVER) return false; parseDesktopServerConnection(value); return true; } catch { return false; }
}
