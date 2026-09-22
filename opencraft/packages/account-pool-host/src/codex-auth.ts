import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  AccountPoolAccount,
  AccountPoolAccountSummary,
  AccountPoolSecret,
  AccountPoolStore,
} from "./store.js";
import type { CodexCredentialRefreshReason } from "./oauth-refresh.js";

const CHATGPT_AUTH_CLAIM = "https://api.openai.com/auth";
const CHATGPT_PROFILE_CLAIM = "https://api.openai.com/profile";
const LOGIN_TTL_MS = 10 * 60 * 1_000;

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
  completion: { success: boolean; error: string | null } | null;
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
  }) {
    this.store = options.store;
    this.loginRoot = options.loginRoot;
    this.createClient = options.createClient;
    this.now = options.now ?? Date.now;
    this.initializeOperation = rm(this.loginRoot, { recursive: true, force: true })
      .then(() => mkdir(this.loginRoot, { recursive: true, mode: 0o700 }))
      .then(() => undefined);
  }

  async start(): Promise<CodexDeviceLoginStart> {
    await this.initializeOperation;
    const id = randomUUID();
    const codexHome = join(this.loginRoot, id);
    await mkdir(codexHome, { recursive: true, mode: 0o700 });
    const client = await this.createClient(codexHome);
    let session: LoginSession | null = null;
    const unsubscribe = client.subscribeNotification((method, params) => {
      if (method !== "account/login/completed" || session === null) return;
      const value = record(params);
      if (value.loginId !== session.loginId) return;
      session.completion = {
        success: value.success === true,
        error: typeof value.error === "string" ? value.error : null,
      };
    });
    try {
      const result = record(await client.request("account/login/start", { type: "chatgptDeviceCode" }));
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
        completion: null,
      };
      this.sessions.set(id, session);
      return {
        sessionId: id,
        verificationUrl: result.verificationUrl,
        userCode: result.userCode,
        expiresAt: session.expiresAt,
      };
    } catch (error) {
      unsubscribe();
      await client.close().catch(() => undefined);
      await rm(codexHome, { recursive: true, force: true });
      throw error;
    }
  }

  async poll(sessionId: string): Promise<CodexDeviceLoginPoll> {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return { status: "error", message: "Login session was not found. Start again." };
    if (this.now() >= session.expiresAt) {
      await this.finish(session);
      return { status: "error", message: "Code expired, start again." };
    }
    if (session.completion === null) return { status: "pending" };
    if (!session.completion.success) {
      const message = session.completion.error ?? "Codex authorization failed. Start again.";
      await this.finish(session);
      return { status: "error", message };
    }
    try {
      const imported = await readCodexCredential(session.codexHome);
      const account = this.commitImported(imported);
      await this.finish(session);
      return { status: "complete", account };
    } catch (error) {
      await this.finish(session);
      return { status: "error", message: error instanceof Error ? error.message : "Codex account could not be saved" };
    }
  }

  async importFrom(codexHome: string): Promise<AccountPoolAccountSummary> {
    await this.initializeOperation;
    return this.commitImported(await readCodexCredential(codexHome));
  }

  async cancel(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return false;
    await session.client.request("account/login/cancel", { loginId: session.loginId }).catch(() => undefined);
    await this.finish(session);
    return true;
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.sessions.values()].map(session => this.finish(session)));
  }

  private async finish(session: LoginSession): Promise<void> {
    if (!this.sessions.delete(session.id)) return;
    session.unsubscribe();
    await session.client.close().catch(() => undefined);
    await rm(session.codexHome, { recursive: true, force: true });
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
  reason: CodexCredentialRefreshReason,
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
