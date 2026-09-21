import type { AppServerThreadItem, AppServerTurn } from "./types";
import { toolOutcome } from "./tool-outcome";
import { resolveToolIdentity } from "./tool-identity";
import { isHermesToolItem, projectHermesTool } from "./tool-semantics";
import { hermesFailureMessage, resolveHermesTerminalCompletion } from "./terminal-completion";

export interface HermesProjectionNotification {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

type TurnPhase = "accepted" | "thinking" | "reasoning" | "tool" | "composing" | "completed";

const PRE_TURN_LIVE_SETTLE_GRACE_MS = 15_000;

interface DeferredIdleSettlement {
  readonly payload: Record<string, unknown>;
  readonly settleAtMs: number;
}

interface TextItemState {
  readonly id: string;
  text: string;
  started: boolean;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.flatMap((part) => {
    if (typeof part === "string") return [part];
    const object = record(part);
    return typeof object.text === "string" ? [object.text] : [];
  }).join("\n");
}

function eventText(payload: Record<string, unknown>): string {
  return text(payload.text ?? payload.reasoning ?? payload.content ?? payload.message);
}

// `session.info` is a liveness settlement rather than a message completion;
// it has no assistant-text fallback or Desktop legacy-error heuristic.
function statusFor(payload: Record<string, unknown>): AppServerTurn["status"] {
  if (payload.status === "interrupted" || payload.status === "cancelled" || payload.status === "canceled") return "interrupted";
  if (payload.status === "error" || payload.status === "failed" || payload.error !== undefined) return "failed";
  return "completed";
}

/**
 * Owns the semantic projection of one live Hermes Turn.
 *
 * Hermes emits transport events; AppServer exposes a durable Turn/Item model.
 * Keeping that translation here makes event ordering, replay idempotency and
 * segment ownership explicit instead of spreading them across UI code.
 */
export class HermesTurnEventStateMachine {
  private phase: TurnPhase = "accepted";
  private turnStarted = false;
  private turnLive = false;
  private acceptedAtMs: number | null = null;
  private completed = false;
  private deferredIdleSettlement: DeferredIdleSettlement | null = null;
  private segmentSequence = 0;
  private reasoningSequence = 0;
  private assistant: TextItemState | null = null;
  /**
   * The last `message.interim` Item is still the completion target until a
   * real semantic boundary (reasoning or a tool call) supersedes it.
   *
   * Hermes Desktop keeps this ownership on the message itself (`interim`),
   * rather than in a volatile session flag that `message.start` can reset.
   */
  private interimAssistant: TextItemState | null = null;
  // Display completion does not revoke the last stream's reconciliation
  // identity. Only a new text/reasoning stream supersedes that identity.
  private streamedAssistant: TextItemState | null = null;
  private streamedAssistantHasToolBoundary = false;
  private reasoning: TextItemState | null = null;
  private readonly tools = new Map<string, AppServerThreadItem>();

  constructor(
    readonly threadId: string,
    readonly turn: AppServerTurn,
    private readonly createId: () => string = () => crypto.randomUUID(),
  ) {
    const lastItem = turn.items.at(-1);
    const lastAssistant = [...turn.items].reverse().find((item) => item.type === "agentMessage");
    if (lastItem?.type === "agentMessage" && lastItem.phase == null && lastItem.completed === true) {
      this.interimAssistant = { id: lastItem.id, text: typeof lastItem.text === "string" ? lastItem.text : "", started: true };
      this.streamedAssistant = this.interimAssistant;
    } else if (lastAssistant === lastItem && lastAssistant !== undefined && lastAssistant.phase == null && lastAssistant.completed === false) {
      this.assistant = {
        id: lastAssistant.id,
        text: typeof lastAssistant.text === "string" ? lastAssistant.text : "",
        started: true,
      };
      this.streamedAssistant = this.assistant;
    } else if (lastItem?.type === "agentMessage" && lastItem.phase === "commentary") {
      // An active replay can resume after an interim preview but before its
      // authoritative completion. Preserve that Item as the completion target.
      this.interimAssistant = {
        id: lastItem.id,
        text: typeof lastItem.text === "string" ? lastItem.text : "",
        started: true,
      };
    }
    const lastReasoning = lastItem?.type === "reasoning" && lastItem.completed === false ? lastItem : undefined;
    if (lastReasoning !== undefined) {
      this.reasoning = {
        id: lastReasoning.id,
        text: text(lastReasoning.content),
        started: true,
      };
    }
    for (const item of turn.items) {
      if (isHermesToolItem(item)) this.tools.set(typeof item.callId === "string" ? item.callId : item.id, item);
    }
  }

  get currentPhase(): TurnPhase {
    return this.phase;
  }

  get isCompleted(): boolean {
    return this.completed;
  }

  /**
   * An idle heartbeat can race prompt admission before Hermes publishes the
   * first live frame. Ignoring it forever leaks a running Turn; treating it as
   * terminal immediately makes the Turn flash completed. The adapter owns the
   * clock and schedules this explicit convergence deadline.
   */
  get deferredSettlementAtMs(): number | null {
    return this.deferredIdleSettlement?.settleAtMs ?? null;
  }

  accept(startedAtMs = Date.now()): HermesProjectionNotification[] {
    if (this.turnStarted || this.completed) return [];
    this.turnStarted = true;
    this.acceptedAtMs = startedAtMs;
    this.turn.status = "inProgress";
    if (this.turn.startedAt === null) this.turn.startedAt = Math.floor(startedAtMs / 1_000);
    return [this.notification("turn/started", { turn: structuredClone(this.turn) })];
  }

  /**
   * `session.steer` acknowledgement is projected as a UserMessage inside the
   * active Turn. The client-side steering item remains the visual owner; this
   * server Item is its identity/provenance acknowledgement.
   */
  acceptSteeringUserMessage(
    input: readonly unknown[],
    clientUserMessageId: string | null,
    occurredAtMs = Date.now(),
  ): HermesProjectionNotification[] {
    if (this.completed) return [];
    const existing = this.turn.items.find((item) => (
      item.type === "userMessage"
      && clientUserMessageId !== null
      && item.clientId === clientUserMessageId
    ));
    if (existing !== undefined) return [];
    const item: AppServerThreadItem = {
      type: "userMessage",
      id: `hermes-steer-${this.turn.id}-${clientUserMessageId ?? this.createId()}`,
      clientId: clientUserMessageId,
      content: structuredClone(input),
      completed: true,
    };
    this.upsertItem(item);
    return [this.notification("item/completed", {
      turnId: this.turn.id,
      item: structuredClone(item),
      completedAtMs: occurredAtMs,
    })];
  }

  project(event: Record<string, unknown>, occurredAtMs = Date.now()): HermesProjectionNotification[] {
    if (this.completed) return [];
    const type = typeof event.type === "string" ? event.type : "";
    const payload = record(event.payload);
    const output = this.accept(occurredAtMs);

    if (
      type === "message.start"
      || type === "message.delta"
      || type === "message.interim"
      || type === "message.complete"
      || type === "reasoning.delta"
      || type === "reasoning.available"
      || type === "tool.start"
      || type === "tool.progress"
      || type === "tool.complete"
      || (type === "session.info" && payload.running === true)
    ) {
      this.turnLive = true;
      this.deferredIdleSettlement = null;
    }

    switch (type) {
      case "message.start":
        this.phase = "thinking";
        break;
      case "thinking.delta":
        // These frames commonly contain spinner/status copy. The active Turn is
        // enough for the renderer to show Thinking; do not fabricate reasoning.
        this.phase = "thinking";
        break;
      case "reasoning.delta":
        this.streamedAssistant = null;
        this.classifyInterimAsCommentary(output);
        this.completeAssistant(output, "commentary");
        this.phase = "reasoning";
        this.appendReasoning(eventText(payload), output, occurredAtMs);
        break;
      case "reasoning.available":
        // Hermes emits this as a fallback preview of assistant_message.content,
        // not a reasoning delta. Match Desktop's replace-preview guard: once
        // this stream owns body text, the preview cannot seal it or discard its
        // identity before message.interim(already_streamed) reconciles it.
        if (!eventText(payload) || this.assistant?.text.trim()) break;
        this.streamedAssistant = null;
        this.classifyInterimAsCommentary(output);
        this.completeAssistant(output, "commentary");
        this.phase = "reasoning";
        this.reconcileReasoning(eventText(payload), output, occurredAtMs);
        break;
      case "message.delta":
        if (this.assistant === null) this.classifyInterimAsCommentary(output);
        this.completeReasoning(output);
        this.phase = "composing";
        this.appendAssistant(eventText(payload), output, occurredAtMs);
        break;
      case "message.interim":
        if (eventText(payload) === "") break;
        this.completeReasoning(output);
        this.phase = "composing";
        if (payload.already_streamed === true && (this.assistant ?? this.streamedAssistant) !== null) {
          // The source explicitly identifies this as the streamed segment's
          // authoritative snapshot, including non-prefix corrections.
          this.assistant = { ...(this.assistant ?? this.streamedAssistant)!, text: eventText(payload) };
          this.streamedAssistant = this.assistant;
        } else if (this.assistant === null) {
          // An unstreamed segment after a tool owns its own completion target.
          this.streamedAssistant = null;
          this.streamedAssistantHasToolBoundary = false;
        }
        this.reconcileAssistant(eventText(payload), output, occurredAtMs);
        // Sealing a transport segment does not classify it as tool commentary:
        // Hermes also seals final previews before verification completes.
        this.completeAssistant(output, this.streamedAssistantHasToolBoundary ? "commentary" : null, !this.streamedAssistantHasToolBoundary);
        this.phase = "thinking";
        break;
      case "tool.start":
        this.streamedAssistantHasToolBoundary = true;
        this.classifyInterimAsCommentary(output);
        this.completeReasoning(output);
        this.completeAssistant(output, "commentary");
        this.phase = "tool";
        this.startTool(payload, output, occurredAtMs);
        break;
      case "tool.generating":
        // Hermes announces only a tool name while its argument JSON is still
        // being drafted. There is no stable Item identity yet.
        this.phase = "tool";
        break;
      case "tool.progress":
        this.streamedAssistantHasToolBoundary = true;
        this.classifyInterimAsCommentary(output);
        this.completeReasoning(output);
        this.completeAssistant(output, "commentary");
        this.phase = "tool";
        this.progressTool(payload, output, occurredAtMs);
        break;
      case "tool.complete":
        this.streamedAssistantHasToolBoundary = true;
        this.classifyInterimAsCommentary(output);
        this.completeReasoning(output);
        this.completeAssistant(output, "commentary");
        this.phase = "tool";
        this.completeTool(payload, output, occurredAtMs);
        if (![...this.tools.values()].some((item) => item.status === "inProgress")) this.phase = "thinking";
        break;
      case "message.complete":
        this.completeReasoning(output);
        {
          const authoritative = eventText(payload);
          const completion = resolveHermesTerminalCompletion(payload, authoritative);
          if (completion.status === "failed") {
            this.completeFailedAssistant(authoritative, completion.keepFailedAssistantText, output, occurredAtMs);
          } else {
            this.completeFinalAssistant(authoritative, output, occurredAtMs);
            this.suppressTransientTextCoveredByFinal(output);
          }
          this.finish(completion.status, payload, output, occurredAtMs, completion.errorMessage);
        }
        break;
      case "session.info":
        if (payload.running === true) {
          this.phase = "thinking";
        } else if (payload.running === false && this.maySettleFromSessionInfo(occurredAtMs)) {
          this.settleFromSessionInfo(payload, output, occurredAtMs);
        } else if (payload.running === false && this.acceptedAtMs !== null) {
          this.deferredIdleSettlement = {
            payload: structuredClone(payload),
            settleAtMs: this.acceptedAtMs + PRE_TURN_LIVE_SETTLE_GRACE_MS,
          };
        }
        break;
      case "error":
        this.completeReasoning(output);
        this.completeAssistant(output, null);
        this.finish("failed", payload, output, occurredAtMs, hermesFailureMessage(payload));
        break;
      default:
        break;
    }
    return output;
  }

  settleDeferredSessionInfo(occurredAtMs = Date.now()): HermesProjectionNotification[] {
    const pending = this.deferredIdleSettlement;
    if (pending === null || this.completed || this.turnLive || occurredAtMs < pending.settleAtMs) return [];
    this.deferredIdleSettlement = null;
    const output: HermesProjectionNotification[] = [];
    this.settleFromSessionInfo(pending.payload, output, occurredAtMs);
    return output;
  }

  private settleFromSessionInfo(
    payload: Record<string, unknown>,
    output: HermesProjectionNotification[],
    occurredAtMs: number,
  ): void {
    this.completeReasoning(output);
    this.completeFinalAssistant("", output, occurredAtMs);
    this.finish(statusFor(payload), payload, output, occurredAtMs);
  }

  private notification(method: string, params: Record<string, unknown>): HermesProjectionNotification {
    return { method, params: { threadId: this.threadId, ...params } };
  }

  private upsertItem(item: AppServerThreadItem): void {
    const index = this.turn.items.findIndex(({ id }) => id === item.id);
    if (index < 0) this.turn.items.push(item);
    else this.turn.items[index] = item;
  }

  private newAssistant(): TextItemState {
    this.segmentSequence += 1;
    return { id: `hermes-agent-${this.turn.id}-${this.segmentSequence}-${this.createId()}`, text: "", started: false };
  }

  private ensureAssistant(output: HermesProjectionNotification[], occurredAtMs: number): TextItemState {
    const state = this.assistant ?? (this.assistant = this.newAssistant());
    if (!state.started) {
      state.started = true;
      const item = { type: "agentMessage", id: state.id, text: state.text, phase: null, memoryCitation: null };
      this.upsertItem(item);
      output.push(this.notification("item/started", { turnId: this.turn.id, item, startedAtMs: occurredAtMs }));
    }
    return state;
  }

  private appendAssistant(delta: string, output: HermesProjectionNotification[], occurredAtMs: number): void {
    if (delta === "") return;
    if (this.assistant === null) this.streamedAssistantHasToolBoundary = false;
    const state = this.ensureAssistant(output, occurredAtMs);
    state.text += delta;
    this.streamedAssistant = state;
    this.upsertItem({ type: "agentMessage", id: state.id, text: state.text, phase: null, completed: false, memoryCitation: null });
    output.push(this.notification("item/agentMessage/delta", { turnId: this.turn.id, itemId: state.id, delta }));
  }

  private reconcileAssistant(authoritative: string, output: HermesProjectionNotification[], occurredAtMs: number): void {
    if (authoritative === "") return;
    const state = this.ensureAssistant(output, occurredAtMs);
    if (authoritative === state.text) return;
    if (authoritative.startsWith(state.text)) {
      this.appendAssistant(authoritative.slice(state.text.length), output, occurredAtMs);
      return;
    }
    // A non-prefix authoritative payload belongs to a new final segment; do
    // not corrupt an already-rendered commentary segment with replacement text.
    this.completeAssistant(output, "commentary");
    this.appendAssistant(authoritative, output, occurredAtMs);
  }

  private completeAssistant(
    output: HermesProjectionNotification[],
    phase: "commentary" | "final_answer" | null,
    retainsInterimOwnership = false,
  ): void {
    const state = this.assistant;
    if (state === null || !state.started) {
      this.assistant = null;
      return;
    }
    const item = { type: "agentMessage", id: state.id, text: state.text, phase, completed: true, memoryCitation: null };
    this.upsertItem(item);
    output.push(this.notification("item/completed", { turnId: this.turn.id, item }));
    this.interimAssistant = retainsInterimOwnership
      ? { ...state }
      : null;
    this.assistant = null;
  }

  private classifyInterimAsCommentary(output: HermesProjectionNotification[]): void {
    if (this.interimAssistant !== null) {
      const item = { type: "agentMessage", id: this.interimAssistant.id, text: this.interimAssistant.text, phase: "commentary", completed: true, memoryCitation: null };
      this.upsertItem(item);
      output.push(this.notification("item/completed", { turnId: this.turn.id, item }));
    }
    this.interimAssistant = null;
  }

  /**
   * Hermes `message.complete` is authoritative state, not another message.
   * When an interim preview exists, complete that same stable Item and promote
   * it from an unclassified sealed preview to final—even across an intervening
   * `message.start`. Actual work boundaries separately classify commentary.
   */
  private completeFinalAssistant(
    authoritative: string,
    output: HermesProjectionNotification[],
    occurredAtMs: number,
  ): void {
    if (this.assistant !== null) {
      this.reconcileAssistant(authoritative, output, occurredAtMs);
      this.completeAssistant(output, "final_answer");
      return;
    }
    const interim = this.interimAssistant;
    if (interim !== null) {
      this.interimAssistant = null;
      if (authoritative !== "") interim.text = authoritative;
      const item = {
        type: "agentMessage",
        id: interim.id,
        text: interim.text,
        phase: "final_answer",
        memoryCitation: null,
      };
      this.upsertItem(item);
      output.push(this.notification("item/completed", { turnId: this.turn.id, item }));
      return;
    }
    this.reconcileAssistant(authoritative, output, occurredAtMs);
    this.completeAssistant(output, "final_answer");
  }

  /**
   * Hermes Desktop removes text parts from a non-partial failed completion.
   * A separate `error` event is different: any preceding stream is partial by
   * construction and is retained by that event's existing path.
   */
  private completeFailedAssistant(
    authoritative: string,
    keepText: boolean,
    output: HermesProjectionNotification[],
    occurredAtMs: number,
  ): void {
    if (keepText) {
      if (this.assistant !== null) {
        this.reconcileAssistant(authoritative, output, occurredAtMs);
        this.completeAssistant(output, null);
        return;
      }
      if (this.interimAssistant !== null) {
        const interim = this.interimAssistant;
        this.interimAssistant = null;
        if (authoritative !== "") interim.text = authoritative;
        const item = {
          type: "agentMessage",
          id: interim.id,
          text: interim.text,
          phase: null,
          completed: true,
          memoryCitation: null,
        };
        this.upsertItem(item);
        output.push(this.notification("item/completed", { turnId: this.turn.id, item }));
        return;
      }
      this.reconcileAssistant(authoritative, output, occurredAtMs);
      this.completeAssistant(output, null);
      return;
    }

    const discardedIds = new Set<string>();
    if (this.assistant?.started) discardedIds.add(this.assistant.id);
    if (this.interimAssistant?.started) discardedIds.add(this.interimAssistant.id);
    for (const id of discardedIds) {
      const item = this.turn.items.find((candidate) => candidate.id === id);
      if (item !== undefined) {
        // Clear the incremental replica before the terminal Turn snapshot
        // removes the Item from authoritative membership.
        output.push(this.notification("item/completed", {
          turnId: this.turn.id,
          item: { ...item, text: "", phase: null, completed: true },
        }));
      }
    }
    if (discardedIds.size > 0) {
      this.turn.items = this.turn.items.filter((item) => !discardedIds.has(item.id));
    }
    if (this.streamedAssistant !== null && discardedIds.has(this.streamedAssistant.id)) {
      this.streamedAssistant = null;
    }
    this.assistant = null;
    this.interimAssistant = null;
  }

  /**
   * Hermes can preview one response through either `message.interim` or the
   * reasoning channel before publishing its authoritative completion. Text
   * continuity (same text, or a prefix in either direction) means these are
   * two protocol phases of one visible message, not two transcript owners.
   * Distinct pre-tool narration and distinct reasoning remain independent.
   *
   * This mirrors Hermes Desktop's `finalContinuesInterim` rule. The cleared
   * completion is a live tombstone for incremental replicas; the following
   * full `turn/completed` snapshot owns the final Item membership.
   */
  private suppressTransientTextCoveredByFinal(output: HermesProjectionNotification[]): void {
    const final = this.turn.items.findLast((item) => (
      item.type === "agentMessage" && item.phase === "final_answer" && typeof item.text === "string" && item.text.trim() !== ""
    ));
    if (final === undefined || typeof final.text !== "string") return;
    const finalText = final.text.replace(/\s+/gu, " ").trim();
    // Legacy snapshots without segment IDs may reconcile only within the
    // current tool-free segment. Equal text before a tool is independent work.
    const boundary = this.turn.items.findLastIndex(isHermesToolItem);
    const lastInterim = this.turn.items.slice(boundary + 1).findLast((item) => (
      item.type === "agentMessage" && item.phase === "commentary"
        && typeof item.text === "string" && item.text.trim() !== ""
    ));
    const retained: AppServerThreadItem[] = [];
    for (const item of this.turn.items) {
      if (item.id === lastInterim?.id && typeof item.text === "string") {
        const commentary = item.text.replace(/\s+/gu, " ").trim();
        if (finalText.startsWith(commentary) || commentary.startsWith(finalText)) {
          output.push(this.notification("item/completed", { turnId: this.turn.id, item: { ...item, text: "" } }));
          continue;
        }
      }
      if (item.type !== "reasoning" || !Array.isArray(item.content)) {
        retained.push(item);
        continue;
      }
      const reasoning = item.content
        .filter((value): value is string => typeof value === "string")
        .join("\n")
        .replace(/\s+/gu, " ")
        .trim();
      if (reasoning === "" || !finalText.startsWith(reasoning)) {
        retained.push(item);
        continue;
      }
      // Clear the live replica first; the immediately following terminal Turn
      // snapshot then removes the redundant Item from durable presentation.
      output.push(this.notification("item/completed", {
        turnId: this.turn.id,
        item: { ...item, summary: [], content: [] },
      }));
    }
    this.turn.items = retained;
  }

  private ensureReasoning(output: HermesProjectionNotification[], occurredAtMs: number): TextItemState {
    if (this.reasoning === null) {
      this.reasoningSequence += 1;
      this.reasoning = {
        id: `hermes-reasoning-${this.turn.id}-${this.reasoningSequence}-${this.createId()}`,
        text: "",
        started: false,
      };
    }
    if (!this.reasoning.started) {
      this.reasoning.started = true;
      const item = { type: "reasoning", id: this.reasoning.id, summary: [], content: [] };
      this.upsertItem(item);
      output.push(this.notification("item/started", { turnId: this.turn.id, item, startedAtMs: occurredAtMs }));
    }
    return this.reasoning;
  }

  private appendReasoning(delta: string, output: HermesProjectionNotification[], occurredAtMs: number): void {
    if (delta === "") return;
    const state = this.ensureReasoning(output, occurredAtMs);
    state.text += delta;
    this.upsertItem({ type: "reasoning", id: state.id, summary: [], content: [state.text], completed: false });
    output.push(this.notification("item/reasoning/textDelta", {
      turnId: this.turn.id,
      itemId: state.id,
      contentIndex: 0,
      delta,
    }));
  }

  private reconcileReasoning(authoritative: string, output: HermesProjectionNotification[], occurredAtMs: number): void {
    if (authoritative === "") return;
    const state = this.ensureReasoning(output, occurredAtMs);
    if (authoritative === state.text) return;
    if (authoritative.startsWith(state.text)) {
      this.appendReasoning(authoritative.slice(state.text.length), output, occurredAtMs);
      return;
    }
    this.completeReasoning(output);
    this.appendReasoning(authoritative, output, occurredAtMs);
  }

  private completeReasoning(output: HermesProjectionNotification[]): void {
    const state = this.reasoning;
    if (state === null || !state.started) {
      this.reasoning = null;
      return;
    }
    const item = { type: "reasoning", id: state.id, summary: [], content: state.text === "" ? [] : [state.text], completed: true };
    this.upsertItem(item);
    output.push(this.notification("item/completed", { turnId: this.turn.id, item }));
    this.reasoning = null;
  }

  private toolId(payload: Record<string, unknown>, phase: "start" | "update" = "update"): string {
    return resolveToolIdentity(this.tools, payload, phase, () => `hermes-tool-${this.createId()}`);
  }

  private toolItem(payload: Record<string, unknown>, id: string, status: string): AppServerThreadItem {
    const previous = this.tools.get(id);
    const failed = status === "failed" || toolOutcome(payload.result) === false;
    return projectHermesTool({
      ...previous,
      type: "dynamicToolCall",
      // The source call ID correlates transport updates; the Item ID owns
      // durable presentation identity. History uses the same formula, so a
      // reconnect cannot remount the row under a different identity.
      id: previous?.id ?? `hermes-tool-${this.threadId}-${id}`,
      callId: id,
      sourceIdentitySynthetic: previous?.sourceIdentitySynthetic ?? !(typeof payload.tool_id === "string" && payload.tool_id),
      namespace: "hermes",
      tool: typeof payload.name === "string" ? payload.name : previous?.hermesToolName ?? previous?.tool ?? "tool",
      arguments: Object.hasOwn(payload, "args") ? record(payload.args) : previous?.arguments ?? {},
      toolContext: typeof payload.context === "string" ? payload.context : previous?.toolContext ?? null,
      toolSummary: typeof payload.summary === "string" ? payload.summary : previous?.toolSummary ?? null,
      inlineDiff: typeof payload.inline_diff === "string" ? payload.inline_diff : previous?.inlineDiff ?? null,
      progressText: typeof payload.message === "string" ? payload.message
        : typeof payload.preview === "string" ? payload.preview : previous?.progressText ?? null,
      structuredResult: Object.hasOwn(payload, "result") ? payload.result : previous?.structuredResult ?? null,
      status: failed ? "failed" : status,
      contentItems: payload.result === undefined
        ? previous?.contentItems ?? null
        : [{ type: "inputText", text: typeof payload.result === "string" ? payload.result : JSON.stringify(payload.result) }],
      success: status === "inProgress" ? null : toolOutcome(payload.result),
      durationMs: typeof payload.duration_s === "number" ? Math.round(payload.duration_s * 1_000) : previous?.durationMs ?? null,
    });
  }

  private startTool(payload: Record<string, unknown>, output: HermesProjectionNotification[], occurredAtMs: number): void {
    const id = this.toolId(payload, "start");
    if (this.tools.has(id)) return;
    const item = { ...this.toolItem(payload, id, "inProgress"), startedAtMs: occurredAtMs };
    this.tools.set(id, item);
    this.upsertItem(item);
    output.push(this.notification("item/started", { turnId: this.turn.id, item, startedAtMs: occurredAtMs }));
  }

  private progressTool(payload: Record<string, unknown>, output: HermesProjectionNotification[], occurredAtMs: number): void {
    const id = this.toolId(payload);
    if (!this.tools.has(id)) this.startTool({ ...payload, tool_id: id }, output, occurredAtMs);
    const previous = this.tools.get(id);
    if (previous === undefined || previous.status !== "inProgress") return;
    const item = { ...previous, ...this.toolItem(payload, id, "inProgress") };
    this.tools.set(id, item);
    this.upsertItem(item);
    output.push(this.notification("item/updated", { turnId: this.turn.id, item }));
  }

  private completeTool(payload: Record<string, unknown>, output: HermesProjectionNotification[], occurredAtMs: number): void {
    const id = this.toolId(payload);
    if (!this.tools.has(id)) this.startTool({ ...payload, tool_id: id }, output, occurredAtMs);
    if (this.tools.get(id)?.status !== "inProgress") return;
    const item = this.toolItem(payload, id, toolOutcome(payload.result) === false ? "failed" : "completed");
    this.tools.set(id, item);
    this.upsertItem(item);
    output.push(this.notification("item/completed", { turnId: this.turn.id, item }));
  }

  private maySettleFromSessionInfo(occurredAtMs: number): boolean {
    if (this.turnLive) return true;
    if (this.acceptedAtMs === null) return true;
    return occurredAtMs - this.acceptedAtMs >= PRE_TURN_LIVE_SETTLE_GRACE_MS;
  }

  private finish(
    status: AppServerTurn["status"],
    payload: Record<string, unknown>,
    output: HermesProjectionNotification[],
    occurredAtMs: number,
    errorMessage: string | null = null,
  ): void {
    if (this.completed) return;
    for (const [id, tool] of this.tools) {
      if (tool.status !== "inProgress") continue;
      const item = { ...tool, status: "completed", success: null, resultMissing: true };
      this.tools.set(id, item);
      this.upsertItem(item);
      output.push(this.notification("item/completed", { turnId: this.turn.id, item }));
    }
    const completedAt = Math.floor(occurredAtMs / 1_000);
    this.turn.status = status;
    this.turn.completedAt = completedAt;
    this.turn.durationMs = this.turn.startedAt === null ? null : Math.max(0, (completedAt - this.turn.startedAt) * 1_000);
    this.turn.error = status === "failed"
      ? {
        message: errorMessage ?? hermesFailureMessage(payload),
        ...(payload.error_surface === undefined ? {} : { errorSurface: structuredClone(payload.error_surface) }),
      }
      : null;
    this.phase = "completed";
    this.completed = true;
    output.push(this.notification("turn/completed", { turn: structuredClone(this.turn) }));
  }
}
