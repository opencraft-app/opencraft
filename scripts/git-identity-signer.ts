import { createHash, createPrivateKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import type { GitVaultCredential } from './employee-git-vault-store.js';

export function sshString(value: string | Uint8Array): Buffer {
  const bytes = Buffer.from(value), size = Buffer.alloc(4); size.writeUInt32BE(bytes.length);
  return Buffer.concat([size, bytes]);
}
export function generateGitSigningKey(): NonNullable<GitVaultCredential['signing']> {
  const pair = generateKeyPairSync('ed25519');
  const publicJwk = pair.publicKey.export({ format: 'jwk' });
  const blob = Buffer.concat([sshString('ssh-ed25519'), sshString(Buffer.from(publicJwk.x!, 'base64url'))]);
  return { generation: randomUUID(), publicKey: `ssh-ed25519 ${blob.toString('base64')}`,
    fingerprint: `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/u, '')}`,
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), registration: 'pending' };
}
function field(bytes: Buffer, offset: number): [Buffer, number] {
  if (offset + 4 > bytes.length) throw new Error('invalid');
  const size = bytes.readUInt32BE(offset), end = offset + 4 + size;
  if (end > bytes.length) throw new Error('invalid');
  return [bytes.subarray(offset + 4, end), end];
}
/** Validate only Git SSHSIG messages; authentication uses a separate agent. */
function gitSigningPayload(bytes: Buffer): boolean {
  try {
    if (bytes.subarray(0, 6).toString() !== 'SSHSIG') return false;
    const [namespace, a] = field(bytes, 6), [reserved, b] = field(bytes, a), [hash, c] = field(bytes, b), [digest, end] = field(bytes, c);
    return namespace.toString() === 'git' && reserved.length === 0 && end === bytes.length
      && ((hash.toString() === 'sha512' && digest.length === 64) || (hash.toString() === 'sha256' && digest.length === 32));
  } catch { return false; }
}
async function createMemoryAgent(signing: NonNullable<GitVaultCredential['signing']>, runtimeDirectory: string, ttlMs = 300_000, authorize: () => Promise<boolean>, accepts: (bytes: Buffer) => boolean) {
  const clear = Buffer.from(signing.privateKey);
  let key: ReturnType<typeof createPrivateKey> | null;
  try { key = createPrivateKey(clear); } finally { clear.fill(0); }
  const blob = Buffer.from(signing.publicKey.split(' ')[1]!, 'base64');
  const directory = await mkdtemp(join(runtimeDirectory, 'sign-'));
  await chmod(directory, 0o700);
  const path = join(directory, 'agent.sock'), sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => socket.destroy());
    let pending = Buffer.alloc(0);
    let queue = Promise.resolve(), outstanding = 0;
    const respond = async (request: Buffer) => {
      let response = Buffer.from([5]);
      try {
        if (request[0] === 11 && request.length === 1) {
          response = Buffer.concat([Buffer.from([12, 0, 0, 0, 1]), sshString(blob), sshString('Git identity')]);
        } else if (request[0] === 13 && key) {
          const [publicKey, a] = field(request, 1), [payload, b] = field(request, a);
          if (b + 4 === request.length && request.readUInt32BE(b) === 0 && publicKey.equals(blob) && accepts(payload)
            && await authorize() && key) {
            response = Buffer.concat([Buffer.from([14]), sshString(Buffer.concat([sshString('ssh-ed25519'), sshString(sign(null, payload, key))]))]);
          }
        }
      } catch { /* Protocol/authorization failures contain no credential details. */ }
      if (!socket.destroyed) socket.write(sshString(response));
    };
    socket.on('data', chunk => {
      pending = Buffer.concat([pending, chunk]);
      if (pending.length > 65_536) { socket.destroy(); return; }
      while (pending.length >= 4) {
        const size = pending.readUInt32BE(0);
        if (size > 32_768 || size === 0) { socket.destroy(); return; }
        if (pending.length < size + 4) return;
        const request = pending.subarray(4, size + 4); pending = pending.subarray(size + 4);
        if (++outstanding > 32) { socket.destroy(); return; }
        queue = queue.then(() => respond(request)).finally(() => { outstanding--; });
      }
    });
  });
  let closed = false;
  const close = async () => {
    if (closed) return; closed = true; clearTimeout(timer); key = null;
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  };
  const timer = setTimeout(() => { void close(); }, ttlMs); timer.unref();
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, () => { server.off('error', reject); resolve(); }); });
    await chmod(path, 0o600);
    return { path, close };
  } catch (error) { await close(); throw error; }
}

/** An authentication agent accepts only SSH publickey userauth for the Git user. */
function gitAuthenticationPayload(bytes: Buffer, publicKey: string): boolean {
  try {
    const [session, a] = field(bytes, 0);
    if (session.length < 16 || session.length > 128 || bytes[a] !== 50) return false;
    const [user, b] = field(bytes, a + 1), [service, c] = field(bytes, b), [method, d] = field(bytes, c);
    if (bytes[d] !== 1) return false;
    const [algorithm, e] = field(bytes, d + 1), [key, end] = field(bytes, e);
    return user.toString() === 'git' && service.toString() === 'ssh-connection' && method.toString() === 'publickey'
      && algorithm.toString() === 'ssh-ed25519' && key.equals(Buffer.from(publicKey.split(' ')[1]!, 'base64')) && end === bytes.length;
  } catch { return false; }
}
export function createMemoryGitSigner(signing: NonNullable<GitVaultCredential['signing']>, runtimeDirectory: string, ttlMs = 300_000, authorize: () => Promise<boolean> = async () => true) {
  return createMemoryAgent(signing, runtimeDirectory, ttlMs, authorize, gitSigningPayload);
}
export function createMemoryGitAuthenticator(key: NonNullable<GitVaultCredential['sshAuth']>, runtimeDirectory: string, ttlMs = 300_000, authorize: () => Promise<boolean> = async () => true) {
  return createMemoryAgent({ ...key, registration: 'unregistered' }, runtimeDirectory, ttlMs, authorize, bytes => gitAuthenticationPayload(bytes, key.publicKey));
}
