/** Hub identity is stable across addresses, sockets and relay paths. */
export const HUB_PROTOCOL = 'opencraft-hub.v1';
export const HUB_CONTROL_PATH = '/__opencraft_hub/control';
export const HUB_DATA_PATH = '/__opencraft_hub/data';
export const HUB_SETTINGS_PATH = '/__opencraft_hub/settings';
export const MAX_HOPS = 8;
export interface IdentityAuthority { issuer: string; publicKey: string; providers: string[]; }
export interface HubService { hubId: string; publicKey: string; origin: string; authority: IdentityAuthority; signature: string; }
export interface HubRoute { service: HubService; path: string[]; }
export interface HubPeerView { id: string; hubId: string | null; name: string; endpoint: string | null; direction: 'incoming' | 'outgoing'; connected: boolean; allowTransit: boolean; origins: string[]; }
export interface HubNetworkSnapshot {
  schemaVersion: 1; revision: number; hubId: string; name: string; endpoint: string; origin: string;
  accepting: boolean; forwarding: boolean; authority: IdentityAuthority | null;
  localService: boolean;
  peers: HubPeerView[]; invitations: { id: string; expiresAt: number; redeemed: boolean; allowTransit: boolean; origins: string[] }[];
  routes: { hubId: string; origin: string; path: string[]; nextHop: string; }[];
  audit: { at: string; operator: string; action: string }[];
}
export function validHubId(value: unknown): value is string { return typeof value === 'string' && /^hub-[a-f0-9]{40}$/u.test(value); }
export function publicOrigin(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Invalid origin');
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.origin !== value || url.username || url.password) throw new Error('Invalid origin');
  return value;
}
export function transportEndpoint(value: unknown): string {
  const origin = publicOrigin(value), url = new URL(origin);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === '127.0.0.1')) throw new Error('Hub connections require HTTPS');
  return origin;
}
