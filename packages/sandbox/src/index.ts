import { DEFAULT_SANDBOX_RESOURCES, SandboxCreationFault, SandboxFault, type Sandbox, type SandboxBackend, type SandboxCommand, type SandboxEnvironment, type SandboxPoolPolicy, type SandboxResources } from "./contract.js";
export * from "./contract.js";
const dimensions = ["cpuMillis", "memoryBytes"] as const;
const fault = (code: ConstructorParameters<typeof SandboxFault>[0], message: string) => new SandboxFault(code, message);
const positive = (n: number) => Number.isSafeInteger(n) && n > 0;
function budget(input: SandboxResources) {
  if (!input || !dimensions.every(k => positive(input[k]))) throw fault("SANDBOX_POLICY", "Sandbox budgets must be positive safe integers");
  return Object.freeze({ cpuMillis: input.cpuMillis, memoryBytes: input.memoryBytes });
}
function command(input: SandboxCommand) {
  if (!input || !input.env || !Array.isArray(input.command)) throw fault("SANDBOX_POLICY", "Invalid sandbox command");
  const entries = Object.entries(input.env);
  if (input.command.length > 4096 || entries.length > 1024
    || input.command.reduce((n, v) => n + (typeof v === "string" ? v.length : 0), 0) > 256 * 1024
    || entries.reduce((n, [k, v]) => n + k.length + (typeof v === "string" ? v.length : 0), 0) > 64 * 1024) {
    throw fault("SANDBOX_POLICY", "Sandbox command or environment exceeds its request budget");
  }
  if (!Array.isArray(input.command) || !input.command.length || !input.command[0] || input.command.some(v => typeof v !== "string" || v.includes("\0"))
    || typeof input.cwd !== "string" || !input.cwd || input.cwd.includes("\0") || !input.env
    || Object.entries(input.env).some(([k, v]) => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(k) || typeof v !== "string" || v.includes("\0"))
    || input.terminal && ![input.terminal.cols, input.terminal.rows].every(v => Number.isInteger(v) && v > 0 && v <= 1000)) {
    throw fault("SANDBOX_POLICY", "Invalid sandbox command, environment or terminal");
  }
  return { command: [...input.command], cwd: input.cwd, env: { ...input.env }, ...(input.terminal ? { terminal: { ...input.terminal } } : {}) };
}
interface Request {
  owner: string; resources: SandboxResources; signal?: AbortSignal; controller: AbortController;
  resolve(sandbox: Sandbox): void; reject(error: unknown): void; cancel(): void;
}
export interface SandboxPool {
  createSandbox(options: { owner: string; resources?: Partial<SandboxResources>; signal?: AbortSignal }): Promise<Sandbox>;
  close(): Promise<void>;
}

/** Provider-neutral admission and lifetime. Linux and remote providers implement the same port. */
export async function createSandboxPool(input: SandboxPoolPolicy, backend: SandboxBackend): Promise<SandboxPool> {
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/u.test(input.id) || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(backend.id)
    || input.queueLimit !== undefined && (!Number.isSafeInteger(input.queueLimit) || input.queueLimit < 0)) throw fault("SANDBOX_POLICY", "Invalid sandbox pool policy");
  const capacity = budget(input.capacity), defaults = budget({ ...DEFAULT_SANDBOX_RESOURCES, ...input.defaults });
  if (dimensions.some(k => defaults[k] > capacity[k])) throw fault("SANDBOX_POLICY", "Default sandbox exceeds the provider pool budget");
  const policy = Object.freeze({ ...input, capacity, defaults });
  const queued: Request[] = [], active = new Set<Sandbox>(), starting = new Map<Request, Promise<void>>();
  const used = { cpuMillis: 0, memoryBytes: 0 };
  let closed = false, closing: Promise<void> | undefined, uncertain = false;
  let initialized = false, initialization: Promise<void> | undefined;
  const initializationController = new AbortController();
  const ready = () => initialization ??= Promise.resolve().then(() => backend.initialize(policy, initializationController.signal)).then(() => { initialized = true; });
  const fits = (r: SandboxResources) => dimensions.every(k => used[k] + r[k] <= capacity[k]);
  const release = (r: SandboxResources) => { for (const k of dimensions) used[k] -= r[k]; drain(); };
  const provision = async (request: Request) => {
    let environment: SandboxEnvironment;
    const identity = Object.freeze({ id: globalThis.crypto.randomUUID().replaceAll("-", ""), owner: request.owner, backend: backend.id });
    try { await ready(); }
    catch (error) {
      if (error instanceof SandboxFault && error.code === "SANDBOX_CLEANUP") uncertain = true;
      release(request.resources); request.reject(fault("SANDBOX_UNAVAILABLE", "Execution environment provider could not initialize")); return;
    }
    if (closed || request.controller.signal.aborted) { release(request.resources); request.reject(fault("SANDBOX_CLOSED", "Sandbox creation was cancelled")); return; }
    try { environment = await backend.create(identity, request.resources, request.controller.signal); }
    catch (error) {
      if (error instanceof SandboxCreationFault && error.outcome === "not-created") { release(request.resources); request.reject(error); }
      else { uncertain = true; request.reject(new SandboxCreationFault("unknown", identity)); }
      return;
    }
    let effective: Readonly<SandboxResources>;
    try {
      effective = budget(environment.resources);
      if (typeof environment.capabilities?.terminal !== "boolean" || environment.processLimits && (!positive(environment.processLimits.tasks) || !positive(environment.processLimits.fileDescriptorsPerProcess))) throw Error();
    } catch {
      try { await environment.close(); release(request.resources); request.reject(fault("SANDBOX_POLICY", "Sandbox backend returned invalid effective constraints")); }
      catch { uncertain = true; request.reject(fault("SANDBOX_CLEANUP", "Invalid sandbox environment could not be reclaimed")); }
      return;
    }
    let ended = false, cleanup: Promise<void> | undefined;
    const executions = new Set<Promise<unknown>>();
    const sandbox: Sandbox = {
      identity, resources: effective, capabilities: Object.freeze({ terminal: environment.capabilities.terminal }),
      ...(environment.processLimits ? { processLimits: Object.freeze({ tasks: environment.processLimits.tasks, fileDescriptorsPerProcess: environment.processLimits.fileDescriptorsPerProcess }) } : {}),
      async spawn(raw, onOutput) {
        if (closed || ended) throw fault("SANDBOX_CLOSED", "Sandbox is closed");
        const selected = command(raw);
        if (selected.terminal && !environment.capabilities.terminal) throw fault("SANDBOX_UNAVAILABLE", "Selected sandbox backend does not support terminals");
        const launch = environment.spawn(selected, onOutput); executions.add(launch);
        try {
          const child = await launch;
          if (closed || ended) { await child.terminate(); throw fault("SANDBOX_CLOSED", "Sandbox closed during process creation"); }
          if (selected.terminal && child.kind !== "terminal") { await child.terminate(); throw fault("SANDBOX_UNAVAILABLE", "Sandbox backend did not provide the requested terminal"); }
          return child;
        } finally { executions.delete(launch); }
      },
      close() {
        if (cleanup) return cleanup;
        ended = true;
        return cleanup = (async () => {
          await Promise.allSettled([...executions]);
          await environment.close();
          active.delete(sandbox); release(request.resources);
        })();
      },
    };
    active.add(sandbox);
    const mismatch = dimensions.some(k => effective[k] !== request.resources[k]);
    if (closed || request.controller.signal.aborted || mismatch) {
      try { await sandbox.close(); request.reject(fault(mismatch ? "SANDBOX_POLICY" : "SANDBOX_CLOSED", mismatch ? "Sandbox effective resources differ from the request" : "Sandbox creation was cancelled")); }
      catch { uncertain = true; request.reject(fault("SANDBOX_CLEANUP", "Late sandbox cleanup is unverified; capacity retained")); }
    } else request.resolve(sandbox);
  };
  const drain = () => {
    while (!closed && queued.length && fits(queued[0]!.resources)) {
      const request = queued.shift()!;
      for (const k of dimensions) used[k] += request.resources[k];
      const operation = provision(request); starting.set(request, operation);
      void operation.finally(() => { starting.delete(request); request.signal?.removeEventListener("abort", request.cancel); }).catch(() => {});
    }
  };
  return {
    createSandbox(options) {
      if (closed) return Promise.reject(fault("SANDBOX_CLOSED", "Sandbox pool is closed"));
      if (typeof options.owner !== "string" || !options.owner.trim() || options.owner.length > 256 || options.owner.includes("\0")) return Promise.reject(fault("SANDBOX_POLICY", "Sandbox requires an execution owner"));
      let selected: SandboxResources;
      try { selected = budget({ ...defaults, ...options.resources }); } catch (e) { return Promise.reject(e); }
      if (dimensions.some(k => selected[k] > capacity[k])) return Promise.reject(fault("SANDBOX_CAPACITY", "Sandbox request exceeds the provider pool budget"));
      if (options.signal?.aborted) return Promise.reject(fault("SANDBOX_CLOSED", "Sandbox creation was cancelled"));
      if ((!fits(selected) || queued.length) && queued.length >= (policy.queueLimit ?? 128)) return Promise.reject(fault("SANDBOX_CAPACITY", "Sandbox admission queue is full"));
      return new Promise<Sandbox>((resolve, reject) => {
        const request: Request = { owner: options.owner, resources: selected, signal: options.signal, controller: new AbortController(), resolve, reject, cancel() {
          request.controller.abort();
          const i = queued.indexOf(request);
          if (i < 0) return;
          queued.splice(i, 1); options.signal?.removeEventListener("abort", request.cancel);
          reject(fault("SANDBOX_CLOSED", "Sandbox creation was cancelled")); drain();
        } };
        queued.push(request); options.signal?.addEventListener("abort", request.cancel, { once: true }); drain();
      });
    },
    close() {
      if (closing) return closing;
      closed = true;
      initializationController.abort();
      for (const request of queued.splice(0)) { request.signal?.removeEventListener("abort", request.cancel); request.reject(fault("SANDBOX_CLOSED", "Sandbox pool is closed")); }
      for (const request of starting.keys()) request.controller.abort();
      return closing = (async () => {
        await Promise.allSettled([...starting.values()]);
        const results = await Promise.allSettled([...active].map(s => s.close()));
        if (uncertain || results.some(r => r.status === "rejected")) throw fault("SANDBOX_CLEANUP", "Sandbox cleanup is unverified; provider pool retained");
        if (initialized) await backend.close();
      })();
    },
  };
}
export function createSandbox(pool: SandboxPool, options: Parameters<SandboxPool["createSandbox"]>[0]): Promise<Sandbox> { return pool.createSandbox(options); }
