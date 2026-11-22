import type { OwnerCalls } from "@opencraft/worker-owner";
import type { ServerDatabase } from "@opencraft/storage-node/server";
import { sqliteTransaction } from "@opencraft/sqlite-node";
import type { Principal } from "@opencraft/identity-core";
import type { ActorContext } from "@opencraft/identity-core/actors";
import { ActorStore } from "./actors.js";
import { HumanAccounts, type HumanLogin } from "./human-accounts.js";
import { commitFence, serveCommitFence } from "./commit-fence.js";

/**
 * Identity writes a Server owner Worker performs on its own connection: login
 * sessions, identity bindings and Actor administration. Validation that needs
 * this process's registrations (local account versions, resource authorities)
 * happens on the calling thread first. Reads stay on the calling thread's
 * permission projection, which is republished after every commit.
 *
 * Actor administration is authorized by the caller's management authority,
 * which can be revoked or expire while the write waits in the owner's queue.
 * Each such write therefore takes the writer lock first, then asks the calling
 * thread through the commit fence to recheck that authority, and mutates only
 * if it was approved. No authority can commit a change while the lock is held.
 */
export class IdentityWriteOwner {
  readonly #actors: ActorStore;
  readonly #accounts: HumanAccounts;
  readonly #fence: ((token: number) => void) | null;
  constructor(
    private readonly owner: ServerDatabase,
    fence?: SharedArrayBuffer,
  ) {
    this.#actors = new ActorStore(owner, Date.now, { permissionProjection: false });
    this.#accounts = new HumanAccounts(owner, this.#actors);
    this.#fence = fence ? commitFence(fence) : null;
  }
  /** Runs `write` under the writer lock, after the caller re-approved `token`. */
  #fenced<T>(token: number, write: () => T): T {
    const fence = this.#fence;
    if (!fence) throw new Error("Actor administration requires a commit fence");
    return sqliteTransaction(this.owner.database, () => {
      fence(token);
      return write();
    });
  }
  issueLogin(principal: Principal, accountVersion: number | null): { token: string; login: HumanLogin } {
    return this.#accounts.issue(principal, accountVersion);
  }
  revokeLogin(token: string): void {
    this.#accounts.revoke(token);
  }
  rememberLabel(principal: Principal, label: string): void {
    this.#accounts.rememberLabel(principal, label);
  }
  bindHuman(owner: ActorContext, principal: Principal): boolean {
    return this.#actors.bindHuman(owner, principal);
  }
  unbindHuman(owner: ActorContext, binding: Pick<Principal, "provider" | "subject">): void {
    this.#actors.unbindHuman(owner, binding);
  }
  createSession(token: number, displayName: string, operator: string) {
    return this.#fenced(token, () => this.#actors.createSession(displayName, operator));
  }
  issueCredential(token: number, id: string, expiresAt: number, operator: string) {
    return this.#fenced(token, () => this.#actors.issueCredential(id, expiresAt, operator));
  }
  revokeCredential(token: number, id: string, operator: string): void {
    this.#fenced(token, () => this.#actors.revokeCredential(id, operator));
  }
  setCheckedGrant(
    token: number,
    id: string,
    resource: string,
    action: string,
    enabled: boolean,
    operator: string,
  ): void {
    this.#fenced(token, () =>
      this.#actors.setGrant(id, resource, action, enabled, operator, { authorityChecked: true }),
    );
  }
  setEnabled(token: number, id: string, enabled: boolean, operator: string): void {
    this.#fenced(token, () => this.#actors.setEnabled(id, enabled, operator));
  }
  close(): void {
    try {
      this.#accounts.close();
    } finally {
      this.#actors.close();
    }
  }
}

export const IDENTITY_WRITE_METHODS = [
  "issueLogin",
  "revokeLogin",
  "rememberLabel",
  "bindHuman",
  "unbindHuman",
  "createSession",
  "issueCredential",
  "revokeCredential",
  "setCheckedGrant",
  "setEnabled",
] as const satisfies readonly (keyof IdentityWriteOwner)[];

/** Methods a Server owner Worker serves for `IdentityWrites`. */
export function identityWriteMethods(owner: IdentityWriteOwner): Record<string, (...args: never[]) => unknown> {
  return Object.fromEntries(
    IDENTITY_WRITE_METHODS.map((name) => [name, (owner[name] as (...args: never[]) => unknown).bind(owner)]),
  );
}

/**
 * Identity writes for a network thread. Each resolves after the owner committed
 * it, then republishes this thread's permission projections and notifies
 * observers, so a read after the await sees the write. When this thread
 * registered registration hooks the owner cannot run, the write stays local.
 */
export class IdentityWrites {
  readonly #checks = new Map<number, () => boolean>();
  #sequence = 0;
  readonly #stopFence: () => void;
  constructor(
    private readonly owner: OwnerCalls<IdentityWriteOwner>,
    readonly actors: ActorStore,
    /** Absent when this installation has no human login. */
    readonly accounts: HumanAccounts | undefined,
    /** The buffer the owner's `IdentityWriteOwner` was given. */
    fence: SharedArrayBuffer,
  ) {
    this.#stopFence = serveCommitFence(fence, (token) => this.#checks.get(token)?.() === true);
  }
  close(): void {
    this.#stopFence();
  }
  /** Runs an administration write whose authority `authorize` rechecks under the owner's writer lock. */
  async #administer<T>(authorize: () => boolean, write: (token: number) => Promise<T>): Promise<T> {
    if (!authorize()) throw new Error("Actor management denied");
    const token = ++this.#sequence;
    this.#checks.set(token, authorize);
    try {
      return await write(token);
    } finally {
      this.#checks.delete(token);
      this.actors.ownerCommitted();
    }
  }

  async issueLogin(principal: Principal): Promise<{ token: string; login: HumanLogin }> {
    const accounts = this.loginAccounts();
    const accountVersion = accounts.loginAccountVersion(principal);
    // A login may register a human; registration hooks live on this thread only.
    if (this.actors.hasLocalRegistrationHooks) return accounts.issue(principal, accountVersion);
    const issued = await this.owner.issueLogin(principal, accountVersion);
    this.committed();
    return issued;
  }
  async revokeLogin(token: string): Promise<void> {
    const accounts = this.loginAccounts();
    await this.owner.revokeLogin(token);
    accounts.ownerCommitted();
  }
  async rememberLabel(principal: Principal, label: string): Promise<void> {
    await this.owner.rememberLabel(principal, label);
  }
  async bindHuman(owner: ActorContext, principal: Principal): Promise<void> {
    const changed = await this.owner.bindHuman(owner, principal);
    this.actors.ownerCommitted(changed ? owner.actorId : undefined);
  }
  async unbindHuman(owner: ActorContext, binding: Pick<Principal, "provider" | "subject">): Promise<void> {
    await this.owner.unbindHuman(owner, binding);
    this.actors.ownerCommitted(owner.actorId);
  }
  // Actor administration. `authorize` is the caller's current management
  // authority; it is checked now and again under the owner's writer lock.
  createSession(authorize: () => boolean, displayName: string, operator: string) {
    return this.#administer(authorize, (token) => this.owner.createSession(token, displayName, operator));
  }
  issueCredential(authorize: () => boolean, id: string, expiresAt: number, operator: string) {
    return this.#administer(authorize, (token) => this.owner.issueCredential(token, id, expiresAt, operator));
  }
  revokeCredential(authorize: () => boolean, id: string, operator: string): Promise<void> {
    return this.#administer(authorize, (token) => this.owner.revokeCredential(token, id, operator));
  }
  setGrant(
    authorize: () => boolean,
    id: string,
    resource: string,
    action: string,
    enabled: boolean,
    operator: string,
  ): Promise<void> {
    // Resource authorities are registered on this thread, so the compiled check
    // runs here; the fence rechecks it with the management authority.
    const check = () => {
      this.actors.checkGrant(id, resource, action, enabled);
      return authorize();
    };
    return this.#administer(check, (token) =>
      this.owner.setCheckedGrant(token, id, resource, action, enabled, operator),
    );
  }
  setEnabled(authorize: () => boolean, id: string, enabled: boolean, operator: string): Promise<void> {
    return this.#administer(authorize, (token) => this.owner.setEnabled(token, id, enabled, operator));
  }
  private committed() {
    this.actors.ownerCommitted();
    this.accounts?.ownerCommitted();
  }
  private loginAccounts(): HumanAccounts {
    if (!this.accounts) throw new Error("Human login is not configured");
    return this.accounts;
  }
}
