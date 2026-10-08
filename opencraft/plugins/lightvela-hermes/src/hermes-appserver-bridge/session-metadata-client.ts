import type { TatHttpVirtualClient } from "../lib/tat-http-virtual-client";
import type { HermesSessionSummary } from "./types";

export interface HermesSessionMetadataClient {
  readPinned(profile: string, signal?: AbortSignal): Promise<{ supported: boolean; rows: HermesSessionSummary[] }>;
  setPinned(id: string, profile: string, pinned: boolean, signal?: AbortSignal): Promise<void>;
  dispose(): void;
}

const record = (v: unknown): Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {};

/** Borrow the existing TAT multiplexer and Dashboard token, not a new tunnel. */
export class HermesDashboardSessionMetadataClient implements HermesSessionMetadataClient {
  constructor(private readonly client: Pick<TatHttpVirtualClient, "fetch" | "close">, private readonly token: string) {}

  async readPinned(profile: string, signal?: AbortSignal) {
    const query = new URLSearchParams({ profile, order: "recent", limit: "100", exclude_sources: "tool,kanban" });
    const response = await this.client.fetch(`/api/sessions?${query}`, {
      headers: { "X-Hermes-Session-Token": this.token }, signal,
    });
    if (response.status === 404 || response.status === 405) return { supported: false, rows: [] };
    if (!response.ok) throw new Error("无法读取置顶会话，请稍后重试");
    const payload = record(await response.json());
    if (!Array.isArray(payload.sessions)) throw new Error("Invalid Hermes session metadata");
    const rows: HermesSessionSummary[] = [];
    for (const value of payload.sessions) {
      const row = record(value);
      if (typeof row.id !== "string" || !row.id || typeof row.pinned !== "boolean"
        || typeof row.profile !== "string" || row.profile !== profile) throw new Error("Invalid Hermes pin ownership");
      if (!row.pinned) continue;
      // Untitled/empty native sessions legitimately carry SQL NULL summaries.
      if ((row.title != null && typeof row.title !== "string")
        || (row.preview != null && typeof row.preview !== "string")
        || typeof row.started_at !== "number" || !Number.isFinite(row.started_at)) throw new Error("Invalid Hermes pinned summary");
      rows.push({
        id: row.id, title: typeof row.title === "string" ? row.title : "", preview: typeof row.preview === "string" ? row.preview : "", started_at: row.started_at,
        message_count: typeof row.message_count === "number" ? row.message_count : 0,
        source: typeof row.source === "string" ? row.source : "", profile,
        ...(typeof row.cwd === "string" ? { cwd: row.cwd } : {}),
        ...(typeof row.last_active === "number" ? { last_active: row.last_active } : {}),
      });
    }
    return { supported: true, rows };
  }

  async setPinned(id: string, profile: string, pinned: boolean, signal?: AbortSignal) {
    if (!id || !profile || typeof pinned !== "boolean") throw new Error("Invalid Hermes pin command");
    const response = await this.client.fetch(`/api/sessions/${encodeURIComponent(id)}`, {
      method: "PATCH", headers: { "X-Hermes-Session-Token": this.token, "Content-Type": "application/json" },
      body: JSON.stringify({ profile, pinned }), signal,
    });
    if (!response.ok) throw new Error("置顶未成功，请刷新列表核对后重试");
    const result = record(await response.json());
    if (result.ok !== true || result.pinned !== pinned) throw new Error("置顶结果尚未确认，请刷新列表核对");
  }
  dispose() { this.client.close(); }
}
