import type { OwnerCalls } from "@opencraft/worker-owner";
import type { ServerDatabaseHandle } from "@opencraft/storage-node/server-repository";
import type { Principal } from "@opencraft/identity-core";
import type { ActorContext } from "@opencraft/identity-core/actors";
import { ActorStore } from "./actors.js";
import { HumanAccounts, type HumanLogin } from "./human-accounts.js";
import { MembershipStore, type MemberRole } from "./index.js";
import type { CommitFence } from "./commit-fence.js";
import type {
  LocalAccountPasswordExpectation,
  LocalAccountPasswordUpgrades,
} from "@opencraft/identity-core/local-account";

/** Owner-connection writes the Worker entry supplies, so their SQL stays off network-thread imports. */
export interface IdentityWriteOwnerOptions {
  readonly upgradeLocalPassword?: (
    id: string,
    expected: LocalAccountPasswordExpectation,
    salt: string,
    passwordDigest: string,
  ) => boolean;
}

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
 * The owner sees only the commit fence port: the shared-memory fence when it
 * runs in the Node owner Worker, the same-thread fence when it runs on the
 * authorizer's own thread.
 */
export class IdentityWriteOwner {
  readonly #actors: ActorStore;
  readonly #accounts: HumanAccounts;
  readonly #members: MembershipStore;
  readonly #fence: CommitFence | null;
  readonly #options: IdentityWriteOwnerOptions;
  constructor(
    private readonly owner: ServerDatabaseHandle,
    fence?: CommitFence,
    options: IdentityWriteOwnerOptions = {},
  ) {
    this.#options = options;
    this.#actors = new ActorStore(owner, Date.now, { permissionProjection: false });
    this.#accounts = new HumanAccounts(owner, this.#actors);
    this.#members = new MembershipStore(owner, { permissionProjection: false });
    this.#fence = fence ?? null;
  }
  /** Runs `write` under the writer lock, after the caller re-approved `token`. */
  #fenced<T>(token: number, write: () => T): T {
    const fence = this.#fence;
    if (!fence) throw new Error("Actor administration requires a commit fence");
    return this.owner.database.transaction(() => {
      fence.pass(token);
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
  /** Compare-and-set login upgrade of a local password record; not an authority change. */
  upgradeLocalPassword(
    id: string,
    expected: LocalAccountPasswordExpectation,
    salt: string,
    passwordDigest: string,
  ): boolean {
    const upgrade = this.#options.upgradeLocalPassword;
    if (!upgrade) throw new Error("Local password upgrade unavailable in this owner");
    return upgrade(id, expected, salt, passwordDigest);
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
  /** A binding membership and, when it names a known human, that Actor's membership, in one commit. */
  setMembership(
    token: number,
    binding: Pick<Principal, "provider" | "subject">,
    role: MemberRole,
    enabled: boolean,
    operator: string,
    actorId: string | null,
  ): void {
    this.#fenced(token, () => {
      this.#members.set(binding, role, enabled, operator);
      if (actorId) this.#members.setActor(actorId, role, enabled, operator);
    });
  }
  setActorMembership(token: number, actorId: string, role: MemberRole, enabled: boolean, operator: string): void {
    this.#fenced(token, () => this.#members.setActor(actorId, role, enabled, operator));
  }
  close(): void {
    try {
      this.#members.close();
    } finally {
      try {
        this.#accounts.close();
      } finally {
        this.#actors.close();
      }
    }
  }
}

export const IDENTITY_WRITE_METHODS = [
  "issueLogin",
  "revokeLogin",
  "rememberLabel",
  "upgradeLocalPassword",
  "bindHuman",
  "unbindHuman",
  "createSession",
  "issueCredential",
  "revokeCredential",
  "setCheckedGrant",
  "setEnabled",
  "setMembership",
  "setActorMembership",
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
 *
 * The owner runs these calls in the order they are issued, but a commit reaches
 * this thread's projection only when its reply is delivered, and the commit
 * fence can be asked about one write before the reply of an earlier one
 * arrived. The fence therefore answers only after every call issued before the
 * fenced one settled and updated the projection, so its recheck never reads
 * authority older than what the owner committed before it.
 */
export class IdentityWrites implements LocalAccountPasswordUpgrades {
  readonly #checks = new Map<number, () => boolean>();
  /** Owner calls in issue order; an administration call's sequence is its fence token. */
  #sequence = 0;
  /** Issued owner calls whose outcome this thread has not applied yet. */
  readonly #unsettled = new Set<number>();
  /** Deferred fence answers, by token, until the calls issued before it settled. */
  readonly #waiting = new Map<number, (ready: boolean) => void>();
  readonly #stopFence: () => void;
  constructor(
    private readonly owner: OwnerCalls<IdentityWriteOwner>,
    readonly actors: ActorStore,
    /** Absent when this installation has no human login. */
    readonly accounts: HumanAccounts | undefined,
    /** The commit fence whose owner side the `IdentityWriteOwner` passes. */
    fence: CommitFence,
    /** Absent when this installation has no instance membership. */
    readonly members?: MembershipStore,
  ) {
    this.#stopFence = fence.serve((token) => {
      const check = () => this.#checks.get(token)?.() === true;
      if (!this.#awaitsEarlier(token)) return check();
      return new Promise<boolean>((resolve) => this.#waiting.set(token, resolve)).then((ready) => ready && check());
    });
  }
  close(): void {
    this.#stopFence();
    for (const resolve of this.#waiting.values()) resolve(false);
    this.#waiting.clear();
  }
  #awaitsEarlier(token: number): boolean {
    for (const sequence of this.#unsettled) if (sequence < token) return true;
    return false;
  }
  /**
   * Issues one owner call. `apply` brings this thread's projections up to the
   * call's outcome (it also runs when the call failed) before the call counts
   * as settled for the fence.
   */
  async #call<T>(issue: (sequence: number) => Promise<T>, apply?: (value: T | undefined) => void): Promise<T> {
    const sequence = ++this.#sequence;
    this.#unsettled.add(sequence);
    let value: T | undefined;
    try {
      value = await issue(sequence);
      return value;
    } finally {
      try {
        apply?.(value);
      } finally {
        this.#unsettled.delete(sequence);
        for (const [token, resolve] of this.#waiting)
          if (!this.#awaitsEarlier(token)) {
            this.#waiting.delete(token);
            resolve(true);
          }
      }
    }
  }
  /** Runs an administration write whose authority `authorize` rechecks under the owner's writer lock. */
  async #administer<T>(
    authorize: () => boolean,
    write: (token: number) => Promise<T>,
    apply: () => void = () => this.actors.ownerCommitted(),
  ): Promise<T> {
    if (!authorize()) throw new Error("Actor management denied");
    let fenced = 0;
    return this.#call(
      (token) => {
        fenced = token;
        this.#checks.set(token, authorize);
        return write(token);
      },
      () => {
        this.#checks.delete(fenced);
        apply();
      },
    );
  }

  async issueLogin(principal: Principal): Promise<{ token: string; login: HumanLogin }> {
    const accounts = this.loginAccounts();
    const accountVersion = accounts.loginAccountVersion(principal);
    // A login may register a human; registration hooks live on this thread only.
    if (this.actors.hasLocalRegistrationHooks) return accounts.issue(principal, accountVersion);
    return this.#call(
      () => this.owner.issueLogin(principal, accountVersion),
      (issued) => {
        if (issued) this.committed();
      },
    );
  }
  async revokeLogin(token: string): Promise<void> {
    const accounts = this.loginAccounts();
    let revoked = false;
    await this.#call(
      async () => {
        await this.owner.revokeLogin(token);
        revoked = true;
      },
      () => {
        if (revoked) accounts.ownerCommitted();
      },
    );
  }
  async rememberLabel(principal: Principal, label: string): Promise<void> {
    await this.#call(() => this.owner.rememberLabel(principal, label));
  }
  /** Resolves after the owner committed (or refused) it; no projection or observer changes. */
  async upgradeLocalPassword(
    id: string,
    expected: LocalAccountPasswordExpectation,
    salt: string,
    passwordDigest: string,
  ): Promise<boolean> {
    return this.#call(() => this.owner.upgradeLocalPassword(id, expected, salt, passwordDigest));
  }
  async bindHuman(owner: ActorContext, principal: Principal): Promise<void> {
    await this.#call(
      () => this.owner.bindHuman(owner, principal),
      (changed) => {
        if (changed !== undefined) this.actors.ownerCommitted(changed ? owner.actorId : undefined);
      },
    );
  }
  async unbindHuman(owner: ActorContext, binding: Pick<Principal, "provider" | "subject">): Promise<void> {
    let unbound = false;
    await this.#call(
      async () => {
        await this.owner.unbindHuman(owner, binding);
        unbound = true;
      },
      () => {
        if (unbound) this.actors.ownerCommitted(owner.actorId);
      },
    );
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
  // Membership administration, fenced like Actor administration.
  async setMembership(
    authorize: () => boolean,
    binding: Pick<Principal, "provider" | "subject">,
    role: MemberRole,
    enabled: boolean,
    operator: string,
    actorId: string | null,
  ): Promise<void> {
    await this.#administer(
      authorize,
      (token) => this.owner.setMembership(token, binding, role, enabled, operator, actorId),
      () => this.membershipCommitted(),
    );
  }
  async setActorMembership(
    authorize: () => boolean,
    actorId: string,
    role: MemberRole,
    enabled: boolean,
    operator: string,
  ): Promise<void> {
    await this.#administer(
      authorize,
      (token) => this.owner.setActorMembership(token, actorId, role, enabled, operator),
      () => this.membershipCommitted(),
    );
  }
  private membershipCommitted() {
    try {
      this.actors.ownerCommitted();
    } finally {
      this.members?.ownerCommitted();
    }
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
