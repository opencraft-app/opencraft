import { sourceRoute, stewardReference } from "./templates";
export interface ImChannel {
  id: string;
  name: string;
  provider: "wecom" | "slack";
  botId?: string;
  ownerId: string;
  enabled: boolean;
  canManage: boolean;
  revision: number;
  route: string | null;
  draft: string | null;
  state: string;
  senders: { senderId: string; actorId: string }[];
  versions: { revision: number; source: string | null; created_at: number }[];
}
export interface ImRecord {
  id: string;
  channel_id: string;
  actor_id: string;
  source: string;
  route_revision: number;
  conversation_ref: string | null;
  state: string;
  error: string | null;
  created_at: number;
}
export interface ImDocument {
  channels: ImChannel[];
  actorId: string;
  serverId: string;
  workbenchHostId: string;
  servers?: { serverId: string; hostId: string }[];
}
export class ImHttpError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}
export class ImClient {
  constructor(readonly fetcher: typeof fetch) {}
  async request<T>(body: Record<string, unknown>): Promise<T> {
    const response = await this.fetcher("/__opencraft_im", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    let value: any;
    try { value = await response.json(); }
    catch { throw new ImHttpError("invalid_server_response", response.status); }
    if (!response.ok) {
      const code = typeof value?.error === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(value.error)
        ? value.error : "invalid_server_response";
      throw new ImHttpError(code, response.status);
    }
    return value as T;
  }
}
export interface ImDraft {
  source: string | null;
  revision: number;
  mode: "source" | "steward" | "custom";
  reference: string;
  name: string;
  credentials: Record<string, string>;
}
/** Activation-scoped drafts survive route changes; secrets never enter browser persistence. */
export class ImController {
  readonly client: ImClient;
  readonly drafts = new Map<string, ImDraft>();
  constructor(fetcher: typeof fetch) {
    this.client = new ImClient(fetcher);
  }
  draft(c: ImChannel) {
    const source = c.draft ?? c.route,
      reference = stewardReference(source);
    if (!this.drafts.has(c.id))
      this.drafts.set(c.id, {
        source,
        revision: c.revision,
        mode:
          source === null || source === sourceRoute
            ? "source"
            : reference
              ? "steward"
              : "custom",
        reference: reference ?? "",
        name: c.name,
        credentials: {},
      });
    return this.drafts.get(c.id)!;
  }
  dispose() {
    this.drafts.clear();
  }
}
