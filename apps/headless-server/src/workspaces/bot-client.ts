import type { AssistantEnvironmentProvider, spawnAssistant } from "@opencraft/personal-assistant/host";
import type { WorkspaceBotPort, WorkspaceBotSourcePort } from "./bot-owner.js";
import type { WorkspaceActorAdmission } from "./actor-authority.js";
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
type SpawnOptions = Parameters<AssistantEnvironmentProvider["spawn"]>[1];
type Brain = ReturnType<typeof spawnAssistant>;
type Environment = Parameters<AssistantEnvironmentProvider["spawn"]>[0];
/** The Bot assignment owner the host resolves environments for. */
export interface WorkspaceBotContext {
  readonly actorId: string;
  readonly generation: number;
}
interface Entry {
  request: SpawnOptions["request"];
  failed: boolean;
  checkedAt?: number;
  brain?: Brain;
  closing?: Promise<void>;
}
/** Main retains only the original brain and assignment callback. Cloud SDK,
 * template credentials, process handles and pool/journal live in Worker. */
export function createWorkspaceBotProvider(options: {
  port: WorkspaceBotPort & Partial<WorkspaceBotSourcePort>;
  /** The local Bot process launcher; a composition root supplies it (Node: `spawnAssistant`). */
  spawnLocal: typeof spawnAssistant;
  onCleanupUnconfirmed(): void;
  /** Main's admission for a Bot owner, rechecked by the vault Worker. With it,
   * `forContext` serves that Actor's personal, platform and installed sources. */
  admission?(context: WorkspaceBotContext): WorkspaceActorAdmission;
}): AssistantEnvironmentProvider & {
  /** One Actor's environments by backend ID; none when it is not admitted. */
  forContext(context: WorkspaceBotContext): Promise<Record<string, AssistantEnvironmentProvider>>;
  close(): Promise<void>;
} {
  const entries = new Map<string, Entry>(),
    callbacks = new Set<string>(),
    authorizing = new Map<string, Promise<unknown>>(),
    pending = new Set<Promise<void>>();
  let stopped = false,
    timer: ReturnType<typeof setTimeout> | undefined,
    pumping: Promise<void> | undefined,
    closing: Promise<void> | undefined;
  const check = () => {
    if (stopped) throw Error("Bot workspace provider closed");
  };
  const report = () => {
    try {
      options.onCleanupUnconfirmed();
    } catch {}
  };
  const schedule = () => {
    if (stopped || timer || pumping || !entries.size) return;
    timer = setTimeout(() => {
      timer = undefined;
      pumping = pump()
        .catch(() => {
          for (const e of entries.values()) e.failed = true;
        })
        .finally(() => {
          pumping = undefined;
          schedule();
        });
    }, 50);
    timer.unref();
  };
  async function pump() {
    const requests = await options.port.workspaceBotCallbacks();
    for (const request of requests) {
      // Another client of the same Worker, or an entry whose open has not yet
      // returned here, owns it; the Worker retires unanswered callbacks itself.
      if (callbacks.has(request.token) || !entries.has(request.entry)) continue;
      if (pending.size >= 128) {
        await options.port.workspaceBotReply(request.token, { error: true });
        continue;
      }
      callbacks.add(request.token);
      // Do not await the original callback on this pump: resource close/cancel and
      // other assignment authorizations must continue while one source is pending.
      const work = (async () => {
        let response: { result: unknown } | { error: true };
        try {
          const e = entries.get(request.entry);
          if (stopped || !e || e.closing) throw Error("Bot assignment retired");
          let authorization = authorizing.get(request.entry);
          if (!authorization) {
            authorization = Promise.resolve().then(() => e.request("opencraft/personal-assistant/authorize", {}));
            authorizing.set(request.entry, authorization);
            const original = authorization;
            const settled = () => {
              if (authorizing.get(request.entry) === original) authorizing.delete(request.entry);
            };
            void authorization.then(settled, settled);
          }
          response = { result: await authorization };
        } catch {
          response = { error: true };
        }
        try {
          await options.port.workspaceBotReply(request.token, response);
        } catch {
          const e = entries.get(request.entry);
          if (e) e.failed = true;
          report();
        }
      })().finally(() => {
        callbacks.delete(request.token);
      });
      pending.add(work);
      void work.finally(() => pending.delete(work));
    }
    for (const [token, e] of entries) {
      if (e.closing || Date.now() - (e.checkedAt ?? 0) < 500) continue;
      e.checkedAt = Date.now();
      try {
        if ((await options.port.workspaceBotStatus(token)).state === "failed") e.failed = true;
      } catch {
        e.failed = true;
      }
    }
  }
  async function result(token: string) {
    for (;;) {
      const value = await options.port.workspaceBotOperation(token);
      if (value.state === "pending") {
        await pause();
        continue;
      }
      await options.port.workspaceBotForget(token);
      if (value.state === "failed") throw Error("Bot workspace operation unavailable; do not replay");
      return value.result;
    }
  }
  async function closeEntry(token: string, e: Entry) {
    return (e.closing ??= (async () => {
      const results = await Promise.allSettled([
        Promise.resolve().then(() => e.brain?.close()),
        Promise.resolve().then(async () => {
          const operation = await options.port.workspaceBotClose(token);
          await result(operation);
        }),
      ]);
      if (results.some((r) => r.status === "rejected")) {
        e.failed = true;
        report();
        throw Error("Bot workspace cleanup unconfirmed");
      }
      entries.delete(token);
    })());
  }
  async function start(
    environment: Environment,
    source: SpawnOptions,
    open: () => Promise<string>,
  ): ReturnType<AssistantEnvironmentProvider["spawn"]> {
    check();
    const token = await open(),
      e: Entry = { request: source.request, failed: false };
    entries.set(token, e);
    schedule();
    try {
      for (;;) {
        check();
        const state = await options.port.workspaceBotStatus(token);
        if (state.state === "failed") throw Error("Bot workspace unavailable");
        if (state.state === "starting") {
          await pause();
          continue;
        }
        check();
        e.brain = options.spawnLocal({
          ...source,
          executionEnvironment: state.descriptor,
          request: async (method, params) => {
            if (!["environment/run", "environment/cancel"].includes(method)) return source.request(method, params);
            check();
            if (e.failed || e.closing) throw Error("Bot workspace retired");
            const operation = await options.port.workspaceBotExecute(token, method, params);
            return result(operation);
          },
        });
        return {
          ...e.brain,
          failed: () => e.failed || stopped || e.brain!.failed(),
          close: () => closeEntry(token, e),
        };
      }
    } catch (cause) {
      await closeEntry(token, e);
      throw cause;
    }
  }
  return {
    async templates() {
      check();
      return (await options.port.workspaceBotCatalog()).templates;
    },
    async validate(environment) {
      check();
      const catalog = await options.port.workspaceBotCatalog();
      await options.port.workspaceBotValidate(catalog.revision, environment);
      check();
    },
    async spawn(environment, source) {
      return start(environment, source, async () => {
        const catalog = await options.port.workspaceBotCatalog();
        check();
        return options.port.workspaceBotOpen(catalog.revision, environment);
      });
    },
    async forContext(context) {
      check();
      const port = options.port;
      const { workspaceBotSources, workspaceBotSourceValidate, workspaceBotSourceOpen } = port;
      if (!options.admission || !workspaceBotSources || !workspaceBotSourceValidate || !workspaceBotSourceOpen)
        throw Error("Bot environment sources unavailable");
      const admit = () => {
        check();
        const value = options.admission!(context);
        if (value.actorId !== context.actorId || value.generation !== context.generation)
          throw Error("Bot environment owner changed");
        return value;
      };
      const sources = async () => {
        const value = await workspaceBotSources.call(port, admit());
        check();
        return value;
      };
      let catalog: Awaited<ReturnType<typeof sources>>;
      try {
        catalog = await sources();
      } catch {
        // A disabled Actor or revoked membership has no environment at all.
        return {};
      }
      const owned = (backendId: string, environment: Environment) => {
        if (environment?.backendId !== backendId) throw Error("Bot environment unavailable");
      };
      return Object.fromEntries(
        catalog.providers.map(({ backendId }) => [
          backendId,
          {
            templates: async () => (await sources()).providers.find((p) => p.backendId === backendId)?.templates ?? [],
            validate: async (environment) => {
              owned(backendId, environment);
              const current = await sources();
              await workspaceBotSourceValidate.call(port, admit(), current.revision, environment);
              check();
            },
            spawn: (environment, source) => {
              owned(backendId, environment);
              return start(environment, source, async () => {
                const current = await sources();
                return workspaceBotSourceOpen.call(port, admit(), current.revision, environment);
              });
            },
          } satisfies AssistantEnvironmentProvider,
        ]),
      );
    },
    close() {
      return (closing ??= (async () => {
        stopped = true;
        clearTimeout(timer);
        await pumping;
        const results = await Promise.allSettled([...entries].map(([token, e]) => closeEntry(token, e)));
        // Original authorization promises may be slow or hung. Worker retirement
        // invalidates their tokens; never let a dead login keep cloud cleanup open.
        if (results.some((r) => r.status === "rejected")) throw Error("Bot workspace cleanup unconfirmed");
      })());
    },
  };
}
