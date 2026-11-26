import { isAbsolute } from "node:path";
import { threadCatalogStatus } from "@opencraft/appserver-protocol";
import {
  BRIDGE_MAX_INPUT_BYTES,
  BRIDGE_THREAD_NOTIFICATIONS,
  parseDelta,
  type BridgeDelta,
  type BridgeErrorKind,
  type ItemShape,
} from "@opencraft/agent-bridge-protocol";

/** The connection is supplied by the existing Core owner. This adapter never
 * launches Codex, opens CODEX_HOME, or owns account/exec-server lifecycle. */
export interface CodexOwnerPort {
  configureExecution?(
    threadId: string,
    environment: Readonly<Record<string, string>>,
    preparationDeadlineMs?: number,
    sessionMcp?: Record<string, unknown> | null,
  ): Promise<void>;
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  /** Passive history may use a separate connection from execution. */
  readHistory?(method: string, params: Record<string, unknown>): Promise<unknown>;
}
export class CodexBridgeError extends Error {
  constructor(
    readonly kind: BridgeErrorKind,
    message: string,
    readonly nativeReason?: "unmaterialized" | "turns-unavailable",
  ) {
    super(message);
  }
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new CodexBridgeError("invalid", "Expected object");
  return value as Record<string, unknown>;
}
function id(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 512)
    throw new CodexBridgeError("invalid", "Expected identifier");
  return value;
}
/** Native input forwarded to Codex, including compiled Skill references. */
export const CODEX_INPUT_TYPES = ["text", "image", "localImage", "mention", "skill"] as const;
export const CODEX_INPUT_MAX_BYTES = BRIDGE_MAX_INPUT_BYTES;
/** An empty start continues the Thread (system continuation after a restart or provider failure); steers need content. */
function nativeInput(value: unknown, allowEmpty = false): boolean {
  if (!Array.isArray(value) || (value.length === 0 && !allowEmpty) || Buffer.byteLength(JSON.stringify(value)) > CODEX_INPUT_MAX_BYTES)
    return false;
  return value.every((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const item = raw as Record<string, unknown>,
      path = (key: string) => typeof item[key] === "string" && isAbsolute(item[key] as string);
    switch (item.type) {
      case "text":
        return typeof item.text === "string";
      case "image":
        return typeof item.url === "string" && /^(https:|data:image\/)/u.test(item.url);
      case "localImage":
        return path("path");
      case "mention":
      case "skill":
        return typeof item.name === "string" && path("path");
      default:
        return false;
    }
  });
}
interface Input {
  inputId: string;
  clientRequestId: string;
  turnId: string;
  nativeId: string;
  state: "dispatching" | "accepted" | "unknown" | "rejected";
  evidence?: string;
}
interface Session {
  nativeId: string;
  starting?: boolean;
  activeTurn?: string;
  uncertainStart?: boolean;
  endedTurns: Set<string>;
  openedTurns: Set<string>;
  inputs: Map<string, Input>;
  /** Text streams opened by deltas and not yet completed natively, by native item ID. */
  streams?: Map<string, { nativeTurnId: string; channel: "agentMessage" | "reasoning" | "plan" }>;
}
/** Provider-native translation only; canonical IDs and event ordering belong to assembler. */
export class CodexBridge {
  private sessions = new Map<string, Session>();
  constructor(
    private owner: CodexOwnerPort,
    private emit: (threadId: string, deltas: BridgeDelta[]) => void,
    private forward: (threadId: string, method: string, params: Record<string, unknown>) => void = () => {},
  ) {}
  bind(threadId: string, nativeId: string): void {
    id(threadId);
    id(nativeId);
    if (this.sessions.has(threadId) || [...this.sessions.values()].some((s) => s.nativeId === nativeId))
      throw new CodexBridgeError("explicit-reject", "Session already bound");
    this.sessions.set(threadId, { nativeId, endedTurns: new Set(), openedTurns: new Set(), inputs: new Map() });
  }
  forgetBinding(threadId: string): void {
    this.sessions.delete(threadId);
  }
  private session(threadId: string): Session {
    const session = this.sessions.get(threadId);
    if (!session) throw new CodexBridgeError("explicit-reject", "Session is not bound");
    return session;
  }
  boundThreads(): readonly string[] {
    return [...this.sessions.keys()];
  }
  nativeSession(threadId: string): string {
    return this.session(threadId).nativeId;
  }
  route(nativeId: string): string | undefined {
    return [...this.sessions].find(([, s]) => s.nativeId === nativeId)?.[0];
  }
  async stop(threadId: string, expectedTurnId: string): Promise<unknown> {
    const session = this.session(threadId);
    if (session.activeTurn !== expectedTurnId)
      throw new CodexBridgeError("stale-target", "Target turn is no longer active");
    return this.owner.request("turn/interrupt", { threadId: session.nativeId, turnId: expectedTurnId });
  }
  /** No turn running or starting, and every input outcome settled. */
  idle(threadId: string, action: string): Session {
    const session = this.session(threadId);
    if (session.activeTurn || session.starting || session.uncertainStart)
      throw new CodexBridgeError("explicit-reject", `Active session cannot ${action}`);
    if (
      [...session.inputs.values()].some(
        (input) =>
          input.state === "unknown" || input.state === "dispatching" || (input.state === "accepted" && !input.evidence),
      )
    )
      throw new CodexBridgeError("explicit-reject", `Input outcome requires reconciliation before ${action}`);
    return session;
  }
  async close(threadId: string): Promise<void> {
    const session = this.idle(threadId, "close");
    await this.owner.request("thread/unsubscribe", { threadId: session.nativeId });
    this.sessions.delete(threadId);
    this.emit(threadId, [{ op: "session.ended", scope: { threadId } }]);
  }
  /** Hand an idle session over to another owner: native stops reporting it here; nothing ends. */
  async release(threadId: string): Promise<void> {
    const session = this.idle(threadId, "release");
    await this.owner.request("thread/unsubscribe", { threadId: session.nativeId });
    this.sessions.delete(threadId);
  }
  /** Reconcile retained turns and join the still-running native turn. */
  recovered(threadId: string, turns: readonly { nativeTurnId: string; status: string }[]): void {
    const session = this.session(threadId),
      scope = { threadId };
    const deltas: BridgeDelta[] = [];
    for (const { nativeTurnId, status } of turns) {
      if (session.endedTurns.has(nativeTurnId)) continue;
      if (status === "inProgress") {
        if (session.activeTurn && session.activeTurn !== nativeTurnId) continue;
        session.activeTurn = nativeTurnId;
        if (!session.openedTurns.has(nativeTurnId)) {
          session.openedTurns.add(nativeTurnId);
          deltas.push({ op: "turn.open", scope, nativeTurnId });
        }
        continue;
      }
      session.endedTurns.add(nativeTurnId);
      if (session.activeTurn === nativeTurnId) session.activeTurn = undefined;
      deltas.push({
        op: "turn.close",
        scope,
        nativeTurnId,
        status: status === "completed" ? "completed" : status === "failed" ? "failed" : "interrupted",
      });
    }
    if (deltas.length) this.emit(threadId, deltas);
  }
  /** Native deletion first; the binding is dropped only once native confirmed it. */
  async delete(threadId: string): Promise<unknown> {
    const session = this.idle(threadId, "delete");
    const result = await this.owner.request("thread/delete", { threadId: session.nativeId });
    this.sessions.delete(threadId);
    this.emit(threadId, [{ op: "session.ended", scope: { threadId } }]);
    return result;
  }
  async start(
    threadId: string,
    params: Record<string, unknown>,
    cliEnvironment?: Readonly<Record<string, string>>,
    cliPreparationDeadlineMs?: number,
    sessionMcp?: Record<string, unknown> | null,
  ): Promise<unknown> {
    const session = this.session(threadId);
    if (session.activeTurn || session.starting || session.uncertainStart)
      throw new CodexBridgeError("explicit-reject", "Turn already active");
    if (!nativeInput(params.input, true))
      throw new CodexBridgeError("unsupported", "Unsupported or oversized Codex input");
    // Permission/environment preparation remains the existing owner's responsibility.
    session.starting = true;
    let nativeStartAttempted = false;
    try {
      if (cliEnvironment || sessionMcp !== undefined) {
        if (!this.owner.configureExecution) throw new CodexBridgeError("unsupported", "cliUnavailable");
        await this.owner.configureExecution(
          session.nativeId,
          cliEnvironment ?? {},
          cliPreparationDeadlineMs,
          sessionMcp,
        );
      }
      nativeStartAttempted = true;
      const result = await this.owner.request("turn/start", { ...params, threadId: session.nativeId });
      const nativeTurnId = id(record(record(result).turn).id);
      if (!session.endedTurns.has(nativeTurnId)) {
        session.activeTurn = nativeTurnId;
        if (!session.openedTurns.has(nativeTurnId)) {
          session.openedTurns.add(nativeTurnId);
          this.emit(threadId, [{ op: "turn.open", scope: { threadId }, nativeTurnId }]);
        }
      }
      return result;
    } catch (error) {
      if (!nativeStartAttempted) throw new CodexBridgeError("unsupported", "cliUnavailable");
      if (!(error instanceof CodexBridgeError) || !["explicit-reject", "stale-target", "invalid"].includes(error.kind))
        session.uncertainStart = true;
      throw error;
    } finally {
      session.starting = false;
    }
  }
  async steer(threadId: string, raw: unknown): Promise<unknown> {
    const p = record(raw),
      session = this.session(threadId);
    const inputId = id(p.inputId),
      clientRequestId = id(p.clientRequestId),
      expectedTurnId = id(p.expectedTurnId);
    if (expectedTurnId !== session.activeTurn)
      throw new CodexBridgeError("stale-target", "Target turn is no longer active");
    if (p.deliveryMethod !== undefined && p.deliveryMethod !== "native-inject")
      throw new CodexBridgeError("unsupported", "Only native injection is available");
    if (!nativeInput(p.input)) throw new CodexBridgeError("unsupported", "Unsupported steer content");
    if (
      session.inputs.has(inputId) ||
      [...session.inputs.values()].some((i) => i.clientRequestId === clientRequestId) ||
      [...session.inputs.values()].some((i) => i.state !== "rejected" && !i.evidence)
    )
      throw new CodexBridgeError("explicit-reject", "Input already pending; query its status");
    // Native client identity, rather than text matching, joins events even if
    // the input event arrives before the RPC response.
    const input: Input = {
      inputId,
      clientRequestId,
      turnId: expectedTurnId,
      nativeId: clientRequestId,
      state: "dispatching",
    };
    session.inputs.set(inputId, input);
    try {
      const result = await this.owner.request("turn/steer", {
        threadId: session.nativeId,
        expectedTurnId,
        clientUserMessageId: clientRequestId,
        input: p.input,
      });
      input.state = "accepted";
      this.emit(threadId, [
        {
          op: "input.accepted",
          scope: { threadId },
          nativeTurnId: expectedTurnId,
          inputId,
          clientRequestId,
          expectedTurnId,
          targetNativeSession: session.nativeId,
          allowedPaths: ["native-inject"],
          fallbackPolicy: "reject-unknown",
        },
        {
          op: "input.delivery",
          scope: { threadId },
          nativeTurnId: expectedTurnId,
          inputId,
          deliveryMethod: "native-inject",
          admitted: true,
          version: 1,
        },
      ]);
      return result;
    } catch (error) {
      // Only the owner's typed rejection can establish non-delivery. Transport
      // failures and unrecognized native errors remain unknown, never resent.
      input.state =
        error instanceof CodexBridgeError && (error.kind === "stale-target" || error.kind === "explicit-reject")
          ? "rejected"
          : "unknown";
      this.emit(threadId, [
        {
          op: "input.outcome",
          scope: { threadId },
          inputId,
          state: input.state,
          reason: input.state === "unknown" ? "Native outcome unknown" : "Native input rejected",
          version: 1,
        },
      ]);
      throw error;
    }
  }
  query(threadId: string, inputId: string): Readonly<Input> | null {
    const input = this.session(threadId).inputs.get(inputId);
    return input ? { ...input } : null;
  }
  /** Consume the native stream once. Foreign/legacy sessions are ignored. */
  notification(method: string, raw: unknown): void {
    if (BRIDGE_THREAD_NOTIFICATIONS.has(method)) {
      const p = record(raw),
        entry = [...this.sessions].find(([, s]) => s.nativeId === p.threadId);
      if (entry && method === "thread/status/changed") {
        const status = threadCatalogStatus(p.status);
        if (status) this.forward(entry[0], method, { threadId: entry[0], status });
      } else if (entry) this.forward(entry[0], method, { ...p, threadId: entry[0] });
      return;
    }
    if (
      ![
        "turn/started",
        "turn/completed",
        "item/started",
        "item/completed",
        "thread/tokenUsage/updated",
        "item/agentMessage/delta",
        "item/reasoning/textDelta",
        "item/plan/delta",
      ].includes(method)
    )
      return;
    const p = record(raw);
    const entry = [...this.sessions].find(([, s]) => s.nativeId === p.threadId);
    if (!entry) return;
    const [threadId, session] = entry,
      scope = { threadId };
    if (method === "turn/started") {
      const nativeTurnId = id(record(p.turn).id);
      if (session.endedTurns.has(nativeTurnId)) return;
      session.uncertainStart = false;
      session.activeTurn = nativeTurnId;
      if (!session.openedTurns.has(nativeTurnId)) {
        session.openedTurns.add(nativeTurnId);
        this.emit(threadId, [{ op: "turn.open", scope, nativeTurnId }]);
      }
    } else if (method === "turn/completed") {
      const turn = record(p.turn),
        nativeTurnId = id(turn.id);
      session.endedTurns.add(nativeTurnId);
      if (session.activeTurn === nativeTurnId) session.activeTurn = undefined;
      const status = turn.status === "failed" ? "failed" : turn.status === "interrupted" ? "interrupted" : "completed";
      // Native completed the turn; a stream it never completed (a response abandoned for a steer) ends with it.
      const abandoned: BridgeDelta[] = [];
      for (const [nativeKey, stream] of session.streams ?? []) {
        if (stream.nativeTurnId !== nativeTurnId) continue;
        session.streams!.delete(nativeKey);
        abandoned.push({ op: "item.textClose", scope, nativeTurnId, nativeKey, channel: stream.channel });
      }
      if (abandoned.length) this.emit(threadId, abandoned);
      // record() refuses non-objects; a completed turn carries error: null.
      const error = turn.error && typeof turn.error === "object" ? (turn.error as Record<string, unknown>) : {};
      // The native classification lets the Host's owner decide on a provider retry.
      const failure =
        status === "failed" && typeof error.message === "string"
          ? {
              error: {
                message: error.message.slice(0, 4096),
                codexErrorInfo: error.codexErrorInfo ?? null,
                additionalDetails:
                  typeof error.additionalDetails === "string" ? error.additionalDetails.slice(0, 4096) : null,
              },
            }
          : {};
      this.emit(threadId, [{ op: "turn.close", scope, nativeTurnId, status, ...failure }]);
    } else if (method === "item/started" || method === "item/completed") {
      const item = record(p.item),
        nativeKey = id(item.id),
        nativeTurnId = id(p.turnId);
      if (method === "item/completed") session.streams?.delete(nativeKey);
      let shape: ItemShape;
      if (item.type === "agentMessage" && typeof item.text === "string")
        shape = { kind: "agentMessage", text: item.text };
      else if (item.type === "plan" && typeof item.text === "string") shape = { kind: "plan", text: item.text };
      else if (item.type === "reasoning" && Array.isArray(item.content)) {
        const content = item.content.filter((v): v is string => typeof v === "string");
        const summary = Array.isArray(item.summary) ? item.summary.filter((v): v is string => typeof v === "string") : [];
        shape = { kind: "reasoning", text: content.join("\n"), content, summary };
      }
      else if ((item.type === "imageGeneration" || item.type === "mcpToolCall" || item.type === "dynamicToolCall") &&
        typeof item.status === "string") {
        const { id: _nativeId, ...fields } = item;
        shape = { kind: "appServerItem", item: { ...fields, type: item.type, status: item.status } };
      }
      else if (item.type === "userMessage" && Array.isArray(item.content)) {
        shape = {
          kind: "userMessage",
          text: item.content
            .map((c) => {
              const value = record(c);
              return value.type === "text" && typeof value.text === "string" ? value.text : "";
            })
            .join(""),
          clientId: typeof item.clientId === "string" ? item.clientId : undefined,
          // Native parts as recorded (hidden locator text, file mentions, images), when bounded.
          ...(JSON.stringify(item.content).length <= 65_536
            ? {
                content: item.content.filter(
                  (c): c is Record<string, unknown> =>
                    !!c &&
                    typeof c === "object" &&
                    !Array.isArray(c) &&
                    typeof (c as Record<string, unknown>).type === "string",
                ),
              }
            : {}),
        };
        // Only an explicit echoed client ID is usable. Native item IDs and
        // identical text alone do not identify an injected input.
        const input = [...session.inputs.values()].find(
          (i) => i.nativeId === item.clientId && i.turnId === nativeTurnId,
        );
        if (input && !input.evidence) {
          input.evidence = nativeKey;
          this.emit(threadId, [
            {
              op: "input.evidence",
              scope,
              nativeTurnId,
              inputId: input.inputId,
              evidenceKind: "native-input-id",
              evidenceRef: nativeKey,
              nativeInputId: nativeKey,
              runId: nativeTurnId,
              version: 1,
            },
          ]);
        }
      } else if (item.type === "commandExecution" && typeof item.command === "string" && typeof item.cwd === "string")
        shape = {
          kind: "command",
          command: item.command,
          cwd: item.cwd,
          status: item.status === "completed" ? "completed" : item.status === "failed" ? "failed" : "inProgress",
          output: typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : null,
          ...(typeof item.exitCode === "number" && Number.isSafeInteger(item.exitCode) ? { exitCode: item.exitCode } : {}),
          ...(typeof item.durationMs === "number" && Number.isFinite(item.durationMs) ? { durationMs: item.durationMs } : {}),
        };
      else if (item.type === "fileChange" && Array.isArray(item.changes) &&
        (item.status === "inProgress" || item.status === "completed" || item.status === "failed" || item.status === "declined"))
        shape = { kind: "fileChange", status: item.status, changes: item.changes as Extract<ItemShape, { kind: "fileChange" }>["changes"] };
      else {
        this.emit(threadId, [{ op: "unhandled", scope, nativeTurnId, nativeKey, reason: "Unsupported native item" }]);
        return;
      }
      const delta = { op: method === "item/started" ? "item.open" : "item.close", scope, nativeTurnId, nativeKey, shape } as const;
      if (shape.kind === "appServerItem" && !parseDelta(delta).ok) {
        this.emit(threadId, [{ op: "unhandled", scope, nativeTurnId, nativeKey, reason: "Invalid native media or tool item" }]);
        return;
      }
      this.emit(threadId, [delta]);
    } else if (method === "thread/tokenUsage/updated") {
      const usage = record(p.tokenUsage);
      const tokens = (raw: unknown) => {
        const value = record(raw);
        const read = (key: string) => {
          if (!Number.isSafeInteger(value[key]) || Number(value[key]) < 0)
            throw new CodexBridgeError("invalid", "Invalid token usage");
          return Number(value[key]);
        };
        return {
          totalTokens: read("totalTokens"),
          inputTokens: read("inputTokens"),
          cachedInputTokens: read("cachedInputTokens"),
          cacheWriteInputTokens: read("cacheWriteInputTokens"),
          outputTokens: read("outputTokens"),
          reasoningOutputTokens: read("reasoningOutputTokens"),
        };
      };
      this.emit(threadId, [
        {
          op: "usage",
          scope,
          nativeTurnId: id(p.turnId),
          total: tokens(usage.total),
          last: tokens(usage.last),
          modelContextWindow: typeof usage.modelContextWindow === "number" ? usage.modelContextWindow : null,
        },
      ]);
    } else if (["item/agentMessage/delta", "item/reasoning/textDelta", "item/plan/delta"].includes(method)) {
      if (typeof p.delta !== "string") throw new CodexBridgeError("invalid", "Invalid text delta");
      const channel =
        method === "item/plan/delta" ? "plan" : method === "item/reasoning/textDelta" ? "reasoning" : "agentMessage";
      (session.streams ??= new Map()).set(id(p.itemId), { nativeTurnId: id(p.turnId), channel });
      this.emit(threadId, [
        {
          op: "item.textDelta",
          scope,
          nativeTurnId: id(p.turnId),
          nativeKey: id(p.itemId),
          channel:
            method === "item/plan/delta"
              ? "plan"
              : method === "item/reasoning/textDelta"
                ? "reasoning"
                : "agentMessage",
          text: p.delta,
        },
      ]);
    }
  }
}
