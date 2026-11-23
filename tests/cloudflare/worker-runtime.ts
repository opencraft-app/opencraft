// Runtime-neutral driver contract for the Cloudflare prototype scenarios.
//
// The workerd prototypes (tests/storage/workerd, tests/identity/workerd,
// tests/protocol/workerd) each export their scenarios as `WorkerScenario`s in a
// `*.scenarios.ts` module. The same scenario objects run in two places:
//  - the Miniflare tests (`npm run test:*:workerd`, miniflare-runtime.ts), with
//    in-memory or temp-dir storage and no network or Cloudflare account;
//  - the real-Cloudflare rehearsal (`npm run cf:rehearsal`,
//    scripts/cloudflare/rehearsal.ts), which uploads the same bundles to a
//    Cloudflare account, runs the same assertions, and deletes what it created.
// A scenario only talks to a `WorkerRuntime`; it never knows which one it got,
// except for `patience` (wall-clock waits) and `label` (diagnostics).
import { resolve } from "node:path";
import { build, type Metafile } from "esbuild";

export const COMPATIBILITY_DATE = "2026-07-30";

/** One prototype worker: its entry module and what it binds. */
export interface WorkerSpec {
  /** Short id, also used in Cloudflare worker names (lowercase letters, digits, dashes). */
  readonly id: string;
  /** Absolute path of the worker module. */
  readonly entry: string;
  readonly compatibilityFlags?: readonly string[];
  /** Binding name → SQLite-backed Durable Object class exported by the entry. */
  readonly durableObjects: Readonly<Record<string, string>>;
  readonly r2Buckets?: readonly string[];
  /** Leave `node:*` imports to nodejs_compat instead of bundling them. */
  readonly externalNode?: boolean;
}

export type BindingValue = string | number;
export interface StartOptions {
  /**
   * Durable storage key. Two starts with the same key see the same Durable
   * Object storage, and the second start is a runtime restart (Miniflare:
   * a new instance over the same directory; Cloudflare: a new version of the
   * same worker). Without a key every start has empty storage.
   */
  readonly persist?: string;
  /** Plain bindings; a function receives the instance origin (for same-origin checks). */
  readonly vars?: Readonly<Record<string, BindingValue>> | ((origin: string) => Readonly<Record<string, BindingValue>>);
  /** Origin used by the in-process runtime; a deployed worker always has its own. */
  readonly localOrigin?: string;
}

/** An accepted WebSocket as the scenarios use it (Miniflare's or a `ws` client). */
export interface TestWebSocket {
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message", listener: (event: { data: string | ArrayBuffer }) => void): void;
  addEventListener(type: "close", listener: (event: { code: number; reason: string }) => void): void;
}

export interface WorkerUpgrade {
  readonly status: number;
  /** Present only for 101; already accepted. */
  readonly socket?: TestWebSocket;
  /** Response body text when the upgrade was refused. */
  readonly text?: string;
}

export interface WorkerInstance {
  /** Origin the instance is reachable at; use it where the worker checks Origin. */
  readonly origin: string;
  /**
   * Requests keep their virtual URL (host and path), e.g. `http://inst-a.relay.test/app`:
   * Miniflare dispatches it as is; the Cloudflare runtime sends it to the deployed
   * worker and its access guard restores the URL before the worker sees it.
   */
  fetch(url: string, init?: RequestInit): Promise<Response>;
  upgrade(url: string, headers?: Readonly<Record<string, string>>): Promise<WorkerUpgrade>;
}

export interface WorkerRuntime {
  readonly kind: "miniflare" | "cloudflare";
  /** Human label for diagnostics, e.g. "LOCAL Miniflare" or "Cloudflare". */
  readonly label: string;
  /** Multiplier for scenario wall-clock waits (network round trips on Cloudflare). */
  readonly patience: number;
  /** The bundle the runtime runs for `spec` (shared esbuild options; see bundleWorker). */
  bundle(spec: WorkerSpec): Promise<WorkerBundle>;
  start(spec: WorkerSpec, options?: StartOptions): Promise<WorkerInstance>;
  /** Ends an instance. Persisted storage survives for a later start with the same key. */
  stop(instance: WorkerInstance): Promise<void>;
}

export interface ScenarioContext {
  readonly runtime: WorkerRuntime;
  /** Temporary directory for Node-side comparison owners. */
  readonly scratch: string;
  diagnostic(line: string): void;
}

export interface WorkerScenario {
  /** Stable name: the Miniflare test title and the rehearsal row. */
  readonly name: string;
  run(context: ScenarioContext): Promise<void>;
}

export interface WorkerBundle {
  readonly code: string;
  readonly metafile: Metafile;
}

/**
 * The one esbuild configuration for every prototype worker. `wrap` lets a
 * runtime put a module around the worker's default export (the rehearsal access
 * guard) while the Durable Object classes are re-exported unchanged.
 */
export async function bundleWorker(
  spec: WorkerSpec,
  wrap?: { readonly module: string; readonly exportName: string },
): Promise<WorkerBundle> {
  const entry = JSON.stringify(spec.entry);
  const stdin = wrap
    ? {
        contents: `import worker from ${entry};\nimport { ${wrap.exportName} as wrap } from ${JSON.stringify(wrap.module)};\nexport * from ${entry};\nexport default wrap(worker);\n`,
        resolveDir: resolve(spec.entry, ".."),
        sourcefile: `${spec.id}-wrapped.ts`,
        loader: "ts" as const,
      }
    : undefined;
  const result = await build({
    ...(stdin ? { stdin } : { entryPoints: [spec.entry] }),
    write: false,
    outfile: "worker.mjs",
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2023",
    mainFields: ["module", "main"],
    // `workerd` selects runtime-neutral package entries (e.g. the handle-only Server repository).
    conditions: ["workerd", "worker", "import"],
    // node:* comes from nodejs_compat where a spec asks for it.
    external: spec.externalNode ? ["cloudflare:*", "node:*"] : ["cloudflare:*"],
    logLevel: "silent",
    metafile: true,
  });
  return { code: result.outputFiles[0]!.text, metafile: result.metafile };
}

/** Polls `read` until `done`, scaled by the runtime's patience; returns the last value. */
export async function until<T>(
  runtime: WorkerRuntime,
  read: () => Promise<T> | T,
  done: (value: T) => boolean,
  timeoutMs: number,
  intervalMs = 25,
): Promise<T> {
  const deadline = Date.now() + timeoutMs * runtime.patience;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type MessageListener = (event: { data: string | ArrayBuffer }) => void;
type CloseListener = (event: { code: number; reason: string }) => void;
interface RawSocket {
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: any) => void): void;
}

/**
 * Wraps an accepted socket so no frame or close is lost between the upgrade
 * resolving and the scenario attaching its listeners: events are queued until
 * the first listener of their type arrives.
 */
export function bufferedSocket(raw: RawSocket): TestWebSocket {
  const messages: MessageListener[] = [];
  const closes: CloseListener[] = [];
  const pendingMessages: { data: string | ArrayBuffer }[] = [];
  let pendingClose: { code: number; reason: string } | undefined;
  raw.addEventListener("message", (event: { data: unknown }) => {
    const data =
      typeof event.data === "string"
        ? event.data
        : event.data instanceof ArrayBuffer
          ? event.data
          : ArrayBuffer.isView(event.data)
            ? new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength).slice().buffer
            : String(event.data);
    if (messages.length) for (const listener of messages) listener({ data });
    else pendingMessages.push({ data });
  });
  raw.addEventListener("close", (event: { code: number; reason: string }) => {
    const close = { code: event.code, reason: event.reason };
    if (closes.length) for (const listener of closes) listener(close);
    else pendingClose = close;
  });
  return {
    send: (data) => raw.send(data),
    close: (code, reason) => raw.close(code, reason),
    addEventListener(type: "message" | "close", listener: MessageListener | CloseListener) {
      if (type === "message") {
        messages.push(listener as MessageListener);
        for (const event of pendingMessages.splice(0)) (listener as MessageListener)(event);
      } else {
        closes.push(listener as CloseListener);
        if (pendingClose) {
          const close = pendingClose;
          pendingClose = undefined;
          (listener as CloseListener)(close);
        }
      }
    },
  } as TestWebSocket;
}
