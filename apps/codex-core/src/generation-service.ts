import { createHash } from "node:crypto";
import type { RouterExpectation } from "./router-owner.js";
import { setTimeout as delay } from "node:timers/promises";
import { realpath, mkdir, stat, chown, chmod, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { CodexCoreControlClient, CodexCoreUnavailableError, CODEX_CORE_PROTOCOL_VERSION, type CodexAppServerHealth } from "@opencraft/account-pool-host";
import { startControlServer, readControlJson } from "./control-server.js";
import { CodexGenerationRuntime } from "./generation-runtime.js";
import { CodexGenerationRouter, startGenerationSocket } from "./generation-router.js";
import { coldHomeValidator } from "./generation-cold-home.js";
import { type GenerationSupervisor, SystemdGenerationSupervisor } from "./generation-supervisor.js";
import type { GenerationDefinition } from "./generation-registry.js";
import { nativeHistoryFailures, type NativeHistoryFailures } from "./native-history-read.js";

export async function startCodexGenerationService(options: {
  endpoint: string; coreEndpoint: string; tokenFile: string; token: string; dataDirectory: string;
  registryDirectory: string; systemdScope: "user" | "system"; requireHostUsage: boolean;
  supervisor?: GenerationSupervisor;
  nativeHistoryFailures?: NativeHistoryFailures;
  bootstrap?: { generation: GenerationDefinition; legacy?: boolean }; signal?: AbortSignal;
}) {
  options = { ...options, nativeHistoryFailures: nativeHistoryFailures(options.nativeHistoryFailures) };
  if (process.platform !== "linux" || ![options.endpoint, options.coreEndpoint, options.tokenFile, options.dataDirectory, options.registryDirectory].every(isAbsolute)
    || options.endpoint === options.coreEndpoint || options.token.length < 32) throw new Error("Invalid generation routing configuration");
  const core = new CodexCoreControlClient(options.coreEndpoint, options.token);
  const launch = await (async () => {
    for (;;) {
      options.signal?.throwIfAborted();
      try { return await core.appServerLaunch(options.signal); }
      catch (reason) {
        if (!(reason instanceof CodexCoreUnavailableError)) throw reason;
        await delay(500, undefined, { signal: options.signal });
      }
    }
  })();
  const dataDirectory = await realpath(options.dataDirectory);
  if (dataDirectory !== launch.dataDirectory) throw new Error("Generation routing account data directory mismatch");
  const base = launch.launch.args.find(value => value.startsWith("chatgpt_base_url="));
  if (!base) throw new Error("Generation routing has no account proxy");
  const proxyBaseUrl: string = JSON.parse(base.slice(base.indexOf("=") + 1));
  await mkdir(options.registryDirectory, { recursive: true, mode: 0o700 });
  const registryDirectory = await realpath(options.registryDirectory);
  for (let parent = registryDirectory;; parent = dirname(parent)) {
    const owner = await stat(parent), trusted = owner.uid === 0 || owner.uid === process.getuid!();
    if (!trusted || ((owner.mode & 0o022) !== 0 && (owner.mode & 0o1000) === 0)) throw new Error("Generation registry requires a trusted owner directory");
    if (dirname(parent) === parent) break;
  }
  const execution = await stat(dataDirectory);
  await mkdir(dirname(options.endpoint), { recursive: true, mode: 0o700 });
  await chmod(dirname(options.endpoint), 0o700);
  const socketDirectoryOwner = await stat(dirname(options.endpoint));
  if (socketDirectoryOwner.uid !== execution.uid || socketDirectoryOwner.gid !== execution.gid) await chown(dirname(options.endpoint), execution.uid, execution.gid);
  const supervisor = options.supervisor ?? new SystemdGenerationSupervisor({ registryDirectory, coreEndpoint: options.coreEndpoint,
    dataDirectory, tokenFile: options.tokenFile, token: options.token, scope: options.systemdScope });
  const validator = coldHomeValidator({ directory: join(registryDirectory, "cold-upgrades"), socketParentDirectory: dirname(options.endpoint), supervisor, nativeHistoryFailures: options.nativeHistoryFailures });
  const runtime = new CodexGenerationRuntime({ directory: registryDirectory, dataDirectory, proxyBaseUrl, supervisor,
    requireHostUsage: options.requireHostUsage, replaceRetiredHome: validator, executionUid: execution.uid, executionGid: execution.gid,
    runtimeParentDirectory: dirname(dataDirectory), socketParentDirectory: dirname(options.endpoint), nativeHistoryFailures: options.nativeHistoryFailures });
  const router = new CodexGenerationRouter(runtime); runtime.serverRequestCount = id => router.serverRequestCount(id);
  const nativeSocket = join(dirname(options.endpoint), "native.sock");
  let socket: Awaited<ReturnType<typeof startGenerationSocket>> | undefined;
  let control: Awaited<ReturnType<typeof startControlServer>> | undefined;
  let closing: Promise<void> | undefined;
  const state = () => ({ preparationOwner: runtime.preparationOwner(), lastActivation: runtime.registry.metadata("last-activation"), routingEpoch: runtime.registry.ownerEpoch, admissionEpoch: runtime.registry.epoch(),
    generations: runtime.registry.list().map(generation => ({ ...generation,
      runtime: runtime.registry.metadata(`runtime:${generation.id}`), appPayload: runtime.registry.metadata(`app-payload:${generation.id}`), coldReplacement: runtime.registry.metadata(`cold-replacement:${generation.id}`), drain: runtime.registry.metadata(`drain:${generation.id}`),
      retention: runtime.registry.metadata(`retention:${generation.id}`), retirementHistory: runtime.registry.metadata(`retirement-history:${generation.id}`),
      retirement: runtime.registry.metadata(`retirement:${generation.id}`), unresolvedCreations: runtime.registry.unresolvedCreations(generation.id) })),
    fences: runtime.fences(true), storage: runtime.registry.outcome });
  const close = () => closing ??= (async () => { await control?.close(); await socket?.close(); await runtime.close(); })();
  try {
    if (runtime.owner.isOpen()) await validator.recover(runtime.registry.list());
    socket = await startGenerationSocket(nativeSocket, router);
    await chown(nativeSocket, execution.uid, execution.gid);
    const configuration = async () => {
      const artifacts = [];
      for (const g of runtime.registry.list()) {
        artifacts.push({ id: g.id, definition: g, files: await Promise.all([g.executable, g.bundle, g.node, ...(g.nativeLauncher ? [g.nativeLauncher.entrypoint, g.nativeLauncher.executable] : [])].map(async path => ({
          path, sha256: createHash("sha256").update(await readFile(path)).digest("hex") }))) });
      }
      const managed = new Set(["INVOCATION_ID", "JOURNAL_STREAM", "SYSTEMD_EXEC_PID", "NOTIFY_SOCKET", "WATCHDOG_PID", "WATCHDOG_USEC", "LISTEN_PID", "LISTEN_FDS", "LISTEN_FDNAMES", "SHLVL", "_"]);
      return createHash("sha256").update(JSON.stringify({ ...options, token: createHash("sha256").update(options.token).digest("hex"), signal: undefined, supervisor: undefined,
        node: process.version, abi: process.versions.modules, proxyBaseUrl, artifacts,
        environment: Object.fromEntries(Object.entries(process.env).filter(([key]) => !managed.has(key)).sort(([a], [b]) => a.localeCompare(b))) })).digest("hex");
    };
    const observation = async () => {
      const value = await runtime.handoffObservation(), counts = { ...value.counts, ...router.handoffCounts() };
      const activeCount = Object.values(counts).reduce((a, b) => a + b, 0);
      let coverage = value.coverage;
      if (coverage === "complete" && activeCount === 0 && !runtime.owner.snapshot().uncertain) {
        // Reject unsupported current history while the exact source can still
        // abort. Discovering it only after release also defeats old-payload recovery.
        try { await runtime.coldReadNative(); } catch { coverage = "unknown"; }
      }
      return { ...value, coverage, counts, activeCount };
    };
    control = await startControlServer(options.endpoint, options.token, async request => {
      if (request.url === "/owner-handoff") {
        let proof: unknown, ready: unknown;
        if (request.method === "POST") {
          const value = await readControlJson(request), input = value as unknown as RouterExpectation;
          if (value.action === "fence") { runtime.owner.fence(input); await runtime.quiesceRouter(); }
          else if (value.action === "abort") runtime.owner.abort(input);
          else if (value.action === "inspect") proof = runtime.owner.inspect(input, await observation());
          else if (value.action === "release") { const config = await configuration(); runtime.owner.release(value as unknown as RouterExpectation & { proof?: string }, await observation(), config); }
          else if (value.action === "cold-ready") ready = await runtime.owner.coldReady(input, await configuration(), () => runtime.coldReadNative());
          else if (value.action === "resume") await runtime.owner.resume(value as unknown as RouterExpectation & { identity?: string }, await configuration(), () => runtime.coldReadNative());
          else throw new Error("Unknown router handoff action");
        } else if (request.method !== "GET") throw new Error("Unknown router handoff method");
        return { status: 200, value: { pid: process.pid, handoff: runtime.owner.snapshot(), proof, ready } };
      }
      const done = runtime.owner.enter();
      try {
      if (request.method === "GET" && request.url?.split("?")[0] === "/generation-directory") {
        const query = new URL(request.url, "http://local.invalid");
        return { status: 200, value: runtime.directory(query.searchParams.get("threadId") ?? undefined) };
      }
      if (request.method === "GET" && request.url === "/health") {
        const current = runtime.registry.current(), execution = await runtime.ensure(current.generation.id);
        return { status: 200, value: { protocolVersion: CODEX_CORE_PROTOCOL_VERSION, pid: process.pid, routingPid: process.pid,
          appServerPid: execution.pid, codexPid: execution.codexPid, nativeSocket, dataDirectory, proxyBaseUrl,
          environmentRoutingVersion: 1, orchestrationRoutingVersion: 1, routingEpoch: runtime.registry.ownerEpoch, generationId: current.generation.id, admissionEpoch: current.epoch,
          ...(execution.callbackProtocolVersion === 1 ? { callbackProtocolVersion: 1 as const, pendingCallbacks: execution.pendingCallbacks, pendingOrchestrationMutations: execution.pendingOrchestrationMutations } : {}) } satisfies CodexAppServerHealth };
      }
      if (request.method === "GET" && request.url === "/generations") return { status: 200, value: state() };
      if (request.method !== "POST" || !["/generations", "/generation-host"].includes(request.url ?? "")) return { status: 404, value: { error: "Unknown generation operation" } };
      const value = await readControlJson(request), params = value.params as Record<string, unknown>;
      if (!params || typeof params !== "object" || Array.isArray(params)) return { status: 400, value: { error: "Invalid generation envelope" } };
      if (request.url === "/generation-host") {
        if (value.operation === "claim") return { status: 200, value: runtime.claimHost(String(params.instanceId ?? ""), String(params.routingEpoch ?? "")) };
        if (value.operation === "state") return { status: 200, value: runtime.publishHostUsage(params as unknown as import("@opencraft/account-pool-host").CodexGenerationHostUsage) };
      } else {
        if (value.operation === "retention") return { status: 200, value: runtime.setRetention(params) };
        if (value.operation === "app-payload") return { status: 200, value: await runtime.selectAppPayload(params) };
        if (value.operation === "prepare") return { status: 200, value: await runtime.prepare(params.definition as unknown as GenerationDefinition, params.legacy === true, params.expectedOwner as string | undefined, params.expectedHost as string | undefined) };
        if (value.operation === "preparation") return { status: 200, value: { preparation: await runtime.preparation(String(params.id ?? ""), params.expectedOwner as string | undefined, params.expectedHost as string | undefined) } };
        if (value.operation === "revoke") return { status: 200, value: await runtime.revoke(String(params.id ?? ""), Number(params.expectedEpoch), String(params.preparation ?? "")) };
        if (value.operation === "activate") return { status: 200, value: { admissionEpoch: await runtime.activate(String(params.id ?? ""), Number(params.expectedEpoch), params.preparation === undefined ? undefined : String(params.preparation), params.expectedOwner as string | undefined, params.expectedHost as string | undefined, params.operationId as string | undefined) } };
        if (value.operation === "discard") { await runtime.discard(String(params.id ?? "")); return { status: 200, value: { discarded: true } }; }
        if (value.operation === "retire") return { status: 200, value: await runtime.retire(String(params.id ?? "")) };
      }
      return { status: 400, value: { error: "Unknown generation operation" } };
      } finally { done(); }
    });
    await chown(options.endpoint, execution.uid, execution.gid);
    if (runtime.owner.isOpen() && options.bootstrap && (!runtime.registry.get(options.bootstrap.generation.id) || runtime.registry.epoch() === 0)) {
      await runtime.prepare(options.bootstrap.generation, options.bootstrap.legacy === true);
      if (runtime.registry.epoch() === 0) await runtime.activate(options.bootstrap.generation.id, 0);
    }
    if (runtime.owner.isOpen() && runtime.registry.epoch() > 0) await runtime.ensure(runtime.registry.current().generation.id);
    options.signal?.throwIfAborted(); runtime.startMonitor();
    return { endpoint: options.endpoint, nativeSocket, close };
  } catch (reason) { await close(); throw reason; }
}
