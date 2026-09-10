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
    return this.client.fetchJson<HermesMessagesPage>(
      `/api/sessions/${encodeURIComponent(sessionId)}/messages?${query.toString()}`,
      { headers: { "x-hermes-session-token": this.sessionToken }, signal },
    );
  }

  dispose(): void {
    this.client.close();
  }
}
