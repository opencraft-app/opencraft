import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign, verify } from 'node:crypto';
import { lstatSync, openSync, closeSync, readFileSync, writeFileSync, renameSync, fsyncSync, mkdirSync, constants } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import lockfile from 'proper-lockfile';
import { publicOrigin, transportEndpoint, validHubId, type IdentityAuthority, type HubService } from './contract.js';

export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const hubId = (publicKey: string) => 'hub-' + digest(createPublicKey(publicKey).export({ format: 'der', type: 'spki' }).toString('base64')).slice(0, 40);
export const random = () => randomBytes(32).toString('base64url');
export function signed(input: unknown, privateKey: string): string { return sign(null, Buffer.from(JSON.stringify(input)), createPrivateKey(privateKey)).toString('base64url'); }
export function verified(input: unknown, signature: string, publicKey: string): boolean {
  try { const key = createPublicKey(publicKey); return key.asymmetricKeyType === 'ed25519' && verify(null, Buffer.from(JSON.stringify(input)), key, Buffer.from(signature, 'base64url')); } catch { return false; }
}
export function authority(input: unknown): IdentityAuthority {
  const a = input as IdentityAuthority;
  if (!a || typeof a.issuer !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/u.test(a.issuer) || typeof a.publicKey !== 'string'
    || a.publicKey.length > 4096 || createPublicKey(a.publicKey).asymmetricKeyType !== 'ed25519' || !Array.isArray(a.providers)
    || !a.providers.length || a.providers.length > 16 || !a.providers.every(p => /^[a-z0-9][a-z0-9._-]{0,63}$/u.test(p))) throw new Error('Invalid identity authority');
  return { issuer: a.issuer, publicKey: a.publicKey, providers: [...new Set(a.providers)] };
}
export function servicePayload(service: HubService) { return { hubId: service.hubId, publicKey: service.publicKey, origin: service.origin, authority: authority(service.authority) }; }
export function validService(input: unknown): HubService {
  const s = input as HubService;
  if (!s || !validHubId(s.hubId) || typeof s.publicKey !== 'string' || s.publicKey.length > 4096 || hubId(s.publicKey) !== s.hubId
    || typeof s.signature !== 'string' || s.signature.length > 256 || !verified(servicePayload(s), s.signature, s.publicKey)) throw new Error('Invalid signed service');
  publicOrigin(s.origin); return { ...servicePayload(s), signature: s.signature };
}
export interface Peer {
  id: string; hubId: string; publicKey: string; endpoint: string; credential: string; ca?: string;
  name?: string;
  allowTransit: boolean; origins: string[];
}
export interface Invitation { id: string; hash: string; expiresAt: number; allowTransit: boolean; origins: string[]; hubId?: string; publicKey?: string; name?: string; }
export interface State {
  schemaVersion: 1; revision: number; privateKey: string; publicKey: string; name: string; endpoint: string; origin: string;
  accepting: boolean; forwarding: boolean; authority: IdentityAuthority | null; peers: Peer[]; invitations: Invitation[];
  audit: { at: string; operator: string; action: string }[];
}
export interface InvitePayload {
  version: 1; endpoint: string; hubId: string; publicKey: string; name: string; id: string; credential: string;
  expiresAt: number; allowTransit: boolean; origins: string[]; authority: IdentityAuthority | null; ca?: string;
}
export function parseInvitation(value: unknown): InvitePayload {
  if (typeof value !== 'string' || value.length > 32_768) throw new Error('Invalid invitation');
  const envelope = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  const p = envelope?.payload as InvitePayload;
  if (!p || p.version !== 1 || !validHubId(p.hubId) || hubId(p.publicKey) !== p.hubId || !verified(p, envelope.signature, p.publicKey)
    || !Number.isSafeInteger(p.expiresAt) || p.expiresAt <= Date.now() || typeof p.credential !== 'string' || (p.name !== undefined && (typeof p.name !== 'string' || p.name.length > 128)) || !/^[A-Za-z0-9_-]{43}$/u.test(p.credential)
    || typeof p.id !== 'string' || p.id.length > 80 || typeof p.allowTransit !== 'boolean' || typeof p.name !== 'string' || p.name.length > 128
    || !Array.isArray(p.origins) || p.origins.length > 64 || p.origins.some(o => publicOrigin(o) !== o)
    || (p.ca !== undefined && (typeof p.ca !== 'string' || p.ca.length > 16_384 || !p.ca.includes('-----BEGIN CERTIFICATE-----')))) throw new Error('Invalid invitation');
  transportEndpoint(p.endpoint); if (p.authority) authority(p.authority); return p;
}
/** One deployment-owned, atomic private state; never browser preferences or relay replicas. */
export class HubStore {
  readonly state: State;
  readonly id: string;
  readonly #release: () => void;
  #closed = false;
  constructor(readonly path: string) {
    if (!isAbsolute(path)) throw new Error('Hub state requires an absolute path');
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.#release = lockfile.lockSync(path, { realpath: false });
    try {
    let present = false;
    try { lstatSync(path); present = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (present) {
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { const info = lstatSync(path); if (!info.isFile() || info.size > 1_048_576 || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())) throw new Error('Hub state must be private');
        this.state = JSON.parse(readFileSync(fd, 'utf8')); } finally { closeSync(fd); }
      const s = this.state;
      if (s.schemaVersion !== 1 || !Number.isSafeInteger(s.revision) || !Array.isArray(s.peers) || !Array.isArray(s.invitations) || !Array.isArray(s.audit)
        || typeof s.accepting !== 'boolean' || typeof s.forwarding !== 'boolean' || typeof s.name !== 'string' || s.name.length > 128
        || createPrivateKey(s.privateKey).asymmetricKeyType !== 'ed25519'
        || createPublicKey(s.privateKey).export({ format: 'pem', type: 'spki' }).toString() !== s.publicKey) throw new Error('Invalid Hub state');
      if (s.endpoint) transportEndpoint(s.endpoint); if (s.origin) publicOrigin(s.origin); if (s.authority) authority(s.authority);
      if (s.peers.length > 32 || s.invitations.length > 128 || s.audit.length > 200) throw new Error('Invalid Hub state size');
      const origins = (values: unknown): values is string[] => Array.isArray(values) && values.length <= 64 && values.every(v => publicOrigin(v) === v);
      for (const p of s.peers) if (!p || typeof p.id !== 'string' || !validHubId(p.hubId) || hubId(p.publicKey) !== p.hubId || transportEndpoint(p.endpoint) !== p.endpoint
        || (p.name !== undefined && (typeof p.name !== 'string' || p.name.length > 128)) || !/^[A-Za-z0-9_-]{43}$/u.test(p.credential) || typeof p.allowTransit !== 'boolean' || !origins(p.origins)
        || (p.ca !== undefined && (typeof p.ca !== 'string' || p.ca.length > 16_384 || !p.ca.includes('-----BEGIN CERTIFICATE-----')))) throw new Error('Invalid stored peer');
      for (const i of s.invitations) if (!i || typeof i.id !== 'string' || !/^[a-f0-9]{64}$/u.test(i.hash) || !Number.isSafeInteger(i.expiresAt)
        || (i.name !== undefined && (typeof i.name !== 'string' || i.name.length > 128)) || typeof i.allowTransit !== 'boolean' || !origins(i.origins) || (i.hubId !== undefined && (!validHubId(i.hubId) || typeof i.publicKey !== 'string' || hubId(i.publicKey) !== i.hubId))) throw new Error('Invalid stored invitation');
    } else {
      const pair = generateKeyPairSync('ed25519');
      this.state = { schemaVersion: 1, revision: 0, privateKey: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
        publicKey: pair.publicKey.export({ format: 'pem', type: 'spki' }).toString(), name: 'OpenCraft Hub', endpoint: '', origin: '', accepting: false, forwarding: false,
        authority: null, peers: [], invitations: [], audit: [] };
      this.save();
    }
    this.id = hubId(this.state.publicKey);
    } catch (error) { this.#release(); throw error; }
  }
  save() {
    if (this.#closed) throw new Error('Hub store is closed');
    const temp = this.path + '.' + randomUUID() + '.tmp';
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, JSON.stringify(this.state)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, this.path);
  }
  record(operator: string, action: string) {
    this.state.revision++;
    this.state.audit.push({ at: new Date().toISOString(), operator: operator.slice(0, 512), action });
    this.state.audit = this.state.audit.slice(-200); this.save();
  }
  service(): HubService | null {
    const s = this.state;
    if (!s.origin || !s.authority) return null;
    const data = { hubId: this.id, publicKey: s.publicKey, origin: s.origin, authority: s.authority };
    return { ...data, signature: signed(data, s.privateKey) };
  }
  close() { if (!this.#closed) { this.#closed = true; this.#release(); } }
}
