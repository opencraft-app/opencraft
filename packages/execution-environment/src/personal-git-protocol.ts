import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { queryGitIdentityBroker } from './git-identity-ipc.js';

export const PERSONAL_GIT_PROTOCOL = 2;
const aad = Buffer.from('opencraft.personal-git.execution.v2');
const actorAad=Buffer.from('opencraft.personal-git.actor-execution.v3');
export interface GitGrantScope {
  readonly account: string; readonly hostId: 'local-codex' | 'opencraft-server';
  readonly threadId: string; readonly inputId: string; readonly executionId: string; readonly leaseGeneration: number;
  readonly actorGeneration?:number;readonly membershipRevision?:number;
}
export function validGitGrantScope(value: unknown): value is GitGrantScope {
  const s = value as GitGrantScope | null;
  return !!s && typeof s === 'object' && ['account','threadId','inputId','executionId'].every(k => typeof (s as any)[k] === 'string' && (s as any)[k].length > 0 && (s as any)[k].length <= 512 && !/[\0\r\n]/u.test((s as any)[k]))
    && ['local-codex','opencraft-server'].includes(s.hostId) && Number.isSafeInteger(s.leaseGeneration) && s.leaseGeneration > 0
    && (!s.account.startsWith('actor:human://') || Number.isSafeInteger(s.actorGeneration)&&s.actorGeneration!>0&&Number.isSafeInteger(s.membershipRevision)&&s.membershipRevision!>=0);
}
export function gitGrantAuthority(key: Uint8Array, accountMode:'principal'|'actor'='principal'): string { return createHmac('sha256', key).update(accountMode==='actor'?actorAad:aad).digest('hex'); }
export function sealGitGrant(key: Uint8Array, scope: GitGrantScope): string {
  if (!validGitGrantScope(scope)) throw Error('git_execution_attestation_missing');
  const { account, hostId, threadId, inputId, executionId, leaseGeneration,actorGeneration,membershipRevision } = scope;
  const actor=account.startsWith("actor:human://");
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(actor?actorAad:aad);
  return (actor?'v3.':'v2.') + Buffer.concat([iv, cipher.update(JSON.stringify({ account, hostId, threadId, inputId, executionId, leaseGeneration,...(actor?{actorGeneration,membershipRevision}:{}) })), cipher.final(), cipher.getAuthTag()]).toString('base64url');
}
export function openGitGrant(key: Uint8Array, token: unknown): GitGrantScope | null {
  if (typeof token !== 'string' || token.length > 8192 || !/^v[23]\.[A-Za-z0-9_-]+$/u.test(token)) return null;
  let clear: Buffer | undefined;
  try {
    const data = Buffer.from(token.slice(3), 'base64url'); if (data.length < 29 || data.toString('base64url') !== token.slice(3)) return null;
    const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0,12)); decipher.setAAD(token.startsWith('v3.')?actorAad:aad); decipher.setAuthTag(data.subarray(-16));
    clear = Buffer.concat([decipher.update(data.subarray(12,-16)), decipher.final()]);
    const value: unknown = JSON.parse(clear.toString()); return validGitGrantScope(value)&&token.startsWith('v3.')===value.account.startsWith('actor:human://') ? Object.freeze(value) : null;
  } catch { return null; } finally { clear?.fill(0); }
}
/** Ready endpoints are replicas of one attestation authority, not "the newest socket".
 * The caller supplies an expected authority/UID from trusted execution injection.
 * Discovery never mints a grant and never substitutes a different account. */
export async function readyGitBroker(runtime: string, authority: string, uid: number, preferred: string, deadline: number): Promise<string> {
  if (!/^[a-f0-9]{64}$/u.test(authority) || !Number.isSafeInteger(uid) || uid < 0) throw Error('git_broker_locator_invalid');
  while (Date.now() < deadline) {
    const root = await lstat(runtime).catch(() => null);
    if (root && (!root.isDirectory() || root.uid !== uid || (root.mode & 0o077))) throw Error('git_broker_locator_invalid');
    const paths: string[] = [];
    for (const name of (await readdir(runtime).catch(() => [])).filter(n => /^owner-[a-f0-9]{12}$/u.test(n)).sort()) {
      const dir = join(runtime,name), descriptor = join(dir,'ready.json'), socket = join(dir,'broker.sock');
      try {
        const [d,f,s] = await Promise.all([lstat(dir),lstat(descriptor),lstat(socket)]);
        if (!d.isDirectory() || !f.isFile() || f.size > 2048 || !s.isSocket() || [d,f,s].some(x => x.uid !== uid || (x.mode & 0o077))) continue;
        const v = JSON.parse(await readFile(descriptor,'utf8'));
        if (v.protocol === PERSONAL_GIT_PROTOCOL && v.authority === authority && v.socket === socket) paths.push(socket);
      } catch { /* A retiring or foreign endpoint is not an authorization failure. */ }
    }
    paths.sort((a,b) => Number(b === preferred) - Number(a === preferred) || a.localeCompare(b));
    for (const socket of paths) {
      const remaining = deadline - Date.now(); if (remaining <= 0) break;
      try {
        const result = await queryGitIdentityBroker(socket,{op:'probe',protocol:PERSONAL_GIT_PROTOCOL,authority},Math.min(1000,remaining));
        if (result.status === 'ready' && result.protocol === PERSONAL_GIT_PROTOCOL && result.authority === authority) return socket;
      } catch { /* No execution or Git mutation has been submitted. */ }
    }
    if (Date.now() < deadline) await new Promise(resolve => setTimeout(resolve,Math.min(100,deadline-Date.now())));
  }
  throw Error('git_broker_not_ready');
}
