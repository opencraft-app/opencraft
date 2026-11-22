import { spawnAssistant, type AssistantEnvironmentProvider } from "@opencraft/personal-assistant/host";
import type { WorkspaceBotPort } from "./bot-owner.js";
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
type SpawnOptions = Parameters<AssistantEnvironmentProvider["spawn"]>[1];
type Brain = ReturnType<typeof spawnAssistant>;
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
  port: WorkspaceBotPort;
  spawnLocal?: typeof spawnAssistant;
  onCleanupUnconfirmed(): void;
}): AssistantEnvironmentProvider & { close(): Promise<void> } {
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
      if (callbacks.has(request.token)) continue;
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
      check();
      const catalog = await options.port.workspaceBotCatalog();
      check();
      const token = await options.port.workspaceBotOpen(catalog.revision, environment),
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
          e.brain = (options.spawnLocal ?? spawnAssistant)({
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
