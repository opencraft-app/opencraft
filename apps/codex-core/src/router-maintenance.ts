import { createHash } from "node:crypto";
import { constants, openSync, fstatSync, readFileSync, closeSync, lstatSync, readdirSync } from "node:fs";
import { createReadStream } from "node:fs";
import { isAbsolute } from "node:path";
import { execFileSync } from "node:child_process";
import { request } from "node:http";
import { inspectGenerationRegistry, type GenerationRecord } from "./generation-registry.js";
import type { GenerationSupervisor } from "./generation-supervisor.js";
import { GenerationPeer, rpcRecord } from "./generation-peer.js";
import { readNativeHistory, type NativeHistoryFailures } from "./native-history-read.js";

export const routerDigest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
class RouterMaintenanceBlocked extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "RouterMaintenanceBlocked"; }
}
export async function routerFileDigest(path: string) {
  const hash = createHash("sha256"); for await (const bytes of createReadStream(path)) hash.update(bytes); return hash.digest("hex");
}
export function processStamp(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid < 1) throw Error("Invalid maintenance process identity");
  try { const value = readFileSync(`/proc/${pid}/stat`, "utf8"); return value.slice(value.lastIndexOf(")") + 1).trim().split(/\s+/u)[19]!; }
  catch (reason) { if ((reason as NodeJS.ErrnoException).code === "ENOENT") return null; throw reason; }
}
export interface RouterMaintenanceReceipt {
  version: 1; kind: "router-maintenance"; mode: "fenced-source" | "crashed-source";
  operationId: string; fence: string; issuedAt: string; expiresAt: string;
  controller: { pid: number; startTime: string; bootId: string; lock: string };
  source: { pid: number; startTime: string; bootId: string; owner: string; bundle: string; bundleSha256: string };
  sourceSnapshot?: { pid: number; handoff: Record<string, unknown>; proof: Record<string, unknown> & { coverage: string; activeCount: unknown; counts: Record<string, number> } };
  sourceHandoff: Record<string, unknown>; registrySha256: string; configurationSha256: string;
  native: unknown; consumers: string[]; systemdScope: "system" | "user";
  payloadSha256: string[];
}
const sha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const identity = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/u.test(value);
export function privateRouterJson(path: string): unknown {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.uid !== process.getuid?.() || info.mode & 0o077 || info.size > 16 * 1024 * 1024) throw Error("Private router maintenance file required");
    return JSON.parse(readFileSync(fd, "utf8"));
  } finally { closeSync(fd); }
}
export function verifyRouterController(receipt: RouterMaintenanceReceipt) {
  const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(), c = receipt.controller;
  if (!c || c.bootId !== boot || !/^\d+$/u.test(c.startTime) || processStamp(c.pid) !== c.startTime || !isAbsolute(c.lock)) throw Error("Router deployment controller changed");
  const info = lstatSync(c.lock, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink() || Number(info.uid) !== process.getuid?.() || info.mode & 0o022n) throw Error("Trusted deployment lock required");
  const major = (info.dev >> 8n & 0xfffn) | (info.dev >> 32n & ~0xfffn), minor = (info.dev & 0xffn) | (info.dev >> 12n & ~0xffn);
  // Inspect this controller's descriptors. The global /proc/locks sequence can
  // skip entries while unrelated processes rapidly create and remove locks.
  const records = readdirSync(`/proc/${c.pid}/fdinfo`).flatMap(fd => {
    try { return readFileSync(`/proc/${c.pid}/fdinfo/${fd}`, "utf8").split("\n").filter(line => line.startsWith("lock:")).map(line => line.replace(/^lock:\s*/u, "")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  });
  const held = records.some(line => {
    const words = line.trim().split(/\s+/u), file = words[5]?.split(":");
    return words[1] === "FLOCK" && words[3] === "WRITE" && Number(words[4]) === c.pid && file?.length === 3
      && BigInt("0x" + file[0]) === major && BigInt("0x" + file[1]) === minor && BigInt(file[2]!) === info.ino;
  });
  if (!held || processStamp(c.pid) !== c.startTime) throw Error("Router maintenance requires the live deployment lock holder");
}
export function verifyRouterConsumers(consumers: string[], scope: "system" | "user") {
  if (!Array.isArray(consumers) || !consumers.length || consumers.length > 16 || !consumers.every(unit => /^[a-zA-Z0-9_.@-]+\.service$/u.test(unit))) throw Error("Explicit router consumer units required");
  for (const unit of consumers) {
    const value = execFileSync("systemctl", [...(scope === "user" ? ["--user"] : []), "show", "--property=LoadState,MainPID,ActiveState,SubState", "--", unit], { encoding: "utf8", timeout: 5000 });
    const state = Object.fromEntries(value.trim().split("\n").map(line => line.split("=")));
    if (state.LoadState !== "loaded" || state.MainPID !== "0" || !["inactive", "failed"].includes(state.ActiveState ?? "")) throw Error("Router consumers must be stopped");
  }
}
export async function routerLocalJson(endpoint: string, token: string, path: string) {
  return new Promise<any>((resolve, reject) => {
    const req = request({ socketPath: endpoint, path, agent: false, headers: { authorization: `Bearer ${token}` } }, response => {
      const chunks: Buffer[] = []; let size = 0;
      response.on("data", chunk => { size += chunk.length; if (size > 1024 * 1024) req.destroy(Error("Router maintenance response too large")); else chunks.push(chunk); });
      response.on("end", () => { try { if (response.statusCode !== 200) throw Error("Router maintenance inspection rejected"); resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch (error) { reject(error); } });
    });
    req.setTimeout(10_000, () => req.destroy(Error("Router maintenance inspection timed out"))); req.on("error", reject); req.end();
  });
}
export function readRouterMaintenance(path: string, state: unknown, storage: string, payload: string, historicalPending = 0, historicalSha256?: string) {
  const value = privateRouterJson(path) as RouterMaintenanceReceipt;
  const now = Date.now(), issued = Date.parse(value?.issuedAt), expires = Date.parse(value?.expiresAt);
  if (value?.version !== 1 || value.kind !== "router-maintenance" || !["fenced-source", "crashed-source"].includes(value.mode)
    || !identity(value.operationId) || !identity(value.fence) || !Number.isFinite(issued) || !Number.isFinite(expires)
    || issued > now + 1000 || expires <= now || expires - issued > 15 * 60_000
    || !sha(value.registrySha256) || !sha(value.configurationSha256) || !Array.isArray(value.payloadSha256)
    || !value.payloadSha256.length || value.payloadSha256.length > 2 || !value.payloadSha256.every(sha) || !value.payloadSha256.includes(payload)
    || !["system", "user"].includes(value.systemdScope)
    || !value.source || !identity(value.source.owner) || !isAbsolute(value.source.bundle) || !sha(value.source.bundleSha256)
    || !/^\d+$/u.test(value.source.startTime) || value.source.bootId !== readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()
    || routerDigest(value.sourceHandoff) !== routerDigest(state) || value.registrySha256 !== storage) throw Error("Router maintenance receipt rejected");
  verifyRouterController(value); verifyRouterConsumers(value.consumers, value.systemdScope);
  if (processStamp(value.source.pid) === value.source.startTime) throw Error("Router maintenance source is still present");
  const raw = rpcRecord(state);
  const pending = raw.pending ?? [];
  if (raw.version !== 1 || !Array.isArray(pending) || !pending.every(identity) || new Set(pending).size !== pending.length
    || typeof raw.uncertain !== "boolean" || !["open", "fenced"].includes(String(raw.phase)) || !Number.isSafeInteger(raw.epoch)) throw Error("Invalid maintenance source state");
  if (value.mode === "fenced-source") {
    const snapshot = value.sourceSnapshot, h = snapshot?.handoff, proof = snapshot?.proof;
    if (raw.phase !== "fenced" || !h || !proof || snapshot!.pid !== value.source.pid || h.pid !== value.source.pid || h.owner !== value.source.owner
      || h.operationId !== value.operationId || h.fence !== value.fence || h.phase !== "fenced" || h.epoch !== raw.epoch || h.persistence !== "ready"
      || h.bootId !== value.source.bootId || h.activeCalls !== pending.length - historicalPending || (h.historicalPendingCount ?? 0) !== historicalPending || h.uncertain !== raw.uncertain
      || h.historicalUnknownSha256 !== historicalSha256 || proof.historicalUnknownSha256 !== historicalSha256 || (proof.historicalPendingCount ?? 0) !== historicalPending
      || h.sourceOwner !== h.owner || !identity(h.incarnation) || proof.ownerId !== h.owner || proof.operationId !== h.operationId
      || proof.fence !== h.fence || proof.epoch !== h.epoch || proof.bootId !== h.bootId || proof.incarnation !== h.incarnation
      || !sha(proof.identity) || routerDigest(Object.fromEntries(Object.entries(proof).filter(([key]) => key !== "identity"))) !== proof.identity
      || !Number.isFinite(Date.parse(String(proof.expiresAt))) || Date.parse(String(proof.expiresAt)) <= now
      || routerDigest(h.pending) !== routerDigest(raw.pending) || proof.coverage !== "unknown" || proof.activeCount !== null
      || !proof.counts || Object.keys(proof.counts).sort().join(",") !== "connectionTools,lifecycle,monitor,nativeAdmission,rpc,starting,subscriptions,unresolvedCreations"
      || Object.values(proof.counts).some(count => count !== 0)) throw Error("Router source maintenance coverage is incomplete");
  }
  return value;
}

async function quietLoadedThreads(peer: GenerationPeer) {
  const value = rpcRecord(await peer.call("thread/loaded/list", {}));
  if (!Array.isArray(value.data) || !value.data.every(id => typeof id === "string") || new Set(value.data).size !== value.data.length) throw Error("Native loaded coverage is unavailable");
  const terminalSystemErrors = [];
  for (const threadId of [...value.data as string[]].sort()) {
    const thread = rpcRecord(rpcRecord(await peer.call("thread/read", { threadId, includeTurns: false })).thread);
    if (thread.id !== threadId) throw Error("Native loaded identity changed");
    if (rpcRecord(thread.status).type === "idle") continue;
    if (rpcRecord(thread.status).type !== "systemError") throw new RouterMaintenanceBlocked("ROUTER_NATIVE_TURN_BUSY", "Native Turn is active or unknown");
    const full = rpcRecord(rpcRecord(await peer.call("thread/read", { threadId, includeTurns: true })).thread);
    if (full.id !== threadId || rpcRecord(full.status).type !== "systemError" || !Array.isArray(full.turns) || !full.turns.length) throw Error("Native terminal error coverage is unavailable");
    const turns = full.turns.map(raw => {
      const turn = rpcRecord(raw);
      if (typeof turn.id !== "string" || !["completed", "failed", "interrupted"].includes(String(turn.status)) || !Array.isArray(turn.items)) throw new RouterMaintenanceBlocked("ROUTER_NATIVE_TURN_BUSY", "Native Turn is active or unknown");
      const executions = [];
      for (const rawItem of turn.items) {
        const item = rpcRecord(rawItem);
        const executable = ["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "collabAgentToolCall"].includes(String(item.type));
        if ((executable || "status" in item) && (typeof item.id !== "string" || !["completed", "failed", "declined", "interrupted"].includes(String(item.status)))) throw new RouterMaintenanceBlocked("ROUTER_NATIVE_TURN_BUSY", "Native command is active or unknown");
        if (executable) executions.push({ id: item.id, type: item.type, status: item.status });
      }
      return { id: turn.id, status: turn.status, executions };
    });
    terminalSystemErrors.push({ threadId, turns });
  }
  return { loaded: [...value.data as string[]].sort(), ...(terminalSystemErrors.length ? { terminalSystemErrors } : {}) };
}

/** Cross-owner zero-work proof; read-only and never resumes, answers or arms Native work. */
export async function inspectRouterNative(options: {
  generations: GenerationRecord[]; routes: { threadId: string; generationId: string }[]; metadata: Record<string, unknown>;
  unresolvedCreations: number; supervisor: GenerationSupervisor; coreEndpoint: string; token: string; failures: NativeHistoryFailures;
}) {
  if (options.unresolvedCreations || options.generations.some(g => !["active", "ready", "draining", "discarded"].includes(g.state))) throw new RouterMaintenanceBlocked("ROUTER_LIFECYCLE_BUSY", "Router lifecycle or creation work is unresolved");
  const core = await routerLocalJson(options.coreEndpoint, options.token, "/owner-handoff");
  const coreQuiet = (v: any) => v.handoff?.protocolVersion === 1 && v.handoff?.topology === "split" && v.handoff?.phase === "open" && v.handoff?.persistence === "ready"
    && typeof v.handoff?.owner === "string" && !!v.handoff.owner && Number.isSafeInteger(v.pid) && v.pid > 0
    && v.proof?.counts && Object.keys(v.proof.counts).sort().join(",") === "oauth,proxy,refresh,requests,resetCredits,subscriptions"
    && Object.values(v.proof.counts).every(n => Number.isSafeInteger(n) && Number(n) >= 0) && v.proof.counts.proxy === 0;
  // Core keeps OAuth, subscriptions and account maintenance. Only its actual
  // proxy admission/stream activity blocks this router-only transition.
  if (!coreQuiet(core)) throw new RouterMaintenanceBlocked("ROUTER_CORE_PROXY_BUSY", "Core has active or unobserved proxy work");
  const generations = [];
  const durable = options.routes.filter(r => options.metadata[`thread-retention:${r.threadId}`] == null);
  if (options.failures.failures.some(f => !durable.some(r => r.generationId === f.generationId && r.threadId === f.threadId))) throw Error("Historical failure route changed");
  for (const g of options.generations.filter(g => g.state !== "discarded")) {
    const health = await options.supervisor.inspect!(g), identity = await options.supervisor.identify(g, health);
    if (routerDigest(identity) !== routerDigest(options.metadata[`runtime:${g.id}`]) || health.callbackProtocolVersion !== 1
      || health.pendingCallbacks !== 0 || health.pendingOrchestrationMutations !== 0 || !await options.supervisor.processesQuiet(identity)) throw new RouterMaintenanceBlocked("ROUTER_NATIVE_ADMISSION_BUSY", "Native admission or process work is unresolved");
    let unexpected = false, disconnected = false;
    const { peer } = await GenerationPeer.open(health.nativeSocket, { clientInfo: { name: "opencraft-router-maintenance", version: "1" }, capabilities: { experimentalApi: true } }, {
      message(message) { if (message.id !== undefined && message.method) unexpected = true; }, disconnected() { disconnected = true; },
    });
    try {
      const loaded = await quietLoadedThreads(peer);
      const history = await readNativeHistory(peer, g.id, durable.filter(r => r.generationId === g.id).map(r => r.threadId), options.failures.failures.filter(f => f.generationId === g.id));
      if (routerDigest(await quietLoadedThreads(peer)) !== routerDigest(loaded)) throw new RouterMaintenanceBlocked("ROUTER_NATIVE_PROOF_CHANGED", "Native terminal evidence changed during inspection");
      const after = await options.supervisor.inspect!(g);
      if (unexpected || disconnected || after.pid !== health.pid || after.codexPid !== health.codexPid || after.pendingCallbacks !== 0 || after.pendingOrchestrationMutations !== 0
        || !await options.supervisor.processesQuiet(identity)) throw new RouterMaintenanceBlocked("ROUTER_NATIVE_PROOF_CHANGED", "Native work changed during inspection");
      generations.push({ generationId: g.id, incarnation: g.incarnation, identity, history, ...loaded });
    } finally { peer.close(); }
  }
  const after = await routerLocalJson(options.coreEndpoint, options.token, "/owner-handoff");
  const coreIdentity = (v: any) => ({ owner: v.handoff?.owner, epoch: v.handoff?.epoch, pid: v.pid, historicalUnknown: v.handoff?.uncertain });
  if (routerDigest(coreIdentity(after)) !== routerDigest(coreIdentity(core)) || !coreQuiet(after)) throw new RouterMaintenanceBlocked("ROUTER_CORE_PROOF_CHANGED", "Core changed during inspection");
  return { version: 1, core: coreIdentity(core), generations };
}

export const readRouterRegistry = inspectGenerationRegistry;
