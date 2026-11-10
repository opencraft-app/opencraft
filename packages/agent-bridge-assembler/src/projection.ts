/**
 * Projection from canonical assembler events to the *existing* AppServer
 * client protocol. This is the only module that knows AppServer notification
 * shapes; keeping it separate preserves the boundary for a future client
 * protocol swap. Nothing here invents a new client API or event envelope.
 *
 * Core timeline events map onto notifications clients already consume. Per-
 * input steer evidence is additive: it rides one capability-gated
 * `opencraft/steerEvidence/updated` notification that old consumers ignore,
 * so an unknown/admission-only input is never flattened into a legacy
 * "injected" success label. Anomalies the assembler detects stay in its
 * diagnostics and are not put on the client wire.
 */

import type { AppServerNotification } from "@opencraft/appserver-protocol";
import {
  OPENCRAFT_STEER_EVIDENCE_NOTIFICATION,
  type OpenCraftSteerEvidenceNotification,
  type SteerInputStatus,
} from "@opencraft/appserver-protocol";
import type {
  AgentMessageDeltaNotification,
  ItemCompletedNotification,
  ItemStartedNotification,
  ThreadItem,
  ThreadTokenUsage,
  ThreadTokenUsageUpdatedNotification,
  TokenUsageBreakdown,
  Turn,
  TurnCompletedNotification,
  TurnStartedNotification,
  WarningNotification,
} from "@opencraft/appserver-protocol/generated/v2";
import type { TokenUsage } from "@opencraft/agent-bridge-protocol";
import type {
  CanonicalEvent,
  CanonicalInputState,
  CanonicalItem,
  CanonicalUsage,
} from "./canonical";

/** Notification methods that are part of the existing client output contract. */
export const EXISTING_APPSERVER_NOTIFICATION_METHODS = Object.freeze([
  "turn/started",
  "turn/completed",
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
  "thread/tokenUsage/updated",
  "warning",
] as const);

/** The single additive extension method, gated by a declared capability. */
export const STEER_EVIDENCE_EXTENSION_METHOD = OPENCRAFT_STEER_EVIDENCE_NOTIFICATION;

export interface ProjectionOptions {
  /** Only true when the client declared `opencraft/steer-evidence`. */
  readonly steerEvidenceDeclared: boolean;
  readonly schemaVersion: number;
}

function toThreadItem(item: CanonicalItem): ThreadItem {
  const shape = item.shape;
  switch (shape.kind) {
    case "userMessage":
      return {
        type: "userMessage",
        id: item.itemId,
        clientId: shape.clientId ?? null,
        content: [{ type: "text", text: shape.text, text_elements: [] }],
      };
    case "agentMessage":
      return {
        type: "agentMessage",
        id: item.itemId,
        text: shape.text,
        phase: null,
        memoryCitation: null,
        delivery: null,
        questions: null,
      };
    case "reasoning":
      return { type: "reasoning", id: item.itemId, summary: [], content: [shape.text] };
    case "plan":
      return { type: "plan", id: item.itemId, text: shape.text };
    case "tool":
      return {
        type: "commandExecution",
        id: item.itemId,
        pluginId: null,
        scriptPath: null,
        command: shape.name,
        cwd: "",
        processId: null,
        source: "agent",
        status: shape.status,
        commandActions: [],
        aggregatedOutput: shape.output ?? null,
        exitCode: null,
        durationMs: null,
      };
  }
}

function toBreakdown(usage: TokenUsage): TokenUsageBreakdown {
  return {
    totalTokens: usage.totalTokens,
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    cacheWriteInputTokens: usage.cacheWriteInputTokens,
    outputTokens: usage.outputTokens,
    reasoningOutputTokens: usage.reasoningOutputTokens,
  };
}

function toTokenUsage(usage: CanonicalUsage): ThreadTokenUsage {
  return {
    total: toBreakdown(usage.total),
    last: toBreakdown(usage.last),
    modelContextWindow: usage.modelContextWindow,
  };
}

function makeTurn(
  id: string,
  status: Turn["status"],
  startedAtMs: number,
  completedAtMs: number | null,
): Turn {
  return {
    id,
    items: [],
    itemsView: "full",
    status,
    error: null,
    startedAt: Math.floor(startedAtMs / 1000),
    completedAt: completedAtMs === null ? null : Math.floor(completedAtMs / 1000),
    durationMs: null,
  };
}

function toSteerStatus(status: CanonicalInputState): SteerInputStatus {
  return {
    inputId: status.inputId,
    clientRequestId: status.clientRequestId,
    expectedTurnId: status.expectedTurnId,
    registration: status.registration,
    admission: status.admission,
    delivery: status.delivery,
    evidence: {
      value: status.evidence.value,
      version: status.evidence.version,
      ...(status.evidence.evidenceKind !== undefined ? { evidenceKind: status.evidence.evidenceKind } : {}),
      ...(status.evidence.evidenceRef !== undefined ? { evidenceRef: status.evidence.evidenceRef } : {}),
      ...(status.evidence.nativeInputId !== undefined ? { nativeInputId: status.evidence.nativeInputId } : {}),
      ...(status.evidence.runId !== undefined ? { runId: status.evidence.runId } : {}),
    },
    withdrawal: status.withdrawal,
    outcome: status.outcome,
  };
}

/** Map one canonical event to zero or more existing AppServer notifications. */
export function projectToAppServer(
  events: readonly CanonicalEvent[],
  options: ProjectionOptions,
): readonly AppServerNotification[] {
  const out: AppServerNotification[] = [];
  const pendingSteer: SteerInputStatus[] = [];

  for (const event of events) {
    switch (event.kind) {
      case "turn.started": {
        const params: TurnStartedNotification = {
          threadId: event.threadId,
          turn: makeTurn(event.turnId, "inProgress", event.atMs, null),
        };
        out.push({ method: "turn/started", params });
        break;
      }
      case "turn.completed": {
        const params: TurnCompletedNotification = {
          threadId: event.threadId,
          turn: makeTurn(event.turnId, event.status, event.atMs, event.atMs),
        };
        out.push({ method: "turn/completed", params });
        break;
      }
      case "item.started": {
        const params: ItemStartedNotification = {
          item: toThreadItem(event.item),
          threadId: event.threadId,
          turnId: event.turnId ?? "",
          startedAtMs: event.atMs,
        };
        out.push({ method: "item/started", params });
        break;
      }
      case "item.completed": {
        const params: ItemCompletedNotification = {
          item: toThreadItem(event.item),
          threadId: event.threadId,
          turnId: event.turnId ?? "",
          completedAtMs: event.atMs,
        };
        out.push({ method: "item/completed", params });
        break;
      }
      case "agentMessage.delta": {
        const params: AgentMessageDeltaNotification = {
          threadId: event.threadId,
          turnId: event.turnId,
          itemId: event.itemId,
          delta: event.delta,
        };
        out.push({ method: "item/agentMessage/delta", params });
        break;
      }
      case "tokenUsage.updated": {
        const params: ThreadTokenUsageUpdatedNotification = {
          threadId: event.threadId,
          turnId: event.turnId,
          tokenUsage: toTokenUsage(event.usage),
        };
        out.push({ method: "thread/tokenUsage/updated", params });
        break;
      }
      case "input.state":
        // Collected and emitted once below, so one notification carries the
        // full snapshot rather than a flicker per facet.
        pendingSteer.push(toSteerStatus(event.status));
        break;
      case "provider.recovery":
      case "unhandled": {
        const message = event.kind === "provider.recovery" ? event.message : event.reason;
        const params: WarningNotification = { threadId: event.threadId, message };
        out.push({ method: "warning", params });
        break;
      }
      // turn.mainRun, extension.state and contextWindow are canonical state
      // with no existing client notification; they are intentionally not
      // projected rather than fabricating a new client event.
      case "turn.mainRun":
      case "extension.state":
      case "contextWindow":
        break;
    }
  }

  if (options.steerEvidenceDeclared && pendingSteer.length > 0) {
    const params: OpenCraftSteerEvidenceNotification = {
      threadId: events[0]?.threadId ?? "",
      schemaVersion: options.schemaVersion,
      inputs: pendingSteer,
    };
    out.push({ method: OPENCRAFT_STEER_EVIDENCE_NOTIFICATION, params });
  }

  return out;
}
