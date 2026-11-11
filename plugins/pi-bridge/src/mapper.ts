/**
 * Pure Pi-native snapshot -> semantic delta mapping.
 *
 * Pi-durable publishes committed snapshots, not token callbacks. The mapper
 * turns successive snapshots into item/turn deltas and keeps per-input
 * evidence facets. Two rules are deliberate:
 *
 * - A steer only ever reaches `evidence-observed` here. Seeing the durable
 *   inbox item leave and the input entry arrive proves the native owner placed
 *   the input; it does not prove the model's next request contained or used
 *   it. Queue removal is not reported as per-input context confirmation.
 * - Inputs are correlated by the stable durable `requestId`/submission
 *   identity, never by matching duplicate text.
 */

import type {
  BridgeDelta,
  DeliveryMethod,
  ItemShape,
  TokenUsage,
  TurnStatus,
} from "@opencraft/agent-bridge-protocol";
import type { PiProjectedSnapshot, PiSubmissionState } from "./types.js";

type Value = Record<string, any>;

const TERMINAL_TURN: Readonly<Record<string, TurnStatus>> = {
  completed: "completed",
  failed: "failed",
  interrupted: "interrupted",
};

const TOOL_STATUS: Readonly<Record<string, "inProgress" | "completed" | "failed">> = {
  inProgress: "inProgress",
  completed: "completed",
  failed: "failed",
};

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part: Value) => part && part.type === "text" && typeof part.text === "string")
    .map((part: Value) => part.text as string)
    .join("\n");
}

function textChannel(type: string): "agentMessage" | "reasoning" | "plan" | null {
  if (type === "agentMessage") return "agentMessage";
  if (type === "reasoning") return "reasoning";
  if (type === "plan") return "plan";
  return null;
}

function itemText(item: Value): string {
  if (item.type === "agentMessage" || item.type === "plan") return typeof item.text === "string" ? item.text : "";
  if (item.type === "reasoning") {
    if (!Array.isArray(item.content)) return "";
    return item.content.filter((part: unknown): part is string => typeof part === "string").join("\n");
  }
  return "";
}

function toolOutput(item: Value): string | null {
  if (item.type === "commandExecution") return typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : null;
  if (Array.isArray(item.contentItems)) return textOfContent(item.contentItems);
  return null;
}

function itemShape(item: Value): ItemShape | null {
  if (item.type === "userMessage") {
    return {
      kind: "userMessage",
      text: textOfContent(item.content),
      clientId: typeof item.clientId === "string" ? item.clientId : null,
    };
  }
  const channel = textChannel(String(item.type));
  if (channel !== null) {
    return { kind: channel, text: itemText(item) };
  }
  if (item.type === "dynamicToolCall") {
    return {
      kind: "tool",
      name: String(item.tool ?? "tool"),
      status: TOOL_STATUS[String(item.status)] ?? "failed",
      output: toolOutput(item),
    };
  }
  if (item.type === "commandExecution") {
    return {
      kind: "command",
      command: String(item.command ?? ""),
      cwd: String(item.cwd ?? ""),
      status: TOOL_STATUS[String(item.status)] ?? "failed",
      output: toolOutput(item),
    };
  }
  return null;
}

type TextShape = Extract<ItemShape, { kind: "agentMessage" | "reasoning" | "plan" }>;

function isTextShape(shape: ItemShape): shape is TextShape {
  return shape.kind === "agentMessage" || shape.kind === "reasoning" || shape.kind === "plan";
}

function terminalShape(shape: ItemShape): ItemShape {
  if (shape.kind === "tool" || shape.kind === "command") {
    return { ...shape, status: shape.status === "inProgress" ? "failed" : shape.status } as ItemShape;
  }
  return shape;
}

interface StreamState {
  readonly channel: "agentMessage" | "reasoning" | "plan";
  text: string;
}

interface TrackedTurn {
  readonly id: string;
  open: boolean;
  status: string;
  readonly items: Map<string, { shape: ItemShape; terminal: boolean }>;
  readonly streams: Map<string, StreamState>;
}

interface TrackedInput {
  readonly inputId: string;
  readonly clientRequestId: string;
  readonly expectedTurnId: string;
  readonly text: string;
  version: number;
  admitted: boolean;
  terminal: boolean;
  outcome: "unknown" | "rejected" | "failed" | null;
  outcomeReason?: string;
  failureKind?: string;
  admissionEvidence: boolean;
  queueEvidence: boolean;
}

export interface SteerRegistration {
  readonly inputId: string;
  readonly clientRequestId: string;
  readonly expectedTurnId: string;
  readonly text: string;
}

export interface MapperOptions {
  readonly threadId: string;
  readonly nativeSessionId: string;
  readonly now?: () => number;
}

/**
 * A bridge-owned mapping of one Pi owner's snapshots. Not persisted: after a
 * restart the Host's assembler checkpoint remains authoritative, and a
 * `session/resume` reconstructs current state from native snapshots rather
 * than replaying old deltas.
 */
export class PiDeltaMapper {
  private readonly threadId: string;
  private readonly nativeSessionId: string;
  private readonly now: () => number;
  private readonly turns = new Map<string, TrackedTurn>();
  private readonly inputs = new Map<string, TrackedInput>();
  private usage?: { total: TokenUsage; last: TokenUsage; modelContextWindow: number | null };
  private lastUsageKey = "";

  constructor(options: MapperOptions) {
    this.threadId = options.threadId;
    this.nativeSessionId = options.nativeSessionId;
    this.now = options.now ?? (() => Date.now());
  }

  private scope(): { threadId: string } {
    return { threadId: this.threadId };
  }

  private turnStatus(status: string): TurnStatus {
    return TERMINAL_TURN[status] ?? "interrupted";
  }

  /**
   * Mark the current native snapshot as already represented. A resumed
   * bridge cannot know the Host's checkpoint watermark, so it deliberately
   * emits no historical turn/item deltas. The Host hydrates history from its
   * own projection or `history/read`; only later native changes are streamed.
   */
  seed(snapshot: PiProjectedSnapshot): void {
    for (const turn of snapshot.turns) {
      const id = String(turn.id);
      const status = String(turn.status);
      const tracked: TrackedTurn = {
        id,
        open: status === "inProgress",
        status,
        items: new Map(),
        streams: new Map(),
      };
      for (const item of turn.items as readonly Value[]) {
        const key = String(item.id ?? "");
        if (!key) continue;
        const shape = itemShape(item);
        if (shape === null) continue;
        if (shape.kind === "userMessage") {
          tracked.items.set(key, { shape, terminal: true });
        } else if (isTextShape(shape)) {
          tracked.items.set(key, { shape, terminal: false });
          tracked.streams.set(key, { channel: shape.kind, text: shape.text });
        } else {
          tracked.items.set(key, { shape, terminal: shape.status !== "inProgress" });
        }
      }
      this.turns.set(id, tracked);
    }
    if (snapshot.usage) this.lastUsageKey = JSON.stringify([snapshot.usage.total, snapshot.usage.last]);
  }

  hasInput(inputId: string): boolean {
    return this.inputs.has(inputId);
  }

  input(inputId: string): TrackedInput | undefined {
    return this.inputs.get(inputId);
  }

  /**
   * Register a steer locally before its native write settles. The caller emits
   * acceptance or rejection deltas only after the native outcome is known.
   * Reusing the same id with different content is a hard conflict.
   */
  registerSteer(registration: SteerRegistration): { duplicate: boolean; conflict: boolean } {
    const existing = this.inputs.get(registration.inputId);
    if (existing) {
      const conflict = existing.clientRequestId !== registration.clientRequestId
        || existing.expectedTurnId !== registration.expectedTurnId
        || existing.text !== registration.text;
      return { duplicate: !conflict, conflict };
    }
    this.inputs.set(registration.inputId, {
      inputId: registration.inputId,
      clientRequestId: registration.clientRequestId,
      expectedTurnId: registration.expectedTurnId,
      text: registration.text,
      version: 0,
      admitted: false,
      terminal: false,
      outcome: null,
      admissionEvidence: false,
      queueEvidence: false,
    });
    return { duplicate: false, conflict: false };
  }

  /** Register an input that was admitted natively (used after `submit`/`steer`). */
  acceptedDeltas(registration: SteerRegistration, admitted: boolean, deliveryMethod: DeliveryMethod = "native-inject"): BridgeDelta[] {
    const tracked = this.inputs.get(registration.inputId);
    if (!tracked) throw new Error("Steer registration is missing");
    tracked.admitted = admitted;
    const scope = this.scope();
    const deltas: BridgeDelta[] = [
      {
        op: "input.accepted",
        inputId: registration.inputId,
        clientRequestId: registration.clientRequestId,
        expectedTurnId: registration.expectedTurnId,
        targetNativeSession: this.nativeSessionId,
        allowedPaths: [deliveryMethod],
        fallbackPolicy: "reject-unknown",
        scope,
      },
      {
        op: "input.delivery",
        inputId: registration.inputId,
        deliveryMethod,
        admitted,
        version: ++tracked.version,
        scope,
      },
    ];
    if (!admitted) {
      tracked.terminal = true;
      tracked.outcome = "rejected";
    }
    return deltas;
  }

  evidenceDeltas(inputId: string, kind: "admission" | "queue-change", evidenceRef: string): BridgeDelta[] {
    const tracked = this.inputs.get(inputId);
    // Evidence may resolve an `unknown` outcome, but never overrides a known
    // rejection/failure or a settled input.
    if (!tracked || tracked.outcome === "rejected" || tracked.outcome === "failed") return [];
    if (kind === "admission" && tracked.admissionEvidence) return [];
    if (kind === "queue-change" && tracked.queueEvidence) return [];
    if (kind === "admission") tracked.admissionEvidence = true;
    if (kind === "queue-change") tracked.queueEvidence = true;
    // Native evidence reconciles an earlier ambiguous outcome.
    if (tracked.outcome === "unknown") tracked.outcome = null;
    return [{
      op: "input.evidence",
      inputId,
      evidenceKind: kind,
      evidenceRef,
      nativeInputId: evidenceRef,
      version: ++tracked.version,
      scope: this.scope(),
    } as BridgeDelta];
  }

  /** Record a rejection that has no wire delta (for example a stale target). */
  noteFailure(inputId: string, state: "unknown" | "rejected" | "failed", reason: string, failureKind?: string): void {
    const tracked = this.inputs.get(inputId);
    if (!tracked) return;
    tracked.terminal = state !== "unknown";
    tracked.outcome = state;
    tracked.outcomeReason = reason;
    if (failureKind !== undefined) tracked.failureKind = failureKind;
  }

  outcomeDeltas(inputId: string, state: "unknown" | "rejected" | "failed", reason: string, failureKind?: string): BridgeDelta[] {
    const tracked = this.inputs.get(inputId);
    if (!tracked || tracked.terminal) return [];
    tracked.outcome = state;
    tracked.outcomeReason = reason;
    if (failureKind !== undefined) tracked.failureKind = failureKind;
    // `unknown` stays open to later native evidence; a known failure/rejection
    // is terminal and must not be relabelled by a late observation.
    tracked.terminal = state !== "unknown";
    return [{
      op: "input.outcome",
      inputId,
      state,
      reason,
      version: ++tracked.version,
      scope: this.scope(),
    }];
  }

  sessionEnded(reason?: string): BridgeDelta[] {
    for (const turn of this.turns.values()) turn.open = false;
    return [{ op: "session.ended", ...(reason === undefined ? {} : { reason }), scope: this.scope() }];
  }

  /** Convert one committed native snapshot into deltas in canonical order. */
  diff(snapshot: PiProjectedSnapshot): BridgeDelta[] {
    const deltas: BridgeDelta[] = [];
    const seen = new Set<string>();
    for (const turn of snapshot.turns) {
      const id = String(turn.id);
      seen.add(id);
      let tracked = this.turns.get(id);
      const status = String(turn.status);
      if (!tracked) {
        tracked = { id, open: true, status, items: new Map(), streams: new Map() };
        this.turns.set(id, tracked);
        deltas.push({ op: "turn.open", nativeTurnId: id, scope: this.scope() });
      } else if (!tracked.open) {
        // A closed turn is immutable in the canonical timeline; late native
        // changes are diagnostics, not a second turn.
        continue;
      }
      tracked.status = status;
      for (const item of turn.items as readonly Value[]) {
        const key = String(item.id ?? "");
        if (!key) continue;
        const shape = itemShape(item);
        if (shape === null) continue;
        const previous = tracked.items.get(key);
        if (shape.kind === "userMessage") {
          if (previous) continue;
          tracked.items.set(key, { shape, terminal: true });
          deltas.push({ op: "item.open", nativeKey: key, shape, scope: this.scope() });
          deltas.push({ op: "item.close", nativeKey: key, shape, scope: this.scope() });
          continue;
        }
        if (isTextShape(shape)) {
          const channel = shape.kind;
          const text = shape.text;
          const stream = tracked.streams.get(key);
          if (!stream) {
            tracked.items.set(key, { shape, terminal: false });
            tracked.streams.set(key, { channel, text: "" });
            deltas.push({ op: "item.open", nativeKey: key, shape: { kind: channel, text: "" } as ItemShape, scope: this.scope() });
            if (text) {
              tracked.streams.set(key, { channel, text });
              deltas.push({ op: "item.textDelta", nativeKey: key, channel, text, scope: this.scope() });
            }
          } else if (text.startsWith(stream.text)) {
            const suffix = text.slice(stream.text.length);
            if (suffix) {
              stream.text = text;
              deltas.push({ op: "item.textDelta", nativeKey: key, channel, text: suffix, scope: this.scope() });
            }
          } else if (text !== stream.text) {
            // The committed native message replaced a partial that is not a
            // prefix. Close with the provider-final text; never stitch a
            // non-monotonic stream into an invented delta.
            stream.text = text;
            deltas.push({ op: "item.textClose", nativeKey: key, channel, text, scope: this.scope() });
            tracked.items.set(key, { shape, terminal: true });
            tracked.streams.delete(key);
          }
          continue;
        }
        // Tool / command items.
        if (!previous) {
          tracked.items.set(key, { shape, terminal: shape.status !== "inProgress" });
          deltas.push({ op: "item.open", nativeKey: key, shape, scope: this.scope() });
          if (shape.status !== "inProgress") {
            deltas.push({ op: "item.close", nativeKey: key, shape, scope: this.scope() });
          }
        } else if (!previous.terminal && !sameShape(previous.shape, shape)) {
          if (shape.status === "inProgress") {
            deltas.push({ op: "item.progress", nativeKey: key, note: shape.output ?? undefined, scope: this.scope() });
            previous.shape = shape;
          } else {
            previous.shape = shape;
            previous.terminal = true;
            deltas.push({ op: "item.close", nativeKey: key, shape, scope: this.scope() });
          }
        }
      }
      const closing = status !== "inProgress";
      // Placed steers are evidence-observed while the turn is still active;
      // queued steers only become a terminal failure at the turn boundary.
      deltas.push(...this.settleInputsForTurn(id, snapshot, closing));
      if (closing) {
        for (const [key, item] of tracked.items) {
          if (item.terminal) continue;
          if (tracked.streams.has(key)) {
            const stream = tracked.streams.get(key)!;
            deltas.push({
              op: "item.textClose",
              nativeKey: key,
              channel: stream.channel,
              text: stream.text,
              scope: this.scope(),
            });
          } else {
            deltas.push({ op: "item.close", nativeKey: key, shape: terminalShape(item.shape), scope: this.scope() });
          }
          item.terminal = true;
        }
        tracked.streams.clear();
        deltas.push({ op: "turn.close", nativeTurnId: id, status: this.turnStatus(status), scope: this.scope() });
        tracked.open = false;
      }
    }
    // A tracked steer whose target turn is no longer in the projection (for
    // example an aborted turn) still gets a terminal fact.
    for (const input of this.inputs.values()) {
      if (input.terminal || seen.has(input.expectedTurnId)) continue;
      const submission = snapshot.submissions.get(input.inputId);
      if (submission?.status === "unanswered") {
        deltas.push(...this.settleUnanswered(input, submission));
      }
    }
    if (snapshot.usage) {
      const key = JSON.stringify([snapshot.usage.total, snapshot.usage.last]);
      if (key !== this.lastUsageKey && snapshot.activeTurnId !== null) {
        this.lastUsageKey = key;
        deltas.push({
          op: "usage",
          total: snapshot.usage.total,
          last: snapshot.usage.last,
          modelContextWindow: snapshot.usage.modelContextWindow,
          scope: this.scope(),
        });
      }
      this.usage = snapshot.usage;
    }
    return deltas;
  }

  private settleInputsForTurn(turnId: string, snapshot: PiProjectedSnapshot, closing: boolean): BridgeDelta[] {
    const deltas: BridgeDelta[] = [];
    for (const input of this.inputs.values()) {
      if (input.terminal || input.expectedTurnId !== turnId) continue;
      const submission = snapshot.submissions.get(input.inputId);
      if (!submission) continue;
      if (submission.status === "placed" || submission.status === "done") {
        deltas.push(...this.evidenceDeltas(input.inputId, "admission", `pi-submission:${input.inputId}`));
        deltas.push(...this.evidenceDeltas(input.inputId, "queue-change", `pi-entry:${submission.entry ?? "placed"}`));
        if (submission.status === "done" || closing) input.terminal = true;
        continue;
      }
      if (submission.status === "unanswered") {
        deltas.push(...this.settleUnanswered(input, submission));
        continue;
      }
      if (closing) {
        // Still queued at the turn boundary: Pi does not place steers at the
        // final boundary. The durable owner settles this input unanswered in
        // the same snapshot; report the known failure instead of success.
        deltas.push(...this.outcomeDeltas(input.inputId, "failed", "Pi turn ended before steer was consumed"));
      }
    }
    return deltas;
  }

  private settleUnanswered(input: TrackedInput, submission: PiSubmissionState): BridgeDelta[] {
    const reason = submission.reason === "aborted"
      ? "Pi turn ended before steer was consumed"
      : String(submission.reason ?? "Pi input was not answered");
    return this.outcomeDeltas(input.inputId, "failed", reason);
  }

  /** Current evidence summary for `input/query`; never upgrades to context. */
  query(inputId: string): {
    readonly inputId: string;
    readonly state: "registered" | "admitted" | "evidence-observed" | "failed" | "unknown";
    readonly evidenceKind: "admission" | "queue-change" | null;
    readonly version: number;
    readonly reason?: string;
    readonly failureKind?: string;
  } | null {
    const tracked = this.inputs.get(inputId);
    if (!tracked) return null;
    const state = tracked.outcome === "failed" || tracked.outcome === "rejected"
      ? "failed"
      : tracked.outcome === "unknown" ? "unknown"
        : tracked.queueEvidence ? "evidence-observed"
          : tracked.admitted ? "admitted"
            : "registered";
    return {
      inputId,
      state,
      evidenceKind: tracked.queueEvidence ? "queue-change" : tracked.admissionEvidence ? "admission" : null,
      version: tracked.version,
      ...(tracked.outcomeReason === undefined ? {} : { reason: tracked.outcomeReason }),
      ...(tracked.failureKind === undefined ? {} : { failureKind: tracked.failureKind }),
    };
  }
}

function sameShape(left: ItemShape, right: ItemShape): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
