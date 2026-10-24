// preflight-cand-20261023 (r2) — fixed preflight PROBE candidate (maintenance tool; NOT the online gate).
// r2 per review: (1) host/frame envelope unwrapped+validated (hostId/generation/leaseId), native replies keyed
//   by inner RPC id; success send-ACK is not an RPC result, only a failed ACK rejects the RPC;
//   (2) protocolVersion statically imported from THIS checkout's app-host-protocol version source;
//   (3) static `import WebSocket from "ws"`, bundled ws inlined, no cross-worktree require paths, no test env hooks;
//   (4) unified failure/cleanup: fatal/close/error/envelope violation/connect failure enter a terminal state that
//   fails pending AND future requests immediately, clears 10s timers (no masking);
//   (5) safe-allowlist output; endpoint printed WITHOUT query; no attempt string.
// Contract: hello -> host/connect(lease) -> initialize -> thread/loaded/list -> thread/read{includeTurns:false}
//   for EVERY loaded thread -> count active/unknown -> host/disconnect (best effort) -> terminate.
// Exit 0 idle; 2 not-idle (active/unknown/malformed/missing status); 3 protocol/handshake/envelope failure.
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { APP_HOST_PROTOCOL_VERSION } from "../../../packages/app-host-protocol/src/version.mjs";

const ENDPOINT_RAW = process.env.PREFLIGHT_ENDPOINT ?? "ws://127.0.0.1/apphost";
const endpointUrl = new URL(ENDPOINT_RAW);
const ENDPOINT_LABEL = endpointUrl.host + endpointUrl.pathname; // no search/query in output
const ORIGIN = "http://" + endpointUrl.host;
if (process.env.PREFLIGHT_TEST_FORCE_VERSION) throw new Error("idle-probe: production protocol is not test-overridable");

const attempt = randomUUID();
const leaseId = "preflight-" + attempt.slice(0, 8);
const url = new URL(ENDPOINT_RAW);
url.searchParams.set("attempt", attempt);
const ws = new WebSocket(url.href, { handshakeTimeout: 5000, origin: ORIGIN });
const started = Date.now();
let generation = null;
let terminalStage = null;
let terminalCode = null;
const pending = new Map();
let rpcSeq = 0;

function stageError(stage, code) { const e = new Error(stage); e.stage = stage; e.code = code ?? null; return e; }
function failAll() { for (const p of [...pending.values()]) { clearTimeout(p.timer); pending.delete(p.key); p.bad(stageError(terminalStage, terminalCode)); } }
function terminal(stage, code) { if (!terminalStage) { terminalStage = stage; terminalCode = code ?? null; } failAll(); }

function emit(result, extra = {}) {
  console.log(JSON.stringify({ observedAt: new Date().toISOString(), protocolVersionUsed: APP_HOST_PROTOCOL_VERSION,
    leaseId, endpointLabel: ENDPOINT_LABEL, ...extra, ...result, elapsedMs: Date.now() - started }));
}

ws.on("message", (raw) => {
  let f; try { f = JSON.parse(String(raw)); } catch { return; }
  if (f?.type === "fatal") { terminal("protocol-fatal", f?.error?.code === "APP_HOST_PROTOCOL_MISMATCH" ? "APP_HOST_PROTOCOL_MISMATCH" : "unspecified"); return; }
  if (f?.type === "host/frame") {
    let inner; try { inner = JSON.parse(f.frame); } catch { terminal("envelope-malformed", null); return; }
    const p = (inner && inner.id !== undefined) ? pending.get(inner.id) : null;
    if (p) { // matched RPC reply: strict hostId/generation/leaseId; broadcast (no id / unmatched id) never treated as a reply
      let badField;
      if (f.hostId !== "local-codex") badField = "foreign-host";
      else if (f.generation !== generation) badField = "foreign-generation";
      else if (f.leaseId === undefined || f.leaseId === null || f.leaseId === "") badField = "missing-lease";
      else if (f.leaseId !== leaseId) badField = "foreign-lease";
      if (badField) { terminal("envelope-mismatch", badField); return; }
      clearTimeout(p.timer); pending.delete(inner.id); p.ok(inner);
    }
    return;
  }
  if (f?.type === "response") {
    const rid = typeof f.requestId === "string" ? f.requestId : null;
    if (!rid) return;
    if (rid === "connect" || rid === "disconnect") {
      const p = pending.get(rid);
      if (p) { clearTimeout(p.timer); pending.delete(rid); f.ok ? p.ok(f) : p.bad(stageError(rid, "ack-failed")); }
      return;
    }
    if (rid.startsWith("send")) { // host/send ACK; success ACK is not the RPC result
      if (f.ok) return;
      const innerId = rid.slice(4);
      const p = pending.get(innerId);
      if (p) { clearTimeout(p.timer); pending.delete(innerId); p.bad(stageError(p.method ?? "rpc", "ack-failed")); }
      return;
    }
    return;
  }
  const byType = pending.get(f?.type); // {type:"ready"} hello reply
  if (byType && f?.type === "ready") {
    if (f.protocolVersion !== APP_HOST_PROTOCOL_VERSION) { terminal("ready-mismatch", "version-mismatch"); return; } // v2 sent, v1 ready -> nonzero
    clearTimeout(byType.timer); pending.delete(f.type); byType.ok(f);
  }
});
ws.on("close", () => terminal("connection-closed", null));
ws.on("error", () => terminal("ws-error", null));

function request(key, payload, method = null) {
  if (terminalStage) return Promise.reject(stageError(terminalStage, terminalCode));
  const p = { key, method, ok: null, bad: null, timer: null };
  const promise = new Promise((ok, bad) => { p.ok = ok; p.bad = bad; });
  promise.catch(() => {});
  p.timer = setTimeout(() => { if (pending.has(key)) { pending.delete(key); p.bad(stageError("request-timeout", null)); } }, 10000);
  pending.set(key, p);
  ws.send(JSON.stringify(payload));
  return promise;
}

const openPromise = new Promise((ok, bad) => {
  ws.once("open", ok);
  ws.once("error", (e) => bad(stageError("connect", e?.code ?? null)));
  ws.once("close", () => bad(stageError("connection-closed", null))); // unconditional: a close-only opening must reject fast
});
openPromise.catch(() => {});
const hostFrame = (inner) => ({ type: "host/send", requestId: "send" + inner.id, hostId: "local-codex", leaseId, generation, frame: JSON.stringify(inner) });

try {
  await openPromise;
  await request("ready", { type: "hello", protocolVersion: APP_HOST_PROTOCOL_VERSION, rendererId: attempt });
  const c = await request("connect", { type: "host/connect", requestId: "connect", hostId: "local-codex", leaseId });
  generation = c?.result?.generation;
  if (!Number.isSafeInteger(generation)) throw stageError("host/connect", "missing-generation");
  const rpc = async (method, params = {}) => {
    const id = `rpc-${++rpcSeq}-${leaseId.slice(-6)}`;
    const f = await request(id, hostFrame({ id, method, params }), method);
    if (f.error) throw stageError("rpc:" + method, "rpc-error");
    return f?.result;
  };
  await rpc("initialize", { clientInfo: { name: "cutover-readonly", version: "1" }, capabilities: { experimentalApi: true } });
  const loaded = (await rpc("thread/loaded/list"))?.data;
  let active = 0, unknown = 0, malformedList = false;
  if (!Array.isArray(loaded)) malformedList = true;
  const status = (type) => { if (type === "active") active += 1; else if (!["idle", "notLoaded", "systemError"].includes(type)) unknown += 1; };
  for (const threadId of Array.isArray(loaded) ? loaded : []) {
    if (typeof threadId !== "string" || !threadId) { malformedList = true; continue; }
    let type;
    try {
      const t = await rpc("thread/read", { threadId, includeTurns: false });
      const s = t?.thread?.status;
      type = typeof s === "string" ? s : s?.type; // missing/malformed status => unknown (never idle)
    } catch { type = undefined; }
    status(type);
  }
  try { await request("disconnect", { type: "host/disconnect", requestId: "disconnect", hostId: "local-codex", leaseId, generation }); } catch {}
  if (malformedList) { emit({ loaded: Array.isArray(loaded) ? loaded.length : null, active, unknown, verdict: "not-idle", reason: "malformed-loaded-list" }, { stage: "ok" }); process.exitCode = 2; }
  else if (active || unknown) { emit({ loaded: loaded.length, active, unknown, verdict: "not-idle" }, { stage: "ok" }); process.exitCode = 2; }
  else emit({ loaded: loaded?.length ?? 0, active: 0, unknown: 0, verdict: "idle" }, { stage: "ok" });
} catch (error) {
  emit({ verdict: "preflight-failed", failedStage: error?.stage ?? terminalStage ?? "unknown", failedCode: error?.code ?? terminalCode ?? null, note: "immediate-fail-no-10s-mask" }, { stage: "failed" });
  process.exitCode = 3;
} finally {
  let residual = 0;
  for (const p of [...pending.values()]) { clearTimeout(p.timer); residual += 1; }
  if (residual) console.log(JSON.stringify({ residualTimers: residual }));
  ws.terminate();
}
