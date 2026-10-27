import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  AccountPoolAccount,
  AccountPoolAccountSummary,
  AccountPoolSecret,
  AccountPoolStore,
} from "./store.js";
import type { AccountCredentialRefreshReason } from "./oauth-refresh.js";

const CHATGPT_AUTH_CLAIM = "https://api.openai.com/auth";
const CHATGPT_PROFILE_CLAIM = "https://api.openai.com/profile";
const LOGIN_TTL_MS = 10 * 60 * 1_000;
const LOGIN_RECEIPT_TTL_MS = 30 * 60 * 1_000;
const MAX_LOGIN_RECEIPTS = 128;

export interface CodexMaintenanceClient {
  request<T>(method: string, params: unknown): Promise<T>;
  subscribeNotification(listener: (method: string, params: unknown) => void): () => void;
  close(): Promise<void>;
}

export type CodexMaintenanceClientFactory = (codexHome: string) => Promise<CodexMaintenanceClient>;

export interface CodexDeviceLoginStart {
  readonly sessionId: string;
  readonly verificationUrl: string;
  readonly userCode: string;
  readonly expiresAt: number;
}

export type CodexDeviceLoginPoll =
  | { readonly status: "pending" }
  | { readonly status: "complete"; readonly account: AccountPoolAccountSummary }
  | { readonly status: "error"; readonly message: string };

interface LoginSession {
  readonly id: string;
  readonly loginId: string;
  readonly codexHome: string;
  readonly client: CodexMaintenanceClient;
  readonly unsubscribe: () => void;
  readonly expiresAt: number;
  settlement: Promise<CodexDeviceLoginPoll> | null;
  expiryTimer: ReturnType<typeof setTimeout> | null;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Codex authentication response");
  return value as Record<string, unknown>;
}

function jwtPayload(token: string | null): Record<string, unknown> | null {
  if (token === null) return null;
  const payload = token.split(".")[1];
  if (payload === undefined) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function nestedString(payload: Record<string, unknown> | null, claim: string, field: string): string | null {
  const nested = payload?.[claim];
  if (!nested || typeof nested !== "object" || Array.isArray(nested)) return null;
  const value = (nested as Record<string, unknown>)[field];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function expiresAt(token: string): number | null {
  const value = jwtPayload(token)?.exp;
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value * 1_000) : null;
}

interface ImportedCodexCredential {
  readonly accountId: string;
  readonly email: string | null;
  readonly secret: AccountPoolSecret;
}

async function readCodexCredential(codexHome: string): Promise<ImportedCodexCredential> {
  const value = record(JSON.parse(await readFile(join(codexHome, "auth.json"), "utf8")));
  const tokens = record(value.tokens);
  const accessToken = typeof tokens.access_token === "string" ? tokens.access_token : "";
  const refreshToken = typeof tokens.refresh_token === "string" ? tokens.refresh_token : "";
  const idToken = typeof tokens.id_token === "string" ? tokens.id_token : null;
  if (!accessToken || !refreshToken) throw new Error("Codex login did not produce reusable OAuth credentials");
  const accessPayload = jwtPayload(accessToken);
  const idPayload = jwtPayload(idToken);
  const accountId = typeof tokens.account_id === "string" && tokens.account_id
    ? tokens.account_id
    : nestedString(accessPayload, CHATGPT_AUTH_CLAIM, "chatgpt_account_id")
      ?? nestedString(idPayload, CHATGPT_AUTH_CLAIM, "chatgpt_account_id");
  if (!accountId) throw new Error("Codex login did not identify a ChatGPT account");
  const email = (typeof idPayload?.email === "string" ? idPayload.email : null)
    ?? nestedString(idPayload, CHATGPT_PROFILE_CLAIM, "email")
    ?? (typeof accessPayload?.email === "string" ? accessPayload.email : null)
    ?? nestedString(accessPayload, CHATGPT_PROFILE_CLAIM, "email");
  return {
    accountId,
    email,
    secret: { accessToken, refreshToken, idToken, expiresAt: expiresAt(accessToken) },
  };
}

async function writeCodexCredential(codexHome: string, account: AccountPoolAccount, secret: AccountPoolSecret): Promise<void> {
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  await writeFile(join(codexHome, "auth.json"), `${JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: secret.idToken ?? null,
      access_token: secret.accessToken,
      refresh_token: secret.refreshToken,
      account_id: account.upstreamAccountId,
    },
    last_refresh: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
}

export class CodexDeviceLoginService {
  private readonly sessions = new Map<string, LoginSession>();
  private readonly receipts = new Map<string, { result: CodexDeviceLoginPoll; expiresAt: number }>();
  private readonly operations = new Set<Promise<unknown>>();
  private closing = false;
  private readonly onAccountImported?: (account: AccountPoolAccountSummary) => void;
  private readonly store: AccountPoolStore;
  private readonly loginRoot: string;
  private readonly createClient: CodexMaintenanceClientFactory;
  private readonly now: () => number;
  private readonly initializeOperation: Promise<void>;

  constructor(options: {
    readonly store: AccountPoolStore;
    readonly loginRoot: string;
    readonly createClient: CodexMaintenanceClientFactory;
    readonly now?: () => number;
    readonly onAccountImported?: (account: AccountPoolAccountSummary) => void;
  }) {
    this.store = options.store;
    this.loginRoot = options.loginRoot;
    this.createClient = options.createClient;
    this.now = options.now ?? Date.now;
    this.onAccountImported = options.onAccountImported;
    this.initializeOperation = this.initialize();
  }

  ready(): Promise<void> { return this.initializeOperation; }

  private async initialize(): Promise<void> {
    await mkdir(this.loginRoot, { recursive: true, mode: 0o700 });
    const completed: Array<{ credential: ImportedCodexCredential; modifiedAt: number }> = [];
    for (const entry of await readdir(this.loginRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      let imported: ImportedCodexCredential;
      try { imported = await readCodexCredential(join(this.loginRoot, entry.name)); }
      catch (error) {
        // Missing/invalid credentials are unfinished flows. Unexpected I/O must
        // preserve the profiles for recovery instead of deleting completed logins.
        if (error && typeof error === "object" && "code" in error && error.code !== "ENOENT") throw error;
        continue;
      }
      completed.push({ credential: imported, modifiedAt: (await stat(join(this.loginRoot, entry.name, "auth.json"))).mtimeMs });
    }
    for (const { credential } of completed.sort((left, right) => right.modifiedAt - left.modifiedAt)) {
      // Recovery fills missing credentials; a later configured login or refresh
      // in the account pool must never be replaced by a stale temporary profile.
      if (this.store.listAccounts().some(account => account.upstreamAccountId === credential.accountId && account.credentialConfigured)) continue;
      this.commitImported(credential);
    }
    // Only remove old profiles after every recoverable account was committed.
    await rm(this.loginRoot, { recursive: true, force: true });
    await mkdir(this.loginRoot, { recursive: true, mode: 0o700 });
  }

  start(): Promise<CodexDeviceLoginStart> {
    if (this.closing) return Promise.reject(new Error("Codex login service is closing"));
    return this.track(this.performStart());
  }

  private async performStart(): Promise<CodexDeviceLoginStart> {
    await this.initializeOperation;
    this.pruneReceipts();
    const id = randomUUID();
    const codexHome = join(this.loginRoot, id);
    await mkdir(codexHome, { recursive: true, mode: 0o700 });
    let client: CodexMaintenanceClient | null = null;
    let session: LoginSession | null = null;
    let earlyCompletion: { loginId: string; success: boolean; error: string | null } | null = null;
    let unsubscribe = () => {};
    try {
      client = await this.createClient(codexHome);
      unsubscribe = client.subscribeNotification((method, params) => {
        if (method !== "account/login/completed" || this.closing) return;
        if (!params || typeof params !== "object") return;
        const value = params as Record<string, unknown>;
        if (typeof value.loginId !== "string") return;
        const completion = { loginId: value.loginId, success: value.success === true,
          error: typeof value.error === "string" ? value.error : null };
        if (session === null) earlyCompletion = completion;
        else if (completion.loginId === session.loginId) void this.settle(session, completion);
      });
      const result = record(await client.request("account/login/start", { type: "chatgptDeviceCode" }));
      if (this.closing) throw new Error("Codex login service is closing");
      if (result.type !== "chatgptDeviceCode" || typeof result.loginId !== "string"
        || typeof result.verificationUrl !== "string" || typeof result.userCode !== "string") {
        throw new Error("Codex returned an invalid device login response");
      }
      session = {
        id,
        loginId: result.loginId,
        codexHome,
        client,
        unsubscribe,
        expiresAt: this.now() + LOGIN_TTL_MS,
        settlement: null,
        expiryTimer: null,
      };
      this.sessions.set(id, session);
      const activeSession = session;
      session.expiryTimer = setTimeout(() => {
        void this.settle(activeSession, { success: false, error: "Code expired, start again." }, true);
      }, LOGIN_TTL_MS);
      session.expiryTimer.unref?.();
      // A fast native completion may arrive before its start response.
      const early = earlyCompletion as { loginId: string; success: boolean; error: string | null } | null;
      if (early?.loginId === session.loginId) void this.settle(session, early);
      return {
        sessionId: id,
        verificationUrl: result.verificationUrl,
        userCode: result.userCode,
        expiresAt: session.expiresAt,
      };
    } catch (error) {
      unsubscribe();
      await client?.close().catch(() => undefined);
      await rm(codexHome, { recursive: true, force: true });
      throw error;
    }
  }

  async poll(sessionId: string): Promise<CodexDeviceLoginPoll> {
    this.pruneReceipts();
    const receipt = this.receipts.get(sessionId);
    if (receipt !== undefined) return receipt.result;
    const session = this.sessions.get(sessionId);
    if (session === undefined) return { status: "error", message: "Login session was not found. Start again." };
    if (session.settlement !== null) return session.settlement;
    if (this.now() >= session.expiresAt) {
      return this.settle(session, { success: false, error: "Code expired, start again." }, true);
    }
    return { status: "pending" };
  }

  async importFrom(codexHome: string): Promise<AccountPoolAccountSummary> {
    await this.initializeOperation;
    return this.commitImported(await readCodexCredential(codexHome));
  }

  async cancel(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return false;
    if (session.settlement !== null) { await session.settlement; return false; }
    await this.settle(session, { success: false, error: "Login cancelled." }, true);
    return true;
  }

  async dispose(): Promise<void> {
    this.closing = true;
    await this.initializeOperation.catch(() => undefined);
    await Promise.allSettled(this.operations);
    await Promise.all([...this.sessions.values()].map(session => this.finish(session)));
    this.receipts.clear();
  }

  private settle(session: LoginSession, completion: { success: boolean; error: string | null }, cancelNative = false): Promise<CodexDeviceLoginPoll> {
    if (session.settlement !== null) return session.settlement;
    if (session.expiryTimer !== null) clearTimeout(session.expiryTimer);
    session.unsubscribe();
    // Defer execution until settlement is assigned, including synchronous cancel notifications.
    session.settlement = this.track(Promise.resolve().then(async () => {
      let result: CodexDeviceLoginPoll;
      try {
        if (cancelNative) await session.client.request("account/login/cancel", { loginId: session.loginId }).catch(() => undefined);
        if (completion.success) {
          const account = this.commitImported(await readCodexCredential(session.codexHome));
          result = { status: "complete", account };
          try { this.onAccountImported?.(account); } catch { /* Usage refresh cannot undo a saved login. */ }
        } else result = { status: "error", message: completion.error ?? "Codex authorization failed. Start again." };
      } catch (error) {
        result = { status: "error", message: error instanceof Error ? error.message : "Codex account could not be saved" };
      }
      this.receipts.set(session.id, { result, expiresAt: this.now() + LOGIN_RECEIPT_TTL_MS });
      this.pruneReceipts();
      await this.finish(session);
      return result;
    }));
    return session.settlement;
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.operations.add(operation);
    void operation.finally(() => this.operations.delete(operation)).catch(() => undefined);
    return operation;
  }

  private pruneReceipts(): void {
    for (const [id, receipt] of this.receipts) if (receipt.expiresAt <= this.now()) this.receipts.delete(id);
    while (this.receipts.size > MAX_LOGIN_RECEIPTS) this.receipts.delete(this.receipts.keys().next().value!);
  }

  private async finish(session: LoginSession): Promise<void> {
    if (!this.sessions.delete(session.id)) return;
    if (session.expiryTimer !== null) clearTimeout(session.expiryTimer);
    session.unsubscribe();
    await session.client.close().catch(() => undefined);
    await rm(session.codexHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
      .catch(() => { console.warn("Codex temporary login profile cleanup failed"); });
  }

  private commitImported(imported: ImportedCodexCredential): AccountPoolAccountSummary {
    const existing = this.store.listAccounts().find(account => account.upstreamAccountId === imported.accountId);
    let account: AccountPoolAccountSummary;
    if (existing === undefined) {
      this.store.addAccount({
        id: randomUUID(),
        provider: "codex",
        label: imported.email ?? "Codex account",
        upstreamAccountId: imported.accountId,
        priority: this.store.listAccounts().length + 1,
        enabled: true,
      }, imported.secret);
      account = this.store.listAccounts().find(candidate => candidate.upstreamAccountId === imported.accountId)!;
    } else {
      this.store.replaceCredential(existing.id, imported.secret);
      this.store.setEnabled(existing.id, true);
      account = this.store.listAccounts().find(candidate => candidate.id === existing.id)!;
    }
    this.store.updateSubscriptionMetadata(account.id, { email: imported.email });
    return account;
  }
}

export function createManagedCodexRefresh(options: {
  readonly refreshRoot: string;
  readonly createClient: CodexMaintenanceClientFactory;
}): (
  account: AccountPoolAccount,
  secret: AccountPoolSecret,
  reason: AccountCredentialRefreshReason,
) => Promise<AccountPoolSecret> {
  const initializeOperation = rm(options.refreshRoot, { recursive: true, force: true })
    .then(() => mkdir(options.refreshRoot, { recursive: true, mode: 0o700 }));
  return async (account, secret) => {
    await initializeOperation;
    const codexHome = await mkdtemp(join(options.refreshRoot, "flight-"));
    let client: CodexMaintenanceClient | null = null;
    try {
      if (!secret.refreshToken) throw new Error("Codex account cannot refresh without a refresh token");
      await writeCodexCredential(codexHome, account, secret);
      client = await options.createClient(codexHome);
      await client.request("account/read", { refreshToken: true });
      const refreshed = await readCodexCredential(codexHome);
      if (refreshed.accountId !== account.upstreamAccountId) throw new Error("Codex refresh changed account identity");
      return refreshed.secret;
    } finally {
      await client?.close().catch(() => undefined);
      await rm(codexHome, { recursive: true, force: true });
    }
  };
}
