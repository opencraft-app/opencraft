import type { CapabilitySession } from "./index.js";
import type { CapabilityBindingSnapshot, CapabilityBindingStore, CapabilityBindingWrite } from "./bindings.js";

type Execution = { scope: CapabilitySession; session: CapabilitySession | null };
const key = (session: CapabilitySession) => JSON.stringify([session.serverId, session.threadId]);
const scope = (session: CapabilitySession): CapabilitySession => ({
  serverId: session.serverId,
  threadId: session.threadId,
});

/**
 * Capability bindings for a network thread that does not hold the database.
 * Reads come from memory; each write is checked here against the same keys the
 * table enforces, applied to memory, then committed by the owner in order. The
 * stored state is therefore always an earlier point of this history: a lost
 * write after a crash looks like the process stopped just before it. Once a
 * commit fails the projection no longer matches storage, so every read finds
 * nothing and every write throws: credentials fail closed.
 */
export class CapabilityBindingProjection implements CapabilityBindingStore {
  private readonly bindings = new Map<string, CapabilitySession>();
  private readonly bindingIds = new Map<string, string>();
  private readonly executions = new Map<string, Execution>();
  private readonly executionIds = new Map<string, string>();
  private committed: Promise<void> = Promise.resolve();
  private failure?: Error;

  constructor(
    snapshot: CapabilityBindingSnapshot,
    private readonly commit: (write: CapabilityBindingWrite) => Promise<void>,
    private readonly onFailure?: (error: Error) => void,
  ) {
    for (const [id, serverId, threadId] of snapshot.bindings) this.storeBinding(id, { serverId, threadId });
    for (const [id, serverId, threadId, sessionJson] of snapshot.executions)
      this.storeExecution(id, {
        scope: { serverId, threadId },
        session: sessionJson === null ? null : JSON.parse(sessionJson),
      });
  }

  /** Resolves once every earlier write committed; rejects if one failed. */
  flush(): Promise<void> {
    return this.committed.then(() => {
      if (this.failure) throw this.failure;
    });
  }

  /** Waits for every accepted write before the owner closes. */
  close(): Promise<void> {
    return this.flush();
  }

  get(id: string): CapabilitySession | null {
    if (this.failure) return null;
    const session = this.bindings.get(id);
    return session ? { ...session } : null;
  }
  id(session: CapabilitySession): string | null {
    return this.failure ? null : (this.bindingIds.get(key(session)) ?? null);
  }
  execution(id: string): Execution | null {
    if (this.failure) return null;
    const execution = this.executions.get(id);
    return execution ? structuredClone(execution) : null;
  }
  executionId(session: CapabilitySession): string | null {
    return this.failure ? null : (this.executionIds.get(key(session)) ?? null);
  }

  bind(id: string, session: CapabilitySession): void {
    this.assertAvailable();
    if (this.bindings.has(id) || this.bindingIds.has(key(session)))
      throw new Error("Capability binding already exists");
    this.storeBinding(id, scope(session));
    this.write(["bind", id, scope(session)]);
  }
  prepareExecution(id: string, session: CapabilitySession): void {
    this.assertAvailable();
    if (this.executions.has(id) || this.executionIds.has(key(session)))
      throw new Error("Execution capability binding already exists");
    this.storeExecution(id, { scope: scope(session), session: null });
    this.write(["prepareExecution", id, scope(session)]);
  }
  bindExecution(id: string, session: CapabilitySession): void {
    this.assertAvailable();
    const prior = this.executions.get(id);
    if (
      !prior ||
      prior.scope.serverId !== session.serverId ||
      prior.scope.threadId !== session.threadId ||
      (prior.session && JSON.stringify(prior.session) !== JSON.stringify(session))
    )
      throw new Error("Execution capability binding changed");
    const copy = structuredClone(session);
    prior.session = copy;
    this.write(["bindExecution", id, copy]);
  }
  removeExecution(id: string): void {
    this.assertAvailable();
    const prior = this.executions.get(id);
    if (prior) {
      this.executions.delete(id);
      if (this.executionIds.get(key(prior.scope)) === id) this.executionIds.delete(key(prior.scope));
    }
    this.write(["removeExecution", id]);
  }

  private storeBinding(id: string, session: CapabilitySession) {
    this.bindings.set(id, Object.freeze(session));
    this.bindingIds.set(key(session), id);
  }
  private storeExecution(id: string, execution: Execution) {
    this.executions.set(id, execution);
    this.executionIds.set(key(execution.scope), id);
  }
  private assertAvailable() {
    if (this.failure) throw new Error("Capability bindings are unavailable", { cause: this.failure });
  }
  private write(write: CapabilityBindingWrite) {
    const commit = this.commit(write);
    this.committed = this.committed
      .then(() => commit)
      .catch((error: unknown) => {
        if (this.failure) return;
        this.failure = error instanceof Error ? error : new Error(String(error));
        this.onFailure?.(this.failure);
      });
  }
}
