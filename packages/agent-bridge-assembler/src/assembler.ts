/**
 * Pure semantic delta assembler. It owns id minting, turn/item lifecycle,
 * stream accumulation, input evidence state, ordering diagnostics and terminal
 * snapshots. It performs no IO, reads no clock, and mints no ids from wall
 * time; given the same state + deltas + context it always returns the same
 * events. A bridge supplies deltas, never finished client events.
 */

import type {
  BridgeDelta,
  ItemShape,
  TextChannel,
  TurnStatus,
} from "@opencraft/agent-bridge-protocol";
import type {
  AssembleContext,
  AssembleDiagnostic,
  AssembleResult,
  AssemblerState,
  CanonicalEvent,
  CanonicalEventBody,
  CanonicalInputState,
  CanonicalItem,
  DiagnosticCode,
} from "./canonical";
import {
  applyDelivery,
  applyEvidence,
  applyOutcome,
  applyWithdrawal,
  blankInput,
  registerInput,
  withDisposition,
} from "./steer";

interface OpenTurn {
  readonly turnId: string;
  readonly nativeTurnId: string;
  readonly threadId: string;
  readonly startedAtMs: number;
}

interface StreamState {
  readonly itemId: string;
  readonly channel: TextChannel;
  readonly text: string;
  readonly turnId: string | null;
}

interface MutableState {
  schemaVersion: number;
  sessionEpoch: number;
  seq: number;
  turnSeq: number;
  itemSeq: number;
  openTurns: Record<string, OpenTurn>;
  activeTurnId: string | null;
  activeNativeTurnId: string | null;
  lastTurnId: string | null;
  settledNativeTurns: Record<string, string>;
  openItems: Record<string, CanonicalItem>;
  streams: Record<string, StreamState>;
  settledKeys: Record<string, true>;
  inputs: Record<string, CanonicalInputState>;
  pendingAccepted: string[];
  extensionStates: Record<string, unknown>;
}

function cloneState(source: AssemblerState): MutableState {
  return {
    schemaVersion: source.schemaVersion,
    sessionEpoch: source.sessionEpoch,
    seq: source.seq,
    turnSeq: source.turnSeq,
    itemSeq: source.itemSeq,
    openTurns: { ...source.openTurns },
    activeTurnId: source.activeTurnId,
    activeNativeTurnId: source.activeNativeTurnId,
    lastTurnId: source.lastTurnId,
    settledNativeTurns: { ...source.settledNativeTurns },
    openItems: { ...source.openItems },
    streams: { ...source.streams },
    settledKeys: { ...source.settledKeys },
    inputs: { ...source.inputs },
    pendingAccepted: [...source.pendingAccepted],
    extensionStates: { ...source.extensionStates },
  };
}

function textShape(channel: TextChannel, text: string): ItemShape {
  if (channel === "reasoning") return { kind: "reasoning", text };
  if (channel === "plan") return { kind: "plan", text };
  return { kind: "agentMessage", text };
}

function channelForShape(shape: ItemShape): TextChannel | null {
  if (shape.kind === "reasoning") return "reasoning";
  if (shape.kind === "plan") return "plan";
  if (shape.kind === "agentMessage") return "agentMessage";
  return null;
}

function textOfShape(shape: ItemShape): string {
  if (shape.kind === "agentMessage" || shape.kind === "reasoning" || shape.kind === "plan") {
    return shape.text;
  }
  return "";
}

/**
 * Consume an ordered batch of deltas. `state` is never mutated; the returned
 * state is the input for the next batch. `clockSeed` makes timestamps
 * deterministic so recordings replay exactly.
 */
export function assemble(
  initialState: AssemblerState,
  deltas: readonly BridgeDelta[],
  context: AssembleContext,
): AssembleResult {
  const state = cloneState(initialState);
  const events: CanonicalEvent[] = [];
  const diagnostics: AssembleDiagnostic[] = [];
  const step = context.atMsStep ?? 1;

  const emit = (body: CanonicalEventBody): number => {
    state.seq += 1;
    const atMs = context.clockSeed + step * state.seq;
    events.push({ ...body, seq: state.seq, atMs } as CanonicalEvent);
    return atMs;
  };
  const diag = (code: DiagnosticCode, op: string, detail: string, nativeKey?: string): void => {
    diagnostics.push(nativeKey === undefined ? { code, op, detail } : { code, op, detail, nativeKey });
  };
  const threadId = context.threadId;

  const mintTurnId = (): string => {
    state.turnSeq += 1;
    return `t${state.sessionEpoch}.${state.turnSeq}`;
  };
  const mintItemId = (): string => {
    state.itemSeq += 1;
    return `i${state.sessionEpoch}.${state.itemSeq}`;
  };

  const emitInput = (input: CanonicalInputState): void => {
    state.inputs[input.inputId] = input;
    emit({ kind: "input.state", threadId, status: input });
  };

  const openTurn = (nativeTurnId: string): string => {
    const turnId = mintTurnId();
    const startedAtMs = emit({ kind: "turn.started", threadId, turnId, nativeTurnId });
    state.openTurns[nativeTurnId] = { turnId, nativeTurnId, threadId, startedAtMs };
    state.activeTurnId = turnId;
    state.activeNativeTurnId = nativeTurnId;
    state.lastTurnId = turnId;
    return turnId;
  };

  /** Attach pending accepted inputs to the just-opened turn. */
  const drainPending = (turnId: string): void => {
    for (const inputId of state.pendingAccepted) {
      const input = state.inputs[inputId];
      if (input === undefined) continue;
      emitInput(withDisposition(input, "steered", turnId));
    }
    state.pendingAccepted = [];
  };

  /** Inputs still pending when a turn ends have raced the end: queue, never drop. */
  const queuePending = (): void => {
    for (const inputId of state.pendingAccepted) {
      const input = state.inputs[inputId];
      if (input === undefined) continue;
      emitInput(withDisposition(input, "queued", null));
      diag("steer-end-race", "turn.boundary", "accepted input raced turn completion; queued, not lost", input.inputId);
    }
    state.pendingAccepted = [];
  };

  const settleTurn = (nativeTurnId: string, status: TurnStatus, claimIfIdle: boolean, op: string): void => {
    let turnKey = nativeTurnId;
    let turn = state.openTurns[turnKey];
    if (turn === undefined) {
      if (claimIfIdle && state.pendingAccepted.length > 0) {
        turnKey = nativeTurnId || `claim.${state.seq}`;
        const claimTurnId = openTurn(turnKey);
        drainPending(claimTurnId);
        turn = state.openTurns[turnKey];
      } else {
        diag("out-of-order", op, `settlement for unknown turn ${nativeTurnId}`, nativeTurnId);
        return;
      }
    }
    const settledId = turn.turnId;
    queuePending();
    emit({ kind: "turn.completed", threadId, turnId: settledId, status, startedAtMs: turn.startedAtMs });
    state.settledNativeTurns[turnKey] = settledId;
    delete state.openTurns[turnKey];
    if (state.activeTurnId === settledId) {
      state.activeTurnId = null;
      state.activeNativeTurnId = null;
    }
  };

  /** Close open work with the right statuses (session ended / reset). */
  const settleOpenWork = (status: TurnStatus): void => {
    for (const [key, stream] of Object.entries(state.streams)) {
      const item: CanonicalItem = {
        itemId: stream.itemId,
        nativeKey: key,
        threadId,
        turnId: stream.turnId,
        shape: textShape(stream.channel, stream.text),
      };
      emit({ kind: "item.completed", threadId, turnId: stream.turnId, item });
      state.settledKeys[key] = true;
    }
    state.streams = {};
    for (const [key, item] of Object.entries(state.openItems)) {
      emit({ kind: "item.completed", threadId, turnId: item.turnId, item });
      state.settledKeys[key] = true;
    }
    state.openItems = {};
    // Every unsettled turn gets a terminal event, not only the active one.
    for (const [native, turn] of Object.entries(state.openTurns)) {
      emit({ kind: "turn.completed", threadId, turnId: turn.turnId, status, startedAtMs: turn.startedAtMs });
      state.settledNativeTurns[native] = turn.turnId;
    }
    state.openTurns = {};
    state.activeTurnId = null;
    state.activeNativeTurnId = null;
  };

  for (const delta of deltas) {
    const op = delta.op;
    const key = delta.nativeKey ?? "";

    switch (delta.op) {
      case "turn.open": {
        if (state.openTurns[delta.nativeTurnId] !== undefined) {
          diag("duplicate-turn-open", op, `turn ${delta.nativeTurnId} already open`, delta.nativeTurnId);
          break;
        }
        const turnId = openTurn(delta.nativeTurnId);
        drainPending(turnId);
        break;
      }
      case "turn.boundary":
        settleTurn(delta.nativeTurnId, delta.status, delta.claimIfIdle === true, op);
        break;
      case "turn.close":
        settleTurn(delta.nativeTurnId, delta.status, false, op);
        break;
      case "turn.mainRun": {
        if (state.activeTurnId === null) {
          diag("orphan-no-turn", op, "mainRun state with no open turn");
          break;
        }
        emit({ kind: "turn.mainRun", threadId, turnId: state.activeTurnId, state: delta.state });
        break;
      }
      case "item.open": {
        if (state.openItems[key] !== undefined || state.streams[key] !== undefined) {
          diag("out-of-order", op, `item ${key} opened twice`, key);
          break;
        }
        if (state.activeTurnId === null) {
          diag("orphan-no-turn", op, `item ${key} opened with no open turn`, key);
          break;
        }
        const shape = delta.shape;
        const itemId = mintItemId();
        const item: CanonicalItem = {
          itemId,
          nativeKey: key,
          threadId,
          turnId: state.activeTurnId,
          shape,
        };
        emit({ kind: "item.started", threadId, turnId: item.turnId, item });
        const channel = channelForShape(shape);
        if (channel !== null) {
          // A text item accumulates through the same stream path as delta-first
          // streams, so textDelta/textClose can settle an explicitly opened item.
          state.streams[key] = {
            itemId,
            channel,
            text: textOfShape(shape),
            turnId: item.turnId,
          };
        } else {
          state.openItems[key] = item;
        }
        break;
      }
      case "item.progress":
        // Progress notes carry no terminal content; no canonical event.
        break;
      case "item.textDelta": {
        if (state.settledKeys[key]) {
          diag("out-of-order", op, `text delta after ${key} settled`, key);
          break;
        }
        const stream = state.streams[key];
        if (stream !== undefined) {
          state.streams[key] = { ...stream, text: stream.text + delta.text };
          emit({ kind: "agentMessage.delta", threadId, turnId: stream.turnId ?? "", itemId: stream.itemId, channel: stream.channel, delta: delta.text });
          break;
        }
        const opened = state.openItems[key];
        if (opened !== undefined) {
          // A non-text item (tool/command) cannot accumulate a text stream; keep
          // the delta observable without minting a second item for the same key.
          emit({ kind: "agentMessage.delta", threadId, turnId: opened.turnId ?? "", itemId: opened.itemId, channel: delta.channel, delta: delta.text });
          break;
        }
        if (state.activeTurnId === null) {
          diag("orphan-no-turn", op, `text stream ${key} with no open turn`, key);
          break;
        }
        const itemId = mintItemId();
        const item: CanonicalItem = {
          itemId,
          nativeKey: key,
          threadId,
          turnId: state.activeTurnId,
          shape: textShape(delta.channel, ""),
        };
        diag("delta-first-synthesized", op, `synthesized item.started for delta-first stream ${key}`, key);
        emit({ kind: "item.started", threadId, turnId: item.turnId, item });
        state.streams[key] = { itemId, channel: delta.channel, text: delta.text, turnId: item.turnId };
        emit({ kind: "agentMessage.delta", threadId, turnId: item.turnId ?? "", itemId, channel: delta.channel, delta: delta.text });
        break;
      }
      case "item.textClose": {
        const stream = state.streams[key];
        const opened = state.openItems[key];
        if (stream === undefined && opened === undefined) {
          diag("out-of-order", op, `textClose for unknown stream ${key}`, key);
          break;
        }
        const channel = stream?.channel ?? channelForShape(opened!.shape);
        if (channel === null) {
          diag("out-of-order", op, `textClose on non-text item ${key}`, key);
          break;
        }
        const accumulated = stream?.text ?? textOfShape(opened!.shape);
        const finalText = delta.text ?? accumulated;
        if (delta.text === undefined && finalText.trim().length === 0) {
          diag("empty-stream", op, `whitespace-only stream ${key} completes nothing`, key);
          delete state.streams[key];
          break;
        }
        const itemId = stream?.itemId ?? opened!.itemId;
        const turnId = stream?.turnId ?? opened!.turnId;
        const item: CanonicalItem = {
          itemId,
          nativeKey: key,
          threadId,
          turnId,
          shape: textShape(channel, finalText),
        };
        emit({ kind: "item.completed", threadId, turnId, item });
        state.settledKeys[key] = true;
        delete state.streams[key];
        delete state.openItems[key];
        break;
      }
      case "item.close": {
        if (state.settledKeys[key]) {
          diag("duplicate-close", op, `repeated close for settled key ${key}`, key);
          break;
        }
        let item: CanonicalItem;
        const opened = state.openItems[key];
        const stream = state.streams[key];
        if (opened !== undefined) {
          item = { ...opened, shape: delta.shape };
          delete state.openItems[key];
          delete state.streams[key];
        } else if (stream !== undefined) {
          item = { itemId: stream.itemId, nativeKey: key, threadId, turnId: stream.turnId, shape: delta.shape };
          delete state.streams[key];
        } else {
          // A close with no open turn is an orphan: diagnose only, never mint
          // an item that would project with an empty turnId.
          if (state.activeTurnId === null) {
            diag("orphan-no-turn", op, `close for ${key} with no open turn`, key);
            break;
          }
          diag("close-without-open", op, `bare completed item for ${key}`, key);
          item = {
            itemId: mintItemId(),
            nativeKey: key,
            threadId,
            turnId: state.activeTurnId,
            shape: delta.shape,
          };
          emit({ kind: "item.started", threadId, turnId: item.turnId, item });
        }
        emit({ kind: "item.completed", threadId, turnId: item.turnId, item });
        state.settledKeys[key] = true;
        break;
      }
      case "input.accepted": {
        const existing = state.inputs[delta.inputId];
        if (existing !== undefined) {
          // Idempotent re-registration: never reset admission/evidence/withdrawal.
          emitInput(existing);
          break;
        }
        const input = registerInput(delta);
        const target = delta.expectedTurnId;
        if (state.activeTurnId !== null && (target === undefined || target === state.activeNativeTurnId)) {
          emitInput(withDisposition(input, "steered", state.activeTurnId));
        } else if (target !== undefined && state.settledNativeTurns[target] !== undefined) {
          emitInput(withDisposition(input, "queued", null));
          diag("steer-end-race", op, "input targeted a settled turn; queued, not lost", input.inputId);
        } else {
          state.inputs[input.inputId] = input;
          state.pendingAccepted.push(input.inputId);
          emit({ kind: "input.state", threadId, status: input });
        }
        break;
      }
      case "input.delivery": {
        const current = state.inputs[delta.inputId];
        if (current === undefined) diag("out-of-order", op, `delivery for unregistered input ${delta.inputId}`, delta.inputId);
        emitInput(applyDelivery(current ?? blankInput(delta.inputId), delta));
        break;
      }
      case "input.evidence": {
        const current = state.inputs[delta.inputId];
        if (current === undefined) diag("out-of-order", op, `evidence for unregistered input ${delta.inputId}`, delta.inputId);
        emitInput(applyEvidence(current ?? blankInput(delta.inputId), delta));
        break;
      }
      case "input.withdrawal": {
        const current = state.inputs[delta.inputId];
        if (current === undefined) diag("out-of-order", op, `withdrawal for unregistered input ${delta.inputId}`, delta.inputId);
        emitInput(applyWithdrawal(current ?? blankInput(delta.inputId), delta));
        break;
      }
      case "input.outcome": {
        const current = state.inputs[delta.inputId];
        const { state: next, settlement } = applyOutcome(current ?? blankInput(delta.inputId), delta);
        emitInput(next);
        if (settlement.reconcileRequired) {
          diag("reconcile-required", op, delta.reason, delta.inputId);
        }
        break;
      }
      case "usage": {
        const turnId = state.activeTurnId ?? state.lastTurnId;
        if (turnId === null) {
          diag("orphan-no-turn", op, "usage with no turn");
          break;
        }
        emit({
          kind: "tokenUsage.updated",
          threadId,
          turnId,
          usage: { total: delta.total, last: delta.last, modelContextWindow: delta.modelContextWindow },
        });
        break;
      }
      case "contextWindow":
        emit({
          kind: "contextWindow",
          threadId,
          usedTokens: delta.usedTokens,
          modelContextWindow: delta.modelContextWindow,
        });
        break;
      case "session.reset": {
        settleOpenWork("interrupted");
        diag("session-reset-settled", op, "all open work settled before fresh id space");
        state.sessionEpoch += 1;
        state.turnSeq = 0;
        state.itemSeq = 0;
        state.settledNativeTurns = {};
        state.settledKeys = {};
        state.inputs = {};
        state.pendingAccepted = [];
        state.extensionStates = {};
        break;
      }
      case "session.ended": {
        settleOpenWork("completed");
        diag("session-ended-settled", op, "all open work settled at session end");
        state.pendingAccepted = [];
        break;
      }
      case "extension.state":
        state.extensionStates[delta.extensionKind] = delta.state;
        emit({ kind: "extension.state", threadId, extensionKind: delta.extensionKind, state: delta.state });
        break;
      case "provider.recovery":
        diag("recovery-hint", op, delta.message);
        emit({
          kind: "provider.recovery",
          threadId,
          recoveryKind: delta.kind,
          message: delta.message,
          retryable: delta.retryable,
        });
        break;
      case "unhandled":
        diag("unhandled-diagnostic", op, delta.reason);
        emit({ kind: "unhandled", threadId, reason: delta.reason });
        break;
    }
  }

  return {
    state: state as AssemblerState,
    events,
    diagnostics,
  };
}
