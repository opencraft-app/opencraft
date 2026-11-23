import { createHash, randomBytes } from "node:crypto";
import { createSandboxAssistantProvider } from "@opencraft/personal-assistant/sandbox";
import { e2bSandboxBackend, type E2BSandboxOptions } from "@opencraft/sandbox-e2b";
import type { SandboxBackend } from "@opencraft/sandbox";
import { withWorkspaceBudget } from "@opencraft/plugin-assets/server/workspace-budget";
import type { AssetWorkspaceOwnerContext } from "@opencraft/plugin-assets/server/workspace-owner";
import type { AssistantEnvironmentProvider } from "@opencraft/personal-assistant/host";
import type { WorkspaceActorAdmission } from "./actor-authority.js";
import {
  BotEnvironmentAuthority,
  botRecordFingerprint,
  platformBotRecords,
  resolveBotEnvironments,
  type BotBackendIdentity,
  type ResolvedBotEnvironment,
} from "./bot-environments.js";
export type { BotBackendIdentity, BotEnvironmentActor, BotEnvironmentRecord } from "./bot-environments.js";

type Environment = Parameters<AssistantEnvironmentProvider["spawn"]>[0];
type Descriptor = {
  id: "execution.environment";
  binding: string;
  backendId: string;
  templateId: string;
  ephemeral: true;
};
type Handle = Awaited<ReturnType<AssistantEnvironmentProvider["spawn"]>>;
type Provider = AssistantEnvironmentProvider & { close(): Promise<void> };
export type BotStatus = { state: "starting" } | { state: "ready"; descriptor: Descriptor } | { state: "failed" };
export type BotOperation = { state: "pending" } | { state: "complete"; result: unknown } | { state: "failed" };
export interface WorkspaceBotPort {
  workspaceBotCatalog(): Promise<{ revision: string; templates: { id: string; name: string }[] }>;
  workspaceBotValidate(revision: string, environment: Environment): Promise<void>;
  workspaceBotOpen(revision: string, environment: Environment): Promise<string>;
  workspaceBotStatus(token: string): Promise<BotStatus>;
  workspaceBotExecute(token: string, method: string, params: Record<string, unknown>): Promise<string>;
  workspaceBotOperation(token: string): Promise<BotOperation>;
  workspaceBotForget(token: string): Promise<void>;
  workspaceBotClose(token: string): Promise<string>;
  workspaceBotCallbacks(): Promise<{ token: string; entry: string }[]>;
  workspaceBotReply(token: string, response: { result: unknown } | { error: true }): Promise<void>;
}
/** One Actor's Bot environments from its personal, platform and installed
 * sources. Every call carries Main's admission; the vault Worker rechecks it
 * against committed Actor/member truth. The token methods of
 * `WorkspaceBotPort` serve entries opened here as well. */
export interface WorkspaceBotSourcePort {
  workspaceBotSources(access: WorkspaceActorAdmission): Promise<BotSourceCatalog>;
  workspaceBotSourceValidate(
    access: WorkspaceActorAdmission,
    revision: string,
    environment: Environment,
  ): Promise<void>;
  workspaceBotSourceOpen(access: WorkspaceActorAdmission, revision: string, environment: Environment): Promise<string>;
}
export interface BotSourceCatalog {
  revision: string;
  providers: { backendId: string; templates: { id: string; name: string }[] }[];
}
/** Pool and lease policy of a personal or platform source. Each configuration
 * has its own pool across all its callers; every allocation also reserves in
 * the installation's global workspace budget, so without an installed
 * capacity these sources cannot allocate. */
export const BOT_SOURCE_POLICY = Object.freeze({
  workspaceRoot: "/home/user/opencraft",
  resources: Object.freeze({ cpuMillis: 2000, memoryBytes: 2 * 1024 ** 3 }),
  capacity: Object.freeze({ cpuMillis: 4000, memoryBytes: 8 * 1024 ** 3 }),
  maxCommandMs: 60000,
  lease: Object.freeze({ timeoutMs: 300000, renewEveryMs: 60000, maxLifetimeMs: 3600000 }),
});
type ProviderOptions = Parameters<typeof createSandboxAssistantProvider>[0];
/** Compiled owner composition, never an executable selected by RPC/data.
 * Sources retain their own authority, credential readers and pool lifetime. */
export interface WorkspaceBotSource {
  catalog(): { revision: string; templates: { id: string; name: string }[] };
  validate(revision: string, environment: Environment): void;
  createProvider(
    revision: string,
    spawnLocal: NonNullable<ProviderOptions["spawnLocal"]>,
  ): Promise<AssistantEnvironmentProvider & { close(): Promise<void> }>;
}
interface Entry {
  active: boolean;
  /** Actor entries only: rechecks the admission and the selected source. */
  guard?: (pending: boolean) => void;
  status: BotStatus;
  handle?: Handle;
  run?: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  starting: Promise<void>;
  closing?: string;
}
interface Callback {
  entry: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}
interface Job {
  status: BotOperation;
  work: Promise<void>;
  finished?: number;
}
const nonce = () => randomBytes(32).toString("hex");
const unavailable = () => Error("Bot workspace unavailable; physical operations must not be replayed");
/** The provider, SDK, execution pool and budget all live in the existing vault
 * Worker. Only the separately owned brain is local. Reverse callbacks are ONLY
 * the original Bot-assignment authorization, never a model-selected Host RPC. */
export class WorkspaceBotOwner {
  private readonly entries = new Map<string, Entry>();
  private readonly callbacks = new Map<string, Callback>();
  private readonly jobs = new Map<string, Job>();
  private readonly providers = new Map<string, Promise<Awaited<ReturnType<typeof createSandboxAssistantProvider>>>>();
  /** Personal and platform pools by backend ID; retiring ones by the same key. */
  private readonly pools = new Map<string, { provider: Promise<Provider>; live(): void }>();
  private readonly retiring = new Map<string, Promise<void>>();
  private readonly actors: BotEnvironmentAuthority;
  private closed = false;
  private closing?: Promise<void>;
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(
    private readonly context: AssetWorkspaceOwnerContext,
    private readonly options: {
      /** Installed source only: replaces the whole backend (tests). */
      backend?: ProviderOptions["createBackend"];
      source?: WorkspaceBotSource;
      /** E2B backend factory for every source; defaults to the SDK backend. */
      e2b?: (options: E2BSandboxOptions) => SandboxBackend;
      /** Identity partition of personal backend IDs; default the Actor partition. */
      backendIdentity?: BotBackendIdentity;
    } = {},
  ) {
    this.actors = new BotEnvironmentAuthority(context.directory);
    this.timer = setInterval(() => {
      for (const [token, job] of this.jobs)
        if (job.finished && Date.now() - job.finished > 300000) this.jobs.delete(token);
    }, 1000);
    this.timer.unref();
  }
  private installed() {
    if (this.closed) throw unavailable();
    const installed = this.context.configurations.installedRuntime();
    // Hash private source facts, including key rotation, without returning them.
    const revision = createHash("sha256").update(JSON.stringify(installed)).digest("hex");
    return { installed, revision };
  }
  catalog() {
    if (this.closed) throw unavailable();
    if (this.options.source) return structuredClone(this.options.source.catalog());
    const { installed, revision } = this.installed();
    return {
      revision,
      templates: (installed?.records ?? []).map((r) => ({ id: r.environment.templateId, name: r.environment.name })),
    };
  }
  private current(revision: string) {
    const value = this.installed();
    if (value.revision !== revision || !value.installed) throw unavailable();
    return value.installed;
  }
  private assertRevision(revision: string) {
    if (this.closed) throw unavailable();
    if (this.options.source) {
      if (this.options.source.catalog().revision !== revision) throw unavailable();
    } else this.current(revision);
  }
  validate(revision: string, environment: Environment) {
    if (this.options.source) {
      this.assertRevision(revision);
      this.options.source.validate(revision, environment);
      return;
    }
    const installed = this.current(revision);
    if (
      !environment ||
      Object.keys(environment).some((k) => !["kind", "backendId", "templateId"].includes(k)) ||
      environment.kind !== "sandbox" ||
      environment.backendId !== "e2b" ||
      !installed.records.some((r) => r.environment.templateId === environment.templateId)
    )
      throw unavailable();
  }
  private authorize(entry: string): Promise<unknown> {
    if (this.closed || !this.entries.get(entry)?.active || this.callbacks.size >= 128)
      return Promise.reject(unavailable());
    const token = nonce();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.callbacks.delete(token);
        reject(unavailable());
      }, 15000);
      timer.unref();
      this.callbacks.set(token, { entry, resolve, reject, timer });
    });
  }
  private readonly spawnLocal: NonNullable<ProviderOptions["spawnLocal"]> = (raw) => {
    const entry = this.entries.get(raw.directory);
    if (!entry?.active || !raw.executionEnvironment || raw.executionEnvironment.id !== "execution.environment")
      throw unavailable();
    // Publication requires the original request to still be admitted.
    entry.guard?.(true);
    entry.run = raw.request;
    entry.status = {
      state: "ready",
      descriptor: { ...structuredClone(raw.executionEnvironment), id: "execution.environment" },
    };
    return { ready: Promise.resolve(null), failed: () => false, close: async () => {} };
  };
  private provider(revision: string) {
    let provider = this.providers.get(revision);
    if (provider) return provider;
    if (this.providers.size >= 8) throw unavailable();
    const spawnLocal = this.spawnLocal;
    if (this.options.source) {
      provider = this.options.source.createProvider(revision, spawnLocal);
      this.providers.set(revision, provider);
      return provider;
    }
    const installed = this.current(revision);
    provider = createSandboxAssistantProvider({
      backendId: "e2b",
      templates: installed.records.map((r) => ({
        id: r.environment.templateId,
        name: r.environment.name,
        resources: { ...r.policy.resources },
        workspaceRoot: r.policy.workspaceRoot,
        ...(r.policy.python ? { python: r.policy.python } : {}),
      })),
      capacity: installed.policy.capacity,
      maxCommandMs: installed.policy.maxCommandMs,
      persistentWorkspaces: installed.policy.persistentWorkspaces,
      createBackend: async (template, callbacks) => {
        const check = async (identity: Parameters<typeof callbacks.authorize>[0]) => {
          this.current(revision);
          await callbacks.authorize(identity);
          this.current(revision);
        };
        const scoped = {
          ...callbacks,
          authorize: check,
          workspaceId: async (identity: Parameters<typeof callbacks.workspaceId>[0]) => {
            await check(identity);
            return callbacks.workspaceId(identity);
          },
        };
        const record = installed.records.find((r) => r.environment.templateId === template.id)!;
        const backend = await (this.options.backend?.(template, scoped) ??
          (this.options.e2b ?? e2bSandboxBackend)({
            apiUrl: record.credential.apiUrl,
            sandboxUrl: record.credential.sandboxUrl,
            templateId: template.id,
            python: template.python,
            readApiKey: async () => {
              const current = this.current(revision).records.find((r) => r.environment.templateId === template.id);
              if (!current) throw unavailable();
              return current.credential.apiKey;
            },
            readWorkspaceId: scoped.workspaceId,
            timeoutMs: installed.policy.lease.timeoutMs,
            requestTimeoutMs: 15000,
            lease: {
              renewEveryMs: installed.policy.lease.renewEveryMs,
              maxLifetimeMs: installed.policy.lease.maxLifetimeMs,
              ...scoped,
            },
          }));
        return withWorkspaceBudget(
          {
            workspaceBudgetReserve: async (...args) => this.context.budget.reserve(...args),
            workspaceBudgetSettle: async (...args) => this.context.budget.settle(...args),
          },
          "bot",
          backend,
        );
      },
      // The real brain is spawned in Main with its original options. Never send
      // profile/model credentials, local paths, or arbitrary callbacks to Worker.
      spawnLocal,
    });
    this.providers.set(revision, provider);
    return provider;
  }
  open(revision: string, environment: Environment) {
    this.validate(revision, environment);
    return this.start(
      environment,
      () => this.provider(revision),
      () => this.assertRevision(revision),
    );
  }
  private start(
    environment: Environment,
    provide: () => Promise<Provider>,
    guard: (pending: boolean) => void,
    actor = false,
  ) {
    if (this.entries.size >= 64) throw unavailable();
    const token = nonce(),
      entry: Entry = { active: true, status: { state: "starting" }, starting: undefined!, ...(actor ? { guard } : {}) };
    this.entries.set(token, entry);
    entry.starting = (async () => {
      try {
        const provider = await provide();
        if (!entry.active) throw unavailable();
        entry.handle = await provider.spawn(environment, {
          directory: token,
          profileOptions: {},
          request: async (method) => {
            if (method !== "opencraft/personal-assistant/authorize") throw unavailable();
            guard(entry.status.state !== "ready");
            const result = await this.authorize(token);
            guard(entry.status.state !== "ready");
            return result;
          },
        });
        if (!entry.active) await entry.handle.close();
      } catch {
        entry.status = { state: "failed" };
      }
    })();
    return token;
  }
  private actor(raw: WorkspaceActorAdmission) {
    if (this.closed) throw unavailable();
    const access = this.actors.admit(raw);
    const owner = this.actors.owner(access, true);
    const actor = { actorId: access.actorId, generation: access.generation, scope: owner.scope };
    const resolve = (pending: boolean) => {
      if (this.closed) throw unavailable();
      const current = this.actors.owner(access, pending);
      if (current.scope !== owner.scope) throw unavailable();
      return resolveBotEnvironments(this.context.configurations, current, actor, this.options.backendIdentity);
    };
    return { access, scope: owner.scope, resolve, catalog: resolve(true) };
  }
  /** Secret-free catalogue of one admitted Actor's three sources. */
  sources(raw: WorkspaceActorAdmission) {
    const { catalog } = this.actor(raw);
    return {
      revision: catalog.revision,
      providers: catalog.environments.map((e) => ({ backendId: e.backendId, templates: structuredClone(e.templates) })),
    };
  }
  private selectSource(raw: WorkspaceActorAdmission, revision: string, environment: Environment) {
    const value = this.actor(raw);
    const selected =
      environment &&
      typeof environment === "object" &&
      !Array.isArray(environment) &&
      !Object.keys(environment).some((k) => !["kind", "backendId", "templateId"].includes(k)) &&
      environment.kind === "sandbox" &&
      value.catalog.revision === revision
        ? value.catalog.environments.find(
            (e) => e.backendId === environment.backendId && e.templates.some((t) => t.id === environment.templateId),
          )
        : undefined;
    if (!selected) throw unavailable();
    return { ...value, selected };
  }
  validateSource(raw: WorkspaceActorAdmission, revision: string, environment: Environment) {
    this.selectSource(raw, revision, environment);
  }
  /** Opens one entry on the selected source. It stays bound to that source's
   * fingerprint: a rotated key or a removed configuration retires it, but an
   * unrelated change to another source does not. */
  openSource(raw: WorkspaceActorAdmission, revision: string, environment: Environment) {
    const { resolve, selected, scope } = this.selectSource(raw, revision, environment);
    let provide: () => Promise<Provider>;
    let bound: () => void;
    if (selected.source === "installed") {
      const installed = this.installed().revision;
      provide = () => this.provider(installed);
      bound = () => this.current(installed);
    } else {
      let pool: Awaited<ReturnType<typeof this.pool>> | undefined;
      provide = async () => {
        pool = await this.pool(selected, scope);
        return pool.provider;
      };
      // A retired or replaced pool never serves an entry opened on it.
      bound = () => {
        if (pool && this.pools.get(selected.backendId) !== pool) throw unavailable();
      };
    }
    const guard = (pending: boolean) => {
      const current = resolve(pending).environments.find((e) => e.backendId === selected.backendId);
      if (!current || current.fingerprint !== selected.fingerprint) throw unavailable();
      bound();
    };
    return this.start(environment, provide, guard, true);
  }
  /** A personal pool belongs to one Actor partition and generation; a platform
   * pool is shared by every member. Neither retains a caller's authority: each
   * spawn and lease is authorized by its own Bot entry. */
  private async pool(selected: Extract<ResolvedBotEnvironment, { source: "personal" | "platform" }>, scope: string) {
    const key = selected.backendId;
    await this.sweep();
    const retiring = this.retiring.get(key);
    if (retiring) await retiring.catch(() => Promise.reject(unavailable()));
    const existing = this.pools.get(key);
    if (existing) return existing;
    if (this.closed || this.pools.size >= 64) throw unavailable();
    const live = () => {
      if (this.closed) throw unavailable();
      const records =
        selected.source === "platform"
          ? platformBotRecords(this.context.configurations)
          : this.context.configurations.runtime(scope, true);
      const match = records.find((r) => botRecordFingerprint(r, selected.source) === selected.fingerprint);
      if (!match) throw unavailable();
      return match;
    };
    const record = selected.record;
    const budget = {
      workspaceBudgetReserve: async (...args: Parameters<typeof this.context.budget.reserve>) =>
        this.context.budget.reserve(...args),
      workspaceBudgetSettle: async (...args: Parameters<typeof this.context.budget.settle>) =>
        this.context.budget.settle(...args),
    };
    const provider = createSandboxAssistantProvider({
      backendId: key,
      templates: [
        {
          id: record.environment.templateId,
          name: record.environment.name,
          workspaceRoot: BOT_SOURCE_POLICY.workspaceRoot,
          resources: { ...BOT_SOURCE_POLICY.resources },
        },
      ],
      capacity: { ...BOT_SOURCE_POLICY.capacity },
      maxCommandMs: BOT_SOURCE_POLICY.maxCommandMs,
      createBackend: (template, callbacks) =>
        withWorkspaceBudget(
          budget,
          "bot",
          (this.options.e2b ?? e2bSandboxBackend)({
            apiUrl: record.credential.apiUrl,
            sandboxUrl: record.credential.sandboxUrl,
            templateId: template.id,
            readApiKey: async () => live().credential.apiKey,
            timeoutMs: BOT_SOURCE_POLICY.lease.timeoutMs,
            requestTimeoutMs: 15000,
            lease: {
              renewEveryMs: BOT_SOURCE_POLICY.lease.renewEveryMs,
              maxLifetimeMs: BOT_SOURCE_POLICY.lease.maxLifetimeMs,
              authorize: async (identity) => {
                live();
                await callbacks.authorize(identity);
                live();
              },
              onLost: callbacks.onLost,
            },
          }),
        ),
      spawnLocal: this.spawnLocal,
    });
    const value = { provider, live };
    this.pools.set(key, value);
    provider.catch(() => {
      if (this.pools.get(key) === value) this.pools.delete(key);
    });
    return value;
  }
  /** Retires pools whose configuration is gone or rotated. A later pool on
   * the same backend ID waits for that cleanup before it is created. */
  private async sweep() {
    for (const [key, pool] of this.pools) {
      try {
        pool.live();
        continue;
      } catch {}
      if (this.pools.get(key) !== pool) continue;
      this.pools.delete(key);
      const retirement: Promise<void> = pool.provider
        .then((p) => p.close())
        .then(() => {
          if (this.retiring.get(key) === retirement) this.retiring.delete(key);
        });
      // A failed cleanup stays as a fail-closed barrier for this backend ID.
      retirement.catch(() => {});
      this.retiring.set(key, retirement);
    }
  }
  status(token: string) {
    const entry = this.entries.get(token);
    if (this.closed || !entry) throw unavailable();
    if (!entry.active || entry.handle?.failed()) return { state: "failed" } as const;
    if (entry.guard && entry.status.state === "ready")
      try {
        entry.guard(false);
      } catch {
        return { state: "failed" } as const;
      }
    return structuredClone(entry.status);
  }
  private job(work: () => Promise<unknown>) {
    if (this.closed || this.jobs.size >= 128) throw unavailable();
    const token = nonce(),
      job: Job = { status: { state: "pending" }, work: undefined! };
    this.jobs.set(token, job);
    job.work = Promise.resolve()
      .then(work)
      .then(
        (result) => {
          job.status = { state: "complete", result };
        },
        () => {
          job.status = { state: "failed" };
        },
      )
      .finally(() => {
        job.finished = Date.now();
      });
    return token;
  }
  execute(token: string, method: string, params: Record<string, unknown>) {
    const entry = this.entries.get(token);
    if (
      !entry?.active ||
      entry.status.state !== "ready" ||
      !entry.run ||
      !["environment/run", "environment/cancel"].includes(method)
    )
      throw unavailable();
    const input = structuredClone(params);
    if (JSON.stringify(input).length > 65536) throw unavailable();
    // A published entry outlives its request, never its resource admission.
    entry.guard?.(false);
    return this.job(async () => {
      if (!entry.active) throw unavailable();
      entry.guard?.(false);
      const result = await entry.run!(method, input);
      if (!entry.active) throw unavailable();
      entry.guard?.(false);
      return result;
    });
  }
  operation(token: string) {
    if (this.closed || !this.jobs.has(token)) throw unavailable();
    return structuredClone(this.jobs.get(token)!.status);
  }
  forget(token: string) {
    const job = this.jobs.get(token);
    if (!job) return;
    if (job.status.state === "pending") throw unavailable();
    this.jobs.delete(token);
  }
  private retire(token: string) {
    const entry = this.entries.get(token);
    if (!entry) throw unavailable();
    entry.active = false;
    for (const [key, callback] of this.callbacks)
      if (callback.entry === token) {
        clearTimeout(callback.timer);
        this.callbacks.delete(key);
        callback.reject(unavailable());
      }
    return entry;
  }
  closeEntry(token: string) {
    const entry = this.entries.get(token);
    if (!entry) throw unavailable();
    if (entry.closing) return entry.closing;
    // Reserve close correlation before retiring; failure to allocate must not lose
    // the only callable handle. A failed destroy remains a bounded tombstone.
    const operation = this.job(async () => {
      await entry.starting;
      await entry.handle?.close();
      this.entries.delete(token);
      return null;
    });
    entry.closing = operation;
    this.retire(token);
    return operation;
  }
  callbackPage() {
    if (this.closed) throw unavailable();
    return [...this.callbacks].map(([token, c]) => ({ token, entry: c.entry }));
  }
  reply(token: string, response: { result: unknown } | { error: true }) {
    const callback = this.callbacks.get(token);
    if (!callback) return;
    this.callbacks.delete(token);
    clearTimeout(callback.timer);
    try {
      if (
        !response ||
        !("result" in response) ||
        JSON.stringify(response).length > 8192 ||
        !this.entries.get(callback.entry)?.active
      )
        throw unavailable();
      callback.resolve(structuredClone(response.result));
    } catch {
      callback.reject(unavailable());
    }
  }
  readonly methods = {
    workspaceBotCatalog: async () => this.catalog(),
    workspaceBotValidate: async (revision: string, environment: Environment) => this.validate(revision, environment),
    workspaceBotOpen: async (revision: string, environment: Environment) => this.open(revision, environment),
    workspaceBotStatus: async (token: string) => this.status(token),
    workspaceBotExecute: async (token: string, method: string, params: Record<string, unknown>) =>
      this.execute(token, method, params),
    workspaceBotOperation: async (token: string) => this.operation(token),
    workspaceBotForget: async (token: string) => this.forget(token),
    workspaceBotClose: async (token: string) => this.closeEntry(token),
    workspaceBotCallbacks: async () => this.callbackPage(),
    workspaceBotReply: async (token: string, response: { result: unknown } | { error: true }) =>
      this.reply(token, response),
    workspaceBotSources: async (access: WorkspaceActorAdmission) => this.sources(access),
    workspaceBotSourceValidate: async (access: WorkspaceActorAdmission, revision: string, environment: Environment) =>
      this.validateSource(access, revision, environment),
    workspaceBotSourceOpen: async (access: WorkspaceActorAdmission, revision: string, environment: Environment) =>
      this.openSource(access, revision, environment),
  } satisfies WorkspaceBotPort & WorkspaceBotSourcePort;
  close() {
    return (this.closing ??= (async () => {
      this.closed = true;
      clearInterval(this.timer);
      for (const token of this.entries.keys()) this.retire(token);
      await Promise.all([...this.entries.values()].map((e) => e.starting));
      const results = await Promise.allSettled([
        ...[...this.providers.values()].map(async (p) => (await p).close()),
        ...[...this.pools.values()].map(async (p) => (await p.provider).close()),
        ...this.retiring.values(),
      ]);
      this.pools.clear();
      this.actors.close();
      await Promise.all([...this.jobs.values()].map((j) => j.work));
      if (results.some((r) => r.status === "rejected")) throw unavailable();
      this.entries.clear();
      this.jobs.clear();
    })());
  }
}
