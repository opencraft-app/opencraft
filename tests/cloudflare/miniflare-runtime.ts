// Miniflare (local workerd) implementation of WorkerRuntime: in-memory storage
// or a temp directory per persist key, no network and no Cloudflare account.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import {
  bundleWorker,
  COMPATIBILITY_DATE,
  type StartOptions,
  bufferedSocket,
  type WorkerBundle,
  type WorkerInstance,
  type WorkerRuntime,
  type WorkerSpec,
  type WorkerUpgrade,
} from "./worker-runtime.ts";

const DEFAULT_ORIGIN = "http://worker.test";

export interface MiniflareRuntime extends WorkerRuntime {
  /** Disposes every running instance and removes persisted storage. */
  dispose(): Promise<void>;
}

export function miniflareRuntime(): MiniflareRuntime {
  const bundles = new Map<string, Promise<WorkerBundle>>();
  const running = new Map<WorkerInstance, Miniflare>();
  const persisted = new Map<string, string>();
  let directory: Promise<string> | undefined;
  const scratch = () => (directory ??= mkdtemp(join(tmpdir(), "workerd-runtime-")));

  const runtime: MiniflareRuntime = {
    kind: "miniflare",
    label: "LOCAL Miniflare/workerd",
    patience: 1,
    bundle(spec) {
      let bundle = bundles.get(spec.id);
      if (!bundle) bundles.set(spec.id, (bundle = bundleWorker(spec)));
      return bundle;
    },
    async start(spec: WorkerSpec, options: StartOptions = {}) {
      const { code } = await runtime.bundle(spec);
      const origin = options.localOrigin ?? DEFAULT_ORIGIN;
      let persist: string | undefined;
      if (options.persist) {
        persist = persisted.get(options.persist);
        if (!persist) persisted.set(options.persist, (persist = await mkdtemp(join(await scratch(), "persist-"))));
      }
      const vars = typeof options.vars === "function" ? options.vars(origin) : options.vars;
      const miniflare = new Miniflare({
        // Inline module contents: workerd refuses module paths outside its working directory.
        modules: [{ type: "ESModule", path: "worker.mjs", contents: code }],
        compatibilityDate: COMPATIBILITY_DATE,
        ...(spec.compatibilityFlags ? { compatibilityFlags: [...spec.compatibilityFlags] } : {}),
        durableObjects: Object.fromEntries(
          Object.entries(spec.durableObjects).map(([binding, className]) => [binding, { className, useSQLite: true }]),
        ),
        ...(spec.r2Buckets ? { r2Buckets: [...spec.r2Buckets] } : {}),
        ...(vars ? { bindings: { ...vars } } : {}),
        ...(persist ? { durableObjectsPersist: persist } : {}),
      });
      await miniflare.ready;
      const instance: WorkerInstance = {
        origin,
        fetch: async (url, init) => (await miniflare.dispatchFetch(url, init as never)) as unknown as Response,
        async upgrade(url, headers = {}): Promise<WorkerUpgrade> {
          const response = await miniflare.dispatchFetch(url, { headers: { upgrade: "websocket", ...headers } });
          if (!response.webSocket) return { status: response.status, text: await response.text().catch(() => "") };
          response.webSocket.accept();
          return { status: response.status, socket: bufferedSocket(response.webSocket as never) };
        },
      };
      running.set(instance, miniflare);
      return instance;
    },
    async stop(instance) {
      const miniflare = running.get(instance);
      running.delete(instance);
      await miniflare?.dispose();
    },
    async dispose() {
      for (const instance of [...running.keys()]) await runtime.stop(instance);
      if (directory) await rm(await directory, { recursive: true, force: true });
      directory = undefined;
      persisted.clear();
    },
  };
  return runtime;
}
