import type {
  AppServerMethod,
  AppServerMethodParams,
  AppServerMethodResult,
  CodexAccountView,
  CodexDeviceLoginPollView,
  CodexDeviceLoginView,
  CodexResetCreditsView,
} from "@opencraft/appserver-protocol";

import type { HostProtocolRequest } from "../local-agent-settings-service.js";

export interface CodexAccountsSnapshot {
  readonly phase: "idle" | "loading" | "ready" | "error";
  readonly accounts: readonly CodexAccountView[];
  readonly login: CodexDeviceLoginView | null;
  readonly error: string | null;
}

const INITIAL: CodexAccountsSnapshot = Object.freeze({ phase: "idle", accounts: [], login: null, error: null });

export class CodexAccountsService {
  private snapshot: CodexAccountsSnapshot = INITIAL;
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private disposed = false;
  private readonly resetAttempts = new Map<string, string>();
  private resumeOperation: Promise<void> | null = null;
  private pollOperation: { sessionId: string; result: Promise<CodexDeviceLoginPollView> } | null = null;

  constructor(private readonly requestHost: HostProtocolRequest, readonly hostId: string) {}

  getSnapshot = (): CodexAccountsSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };

  async refresh(): Promise<void> {
    if (this.disposed) return;
    const generation = ++this.generation;
    this.publish({ ...this.snapshot, phase: "loading", error: null });
    try {
      const result = await this.request("opencraft/codex/accounts/list", {});
      if (this.disposed || generation !== this.generation) return;
      this.publish({ ...this.snapshot, phase: "ready", accounts: result.accounts, error: null });
    } catch (error) {
      if (this.disposed || generation !== this.generation) return;
      this.publish({ ...this.snapshot, phase: "error", error: error instanceof Error ? error.message : String(error) });
    }
  }

  async setEnabled(accountId: string, enabled: boolean): Promise<void> {
    await this.update("opencraft/codex/accounts/setEnabled", { accountId, enabled });
  }

  async setAllowCredits(accountId: string, allowCredits: boolean): Promise<void> {
    await this.update("opencraft/codex/accounts/setAllowCredits", { accountId, allowCredits });
  }

  async reorder(accountIds: readonly string[]): Promise<void> {
    await this.update("opencraft/codex/accounts/reorder", { accountIds });
  }

  async remove(accountId: string): Promise<void> {
    await this.update("opencraft/codex/accounts/remove", { accountId });
  }

  async refreshAccount(accountId: string): Promise<void> {
    await this.update("opencraft/codex/accounts/refresh", { accountId });
  }

  listResetCredits(accountId: string): Promise<CodexResetCreditsView> {
    if (this.disposed) return Promise.reject(new Error("Account service is closed"));
    return this.request("opencraft/codex/accounts/resetCredits/list", { accountId });
  }

  async consumeResetCredit(accountId: string, creditId: string) {
    if (this.disposed) throw new Error("Account service is closed");
    const identity = JSON.stringify([accountId, creditId]);
    let idempotencyKey = this.resetAttempts.get(identity);
    if (!idempotencyKey) { idempotencyKey = crypto.randomUUID(); this.resetAttempts.set(identity, idempotencyKey); }
    const generation = ++this.generation;
    const result = await this.request("opencraft/codex/accounts/resetCredits/consume", { accountId, creditId, idempotencyKey, confirmed: true });
    if (result.outcome !== "unknown") this.resetAttempts.delete(identity);
    if (!this.disposed && generation === this.generation) {
      this.generation += 1;
      this.publish({ ...this.snapshot, phase: "ready", accounts: result.accounts, error: null });
    }
    return result;
  }

  async importLocalLogin(): Promise<void> {
    try {
      const result = await this.request("opencraft/codex/accounts/import", {});
      this.publish({
        phase: "ready",
        accounts: [...this.snapshot.accounts.filter(account => account.id !== result.account.id), result.account]
          .sort((left, right) => left.priority - right.priority),
        login: this.snapshot.login,
        error: null,
      });
    } catch (error) {
      this.publish({ ...this.snapshot, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  async startDeviceLogin(): Promise<void> {
    try {
      const login = await this.request("opencraft/codex/accounts/deviceLogin/start", {});
      this.publish({ ...this.snapshot, login, error: null });
    } catch (error) {
      this.publish({ ...this.snapshot, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  /** Restore from server-owned accounts even if a reload lost the local login session. */
  resume(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    return this.resumeOperation ??= (async () => {
      try {
        if (this.snapshot.login !== null) await this.pollDeviceLogin().catch(() => undefined);
        await this.refresh();
      } finally { this.resumeOperation = null; }
    })();
  }

  pollDeviceLogin(): Promise<CodexDeviceLoginPollView> {
    const login = this.snapshot.login;
    if (login === null || this.disposed) return Promise.resolve({ status: "error", message: "No active login" });
    if (this.pollOperation?.sessionId === login.sessionId) return this.pollOperation.result;
    const result = (async () => {
      try {
        const result = await this.request("opencraft/codex/accounts/deviceLogin/poll", { sessionId: login.sessionId });
        if (this.disposed || this.snapshot.login?.sessionId !== login.sessionId) return result;
        if (result.status === "complete") {
          this.generation += 1;
          this.publish({ phase: "ready", accounts: [...this.snapshot.accounts.filter(account => account.id !== result.account.id), result.account]
            .sort((left, right) => left.priority - right.priority), login: null, error: null });
        } else if (result.status === "error") {
          this.publish({ ...this.snapshot, login: null, error: result.message });
        }
        return result;
      } finally {
        if (this.pollOperation?.sessionId === login.sessionId) this.pollOperation = null;
      }
    })();
    this.pollOperation = { sessionId: login.sessionId, result };
    return result;
  }

  async cancelDeviceLogin(): Promise<void> {
    const login = this.snapshot.login;
    if (login === null) return;
    try {
      await this.request("opencraft/codex/accounts/deviceLogin/cancel", { sessionId: login.sessionId });
      if (this.snapshot.login?.sessionId === login.sessionId) this.publish({ ...this.snapshot, login: null });
      await this.refresh();
    } catch (error) {
      this.publish({ ...this.snapshot, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.listeners.clear();
  }

  private async request<TMethod extends AppServerMethod>(method: TMethod, params: AppServerMethodParams<TMethod>): Promise<AppServerMethodResult<TMethod>> {
    return this.requestHost(this.hostId, method, params);
  }

  private async update<TMethod extends "opencraft/codex/accounts/setEnabled" | "opencraft/codex/accounts/setAllowCredits" | "opencraft/codex/accounts/reorder" | "opencraft/codex/accounts/remove" | "opencraft/codex/accounts/refresh">(
    method: TMethod,
    params: AppServerMethodParams<TMethod>,
  ): Promise<void> {
    // A list started before or during a mutation cannot undo its committed value.
    this.generation += 1;
    const result = await this.request(method, params);
    this.generation += 1;
    this.publish({ ...this.snapshot, phase: "ready", accounts: result.accounts, error: null });
  }

  private publish(snapshot: CodexAccountsSnapshot): void {
    if (this.disposed) return;
    this.snapshot = Object.freeze(snapshot);
    for (const listener of this.listeners) listener();
  }
}
