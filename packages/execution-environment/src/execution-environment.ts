import { randomUUID } from 'node:crypto';
import { PersonalGitEnvironment, type PersonalGitGrant } from './personal-git.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { TransportSubmissionContext } from '@opencraft/appserver-client/transport';
import { EmployeeGitVaultStore } from './employee-git-vault-store.js';
import { AccountEnvironment, EnvironmentError, validateEnvironmentName } from './account-environment.js';

export const EXECUTION_ENVIRONMENT_FIELD = '__opencraftEnvironment';
// Compatibility exports consume one operation-effects model. An ENV snapshot is
// configuration material, never evidence of participation or a live native Turn.
export { requiresEnvironmentAuthority, requiresCurrentEnvironmentAuthority } from './execution-request-policy.js';
import {EnvironmentMetadata,environmentProjectId,environmentScopeRequest,type EnvironmentExecutionScope} from './environment-metadata.js';
export {EnvironmentMetadata,environmentProjectId,environmentScopeRequest,environmentThreadProject} from './environment-metadata.js';
export type {EnvironmentExecutionScope,EnvironmentScopeRequest,EnvironmentMetadataPort} from './environment-metadata.js';
export {executionEnvironmentOwner,ExecutionEnvironmentSnapshot} from "./execution-snapshot.js";
import {executionEnvironmentOwner,ExecutionEnvironmentSnapshot} from "./execution-snapshot.js";
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\0\r\n]/u.test(value);

/** Trusted Node owner port. Storage and signed scope reuse the credential vault;
 * no browser frame can select another person's account or supply clear values. */
export class ExecutionEnvironmentRuntime {
  private readonly environment: AccountEnvironment;
  private readonly metadata: EnvironmentMetadata;
  private readonly git: PersonalGitEnvironment | undefined;
  private readonly disposers = new Set<() => void>();
  private readonly consumed = new Map<string, number>();
  private readonly snapshots = new Set<WeakRef<ExecutionEnvironmentSnapshot>>();
  constructor(readonly directory: string, private readonly vault: EmployeeGitVaultStore, private readonly ownsVault = false, gitMode: 'execution' | 'issuer' | 'disabled' = 'execution') {
    this.environment = new AccountEnvironment(vault);
    this.metadata = new EnvironmentMetadata(vault);
    // Compiled ENV delivery may borrow the sole vault without constructing a
    // second Git bridge. Existing execution/issuer callers remain unchanged.
    this.git = gitMode === 'disabled' ? undefined : PersonalGitEnvironment.fromEnvironment(directory, { authority: vault.personalGitAuthority(), seal: scope => vault.sealPersonalGitGrant(scope) }, gitMode);
  }
  static open(directory: string, options?: { create?: boolean }): ExecutionEnvironmentRuntime | undefined {
    // Independent execution owners can boot before the identity gateway. They
    // must retain a live store so later personal ENV writes become visible.
    return options?.create || existsSync(join(directory, 'employee-git-vault.sqlite'))
      ? new ExecutionEnvironmentRuntime(directory, new EmployeeGitVaultStore(directory), true) : undefined;
  }
  onClose(dispose: () => void) { this.disposers.add(dispose); }
  close() { void this.git?.close().catch(() => {}); for (const dispose of this.disposers) dispose(); this.disposers.clear(); if (this.ownsVault) this.vault.close(); }
  // Non-secret metadata shares its implementation with the vault-owner Worker.
  project(hostId: string, threadId: string): string | null { return this.metadata.project(hostId, threadId); }
  bind(hostId: string, threadId: string, projectId: string | null) { this.metadata.bind(hostId, threadId, projectId); }
  rememberCreation(scope: EnvironmentExecutionScope, threadId: string) { this.metadata.rememberCreation(scope, threadId); }
  creation(hostId: string, threadId: string): EnvironmentExecutionScope | null { return this.metadata.creation(hostId, threadId); }
  bindCreator(scope: EnvironmentExecutionScope, threadId: string): void { this.metadata.bindCreator(scope, threadId); }
  creator(hostId: string, threadId: string): { account: string | null } | null { return this.metadata.creator(hostId, threadId); }
  private admittedScope(scope: EnvironmentExecutionScope): EnvironmentExecutionScope { return this.metadata.admitted(scope); }
  rememberProjects(hostId: string, projects: readonly { id: string; name: string }[]) { this.metadata.rememberProjects(hostId, projects); }
  projects(hostIds?: string[]): { id: string; name: string }[] { return this.metadata.projects(hostIds); }
  scope(context: TransportSubmissionContext, hostId: string, params: Record<string, unknown>): EnvironmentExecutionScope {
    return this.metadata.admit(environmentScopeRequest(context, hostId, params));
  }
  seal(scope: EnvironmentExecutionScope, method: string, processHandle?: unknown): string {
    return this.vault.sealExecutionContext({ version: 1, scope, method, processHandle: processHandle ?? null, expires: Date.now() + 60_000, nonce: randomUUID() });
  }
  open(envelope: unknown, hostId: string, method: string, params: Record<string, unknown>): EnvironmentExecutionScope {
    const now = Date.now();
    for (const [nonce, expires] of this.consumed) if (expires < now) this.consumed.delete(nonce);
    let value: any;
    try { value = this.vault.openExecutionContext(envelope as string); } catch { throw new EnvironmentError('unavailable', 403); }
    const scope = value?.scope;
    if (value?.version !== 1 || !text(value.nonce) || value.expires < now || value.expires > now + 60_000
      || this.consumed.has(value.nonce) || this.consumed.size >= 4096 || value.method !== method
      || value.processHandle !== (params.processHandle ?? null) || !scope || scope.hostId !== hostId
      || scope.threadId !== (text(params.threadId) ? params.threadId : null)
      || params.projectId != null && params.projectId !== scope.projectId
      || scope.account !== null && !text(scope.account) || scope.projectId !== null && !text(scope.projectId)) throw new EnvironmentError('unavailable', 403);
    this.consumed.set(value.nonce, value.expires);
    return this.admittedScope(Object.freeze({ ...scope }));
  }
  /** Durable original execution provenance, also used for scheduler/recovery
   * launches. A reconnecting browser never replaces its principal. */
  execution(hostId: string, threadId: string, inputId?: string, projectId?: string | null, turnId?: string): EnvironmentExecutionScope {
    let account: string | null = null;
    let activeInput: string | undefined, activeExecution: string | undefined, leaseGeneration: number | undefined;
    const codex = hostId === 'local-codex';
    const root = codex ? join(this.directory, 'codex') : join(this.directory, 'thread-identities', 'opencraft-server');
    const primary = join(root, codex ? 'opencraft-host-state.sqlite' : 'thread-identity.sqlite');
    const path = codex && !existsSync(primary) ? join(root, 'codex-host-queue.sqlite') : primary;
    if (existsSync(path)) {
      const db = new DatabaseSync(path, { readOnly: true });
      try {
        db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000');
        const row = db.prepare(`SELECT s.principal_json,s.ownership,s.admission,l.state,l.input_id,l.execution_id,l.generation FROM execution_leases l
          JOIN execution_submissions s ON s.thread_id=l.thread_id AND s.input_id=l.input_id
          WHERE l.thread_id=? ${inputId ? 'AND l.input_id=?' : turnId ? 'AND l.turn_id=?' : ''} ORDER BY l.generation DESC LIMIT 1`).get(...(inputId || turnId ? [threadId, inputId ?? turnId!] : [threadId]));
        if (row?.ownership === 'human' && (row.admission === 'accepted' || inputId && row.admission === 'pending') && ['active', 'pending'].includes(String(row.state))) {
          const principal = JSON.parse(String(row.principal_json));
          if (text(principal?.provider) && text(principal?.subject)) { account = `${principal.provider}:${principal.subject}`; activeInput = String(row.input_id); activeExecution = String(row.execution_id); leaseGeneration = Number(row.generation); }
        }
      } finally { db.close(); }
    }
    const scope = Object.freeze({ account, hostId, threadId, projectId: projectId ?? this.project(hostId, threadId), ...(activeInput && activeExecution ? { inputId: activeInput, executionId: activeExecution, leaseGeneration } : {}) });
    // No active admission must never acquire a creator's credentials merely
    // because the caller knows the thread ID.
    return account === null ? scope : this.admittedScope(scope);
  }
  redact(value: unknown): unknown {
    if (typeof value === 'string') {
      for (const reference of this.snapshots) { const snapshot = reference.deref(); if (snapshot) value = snapshot.redact(value as string); else this.snapshots.delete(reference); }
      return value;
    }
    if (Array.isArray(value)) return value.map(item => this.redact(item));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.redact(item)]));
    return value;
  }
  snapshot(scope: EnvironmentExecutionScope, options?: { creation?: boolean }): ExecutionEnvironmentSnapshot {
    // Cold catalog/resume work has no active admission. It may receive an empty
    // environment, never the bound account's values.
    if (scope.account !== null) scope = this.admittedScope(scope);
    const variables = scope.account ? this.environment.launchEnvironment(scope.account, {
      projectId: scope.projectId === null ? null : environmentProjectId(scope.hostId, scope.projectId),
    }, {}) : {};
    const snapshot = new ExecutionEnvironmentSnapshot(scope, variables as Record<string, string>, this.git?.grant(scope, options), !!this.git && !!scope.account && (!scope.inputId || !scope.executionId));
    for (const reference of this.snapshots) if (!reference.deref()) this.snapshots.delete(reference);
    this.snapshots.add(new WeakRef(snapshot));
    return snapshot;
  }
}
