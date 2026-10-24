import type {
  InteractionResponse,
  PendingInteraction,
} from "@opencraft/chat-runtime";

export type InteractionLedgerState = "resolving" | "delivered";

export interface InteractionLedgerSnapshot {
  readonly response: InteractionResponse;
  readonly state: InteractionLedgerState;
}

export interface AppServerInteractionLedgerOptions {
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly maxEntries?: number;
}

interface InteractionLedgerEntry {
  readonly response: InteractionResponse;
  state: InteractionLedgerState;
  readonly requestFingerprint: string;
  readonly fingerprint: string;
  touchedAtMs: number;
}

export class AppServerInteractionLedgerError extends Error {
  readonly code: "INTERACTION_REQUEST_CONFLICT" | "INTERACTION_RESPONSE_CONFLICT";

  constructor(requestId: string, kind: "request" | "response" = "response") {
    super(`Interaction ${requestId} already has a different ${kind}`);
    this.name = "AppServerInteractionLedgerError";
    this.code = kind === "request"
      ? "INTERACTION_REQUEST_CONFLICT"
      : "INTERACTION_RESPONSE_CONFLICT";
  }
}

type LedgerInteraction = PendingInteraction & { readonly threadId: string };

function interactionKey(interaction: LedgerInteraction): string {
  const requestIdentity = interaction.itemId === null
    ? ["rpc", interaction.requestId]
    : ["item", interaction.itemId];
  return JSON.stringify([
    interaction.threadId,
    interaction.method,
    interaction.turnId,
    requestIdentity,
  ]);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(",")}}`;
}

function responseFingerprint(response: InteractionResponse): string {
  const { requestId: _requestId, ...semanticResponse } = response;
  return canonicalJson(semanticResponse);
}

/**
 * Host-runtime response ledger shared by every physical client generation.
 *
 * It remembers the exact response chosen for a stable AppServer request. A
 * reconnect may replay that response, but a different response for the same
 * identity is rejected. This is deliberately process-local: provider requests
 * cannot outlive the owning Host runtime process.
 */
export class AppServerInteractionLedger {
  private readonly entries = new Map<string, InteractionLedgerEntry>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(options: AppServerInteractionLedgerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? 5 * 60_000;
    this.maxEntries = options.maxEntries ?? 512;
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 1) {
      throw new TypeError("Interaction ledger ttlMs must be a positive integer");
    }
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries < 1) {
      throw new TypeError("Interaction ledger maxEntries must be a positive integer");
    }
  }

  recall(interaction: LedgerInteraction): InteractionLedgerSnapshot | null {
    this.prune();
    const key = interactionKey(interaction);
    const entry = this.entries.get(key);
    if (entry === undefined) return null;
    if (entry.requestFingerprint !== canonicalJson(interaction.params)) {
      throw new AppServerInteractionLedgerError(interaction.requestId, "request");
    }
    entry.touchedAtMs = this.now();
    this.entries.delete(key);
    this.entries.set(key, entry);
    return { response: entry.response, state: entry.state };
  }

  remember(
    interaction: LedgerInteraction,
    response: InteractionResponse,
  ): InteractionLedgerSnapshot {
    this.prune();
    const key = interactionKey(interaction);
    const requestFingerprint = canonicalJson(interaction.params);
    const fingerprint = responseFingerprint(response);
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      if (existing.requestFingerprint !== requestFingerprint) {
        throw new AppServerInteractionLedgerError(interaction.requestId, "request");
      }
      if (existing.fingerprint !== fingerprint) {
        throw new AppServerInteractionLedgerError(interaction.requestId);
      }
      existing.touchedAtMs = this.now();
      return { response: existing.response, state: existing.state };
    }
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    const entry: InteractionLedgerEntry = {
      fingerprint,
      requestFingerprint,
      response,
      state: "resolving",
      touchedAtMs: this.now(),
    };
    this.entries.set(key, entry);
    return { response, state: entry.state };
  }

  markDelivered(
    interaction: LedgerInteraction,
    response: InteractionResponse,
  ): void {
    this.remember(interaction, response);
    const entry = this.entries.get(interactionKey(interaction));
    if (entry === undefined) return;
    entry.state = "delivered";
    entry.touchedAtMs = this.now();
  }

  forget(interaction: LedgerInteraction): void {
    this.entries.delete(interactionKey(interaction));
  }

  clear(): void {
    this.entries.clear();
  }

  private prune(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [key, entry] of this.entries) {
      if (entry.touchedAtMs <= cutoff) this.entries.delete(key);
    }
  }
}
