import {
  AppServerRpcError,
  type AppServerClient,
} from "@opencraft/appserver-client";
import type {
  FuzzyFileSearchResult,
  FuzzyFileSearchSessionCompletedNotification,
  FuzzyFileSearchSessionUpdatedNotification,
} from "@opencraft/appserver-protocol/generated";
import { createClientId } from "@opencraft/composer-core";

export interface FuzzyFileSearchSessionUpdate {
  readonly query: string;
  readonly files: readonly FuzzyFileSearchResult[];
}

export interface FuzzyFileSearchSessionOptions {
  readonly roots: readonly string[];
  readonly onUpdated?: (update: FuzzyFileSearchSessionUpdate) => void;
  readonly onCompleted?: () => void;
}

export interface FuzzyFileSearchSession {
  update(query: string): Promise<void>;
  stop(): Promise<void>;
}

type FuzzyFileSearchClient = Pick<AppServerClient, "request" | "subscribeNotification">;
type SessionSupport = "unknown" | "supported" | "unsupported";

interface SessionCallbacks {
  readonly onUpdated?: FuzzyFileSearchSessionOptions["onUpdated"];
  readonly onCompleted?: FuzzyFileSearchSessionOptions["onCompleted"];
}

function isMethodNotFound(error: unknown, method: string): boolean {
  if (error instanceof AppServerRpcError && error.code === -32601) return true;
  return error instanceof Error
    && /method\s+not\s+found/iu.test(error.message)
    && error.message.includes(method);
}

function isSessionNotFound(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const data = error instanceof AppServerRpcError && error.data !== undefined
    ? ` ${JSON.stringify(error.data)}`
    : "";
  return /(?:fuzzy|search).*session.*not\s+found|session.*(?:missing|unknown|not\s+found)/iu
    .test(`${error.message}${data}`);
}

/**
 * Host-scoped implementation of Codex's reusable fuzzy-file search channel.
 * New AppServers receive start/update/stop. Older servers are detected once
 * and use the legacy one-shot method without changing Composer semantics.
 */
export class AppServerFuzzyFileSearchController {
  private readonly client: FuzzyFileSearchClient;
  private readonly createSessionId: () => string;
  private readonly sessions = new Map<string, SessionCallbacks>();
  private readonly removeNotificationListener: () => void;
  private sessionSupport: SessionSupport = "unknown";
  private disposed = false;

  constructor(
    client: FuzzyFileSearchClient,
    options: { readonly createSessionId?: () => string } = {},
  ) {
    this.client = client;
    this.createSessionId = options.createSessionId ?? createClientId;
    this.removeNotificationListener = client.subscribeNotification((notification) => {
      if (notification.method === "fuzzyFileSearch/sessionUpdated") {
        const update = notification.params as FuzzyFileSearchSessionUpdatedNotification;
        this.sessions.get(update.sessionId)?.onUpdated?.({
          query: update.query,
          files: update.files,
        });
      } else if (notification.method === "fuzzyFileSearch/sessionCompleted") {
        const completed = notification.params as FuzzyFileSearchSessionCompletedNotification;
        this.sessions.get(completed.sessionId)?.onCompleted?.();
      }
    });
  }

  async createSession(options: FuzzyFileSearchSessionOptions): Promise<FuzzyFileSearchSession> {
    if (this.disposed) throw new Error("Fuzzy file search controller is disposed");
    const roots = [...new Set(options.roots.map((root) => root.trim()).filter(Boolean))];
    if (roots.length === 0) throw new Error("Fuzzy file search requires at least one workspace root");
    const sessionId = this.createSessionId();

    if (this.sessionSupport !== "unsupported") {
      try {
        await this.client.request("fuzzyFileSearch/sessionStart", { sessionId, roots });
        this.sessionSupport = "supported";
      } catch (error) {
        if (!isMethodNotFound(error, "fuzzyFileSearch/sessionStart")) throw error;
        this.sessionSupport = "unsupported";
      }
    }

    this.sessions.set(sessionId, options);
    let stopped = false;
    return {
      update: async (query) => {
        if (stopped) return;
        if (this.sessionSupport === "supported") {
          try {
            await this.client.request("fuzzyFileSearch/sessionUpdate", { sessionId, query });
            return;
          } catch (error) {
            if (!isSessionNotFound(error)) throw error;
            await this.client.request("fuzzyFileSearch/sessionStart", { sessionId, roots });
            await this.client.request("fuzzyFileSearch/sessionUpdate", { sessionId, query });
            return;
          }
        }

        const response = await this.client.request("fuzzyFileSearch", {
          query,
          roots,
          cancellationToken: `opencraft-fuzzy-file-search:${sessionId}`,
        });
        if (stopped) return;
        options.onUpdated?.({ query, files: response.files });
        options.onCompleted?.();
      },
      stop: async () => {
        if (stopped) return;
        stopped = true;
        this.sessions.delete(sessionId);
        if (this.sessionSupport === "unsupported") return;
        try {
          await this.client.request("fuzzyFileSearch/sessionStop", { sessionId });
        } catch (error) {
          if (isMethodNotFound(error, "fuzzyFileSearch/sessionStop")) {
            this.sessionSupport = "unsupported";
          }
          // Stopping is best-effort: route changes must not surface teardown
          // failures as Composer errors.
        }
      },
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.sessions.clear();
    this.removeNotificationListener();
  }
}
