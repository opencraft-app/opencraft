import { connect } from 'node:net';
import type { ExecutionEnvironmentRuntime, EnvironmentExecutionScope } from '@opencraft/execution-environment';
import { prepareProcessIdentity, type PreparedProcessIdentity } from './process-identity.js';
import { lstat, readFile } from 'node:fs/promises';
import { launchTerminalOwner, terminalOwnerLocation } from './terminal-owner-runtime.js';
import { openTerminalOwnerLink, releaseTerminalThread, type TerminalOwnerConnection, type TerminalOwnerLink } from './terminal-owner-link.js';

/** Host-side authority adapter. Closing this adapter only detaches observers. */
export class DurableHostProcessService {
  private readonly listeners = new Set<(method: string, params: unknown) => void>();
  private link?: TerminalOwnerLink;
  private connecting?: Promise<TerminalOwnerLink>;
  private closed = false;
  constructor(private readonly directory: string, private readonly environment?: ExecutionEnvironmentRuntime,
    private readonly external?: { endpoint: string; tokenFile: string;
      /** Issuer key from trusted composition; the owner pins it for this attachment. */
      environmentIssuer?: string;
      prepare(method: string, params: unknown, scope: EnvironmentExecutionScope | undefined,
        context: { service: DurableHostProcessService; assertCurrent?: () => void }): PreparedProcessIdentity | Promise<PreparedProcessIdentity> }) {}
  subscribe(listener: (method: string, params: unknown) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  async probe(): Promise<void> { if ((await this.connection()).terminalAdmission) await this.probeTerminalAdmission(); }
  private async connection(): Promise<TerminalOwnerLink> {
    if (this.closed) throw new Error('Process service is closed');
    if (this.link && !this.link.isClosed) return this.link;
    if (!this.connecting) {
      this.connecting = this.establish().finally(() => { this.connecting = undefined; });
    }
    return this.connecting;
  }
  private async establish() {
    if (this.external) {
      const info = await lstat(this.external.tokenFile);
      if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077)) throw new Error('Invalid terminal owner token file');
      const token = (await readFile(this.external.tokenFile, 'utf8')).trim();
      if (token.length < 32 || token.length > 512) throw new Error('Invalid terminal owner token');
      return this.attach(this.external.endpoint, token);
    }
    const location = await terminalOwnerLocation(this.directory);
    const until = Date.now() + 15_000;
    let started = false;
    do {
      if (this.closed) throw new Error('Process service is closed');
      try { return await this.attach(location.endpoint); }
      catch (error) {
        if (!['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      }
      if (!started) { await launchTerminalOwner(location); started = true; }
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < until);
    throw new Error('Terminal owner unavailable');
  }
  private async attach(endpoint: string, token?: string): Promise<TerminalOwnerLink> {
    const link = await openTerminalOwnerLink(onData => this.dial(endpoint, onData), {
      token,
      environmentIssuer: this.external?.environmentIssuer,
      onNotification: (method, params) => {
        for (const listener of this.listeners) listener(method, params);
      },
    });
    if (this.closed || link.isClosed) {
      await link.close();
      throw new Error('Process service is closed');
    }
    this.link = link;
    void link.closed.then(() => { if (this.link === link) this.link = undefined; });
    return link;
  }
  private dial(endpoint: string, onData: (bytes: Uint8Array) => void): Promise<TerminalOwnerConnection> {
    return new Promise((resolve, reject) => {
      const socket = connect(endpoint);
      const closed = new Promise<void>(finish => socket.once('close', () => {
        clearTimeout(timer);
        reject(new Error('Terminal owner connection closed'));
        finish();
      }));
      const timer = setTimeout(() => {
        reject(new Error('Terminal owner connection timed out'));
        socket.destroy();
      }, 5000);
      socket.on('error', reject);
      socket.on('data', onData);
      socket.once('connect', () => {
        clearTimeout(timer);
        resolve({
          closed,
          write: bytes => new Promise<void>((written, failed) => {
            socket.write(bytes, error => error ? failed(error) : written());
          }),
          close: () => { socket.destroy(); return closed; },
        });
      });
    });
  }
  async probeTerminalAdmission(): Promise<void> {
    if (!(await this.connection()).terminalAdmission) throw Error('Hands terminal admission unavailable');
    await this.dispatchIdentity('process/quotaProbe', {}, {quotaOwner:'server-terminal-admission', lifecycleAuthority:true});
  }
  /** Compiled provider/owner IPC only; excluded from the public method catalog. */
  async reserveTerminal(quotaOwner: string, resource: string, operation: string): Promise<string> {
    if (!(await this.connection()).terminalAdmission) throw Error('Hands terminal admission unavailable');
    const token = await this.dispatchIdentity('process/quotaReserve', {resource, operation}, {quotaOwner, lifecycleAuthority:true});
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/u.test(token)) throw Error('Invalid terminal admission receipt');
    return token;
  }
  async releaseTerminal(token: string, proof: 'exited'|'not-created'): Promise<void> {
    if (!(await this.connection()).terminalAdmission) throw Error('Hands terminal admission unavailable');
    await this.dispatchIdentity('process/quotaRelease', {token, proof}, {quotaOwner:'server-terminal-admission', lifecycleAuthority:true});
  }
  async confirmTerminalResourceDestroyed(quotaOwner: string, resource: string): Promise<void> {
    if (!(await this.connection()).terminalAdmission) throw Error('Hands terminal admission unavailable');
    await this.dispatchIdentity('process/quotaResourceDestroyed', {resource}, {quotaOwner, lifecycleAuthority:true});
  }
  /** Delivered ENV: the owner writes its reservation (with the Actor epoch the
   * Host admitted) and answers with the admission and its receiver target. An
   * owner that did not accept the pinned issuer is refused, never bypassed. */
  async reserveEnvironmentLaunch(identity: PreparedProcessIdentity, processHandle: unknown, admission: unknown): Promise<unknown> {
    if (!(await this.connection()).environmentLaunch) throw Error('Terminal owner does not accept delivered ENV; upgrade it');
    return this.dispatchIdentity('process/environmentReserve', { processHandle, admission }, identity);
  }
  async abandonEnvironmentLaunch(identity: PreparedProcessIdentity, processHandle: unknown): Promise<void> {
    if (!(await this.connection()).environmentLaunch) return;
    await this.dispatchIdentity('process/environmentAbandon', { processHandle }, identity);
  }
  async threadScopes(): Promise<{hostId: string; threadId: string}[]> {
    return await this.dispatchIdentity('process/threadScopes', {}, { quotaOwner: 'server-lifecycle', lifecycleAuthority: true }) as {hostId: string; threadId: string}[];
  }
  /** Trusted composition only; not in the public method catalog. */
  releaseThread(hostId: string, threadId: string, activate = false, aliases: readonly {owner: string; resourceOwnerId: string}[] = []): Promise<void> {
    return releaseTerminalThread((method, params, identity) => this.dispatchIdentity(method, params, identity),
      hostId, threadId, activate, aliases);
  }
  async dispatch(method: string, params: unknown, scope?: EnvironmentExecutionScope, assertCurrent?: () => void, onAccepted?: () => void): Promise<unknown> {
    const identity = this.external ? await this.external.prepare(method, params, scope, { service: this, assertCurrent })
      : prepareProcessIdentity(this.environment, scope, method, params);
    return this.dispatchIdentity(method, params, identity, assertCurrent, onAccepted);
  }
  private async dispatchIdentity(method: string, params: unknown, identity: PreparedProcessIdentity, assertCurrent?: () => void, onAccepted?: () => void): Promise<unknown> {
    const link = await this.connection();
    if (this.closed) throw new Error('Process service is closed');
    return link.dispatch(method, params, identity, assertCurrent, onAccepted);
  }
  close() {
    this.closed = true;
    this.listeners.clear();
    void this.link?.close().catch(() => {});
  }
}
