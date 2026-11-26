import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { negotiateHandshake, BRIDGE_ERROR_CODES, type BridgeDelta, type BridgeErrorKind } from "@opencraft/agent-bridge-protocol";
import { CURSOR_KEY_GUIDANCE } from "./credentials.js";
import { CURSOR_DECLARATION } from "./declaration.js";
import { InputFiles, parseInput } from "./input.js";
import type { CursorAgent, CursorFactory, CursorRun } from "./types.js";

const MODEL_LOOKUP_TIMEOUT_MS = 10_000;

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
  turnId: string; run?: CursorRun; dispatch: Promise<void>; startup: Promise<void>; done: Promise<void>;
  dispatchAttempted: boolean;
  output: AbortController;
  terminal?: ReturnType<CursorRun["wait"]>; nativeEnded: boolean;
  cancelled: boolean; opened: boolean; accepting: boolean; tools: Map<string, string>; textKey?: string; text: string; steers: Set<Promise<unknown>>; files: Set<InputFiles>;
}
interface Session {
  threadId: string; agent: CursorAgent; active?: Active; inputs: Map<string, Input>;
  stopped: boolean; fenced: boolean; files: Set<InputFiles>;
  callbackTail: Promise<unknown>;
  stopping?: Promise<void>;
  closeRequested?: true;
  closing?: Promise<{ closed: true }>;
  locallyClosed?: true;
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
  private readonly provisionalLifetime = new AbortController();
  private modelListing?: Promise<unknown>;
  private readonly creating = new Map<string, Promise<{ providerThreadId: string }>>();
  private shuttingDown?: Promise<void>;
  constructor(private readonly options: CursorOptions) {}
  private emit(s: Session, delta: BridgeDelta): Promise<unknown> {
    const operation = s.callbackTail.then(() => this.options.notify("thread/delta", { threadId: s.threadId, deltas: [delta] }));
    s.callbackTail = operation.catch(() => {});
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
      return this.modelListing ??= Promise.resolve().then(() => this.listModels())
        .finally(() => { this.modelListing = undefined; });
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
      const { cwd, stateDirectory } = p;
      const opening = Promise.resolve().then(() => this.createSession(threadId, cwd, model, stateDirectory))
        .finally(() => this.creating.delete(threadId));
      this.creating.set(threadId, opening);
      return opening;
    }
    if (this.creating.has(threadId)) return fail("stale-target", "Cursor session identity is pending");
    const s = this.sessions.get(threadId);
    if (!s) return fail("stale-target", "session unavailable");
    if (method === "input/query") return { inputs: [...s.inputs.values()].filter((i) => !Array.isArray(p.inputIds) || p.inputIds.includes(i.inputId))
      .map((i) => ({ inputId: i.inputId, clientRequestId: i.clientRequestId, expectedTurnId: i.target,
        targetNativeSession: s.agent.agentId, state: i.state, deliveryMethod: i.delivery })) };
    if (method === "session/close") return this.closeSession(s);
    if (s.closeRequested) return fail("stale-target", "Cursor session is closing");
    if (method === "input/withdraw") {
      const i = s.inputs.get(id(p.inputId));
      if (!i) return fail("stale-target", "input unavailable");
      const state = i.state === "unknown" ? "unknown" : i.state === "withdrawn" || i.state === "preparing" ? "withdrawn"
        : i.state === "delivered" ? "too-late" : "unsupported";
      if (state === "withdrawn") i.state = "withdrawn";
      await this.emit(s, { op: "input.withdrawal", scope: { threadId }, inputId: i.inputId, state, version: 1 });
      if (state === "withdrawn" && !await this.clean(s, [i.files])) return fail("explicit-reject", "The input was withdrawn, but attachment cleanup did not finish. Close the session to retry cleanup.");
      return { state };
    }
    if (method === "turn/stop") {
      const target = p.expectedTurnId ?? p.turnId;
      if (target !== undefined && (!s.active || id(target) !== s.active.turnId)) return fail("stale-target", "Stop target does not match the active turn");
      if (!s.stopping && !s.active && !s.files.size) return { stopped: false };
      await this.stop(s);
      return { stopped: true };
    }
    if (s.fenced) return fail("unknown-outcome", "Cursor mutation outcome unknown; reconcile, do not replay");
    if (s.stopped) return fail("stale-target", "session stopped; close before reuse");
    if (method === "turn/start") {
      if (s.active) return fail("stale-target", "turn active");
      const files = new InputFiles(validInput(p.input), this.options.attachmentRoot);
      const active = this.launch(s, files);
      try { await active.startup; }
      catch (error) {
        if (active.dispatchAttempted) throw error;
        await active.done;
        if (s.files.has(files))
          return fail("explicit-reject", "Nothing was sent to Cursor, but attachment cleanup did not finish. Close the session to retry cleanup.");
        if (error instanceof CursorError) throw error;
        return fail("explicit-reject", "Input attachment preparation failed. Nothing was sent to Cursor.");
      }
      return { nativeTurnId: active.turnId };
    }
    if (method === "turn/steer") return this.steer(s, p);
    return fail("unsupported", `unsupported Cursor method ${method}`);
  }
  private async listModels() {
    const shutdown = this.provisionalLifetime.signal;
    const signal = AbortSignal.any([shutdown, AbortSignal.timeout(MODEL_LOOKUP_TIMEOUT_MS)]);
    try {
      signal.throwIfAborted();
      const credentials = await this.options.factory.hasCredentials(signal);
      signal.throwIfAborted();
      if (!credentials) return fail("auth", CURSOR_KEY_GUIDANCE);
      const models = await this.options.factory.models(signal);
      signal.throwIfAborted();
      return { models };
    } catch (error) {
      if (!signal.aborted || error !== signal.reason) throw error;
      if (shutdown.aborted && error === shutdown.reason)
        return fail("stale-target", "Cursor model lookup stopped because the bridge is closed");
      return fail("explicit-reject", "Cursor model lookup timed out. Try again.");
    }
  }
  private async createSession(threadId: string, cwd: string, model: string, stateDirectory: string) {
    const { signal } = this.provisionalLifetime;
    signal.throwIfAborted();
    const credentials = await this.options.factory.hasCredentials(signal);
    signal.throwIfAborted();
    if (!credentials) return fail("auth", CURSOR_KEY_GUIDANCE);
    const agent = await this.options.factory.create(cwd, model, stateDirectory, signal);
    const s: Session = { threadId, agent, inputs: new Map(), stopped: false, fenced: false,
      files: new Set(), callbackTail: Promise.resolve() };
    this.sessions.set(threadId, s);
    let onAbort!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      signal.throwIfAborted();
      const confirmation = Promise.resolve().then(() => {
        signal.throwIfAborted();
        return this.options.notify("thread/identity", { threadId, providerThreadId: agent.agentId, sessionRestorable: false });
      });
      await Promise.race([confirmation, aborted]);
      signal.throwIfAborted();
      return { providerThreadId: agent.agentId };
    } catch (error) {
      s.fenced = true;
      s.closeRequested = true;
      await this.disposeAgent(s);
      this.sessions.delete(threadId);
      throw error;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }
  private async disposeAgent(s: Session): Promise<void> {
    await s.agent.close();
    s.locallyClosed = true;
  }
  private closeSession(s: Session): Promise<{ closed: true }> {
    if (s.closing) return s.closing;
    s.closeRequested = true;
    s.closing = (async () => {
      if (!s.locallyClosed) {
        try { await this.stop(s); }
        catch { return fail("explicit-reject", "The session is still open because stopping did not finish. Check the current run before closing again."); }
        try { await this.disposeAgent(s); }
        catch { return fail("explicit-reject", "The session is still open because local cleanup did not finish. Close it again to retry cleanup."); }
      }
      await this.emit(s, { op: "session.ended", scope: { threadId: s.threadId } });
      this.sessions.delete(s.threadId);
      return { closed: true } as const;
    })().finally(() => { s.closing = undefined; });
    return s.closing;
  }
  private launch(s: Session, files: InputFiles): Active {
    const a: Active = { turnId: `cursor:${randomUUID()}`, dispatch: Promise.resolve(), startup: Promise.resolve(), done: Promise.resolve(),
      dispatchAttempted: false, output: new AbortController(), nativeEnded: false, cancelled: false, opened: false, accepting: true, tools: new Map(), text: "", steers: new Set(), files: new Set([files]) };
    s.active = a; s.files.add(files);
    a.dispatch = (async () => {
      const text = await files.prepare();
      if (a.cancelled) return;
      a.dispatchAttempted = true;
      a.run = await s.agent.send(text);
      a.terminal = this.observeTerminal(s, a, a.run);
      void a.terminal.catch(() => {});
    })();
    a.startup = a.dispatch.then(async () => {
      if (!a.run) return fail("explicit-reject", "Cursor start was stopped before dispatch. Nothing was sent to Cursor.");
      a.opened = true;
      await this.emit(s, { op: "turn.open", scope: { threadId: s.threadId }, nativeTurnId: a.turnId });
    });
    a.done = this.consume(s, a);
    void a.done.catch(() => { s.fenced = true; });
    return a;
  }
  private async observeTerminal(s: Session, a: Active, run: CursorRun) {
    try {
      const result = await run.wait();
      a.accepting = false;
      a.nativeEnded = true;
      if (!await this.clean(s, [...a.files])) s.stopped = true;
      return result;
    } catch (error) {
      a.accepting = false;
      s.fenced = true;
      throw error;
    }
  }
  private async consume(s: Session, a: Active): Promise<void> {
    let status: "completed" | "failed" | "interrupted" = "failed";
    try {
      await a.startup;
      if (!a.run || !a.terminal) return;
      for await (const m of a.run.stream(a.output.signal)) {
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
      const result = await a.terminal;
      status = a.cancelled || result.status === "cancelled" ? "interrupted" : result.status === "finished" ? "completed" : "failed";
    } catch {
      if (a.dispatchAttempted) s.fenced = true;
    } finally {
      a.accepting = false;
      // Terminal steer acks may arrive after wait(): preserve the original run owner.
      await Promise.allSettled([...a.steers]);
      const terminal = await a.terminal?.catch(() => undefined);
      try {
        await this.finishText(s, a);
        for (const [nativeKey, name] of a.tools) await this.emit(s, { op: "item.close", scope: { threadId: s.threadId }, nativeTurnId: a.turnId,
          nativeKey, shape: { kind: "tool", name, status: "failed" } });
        a.tools.clear();
        if (a.opened && terminal) await this.emit(s, { op: "turn.close", scope: { threadId: s.threadId }, nativeTurnId: a.turnId, status });
      } finally {
        try {
          if (!a.terminal && !await this.clean(s, [...a.files])) s.stopped = true;
        } finally { if (s.active === a) s.active = undefined; }
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
    s.inputs.set(inputId, i); a.files.add(i.files); s.files.add(i.files);
    const operation = (async () => {
      let dispatched = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // input.accepted registers custody/identity; admission remains none until delivery.
        await this.accepted(s, i);
        if (a.cancelled || i.state === "withdrawn") return { state: i.state };
        if (!a.accepting || s.stopped) throw Error("Run stopped accepting inputs");
        i.text = await i.files.prepare();
        if (a.cancelled || (i as Input).state === "withdrawn") return { state: i.state };
        if (!a.accepting || s.stopped) throw Error("Run stopped accepting inputs");
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
          const reason = !cleaned ? "Input was not sent to Cursor, but attachment cleanup is still required."
            : !a.accepting ? "Input did not reach Cursor before the run stopped accepting inputs."
            : "Input preparation failed; nothing was sent to Cursor.";
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
  private async clean(s: Session, files: InputFiles[]): Promise<boolean> {
    const results = await Promise.allSettled(files.map(async (f) => { await f.dispose(); s.files.delete(f); }));
    return results.every((result) => result.status === "fulfilled");
  }
  private stop(s: Session): Promise<void> {
    return s.stopping ??= this.stopSession(s).finally(() => { s.stopping = undefined; });
  }
  private async stopSession(s: Session): Promise<void> {
    s.stopped = true;
    const a = s.active;
    if (a) a.cancelled = true;
    const withdrawn: Input[] = [];
    for (const i of s.inputs.values()) {
      if (i.state !== "preparing") continue;
      i.state = "withdrawn"; withdrawn.push(i);
    }
    const files = [...s.files];
    const clean = () => this.clean(s, files);
    // A cleanup error must not prevent native cancellation, nor wait for its ack.
    await clean();
    let nativeFailure: unknown;
    try {
      if (a) {
        await a.dispatch.catch(error => { if (a.dispatchAttempted) throw error; });
        if (a.run) {
          if (!a.nativeEnded) await a.run.cancel();
          await a.terminal;
          a.output.abort();
        }
        await a.done;
      }
    } catch (error) { nativeFailure = error; s.fenced = true; }
    const cleaned = await clean();
    for (const i of withdrawn) await this.emit(s, { op: "input.withdrawal", scope: { threadId: s.threadId }, inputId: i.inputId, state: "withdrawn", version: 1 });
    if (nativeFailure) throw nativeFailure;
    if (!cleaned) return fail("explicit-reject", "Cursor stopped, but attachment cleanup did not finish. Close the session again to retry cleanup.");
    if (!s.fenced) s.stopped = false;
  }
  close(): Promise<void> {
    if (!this.shuttingDown) {
      this.closed = true;
      this.shuttingDown = Promise.resolve().then(() => this.drainOwners());
      this.provisionalLifetime.abort(new CursorError("unknown-outcome", "Cursor session creation could not be confirmed before shutdown"));
    }
    return this.shuttingDown;
  }
  private async closeOwnedSession(s: Session): Promise<void> {
    await s.closing?.catch(() => {});
    try {
      if (s.locallyClosed) return;
      try { await this.stop(s); } finally { await this.disposeAgent(s); }
    } finally {
      await s.callbackTail;
    }
  }
  private async drainOwners(): Promise<void> {
    const opening = [...this.creating];
    const ready = [...this.sessions.values()].filter(s => !this.creating.has(s.threadId));
    const results = await Promise.allSettled([
      this.modelListing?.catch(() => {}),
      ...ready.map(s => this.closeOwnedSession(s)),
      ...opening.map(async ([threadId, creation]) => {
        await creation.catch(() => {});
        const retained = this.sessions.get(threadId);
        if (retained) await this.closeOwnedSession(retained);
      }),
    ]);
    this.sessions.clear();
    if (results.some((result) => result.status === "rejected")) throw Error("Cursor shutdown cleanup could not be confirmed");
  }
}
