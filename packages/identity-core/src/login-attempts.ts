/**
 * Login attempt budget: refuses password attempts before any password
 * derivation runs. Runtime-neutral; the composition picks where the counts
 * live. Node keeps them in the process that derives (it is the only one);
 * Cloudflare keeps them in the single-writer Durable Object's storage through
 * `stateLoginAttemptLimiter`, so restarts, evictions and other isolates see
 * the same counts. See docs/architecture/platform/gateway-split.md §3.4.
 */

export interface LoginAttemptKey {
  /** Scope-qualified bucket name, e.g. `auth/address/198.51.100.7`. */
  readonly key: string;
  /** Attempts the bucket admits within one window */
  readonly limit: number;
}

export interface LoginAttemptLimiter {
  /**
   * Counts one attempt against each key in order and resolves true only when
   * every key stayed within its limit. Counting stops at the first key over
   * its limit. A key not yet tracked is refused while the ledger already holds
   * its maximum number of live keys. Rejects when the counts cannot be read or
   * written; callers then refuse the attempt.
   */
  take(keys: readonly LoginAttemptKey[], now: number): Promise<boolean>;
}

export const LOGIN_ATTEMPT_WINDOW_MS = 60_000;
/** Per-window budgets: every attempt of a scope, one client address, one login identifier. */
export const LOGIN_ATTEMPT_LIMITS = Object.freeze({ global: 60, address: 12, account: 12 });
const MAX_KEYS = 1024;

export interface LoginAttemptOptions {
  readonly windowMs?: number;
  /** Live keys kept per ledger; new keys beyond it are refused until entries expire. */
  readonly maxKeys?: number;
}

/** Same comparison form for every runtime; the identifier itself is never resolved to an account. */
export function normalizeLoginIdentifier(value: unknown): string {
  return typeof value === "string" && value.length <= 256 ? value.trim().toLowerCase() : "";
}

/** Buckets checked before a request body is read: the scope's global ceiling and the client address. */
export function loginRequestKeys(scope: string, clientAddress: string | null): LoginAttemptKey[] {
  return [
    { key: `${scope}/global`, limit: LOGIN_ATTEMPT_LIMITS.global },
    { key: `${scope}/address/${clientAddress ?? "unknown"}`, limit: LOGIN_ATTEMPT_LIMITS.address },
  ];
}

/** Bucket checked once the login identifier is known, before the password is derived. */
export function loginAccountKeys(scope: string, identifier: unknown): LoginAttemptKey[] {
  return [{ key: `${scope}/account/${normalizeLoginIdentifier(identifier)}`, limit: LOGIN_ATTEMPT_LIMITS.account }];
}

interface Entry {
  until: number;
  count: number;
}

function take(
  entries: Map<string, Entry>,
  keys: readonly LoginAttemptKey[],
  now: number,
  windowMs: number,
  maxKeys: number,
): boolean {
  for (const [key, entry] of entries) if (entry.until <= now) entries.delete(key);
  for (const { key, limit } of keys) {
    let entry = entries.get(key);
    if (!entry) {
      if (entries.size >= maxKeys) return false;
      entries.set(key, (entry = { until: now + windowMs, count: 0 }));
    }
    if (++entry.count > limit) return false;
  }
  return true;
}

/** In-process ledger: the Node composition, where one process performs every derivation. */
export function memoryLoginAttemptLimiter(options: LoginAttemptOptions = {}): LoginAttemptLimiter {
  const entries = new Map<string, Entry>();
  const windowMs = options.windowMs ?? LOGIN_ATTEMPT_WINDOW_MS,
    maxKeys = options.maxKeys ?? MAX_KEYS;
  return { take: async (keys, now) => take(entries, keys, now, windowMs, maxKeys) };
}

/** Structural subset of `@opencraft/document-storage/state` StateDocumentStore. */
export interface LoginAttemptDocuments {
  update<T>(
    key: string,
    change: (current: unknown | null) => { readonly result: T; readonly next?: unknown },
  ): Promise<T>;
}

const DIGEST = /^[0-9a-f]{32}$/u;
function ledger(document: unknown): Map<string, Entry> {
  const entries = new Map<string, Entry>();
  const rows = (document as { v?: unknown; entries?: unknown } | null)?.entries;
  // An unrecognized document starts a fresh window rather than locking every login out.
  if ((document as { v?: unknown } | null)?.v !== 1 || !Array.isArray(rows)) return entries;
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== 3) continue;
    const [key, until, count] = row as unknown[];
    if (typeof key === "string" && DIGEST.test(key) && Number.isSafeInteger(until) && Number.isSafeInteger(count))
      entries.set(key, { until: until as number, count: count as number });
  }
  return entries;
}

async function digest(text: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(bytes.subarray(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Durable ledger in one state document of the single-writer owner (Cloudflare:
 * the login Durable Object's storage). Each `take` is one atomic update, so
 * concurrent requests and later isolates share the counts. Bucket names are
 * stored as truncated SHA-256 digests: storage holds no client address or
 * login identifier.
 */
export function stateLoginAttemptLimiter(
  documents: LoginAttemptDocuments,
  options: LoginAttemptOptions & { readonly document?: string } = {},
): LoginAttemptLimiter {
  const windowMs = options.windowMs ?? LOGIN_ATTEMPT_WINDOW_MS,
    maxKeys = options.maxKeys ?? MAX_KEYS;
  const name = options.document ?? "login-attempts";
  return {
    async take(keys, now) {
      const hashed = await Promise.all(keys.map(async ({ key, limit }) => ({ key: await digest(key), limit })));
      return documents.update(name, (current) => {
        const entries = ledger(current);
        const admitted = take(entries, hashed, now, windowMs, maxKeys);
        return {
          result: admitted,
          next: { v: 1, entries: [...entries].map(([key, entry]) => [key, entry.until, entry.count]) },
        };
      });
    },
  };
}
