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
  readonly stop: () => Promise<void>;
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
 * Host-scoped implementation of the reusable AppServer fuzzy-file search channel.
 * New AppServers receive start/update/stop. Older servers are detected once
 * and use the legacy one-shot method without changing Composer semantics.
 * Opening a file browser does not create a remote index: the first non-empty
 * query acquires it, and clearing the query or releasing its owner stops it.
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
    for (const root of roots) {
      const path = root.replace(/\\/gu, "/");
      const parts: string[] = [];
      for (const part of path.split("/")) {
        if (!part || part === ".") continue;
        if (part === "..") parts.pop(); else parts.push(part);
      }
      const normalized = parts.join("/");
      if (!(path.startsWith("/") || /^[a-z]:\//iu.test(path))
        || path.startsWith("/") && (parts.length === 0
        || /^(?:proc|sys|dev)(?:\/|$)/u.test(normalized)
        || /^(?:data|home|root|opt|var|usr|etc|tmp|mnt|media)$/u.test(normalized))
        || /^[a-z]:$/iu.test(normalized)
        || path.startsWith("//") && parts.length <= 2) {
        throw new Error("Fuzzy file search requires a project directory");
      }
    }
    const sessionId = this.createSessionId();
    let stopped = false;
    let started = false;
    let starting: Promise<void> | undefined;
    let updates = Promise.resolve();
    const stopRemote = async () => {
      if (!started) return;
      started = false;
      try {
        await this.client.request("fuzzyFileSearch/sessionStop", { sessionId });
      } catch {
        // Teardown is best-effort and must not surface as a Composer error.
      }
    };
    const start = (): Promise<void> => {
      if (stopped || this.disposed || this.sessionSupport === "unsupported") return Promise.resolve();
      return starting ??= (async () => {
        try {
          await this.client.request("fuzzyFileSearch/sessionStart", { sessionId, roots });
          this.sessionSupport = "supported";
          started = true;
          if (stopped || this.disposed) await stopRemote();
        } catch (error) {
          if (!isMethodNotFound(error, "fuzzyFileSearch/sessionStart")) throw error;
          this.sessionSupport = "unsupported";
        }
      })();
    };
    const session: FuzzyFileSearchSession = {
      update: (query) => {
        const update = updates.then(async () => {
          if (stopped || this.disposed) return;
          if (!query.trim()) {
            await stopRemote();
            starting = undefined;
            return;
          }
          await start();
          if (stopped || this.disposed) return;
          if (this.sessionSupport === "supported") {
            try {
              await this.client.request("fuzzyFileSearch/sessionUpdate", { sessionId, query });
              return;
            } catch (error) {
              if (!isSessionNotFound(error)) throw error;
              if (stopped || this.disposed) return;
              started = false;
              starting = undefined;
              await start();
              if (stopped || this.disposed) return;
              await this.client.request("fuzzyFileSearch/sessionUpdate", { sessionId, query });
              return;
            }
          }
          const response = await this.client.request("fuzzyFileSearch", {
            query, roots, cancellationToken: `opencraft-fuzzy-file-search:${sessionId}`,
          });
          if (stopped || this.disposed) return;
          options.onUpdated?.({ query, files: response.files });
          options.onCompleted?.();
        });
        updates = update.catch(() => undefined);
        return update;
      },
      stop: async () => {
        if (stopped) return;
        stopped = true;
        this.sessions.delete(sessionId);
        await starting?.catch(() => undefined);
        await stopRemote();
      },
    };
    this.sessions.set(sessionId, { ...options, stop: session.stop });
    return session;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const session of this.sessions.values()) void session.stop();
    this.sessions.clear();
    this.removeNotificationListener();
  }
}
