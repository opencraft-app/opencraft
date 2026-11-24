// Type-only imports keep this demand-loaded chunk free of startup dependencies; the
// attention owner parses every receipt it receives (`parseThreadReadReceipts`).
import type { ThreadReadReceiptPort, ThreadReadReceiptSource } from "@opencraft/workbench-runtime";

export const THREAD_READ_RECEIPTS_PATH = "/__opencraft_thread_reads";

/** A refused or failed request; `code` is the server's stable error code. */
export class ThreadReadReceiptsRequestError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
    this.name = "ThreadReadReceiptsRequestError";
  }
}

type Storage_ = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function actorOf(value: unknown): string {
  const actorId = (value as { actorId?: unknown } | null)?.actorId;
  if (typeof actorId !== "string" || !actorId || actorId.length > 512) throw new Error("Invalid read receipts account");
  return actorId;
}

async function failure(response: Response): Promise<ThreadReadReceiptsRequestError> {
  let code = "read_receipts_unavailable";
  try {
    const value = (await response.json()) as { error?: unknown };
    if (typeof value.error === "string" && /^[a-z_]{1,64}$/u.test(value.error)) code = value.error;
  } catch {
    /* Keep the generic code for non-JSON failures. */
  }
  return new ThreadReadReceiptsRequestError(code, response.status);
}

function receiptsOf(value: unknown): string[] {
  const receipts = (value as { receipts?: unknown }).receipts;
  if (!Array.isArray(receipts)) throw new Error("Invalid read receipts");
  return receipts as string[];
}

const json = (response: Response) => response.headers.get("content-type")?.includes("application/json") === true;

/** One browser slot: the last verified person and, once cached, their receipts. */
class Slot {
  constructor(
    private readonly storage: Storage_ | undefined,
    private readonly key: string,
  ) {}
  private get(): { actorId?: unknown; receipts?: unknown } | null {
    try {
      const raw = this.storage?.getItem(this.key);
      return raw ? (JSON.parse(raw) as { actorId?: unknown; receipts?: unknown }) : null;
    } catch {
      return null;
    }
  }
  actor(): string | null {
    const actorId = this.get()?.actorId;
    return typeof actorId === "string" && actorId && actorId.length <= 512 ? actorId : null;
  }
  /** A different person, or nobody, replaces the slot; the same person keeps their receipts. */
  remember(actorId: string | null) {
    try {
      if (actorId === null) this.storage?.removeItem(this.key);
      else if (this.actor() !== actorId) this.storage?.setItem(this.key, JSON.stringify({ actorId }));
    } catch {
      /* The slot only restores offline display; storage may be unavailable. */
    }
  }
  read(actorId: string): string[] | null {
    const slot = this.get();
    return slot?.actorId === actorId && Array.isArray(slot.receipts)
      ? slot.receipts.filter((item): item is string => typeof item === "string")
      : null;
  }
  write(actorId: string, receipts: readonly string[]) {
    this.storage?.setItem(this.key, JSON.stringify({ actorId, receipts }));
  }
}

/**
 * Cross-device read receipts of the server's own logins (local accounts, OIDC and other
 * verified identity sources). The server keys receipts by the signed-in human Actor; the
 * scope is that Actor's ID and only fences an account change between requests. Reads are
 * incremental: the port returns only receipts recorded after the last page it returned for
 * the current scope. The source owns one browser slot holding the last verified person
 * (a display hint, never a credential) and their cached receipts: a device that starts
 * offline keeps showing and queueing its own reads until the server answers, another
 * person replaces the slot, and a server reporting nobody signed in removes it.
 */
export class ServerThreadReadReceipts implements ThreadReadReceiptSource {
  readonly id = "opencraft.server-account";
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private cursor: { readonly scope: string; readonly value: number } | null = null;

  private constructor(
    private readonly fetcher: typeof fetch,
    private scope: string | null,
    readonly cache: Slot,
  ) {}

  /**
   * Resolves when the server serves read receipts, with a null scope while nobody is signed
   * in. A server without the route resolves undefined and the device keeps local read state.
   */
  static async discover(
    fetcher: typeof fetch,
    options: { readonly storage?: Storage_; readonly key: string; readonly signal?: AbortSignal },
  ): Promise<ServerThreadReadReceipts | undefined> {
    const slot = new Slot(options.storage, options.key);
    let response: Response;
    try {
      response = await fetcher(THREAD_READ_RECEIPTS_PATH, {
        credentials: "same-origin",
        cache: "no-store",
        signal: options.signal ?? AbortSignal.timeout(5000),
      });
    } catch {
      // Offline: keep the last verified person's read state; the server rechecks on reconnect.
      const actorId = slot.actor();
      return actorId === null ? undefined : new ServerThreadReadReceipts(fetcher, actorId, slot);
    }
    try {
      if (response.status === 401 || response.status === 403) {
        slot.remember(null);
        return new ServerThreadReadReceipts(fetcher, null, slot);
      }
      if (!response.ok || !json(response)) {
        if (response.status === 404 || response.ok) slot.remember(null);
        return undefined;
      }
      const actorId = actorOf(await response.json());
      slot.remember(actorId);
      return new ServerThreadReadReceipts(fetcher, actorId, slot);
    } catch {
      return undefined;
    }
  }

  getScope = (): string | null => this.scope;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Rechecks the signed-in Actor after a refused request; transient failures keep the scope. */
  refresh = async (): Promise<void> => {
    const generation = ++this.generation;
    let next: string | null;
    try {
      const response = await this.fetcher(THREAD_READ_RECEIPTS_PATH, { credentials: "same-origin", cache: "no-store" });
      if (response.status === 401 || response.status === 403) next = null;
      else if (response.ok && json(response)) next = actorOf(await response.json());
      else return;
    } catch {
      return;
    }
    if (generation !== this.generation) return;
    this.cache.remember(next);
    if (next === this.scope) return;
    this.scope = next;
    this.cursor = null;
    for (const listener of this.listeners) listener();
  };

  readonly port: ThreadReadReceiptPort = {
    read: async (scope, signal) => {
      const after = this.cursor?.scope === scope ? this.cursor.value : 0;
      const query = new URLSearchParams({ expectedActorId: scope, after: String(after) });
      const response = await this.fetcher(`${THREAD_READ_RECEIPTS_PATH}?${query}`, {
        credentials: "same-origin",
        cache: "no-store",
        signal,
      });
      const value = await this.page(response, scope);
      const cursor = (value as { cursor?: unknown }).cursor;
      if (!Number.isSafeInteger(cursor) || (cursor as number) < 0) throw new Error("Invalid read receipt cursor");
      const receipts = receiptsOf(value);
      // Only a page for the current scope advances its cursor; a late page never rewinds it.
      if (this.scope === scope && (this.cursor?.scope !== scope || this.cursor.value < (cursor as number)))
        this.cursor = { scope, value: cursor as number };
      return receipts;
    },
    merge: async (scope, receipts, signal) => {
      const response = await this.fetcher(THREAD_READ_RECEIPTS_PATH, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ receipts, expectedActorId: scope }),
      });
      return receiptsOf(await this.page(response, scope));
    },
  };

  private async page(response: Response, scope: string): Promise<unknown> {
    if (!response.ok) {
      const error = await failure(response);
      if (error.status === 401 || error.status === 403 || error.code === "account_changed") void this.refresh();
      throw error;
    }
    const value: unknown = await response.json();
    if (actorOf(value) !== scope) {
      void this.refresh();
      throw new ThreadReadReceiptsRequestError("account_changed", 409);
    }
    return value;
  }
}

/** The demand-loaded entry: discovery with this browser's local storage, when available. */
export function discoverServerThreadReadReceipts(fetcher: typeof fetch, key: string) {
  let storage: Storage | undefined;
  try {
    storage = window.localStorage;
  } catch {
    /* Private or disabled storage keeps read state in memory only. */
  }
  return ServerThreadReadReceipts.discover(fetcher, { storage, key });
}
