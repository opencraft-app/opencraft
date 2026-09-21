import type { TatHttpVirtualClient } from "../lib/tat-http-virtual-client";
import type { HermesMessagesPage } from "./types";
import { throwIfSignalAborted } from "@opencraft/workbench-runtime";

export interface HermesHistoryPageRequest {
  readonly limit: number;
  readonly offset: number;
  readonly order: "latest" | "oldest";
  readonly includeCompacted: boolean;
  readonly profile?: string | null;
}

export interface HermesHistoryClient {
  readMessages(sessionId: string, request: HermesHistoryPageRequest, signal?: AbortSignal): Promise<HermesMessagesPage>;
  dispose(): void;
}

type JsonHttpClient = Pick<TatHttpVirtualClient, "fetchJson" | "close">;

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function dashboardHistoryError(payload: Record<string, unknown>): string {
  for (const candidate of [payload.detail, payload.error, payload.message]) {
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate.trim();
  }
  return "Hermes Dashboard returned an invalid message history response";
}

/** Durable transcript port backed by Hermes Dashboard's authenticated REST API. */
export class HermesDashboardHistoryClient implements HermesHistoryClient {
  constructor(
    private readonly client: JsonHttpClient,
    private readonly sessionToken: string,
  ) {}

  async readMessages(sessionId: string, request: HermesHistoryPageRequest, signal?: AbortSignal): Promise<HermesMessagesPage> {
    throwIfSignalAborted(signal);
    const query = new URLSearchParams({
      limit: String(Math.min(Math.max(Math.floor(request.limit), 1), 500)),
      offset: String(Math.max(Math.floor(request.offset), 0)),
      order: request.order,
      include_compacted: String(request.includeCompacted),
    });
    if (request.profile) query.set("profile", request.profile);
    const payload = await this.client.fetchJson<unknown>(
      `/api/sessions/${encodeURIComponent(sessionId)}/messages?${query.toString()}`,
      { headers: { "x-hermes-session-token": this.sessionToken }, signal },
    );
    const value = record(payload);
    // Some Dashboard builds encode a failed conversation lookup in an HTTP
    // 200 JSON envelope. Validate the semantic contract here so callers see a
    // stable history error instead of a later TypeError from page.messages.
    if (!Array.isArray(value.messages)) throw new Error(dashboardHistoryError(value));
    return payload as HermesMessagesPage;
  }

  dispose(): void {
    this.client.close();
  }
}
