import {
  parseThreadReadReceipts,
  type ThreadReadReceiptPort,
  type ThreadReadReceiptSource,
} from "@opencraft/workbench-runtime";

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

type Hint = Pick<Storage, "getItem" | "setItem" | "removeItem">;

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

const json = (response: Response) => response.headers.get("content-type")?.includes("application/json") === true;

/**
 * Cross-device read receipts of the server's own logins (local accounts, OIDC and other
 * verified identity sources). The server keys receipts by the signed-in human Actor; the
 * scope is that Actor's ID and only fences an account change between requests. Reads are
 * incremental: the port returns only receipts recorded after the last page it returned for
 * the current scope. A remembered Actor (a display hint, never a credential) lets a device
 * that starts offline keep showing and queueing its own reads until the server answers.
 */
export class ServerThreadReadReceipts implements ThreadReadReceiptSource {
  readonly id = "opencraft.server-account";
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private cursor: { readonly scope: string; readonly value: number } | null = null;

  private constructor(
    private readonly fetcher: typeof fetch,
    private scope: string | null,
    private readonly hint: Hint | undefined,
    private readonly hintKey: string,
  ) {}

  /**
   * Resolves when the server serves read receipts, with a null scope while nobody is signed
   * in. A server without the route resolves undefined and the device keeps local read state.
   */
  static async discover(
    fetcher: typeof fetch,
    options: { readonly hint?: Hint; readonly hintKey: string; readonly signal?: AbortSignal },
  ): Promise<ServerThreadReadReceipts | undefined> {
    const remember = (actorId: string | null) => {
      try {
        if (actorId === null) options.hint?.removeItem(options.hintKey);
        else options.hint?.setItem(options.hintKey, actorId);
      } catch {
        /* The hint only restores offline display; storage may be unavailable. */
      }
    };
    let response: Response;
    try {
      response = await fetcher(THREAD_READ_RECEIPTS_PATH, {
        credentials: "same-origin",
        cache: "no-store",
        signal: options.signal ?? AbortSignal.timeout(5000),
      });
    } catch {
      // Offline: keep the last verified person's read state; the server rechecks on reconnect.
      let actorId: string | null = null;
      try {
        actorId = actorOf({ actorId: options.hint?.getItem(options.hintKey) });
      } catch {
        return undefined;
      }
      return new ServerThreadReadReceipts(fetcher, actorId, options.hint, options.hintKey);
    }
    try {
      if (response.status === 401 || response.status === 403) {
        remember(null);
        return new ServerThreadReadReceipts(fetcher, null, options.hint, options.hintKey);
      }
      if (!response.ok || !json(response)) {
        if (response.status === 404 || response.ok) remember(null);
        return undefined;
      }
      const actorId = actorOf(await response.json());
      remember(actorId);
      return new ServerThreadReadReceipts(fetcher, actorId, options.hint, options.hintKey);
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
    try {
      if (next === null) this.hint?.removeItem(this.hintKey);
      else this.hint?.setItem(this.hintKey, next);
    } catch {
      /* Display hint only. */
    }
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
      const receipts = parseThreadReadReceipts((value as { receipts?: unknown }).receipts);
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
      return parseThreadReadReceipts(((await this.page(response, scope)) as { receipts?: unknown }).receipts);
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
