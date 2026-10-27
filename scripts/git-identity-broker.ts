import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { EmployeeGitVaultStore, type GitVaultCredential } from './employee-git-vault-store.js';
import { createMemoryGitSigner, createMemoryGitAuthenticator } from './git-identity-signer.js';

export interface GitPeer { pid: number; uid: number }
export type GitExecutionIdentity = { status: 'active'; account: string; executionId: string }
  | { status: 'unowned' | 'unknown' | 'expired' };
export interface GitBrokerOptions {
  store: EmployeeGitVaultStore; hosts: readonly string[]; runtimeDirectory: string;
  resolve(peer: GitPeer, threadId: string): Promise<GitExecutionIdentity>;
  ttlMs?: number;
}
interface Session {
  peer: GitPeer; startTicks: string; account: string; host: string; revision: number;
  threadId: string; executionId: string;
  credential: GitVaultCredential; expires: number;
  authenticator: Awaited<ReturnType<typeof createMemoryGitAuthenticator>> | null;
  signer: Awaited<ReturnType<typeof createMemoryGitSigner>> | null;
}
export async function readGitProcess(pid: number) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('unavailable');
  const value = await readFile(`/proc/${pid}/stat`, 'utf8'), fields = value.slice(value.lastIndexOf(')') + 2).split(' ');
  return { pid, parent: Number(fields[1]), startTicks: fields[19]! };
}
async function sameProcessTree(peer: GitPeer, session: Session): Promise<boolean> {
  if (peer.uid !== session.peer.uid) return false;
  let pid = peer.pid;
  for (let i = 0; i < 128 && pid > 1; i++) {
    const process = await readGitProcess(pid);
    if (pid === session.peer.pid) return process.startTicks === session.startTicks;
    pid = process.parent;
  }
  return false;
}
/** Single-command capabilities carry no private key and cannot switch to another employee. */
export class GitIdentityBroker {
  private readonly sessions = new Map<string, Session>();
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(private readonly options: GitBrokerOptions) {
    this.timer = setInterval(() => { void this.reap(); }, 5_000); this.timer.unref();
  }
  async request(peer: GitPeer, input: unknown): Promise<Record<string, unknown>> {
    try {
      if (peer.uid !== process.getuid?.() || !input || typeof input !== 'object' || Array.isArray(input)) return { status: 'unavailable' };
      const request = input as Record<string, unknown>;
      if (request.op === 'health') return { status: 'ready', commandSessions: this.sessions.size };
      if (request.op === 'open') {
        if (typeof request.threadId !== 'string' || !request.threadId || request.threadId.length > 512
          || typeof request.host !== 'string' || !this.options.hosts.includes(request.host)) return { status: 'unavailable' };
        // Establish host-wide absence before touching asynchronous execution
        // adapters. Unbound Git must not depend on their health or latency.
        if (!this.options.store.hasBindings(request.host)) return { status: 'unconfigured' };
        const identity = await this.options.resolve(peer, request.threadId);
        if (identity.status === 'unowned') return { status: 'unconfigured' };
        if (identity.status !== 'active') return { status: identity.status === 'expired' ? 'expired' : 'unavailable' };
        const record = this.options.store.read(identity.account, request.host);
        if (!record.credential) return { status: 'unconfigured' };
        const start = await readGitProcess(peer.pid), credential = record.credential;
        const threadId = request.threadId;
        const authorize = async () => {
          if ((await readGitProcess(peer.pid)).startTicks !== start.startTicks) return false;
          const current = await this.options.resolve(peer, threadId);
          return current.status === 'active' && current.account === identity.account && current.executionId === identity.executionId
            && this.options.store.read(identity.account, request.host as string).revision === record.revision;
        };
        const signer = credential.signing ? await createMemoryGitSigner(credential.signing, this.options.runtimeDirectory, this.options.ttlMs, authorize) : null;
        const authenticator = request.operation === 'push' && credential.sshAuth
          ? await createMemoryGitAuthenticator(credential.sshAuth, this.options.runtimeDirectory, this.options.ttlMs, authorize) : null;
        const id = randomUUID();
        this.sessions.set(id, { peer, startTicks: start.startTicks, account: identity.account, host: request.host,
          threadId, executionId: identity.executionId, revision: record.revision, credential, signer, authenticator, expires: performance.now() + (this.options.ttlMs ?? 300_000) });
        return { status: 'configured', sessionId: id, identity: credential.identity,
          ...(authenticator ? { sshAuth: { socket: authenticator.path, publicKey: credential.sshAuth!.publicKey } } : {}),
          ...(signer ? { signing: { socket: signer.path, publicKey: credential.signing!.publicKey } } : {}) };
      }
      if (typeof request.sessionId !== 'string') return { status: 'unavailable' };
      const session = this.sessions.get(request.sessionId);
      if (!session || session.expires <= performance.now()) return { status: 'expired' };
      if (!await sameProcessTree(peer, session)) return { status: 'unavailable' };
      if (request.op === 'close') { await this.remove(request.sessionId); return { status: 'closed' }; }
      if (request.op !== 'credential') return { status: 'unavailable' };
      // Exact final Git credential protocol/host, not URL hints or substring matches.
      if (session.credential.sshAuth || !session.credential.token || request.protocol !== 'https' || request.host !== session.host || !this.options.hosts.includes(String(request.host))) return { status: 'denied' };
      const current = await this.options.resolve(session.peer, session.threadId);
      if (current.status === 'unknown') return { status: 'unavailable' };
      if (current.status !== 'active' || current.executionId !== session.executionId || current.account !== session.account) return { status: 'expired' };
      if (this.options.store.read(session.account, session.host).revision !== session.revision) return { status: 'expired' };
      return { status: 'configured', username: session.credential.identity.username, password: session.credential.token };
    } catch { return { status: 'unavailable' }; }
  }
  async close(): Promise<void> { clearInterval(this.timer); await Promise.all([...this.sessions.keys()].map(id => this.remove(id))); }
  private async remove(id: string): Promise<void> {
    const session = this.sessions.get(id); this.sessions.delete(id); await session?.signer?.close(); await session?.authenticator?.close();
  }
  private async reap(): Promise<void> {
    for (const [id, session] of this.sessions) {
      try { if (session.expires > performance.now() && (await readGitProcess(session.peer.pid)).startTicks === session.startTicks) continue; }
      catch { /* The command owner exited. */ }
      await this.remove(id);
    }
  }
}
