import type { OwnerCalls } from "@opencraft/worker-owner";
import type { ServerDatabaseSource } from "@opencraft/storage-node/server-repository";
import type { Principal } from "@opencraft/identity-core";
import type { ActorContext } from "@opencraft/identity-core/actors";
import { ActorStore } from "./actors.js";
import { HumanAccounts, type HumanLogin } from "./human-accounts.js";

/**
 * Identity writes a Server owner Worker performs on its own connection: login
 * sessions, identity bindings and Actor administration. Validation that needs
 * this process's registrations (local account versions, resource authorities)
 * happens on the calling thread first. Reads stay on the calling thread's
 * permission projection, which is republished after every commit.
 */
export class IdentityWriteOwner {
  readonly #actors: ActorStore;
  readonly #accounts: HumanAccounts;
  constructor(owner: ServerDatabaseSource) {
    this.#actors = new ActorStore(owner, Date.now, { permissionProjection: false });
    this.#accounts = new HumanAccounts(owner, this.#actors);
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
  createSession(displayName: string, operator: string) {
    return this.#actors.createSession(displayName, operator);
  }
  issueCredential(id: string, expiresAt: number, operator: string) {
    return this.#actors.issueCredential(id, expiresAt, operator);
  }
  revokeCredential(id: string, operator: string): void {
    this.#actors.revokeCredential(id, operator);
  }
  setCheckedGrant(id: string, resource: string, action: string, enabled: boolean, operator: string): void {
    this.#actors.setGrant(id, resource, action, enabled, operator, { authorityChecked: true });
  }
  setEnabled(id: string, enabled: boolean, operator: string): void {
    this.#actors.setEnabled(id, enabled, operator);
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
  constructor(
    private readonly owner: OwnerCalls<IdentityWriteOwner>,
    readonly actors: ActorStore,
    /** Absent when this installation has no human login. */
    readonly accounts?: HumanAccounts,
  ) {}

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
  async createSession(displayName: string, operator: string) {
    const actor = await this.owner.createSession(displayName, operator);
    this.actors.ownerCommitted();
    return actor;
  }
  async issueCredential(id: string, expiresAt: number, operator: string) {
    const credential = await this.owner.issueCredential(id, expiresAt, operator);
    this.actors.ownerCommitted();
    return credential;
  }
  async revokeCredential(id: string, operator: string): Promise<void> {
    await this.owner.revokeCredential(id, operator);
    this.actors.ownerCommitted();
  }
  async setGrant(id: string, resource: string, action: string, enabled: boolean, operator: string): Promise<void> {
    // Resource authorities are registered on this thread; the owner trusts this check.
    this.actors.checkGrant(id, resource, action, enabled);
    await this.owner.setCheckedGrant(id, resource, action, enabled, operator);
    this.actors.ownerCommitted();
  }
  async setEnabled(id: string, enabled: boolean, operator: string): Promise<void> {
    await this.owner.setEnabled(id, enabled, operator);
    this.actors.ownerCommitted();
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
