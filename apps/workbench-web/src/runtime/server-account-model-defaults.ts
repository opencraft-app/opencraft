import {
  parseAccountModelDefaultsRecord,
  type AccountModelDefaultsPort,
  type AccountModelDefaultsRecord,
  type AccountModelDefaultsSource,
  type AccountModelSelection,
} from "@opencraft/workbench-runtime";

export const ACCOUNT_MODEL_DEFAULTS_PATH = "/__opencraft_model_defaults";

/** A refused or failed request; `code` is the server's stable error code. */
export class AccountModelDefaultsRequestError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
    this.name = "AccountModelDefaultsRequestError";
  }
}

function actorOf(value: unknown): string {
  const actorId = (value as { actorId?: unknown } | null)?.actorId;
  if (typeof actorId !== "string" || !actorId || actorId.length > 512)
    throw new Error("Invalid model defaults account");
  return actorId;
}

async function failure(response: Response): Promise<AccountModelDefaultsRequestError> {
  let code = "model_defaults_unavailable";
  try {
    const value = (await response.json()) as { error?: unknown };
    if (typeof value.error === "string" && /^[a-z_]{1,64}$/u.test(value.error)) code = value.error;
  } catch {
    /* Keep the generic code for non-JSON failures. */
  }
  return new AccountModelDefaultsRequestError(code, response.status);
}

/**
 * Personal model defaults of the server's own logins (local accounts, OIDC and other
 * verified identity sources). The server keys records by the signed-in human Actor;
 * the scope is that Actor's ID and only fences an account change between requests.
 * Nothing is cached in browser storage.
 */
export class ServerAccountModelDefaults implements AccountModelDefaultsSource {
  readonly id = "opencraft.server-account";
  private readonly listeners = new Set<() => void>();
  private generation = 0;

  private constructor(
    private readonly fetcher: typeof fetch,
    private scope: string | null,
  ) {}

  /**
   * Resolves only when the server serves personal defaults to a signed-in human. Servers
   * without the route, and unreachable servers, leave installation memory in place.
   */
  static async discover(
    fetcher: typeof fetch,
    signal: AbortSignal = AbortSignal.timeout(5000),
  ): Promise<ServerAccountModelDefaults | undefined> {
    try {
      const response = await fetcher(ACCOUNT_MODEL_DEFAULTS_PATH, {
        credentials: "same-origin",
        cache: "no-store",
        signal,
      });
      // Signed-out and anonymous visitors keep installation memory; a later sign-in reloads.
      if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) return undefined;
      return new ServerAccountModelDefaults(fetcher, actorOf(await response.json()));
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
      const response = await this.fetcher(ACCOUNT_MODEL_DEFAULTS_PATH, {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (response.status === 401 || response.status === 403) next = null;
      else if (response.ok) next = actorOf(await response.json());
      else return;
    } catch {
      return;
    }
    if (generation !== this.generation || next === this.scope) return;
    this.scope = next;
    for (const listener of this.listeners) listener();
  };

  readonly port: AccountModelDefaultsPort = {
    read: async (scope, hostId, signal) => {
      const query = new URLSearchParams({ hostId, expectedActorId: scope });
      const response = await this.fetcher(`${ACCOUNT_MODEL_DEFAULTS_PATH}?${query}`, {
        credentials: "same-origin",
        cache: "no-store",
        signal,
      });
      return this.record(response, scope);
    },
    write: async (scope, hostId, revision, selection: AccountModelSelection, signal) => {
      const response = await this.fetcher(ACCOUNT_MODEL_DEFAULTS_PATH, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hostId, revision, selection, expectedActorId: scope }),
      });
      return this.record(response, scope);
    },
  };

  private async record(response: Response, scope: string): Promise<AccountModelDefaultsRecord> {
    if (!response.ok) {
      const error = await failure(response);
      if (error.status === 401 || error.status === 403 || error.code === "account_changed") void this.refresh();
      throw error;
    }
    const value: unknown = await response.json();
    if (actorOf(value) !== scope) throw new AccountModelDefaultsRequestError("account_changed", 409);
    return parseAccountModelDefaultsRecord(value);
  }
}
