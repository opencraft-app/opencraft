/** CodeBuddy's private ACP steering dialect. No prompt retry or cancel fallback. */
import { randomUUID } from "node:crypto";
import { AcpRpcError, type AcpConnection, type AcpInitializeResult } from "./acp";
import type { AcpDialect } from "./dialect";

const PROBE = "opencraft.codebuddySteerProbed";
const OWNER = "codebuddy.ai/conversationRequestId";

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

/** An invalid, sessionless request checks the extension without invoking a model. */
export async function probeCodeBuddy(connection: AcpConnection, initialize: AcpInitializeResult): Promise<AcpInitializeResult> {
  let supported = false;
  try {
    await connection.request("session/steer", {}, { timeoutMs: 3_000 });
  } catch (error) {
    supported = error instanceof AcpRpcError && error.code === -32602
      && [error.message, error.data].some((value) =>
        typeof value === "string" && value.includes('Steer operation requires "sessionId"'));
  }
  return { ...initialize, _meta: { ...initialize._meta, [PROBE]: supported } };
}

export function codeBuddyDialect(base: AcpDialect): AcpDialect {
  return {
    ...base,
    id: "codebuddy",
    nativeSteering: ({ initialize }) => initialize._meta?.[PROBE] === true,
  };
}

/** Reject unknown content rather than dropping it while converting to text. */
export function isCodeBuddySteerInput(value: unknown): boolean {
  const input = record(value);
  return typeof input.text === "string" && input.text.trim().length > 0
    && !input.text.trimStart().startsWith("/")
    && Object.keys(input).every((key) => key === "text" || key === "images")
    && (input.images === undefined || (Array.isArray(input.images) && input.images.length === 0));
}

export interface CodeBuddyReceipt {
  readonly nativeInputId: string;
  readonly runId: string;
}

interface Pending {
  readonly owner: string;
  admitted: boolean;
  inserted: boolean;
  readonly resolve: () => void;
  readonly onDelivered: (proof: CodeBuddyReceipt) => void;
  readonly reject: (error: Error) => void;
}

/** One instance per run: both receipts must belong to its immutable native owner. */
export class CodeBuddyRun {
  private owner: string | null = null;
  private ended = false;
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly priorOwners: Set<string>) {}

  get ready(): boolean { return !this.ended && this.owner !== null; }

  observe(update: Record<string, unknown>): void {
    if (this.ended) return;
    const meta = record(update._meta);
    const owner = meta[OWNER];
    if (typeof owner !== "string" || owner.length === 0 || this.priorOwners.has(owner)) return;
    if (this.owner === null) this.owner = owner;
    if (owner !== this.owner) return;
    const id = update.messageId ?? meta["codebuddy.ai/messageId"];
    if (update.sessionUpdate !== "user_message_chunk" || typeof id !== "string") return;
    const pending = this.pending.get(id);
    if (pending === undefined || pending.owner !== owner) return;
    pending.inserted = true;
    this.settle(id, pending);
  }

  inject(connection: AcpConnection, sessionId: string, text: string, onDelivered: (proof: CodeBuddyReceipt) => void): Promise<void> {
    if (!this.ready) return Promise.reject(new Error("CodeBuddy run owner is unavailable"));
    const owner = this.owner!;
    const id = randomUUID();
    return new Promise<void>((resolve, reject) => {
      const pending: Pending = { owner, admitted: false, inserted: false, resolve, reject, onDelivered };
      this.pending.set(id, pending);
      void connection.request("session/steer", {
        sessionId,
        contentBlocks: [{ type: "text", text }],
        expectedRequestId: owner,
        clientUserMessageId: id,
      }, { timeoutMs: 3_000 }).then((value) => {
        if (!this.pending.has(id)) return;
        const result = record(value);
        if (result.steered !== true || result.ownerRequestId !== owner) {
          this.pending.delete(id);
          reject(new Error("CodeBuddy steering admission unconfirmed for the target owner; do not replay"));
          return;
        }
        pending.admitted = true;
        this.settle(id, pending);
      }, () => {
        if (!this.pending.delete(id)) return;
        reject(new Error("CodeBuddy steering admission unconfirmed after request failure; do not replay"));
      });
    });
  }

  private settle(id: string, pending: Pending): void {
    if (!pending.admitted || !pending.inserted) return;
    this.pending.delete(id);
    pending.onDelivered({ nativeInputId: id, runId: pending.owner });
    pending.resolve();
  }

  finish(): void {
    this.ended = true;
    if (this.owner !== null) this.priorOwners.add(this.owner);
    for (const pending of this.pending.values()) {
      pending.reject(new Error("CodeBuddy steering double receipt unconfirmed before run ended; do not replay"));
    }
    this.pending.clear();
  }
}
