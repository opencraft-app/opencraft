import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { negotiateHandshake, BRIDGE_ERROR_CODES, type BridgeDelta, type BridgeErrorKind } from "@opencraft/agent-bridge-protocol";
import { CURSOR_KEY_GUIDANCE } from "./credentials.js";
import { CURSOR_DECLARATION } from "./declaration.js";
import { InputFiles, parseInput } from "./input.js";
import type { CursorAgent, CursorFactory, CursorRun } from "./types.js";

export class CursorError extends Error {
  constructor(readonly kind: BridgeErrorKind, message: string) { super(message); }
  get code(): number {
    const codes: Record<BridgeErrorKind, number> = {
      invalid: BRIDGE_ERROR_CODES.invalidParams, unsupported: BRIDGE_ERROR_CODES.unsupportedCapability,
      "stale-target": BRIDGE_ERROR_CODES.staleTarget, auth: BRIDGE_ERROR_CODES.auth, quota: BRIDGE_ERROR_CODES.quota,
      "unknown-outcome": BRIDGE_ERROR_CODES.unknownOutcome, "explicit-reject": BRIDGE_ERROR_CODES.explicitReject,
      "frame-too-large": BRIDGE_ERROR_CODES.frameTooLarge, internal: BRIDGE_ERROR_CODES.internal,
    };
    return codes[this.kind];
  }
}
const fail = (kind: BridgeErrorKind, text: string): never => { throw new CursorError(kind, text); };
function id(v: unknown): string { if (typeof v !== "string" || !v || v.length > 512) return fail("invalid", "invalid identifier"); return v; }
function validInput(value: unknown) {
  try { return parseInput(value); } catch { return fail("invalid", "unsupported or invalid Cursor input"); }
}
interface Input {
  inputId: string; clientRequestId: string; files: InputFiles; text?: string;
  state: "preparing" | "dispatching" | "delivered" | "unknown" | "withdrawn" | "rejected" | "failed";
  delivery?: "native-inject"; allowedPaths: "native-inject"[];
  fallbackPolicy: "reject-unknown";
  target: string; operation?: Promise<unknown>;
}
interface Active {
  turnId: string; run?: CursorRun; startup: Promise<void>; done: Promise<void>;
  cancelled: boolean; opened: boolean; accepting: boolean; tools: Map<string, string>; textKey?: string; text: string; steers: Set<Promise<unknown>>; files: Set<InputFiles>;
}
interface Session {
  threadId: string; agent: CursorAgent; active?: Active; inputs: Map<string, Input>;
  stopped: boolean; fenced: boolean;
}
export interface CursorOptions {
  factory: CursorFactory;
  notify(method: "thread/identity" | "thread/delta", params: Record<string, unknown>): Promise<unknown>;
  attachmentRoot?: string;
  steerTimeoutMs?: number;
}

/** SDK adapter: native transport facts only; never writes provider context evidence. */
export class CursorBridge {
  private initialized = false;
  private closed = false;
  private sessions = new Map<string, Session>();
  private creating = new Set<string>();
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly options: CursorOptions) {}
  private emit(s: Session, delta: BridgeDelta): Promise<unknown> {
    const operation = this.tail.then(() => this.options.notify("thread/delta", { threadId: s.threadId, deltas: [delta] }));
    this.tail = operation.catch(() => {});
    return operation.catch((error) => { s.fenced = true; throw error; });
  }
  private async outcome(s: Session, i: Input, state: "unknown" | "rejected" | "failed", reason: string): Promise<void> {
    i.state = state;
    if (state === "unknown") s.fenced = true;
    await this.emit(s, { op: "input.outcome", scope: { threadId: s.threadId }, inputId: i.inputId, state, reason, version: 1 });
  }
  private async accepted(s: Session, i: Input): Promise<void> {
    await this.emit(s, { op: "input.accepted", scope: { threadId: s.threadId }, inputId: i.inputId,
      clientRequestId: i.clientRequestId, expectedTurnId: i.target, targetNativeSession: s.agent.agentId,
      allowedPaths: i.allowedPaths, fallbackPolicy: i.fallbackPolicy, disposition: "steered" });
  }
  private async delivered(s: Session, i: Input, run: CursorRun): Promise<void> {
    i.state = "delivered"; i.delivery = "native-inject";
    await this.emit(s, { op: "input.delivery", scope: { threadId: s.threadId }, inputId: i.inputId,
      deliveryMethod: "native-inject", admitted: true, runId: run.id, version: 1 });
    // complete_delivered is SDK delivery/admission, not native context confirmation.
    await this.emit(s, { op: "input.evidence", scope: { threadId: s.threadId }, inputId: i.inputId,
      evidenceKind: "admission", evidenceRef: "cursor-sdk:complete_delivered",
      runId: run.id, version: 1 });
  }
  async handle(method: string, p: Record<string, unknown> = {}): Promise<unknown> {
    if (this.closed) return fail("stale-target", "bridge closed");
    if (method === "initialize") {
      const result = negotiateHandshake(p as never, CURSOR_DECLARATION);
      if (!result.ok) throw new CursorError("unsupported", result.error.message);
      this.initialized = true; return result.result;
    }
    if (!this.initialized) return fail("invalid", "initialize first");
    if (method === "model/list") {
      if (!await this.options.factory.hasCredentials()) return fail("auth", CURSOR_KEY_GUIDANCE);
      return { models: await this.options.factory.models() };
    }
    if (method === "maintenance/probe") return { providerId: CURSOR_DECLARATION.providerId, sdk: "1.0.32" };
    const threadId = id(p.threadId);
    if (method === "session/create") {
      if (this.sessions.has(threadId) || this.creating.has(threadId)) return fail("invalid", "session exists");
      if (typeof p.cwd !== "string" || !isAbsolute(p.cwd)) return fail("invalid", "absolute cwd required");
      // P5 explicitly supports full native tools only; other modes are never silently widened.
      if (p.permissionMode !== "full") return fail("unsupported", "Cursor P5 requires explicit full permissionMode");
      const model = id(p.model);
      if (typeof p.stateDirectory !== "string" || !isAbsolute(p.stateDirectory)) return fail("invalid", "absolute private stateDirectory required");
      this.creating.add(threadId);
      try {
        if (!await this.options.factory.hasCredentials()) return fail("auth", CURSOR_KEY_GUIDANCE);
        if (this.closed) return fail("stale-target", "bridge closed during credential check");
        const agent = await this.options.factory.create(p.cwd, model, p.stateDirectory);
        if (this.closed) { await agent.close(); return fail("stale-target", "bridge closed during create"); }
        const s: Session = { threadId, agent, inputs: new Map(), stopped: false, fenced: false };
        this.sessions.set(threadId, s);
        try { await this.options.notify("thread/identity", { threadId, providerThreadId: agent.agentId, sessionRestorable: false }); }
        catch (error) { s.fenced = true; await agent.close(); this.sessions.delete(threadId); throw error; }
        return { providerThreadId: agent.agentId };
      } finally { this.creating.delete(threadId); }
    }
    const s = this.sessions.get(threadId);
    if (!s) return fail("stale-target", "session unavailable");
    if (method === "input/query") return { inputs: [...s.inputs.values()].filter((i) => !Array.isArray(p.inputIds) || p.inputIds.includes(i.inputId))
      .map((i) => ({ inputId: i.inputId, clientRequestId: i.clientRequestId, expectedTurnId: i.target,
        targetNativeSession: s.agent.agentId, state: i.state, deliveryMethod: i.delivery })) };
    if (method === "input/withdraw") {
      const i = s.inputs.get(id(p.inputId));
      if (!i) return fail("stale-target", "input unavailable");
      const state = i.state === "unknown" ? "unknown" : i.state === "withdrawn" || i.state === "preparing" ? "withdrawn"
        : i.state === "delivered" ? "too-late" : "unsupported";
      if (state === "withdrawn") { i.state = "withdrawn"; await i.files.dispose(); }
      await this.emit(s, { op: "input.withdrawal", scope: { threadId }, inputId: i.inputId, state, version: 1 });
      return { state };
    }
    if (method === "turn/stop") {
      const target = p.expectedTurnId ?? p.turnId;
      if (target !== undefined && (!s.active || id(target) !== s.active.turnId)) return fail("stale-target", "Stop target does not match the active turn");
      if (!s.active) return { stopped: false };
      await this.stop(s);
      return { stopped: true };
    }
    if (method === "session/close") {
      try { await this.stop(s); }
      catch { return fail("explicit-reject", "The session is still open because stopping did not finish. Check the current run before closing again."); }
      await s.agent.close();
      await this.emit(s, { op: "session.ended", scope: { threadId } });
      this.sessions.delete(threadId);
      return { closed: true };
    }
    if (s.fenced) return fail("unknown-outcome", "Cursor mutation outcome unknown; reconcile, do not replay");
    if (s.stopped) return fail("stale-target", "session stopped; close before reuse");
    if (method === "turn/start") {
      if (s.active) return fail("stale-target", "turn active");
      const files = new InputFiles(validInput(p.input), this.options.attachmentRoot);
      const active = this.launch(s, files);
      await active.startup;
      return { nativeTurnId: active.turnId };
    }
    if (method === "turn/steer") return this.steer(s, p);
    return fail("unsupported", `unsupported Cursor method ${method}`);
  }
  private launch(s: Session, files: InputFiles): Active {
    const a: Active = { turnId: `cursor:${randomUUID()}`, startup: Promise.resolve(), done: Promise.resolve(),
      cancelled: false, opened: false, accepting: true, tools: new Map(), text: "", steers: new Set(), files: new Set([files]) };
    s.active = a;
    a.startup = (async () => {
      const text = await files.prepare();
      if (a.cancelled) return;
      a.run = await s.agent.send(text);
      if (a.cancelled) return;
      a.opened = true;
      await this.emit(s, { op: "turn.open", scope: { threadId: s.threadId }, nativeTurnId: a.turnId });
    })();
    a.done = this.consume(s, a);
    void a.done.catch(() => { s.fenced = true; });
    return a;
  }
  private async consume(s: Session, a: Active): Promise<void> {
    let status: "completed" | "failed" | "interrupted" = "failed";
    try {
      await a.startup;
      if (!a.run) return;
      for await (const m of a.run.stream()) {
        if (a.cancelled) continue;
        if (m.run_id !== a.run.id || m.agent_id !== s.agent.agentId) throw Error("SDK stream identity mismatch");
        if (m.type === "tool_call") {
          if (m.status === "running") await this.finishText(s, a);
          if (m.status === "running") a.tools.set(m.call_id, m.name); else a.tools.delete(m.call_id);
          const shape = { kind: "tool" as const, name: m.name, status: m.status === "running" ? "inProgress" as const : m.status === "completed" ? "completed" as const : "failed" as const };
          await this.emit(s, { op: m.status === "running" ? "item.open" : "item.close", scope: { threadId: s.threadId }, nativeTurnId: a.turnId, nativeKey: m.call_id, shape });
        } else if (m.type === "assistant") {
          const text = m.message.content.filter((b) => b.type === "text").map((b) => b.text).join("");
          if (text) {
            if (!a.textKey) {
              a.textKey = `message:${randomUUID()}`;
              a.text = "";
              await this.emit(s, { op: "item.open", scope: { threadId: s.threadId }, nativeTurnId: a.turnId, nativeKey: a.textKey, shape: { kind: "agentMessage", text: "" } });
            }
            a.text += text;
            await this.emit(s, { op: "item.textDelta", scope: { threadId: s.threadId }, nativeTurnId: a.turnId, nativeKey: a.textKey, channel: "agentMessage", text });
          }
        }
      }
      const result = await a.run.wait();
      status = a.cancelled || result.status === "cancelled" ? "interrupted" : result.status === "finished" ? "completed" : "failed";
    } catch {
      s.fenced = true;
    } finally {
      a.accepting = false;
      // Terminal steer acks may arrive after wait(): preserve the original run owner.
      await Promise.allSettled([...a.steers]);
      try {
        await this.finishText(s, a);
        for (const [nativeKey, name] of a.tools) await this.emit(s, { op: "item.close", scope: { threadId: s.threadId }, nativeTurnId: a.turnId,
          nativeKey, shape: { kind: "tool", name, status: "failed" } });
        a.tools.clear();
        if (a.opened) await this.emit(s, { op: "turn.close", scope: { threadId: s.threadId }, nativeTurnId: a.turnId, status });
      } finally {
        await Promise.all([...a.files].map((f) => f.dispose()));
        if (s.active === a) s.active = undefined;
      }
    }
  }
  private async finishText(s: Session, a: Active): Promise<void> {
    if (!a.textKey) return;
    const nativeKey = a.textKey;
    a.textKey = undefined;
    await this.emit(s, { op: "item.close", scope: { threadId: s.threadId }, nativeTurnId: a.turnId, nativeKey, shape: { kind: "agentMessage", text: a.text } });
    a.text = "";
  }
  private async steer(s: Session, p: Record<string, unknown>): Promise<unknown> {
    const a = s.active;
    if (!a || !a.run || a.cancelled || !a.accepting) return fail("stale-target", "no ready active Cursor run");
    if (id(p.expectedTurnId) !== a.turnId) return fail("stale-target", "expectedTurnId mismatch");
    const inputId = id(p.inputId), clientRequestId = id(p.clientRequestId);
    if (s.inputs.has(inputId) || [...s.inputs.values()].some((i) => i.clientRequestId === clientRequestId)) return fail("invalid", "inputId or clientRequestId already registered; query existing input");
    if ([...s.inputs.values()].some((i) => i.state === "preparing" || i.state === "dispatching")) return fail("invalid", "one unresolved Cursor input at a time");
    const delivery = p.delivery ?? "native-inject";
    if (delivery !== "native-inject") return fail("unsupported", "unsupported delivery path");
    if (p.fallbackPolicy !== undefined && p.fallbackPolicy !== "reject-unknown") return fail("invalid", "invalid fallbackPolicy");
    const fallbackPolicy = "reject-unknown";
    const allowedPaths: "native-inject"[] = ["native-inject"];
    if (delivery === "native-inject" && typeof a.run.steer !== "function") return fail("unsupported", "SDK run has no steer method");
    const i: Input = { inputId, clientRequestId, target: a.turnId, state: "preparing", allowedPaths, fallbackPolicy,
      files: new InputFiles(validInput(p.input), this.options.attachmentRoot) };
    s.inputs.set(inputId, i); a.files.add(i.files);
    const operation = (async () => {
      let dispatched = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // input.accepted registers custody/identity; admission remains none until delivery.
        await this.accepted(s, i);
        if (a.cancelled || s.stopped || i.state === "withdrawn") return { state: i.state };
        i.text = await i.files.prepare();
        if (a.cancelled || s.stopped || (i as Input).state === "withdrawn") return { state: i.state };
        i.state = "dispatching";
        dispatched = true;
        const result = await Promise.race([a.run!.steer!(i.text), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(Error("SDK steer timed out")), this.options.steerTimeoutMs ?? 30_000);
        })]);
        if (a.cancelled || s.stopped) {
          await this.outcome(s, i, "unknown", "Stop raced SDK steer; no replay");
          return fail("unknown-outcome", "Stop raced SDK steer; query input");
        }
        if (result === "complete_delivered") {
          await this.delivered(s, i, a.run!);
          return { deliveryMethod: "native-inject", evidence: "sdk-delivered" };
        }
        if (result !== "revert_to_followup") throw Error("unrecognized SDK steer result");
        await this.outcome(s, i, "rejected", "The message was not inserted into the current turn.");
        await i.files.dispose();
        return { state: "rejected", message: "The message was not inserted into the current turn." };
      } catch (error) {
        if (!dispatched) {
          let cleaned = true;
          try { await i.files.dispose(); } catch { cleaned = false; }
          const reason = cleaned ? "Input preparation failed; nothing was sent to Cursor." : "Input preparation failed; nothing was sent, but attachment cleanup is still required.";
          if (i.state !== "withdrawn") await this.outcome(s, i, "failed", reason);
          throw new CursorError("explicit-reject", reason);
        }
        if ((i as Input).state !== "unknown" && (i as Input).state !== "rejected") await this.outcome(s, i, "unknown", "SDK steering outcome unconfirmed; no replay");
        throw error instanceof CursorError ? error : new CursorError("unknown-outcome", "SDK steering outcome unconfirmed; no replay");
      } finally { if (timer) clearTimeout(timer); }
    })();
    i.operation = operation; a.steers.add(operation);
    try { return await operation; } finally { a.steers.delete(operation); }
  }
  private async stop(s: Session): Promise<void> {
    s.stopped = true;
    const a = s.active;
    if (a) a.cancelled = true;
    const withdrawn: Input[] = [];
    for (const i of s.inputs.values()) {
      if (i.state !== "preparing") continue;
      i.state = "withdrawn"; withdrawn.push(i);
    }
    const files = [...new Set([...(a?.files ?? []), ...[...s.inputs.values()].map((i) => i.files)])];
    const clean = () => Promise.allSettled(files.map((f) => f.dispose()));
    // A cleanup error must not prevent native cancellation, nor wait for its ack.
    await clean();
    let nativeFailure: unknown;
    try {
      if (a) {
        await a.startup;
        if (a.run) { await a.run.cancel(); await a.run.wait(); }
        await a.done;
      }
    } catch (error) { nativeFailure = error; s.fenced = true; }
    const cleaned = await clean();
    if (cleaned.some((result) => result.status === "rejected")) {
      s.fenced = true;
      return fail("unknown-outcome", "Cursor attachment cleanup could not be completed. The session remains open for cleanup.");
    }
    for (const i of withdrawn) await this.emit(s, { op: "input.withdrawal", scope: { threadId: s.threadId }, inputId: i.inputId, state: "withdrawn", version: 1 });
    if (nativeFailure) throw nativeFailure;
    if (!s.fenced) s.stopped = false;
  }
  async close(): Promise<void> {
    this.closed = true;
    const results = await Promise.allSettled([...this.sessions.values()].map(async (s) => { try { await this.stop(s); } finally { await s.agent.close(); } }));
    this.sessions.clear(); await this.tail;
    if (results.some((result) => result.status === "rejected")) throw Error("Cursor shutdown cleanup could not be confirmed");
  }
}
