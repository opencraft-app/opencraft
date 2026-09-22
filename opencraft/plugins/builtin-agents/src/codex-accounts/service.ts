import type {
  AppServerMethod,
  AppServerMethodParams,
  AppServerMethodResult,
  CodexAccountView,
  CodexDeviceLoginPollView,
  CodexDeviceLoginView,
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

  constructor(private readonly requestHost: HostProtocolRequest, readonly hostId: string) {}

  getSnapshot = (): CodexAccountsSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };

  async refresh(): Promise<void> {
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

  async reorder(accountIds: readonly string[]): Promise<void> {
    await this.update("opencraft/codex/accounts/reorder", { accountIds });
  }

  async remove(accountId: string): Promise<void> {
    await this.update("opencraft/codex/accounts/remove", { accountId });
  }

  async refreshAccount(accountId: string): Promise<void> {
    await this.update("opencraft/codex/accounts/refresh", { accountId });
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

  async pollDeviceLogin(): Promise<CodexDeviceLoginPollView> {
    const login = this.snapshot.login;
    if (login === null) return { status: "error", message: "No active login" };
    const result = await this.request("opencraft/codex/accounts/deviceLogin/poll", { sessionId: login.sessionId });
    if (result.status === "complete") {
      this.publish({ phase: "ready", accounts: [...this.snapshot.accounts.filter(account => account.id !== result.account.id), result.account]
        .sort((left, right) => left.priority - right.priority), login: null, error: null });
    } else if (result.status === "error") {
      this.publish({ ...this.snapshot, login: null, error: result.message });
    }
    return result;
  }

  async cancelDeviceLogin(): Promise<void> {
    const login = this.snapshot.login;
    if (login === null) return;
    try {
      await this.request("opencraft/codex/accounts/deviceLogin/cancel", { sessionId: login.sessionId });
      this.publish({ ...this.snapshot, login: null });
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

  private request<TMethod extends AppServerMethod>(method: TMethod, params: AppServerMethodParams<TMethod>): Promise<AppServerMethodResult<TMethod>> {
    return this.requestHost(this.hostId, method, params);
  }

  private async update<TMethod extends "opencraft/codex/accounts/setEnabled" | "opencraft/codex/accounts/reorder" | "opencraft/codex/accounts/remove" | "opencraft/codex/accounts/refresh">(
    method: TMethod,
    params: AppServerMethodParams<TMethod>,
  ): Promise<void> {
    const result = await this.request(method, params);
    this.publish({ ...this.snapshot, phase: "ready", accounts: result.accounts, error: null });
  }

  private publish(snapshot: CodexAccountsSnapshot): void {
    this.snapshot = Object.freeze(snapshot);
    for (const listener of this.listeners) listener();
  }
}
