import { createHash, randomBytes } from "node:crypto";
import { createSandboxAssistantProvider } from "@opencraft/personal-assistant/sandbox";
import { e2bSandboxBackend } from "@opencraft/sandbox-e2b";
import { withWorkspaceBudget } from "@opencraft/plugin-assets/server/workspace-budget";
import type { AssetWorkspaceOwnerContext } from "@opencraft/plugin-assets/server/workspace-owner";
import type { AssistantEnvironmentProvider } from "@opencraft/personal-assistant/host";

type Environment = Parameters<AssistantEnvironmentProvider["spawn"]>[0];
type Descriptor = {
  id: "execution.environment";
  binding: string;
  backendId: string;
  templateId: string;
  ephemeral: true;
};
type Handle = Awaited<ReturnType<AssistantEnvironmentProvider["spawn"]>>;
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
  private closed = false;
  private closing?: Promise<void>;
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(
    private readonly context: AssetWorkspaceOwnerContext,
    private readonly options: { backend?: ProviderOptions["createBackend"]; source?: WorkspaceBotSource } = {},
  ) {
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
  private provider(revision: string) {
    let provider = this.providers.get(revision);
    if (provider) return provider;
    if (this.providers.size >= 8) throw unavailable();
    const spawnLocal: NonNullable<ProviderOptions["spawnLocal"]> = (raw) => {
      const entry = this.entries.get(raw.directory);
      if (!entry?.active || !raw.executionEnvironment || raw.executionEnvironment.id !== "execution.environment")
        throw unavailable();
      entry.run = raw.request;
      entry.status = {
        state: "ready",
        descriptor: { ...structuredClone(raw.executionEnvironment), id: "execution.environment" },
      };
      return { ready: Promise.resolve(null), failed: () => false, close: async () => {} };
    };
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
          e2bSandboxBackend({
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
    if (this.entries.size >= 64) throw unavailable();
    const token = nonce(),
      entry: Entry = { active: true, status: { state: "starting" }, starting: undefined! };
    this.entries.set(token, entry);
    entry.starting = (async () => {
      try {
        const provider = await this.provider(revision);
        if (!entry.active) throw unavailable();
        entry.handle = await provider.spawn(environment, {
          directory: token,
          profileOptions: {},
          request: async (method) => {
            if (method !== "opencraft/personal-assistant/authorize") throw unavailable();
            this.assertRevision(revision);
            const result = await this.authorize(token);
            this.assertRevision(revision);
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
  status(token: string) {
    const entry = this.entries.get(token);
    if (this.closed || !entry) throw unavailable();
    if (!entry.active || entry.handle?.failed()) return { state: "failed" } as const;
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
    return this.job(async () => {
      if (!entry.active) throw unavailable();
      const result = await entry.run!(method, input);
      if (!entry.active) throw unavailable();
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
  } satisfies WorkspaceBotPort;
  close() {
    return (this.closing ??= (async () => {
      this.closed = true;
      clearInterval(this.timer);
      for (const token of this.entries.keys()) this.retire(token);
      await Promise.all([...this.entries.values()].map((e) => e.starting));
      const results = await Promise.allSettled([...this.providers.values()].map(async (p) => (await p).close()));
      await Promise.all([...this.jobs.values()].map((j) => j.work));
      if (results.some((r) => r.status === "rejected")) throw unavailable();
      this.entries.clear();
      this.jobs.clear();
    })());
  }
}
