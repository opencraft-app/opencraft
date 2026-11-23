import { createHmac, randomBytes } from "node:crypto";
import {
  canonicalEnvironmentLaunchAdmission,
  type EnvironmentCreationAdmission,
  type EnvironmentLaunchAdmission,
  type EnvironmentTurnAdmission,
} from "@opencraft/execution-environment/environment-delivery";
import {
  createEnvironmentLaunchAdmissionReceiver,
  environmentLaunchLocator,
  type EnvironmentLaunchLocator,
} from "@opencraft/execution-environment/environment-launch-receiver";

/** Private request field: the opaque launch a creation or Thread reload installs.
 * It names a staged delivery; it never carries values. */
export const ENVIRONMENT_LAUNCH_FIELD = "__opencraftEnvironmentLaunch";
const POLICY = "shell_environment_policy.set";
const STAGE_TTL_MS = 60_000;
const MAX_STAGED = 256;
const MAX_APPLIED = 256;

export interface CodexEnvironmentLaunchOptions {
  /** Issuer key pinned through this process's own configuration. */
  readonly issuer: string;
  /** The authenticated attachment of this owner, e.g. `server:<machine>:codex`. */
  readonly instance: string;
  /** This owner's own durable admission for `locator`, read off this event loop.
   * `null` only for a pending input without a Human owner; rejects otherwise. */
  admission(locator: EnvironmentLaunchLocator): Promise<EnvironmentLaunchAdmission | null>;
  /** The live incarnation of the native process this owner launches. */
  incarnation(): Promise<string>;
  readonly now?: () => number;
}
export interface CodexEnvironmentLaunch {
  /** What an execution adapter needs to request a capsule for this owner. */
  capability(): { version: 1; purpose: "codex"; instance: string; key: string; kinds: readonly string[] };
  /** Opens a relayed reply `{locator, reply}` and holds the values here. The
   * result is an opaque digest that changes with the account and the values. */
  stage(params: unknown): Promise<{ key: string }>;
  /** Installs a staged delivery into a native creation or Thread reload as
   * `shell_environment_policy.set`. Requests without the field pass unchanged. */
  apply(method: unknown, params: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Replaces every installed value in strings of `value`. */
  redact(value: unknown): unknown;
  close(): void;
}

const unavailable = (): never => {
  throw Error("environment_launch_unavailable");
};
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
const canonical = (a: EnvironmentLaunchAdmission | null) =>
  a === null ? "null" : canonicalEnvironmentLaunchAdmission(a);

/** The ENV receiver of the Codex Core process that owns `codex app-server`. The
 * execution adapter only relays opaque capsules and non-secret locators; values
 * are opened here, against this owner's own durable admission (Decision 1), and
 * reach the native server only as its Thread configuration. Every failure is
 * closed: there is no fallback to an empty or a relayed environment. */
export function createCodexEnvironmentLaunch(options: CodexEnvironmentLaunchOptions): CodexEnvironmentLaunch {
  const now = options.now ?? Date.now;
  const secret = randomBytes(32);
  let closed = false;
  // The admission must name this live native process.
  const read = async (locator: EnvironmentLaunchLocator): Promise<EnvironmentLaunchAdmission | null> => {
    if (closed || locator.hostId !== "local-codex") return unavailable();
    const value = await options.admission(locator);
    if (closed) return unavailable();
    if (value !== null && value.incarnation !== (await options.incarnation())) return unavailable();
    if (closed) return unavailable();
    return value;
  };
  const receiver = createEnvironmentLaunchAdmissionReceiver({
    purpose: "codex",
    instance: options.instance,
    issuer: options.issuer,
    admission: {
      turn: async (locator) => (await read(locator)) as EnvironmentTurnAdmission | null,
      creation: async (locator) => (await read(locator)) as EnvironmentCreationAdmission | null,
    },
  });
  const staged = new Map<
    string,
    { key: string; values: Readonly<Record<string, string>>; admission: string; expires: number }
  >();
  const applied: Readonly<Record<string, string>>[] = [];
  const locatorKey = (locator: EnvironmentLaunchLocator) => JSON.stringify(locator);
  return {
    capability() {
      if (closed) return unavailable();
      return {
        version: 1,
        purpose: "codex",
        instance: receiver.target.instance,
        key: receiver.target.key,
        kinds: receiver.kinds,
      };
    },
    async stage(params) {
      try {
        if (closed || !record(params) || !exact(params, ["locator", "reply"])) return unavailable();
        const locator = environmentLaunchLocator(params.locator);
        const snapshot = await receiver.open(locator, params.reply);
        // The record the values were opened against; the launch rereads it.
        const owned = await read(locator);
        const values = Object.freeze(snapshot.overlay());
        const entries = Object.entries(values).sort(([a], [b]) => (a < b ? -1 : 1));
        const key = createHmac("sha256", secret)
          .update(JSON.stringify([snapshot.account, entries]))
          .digest("base64url");
        for (const [name, entry] of staged) if (entry.expires <= now()) staged.delete(name);
        if (staged.size >= MAX_STAGED) staged.delete(staged.keys().next().value!);
        staged.set(locatorKey(locator), { key, values, admission: canonical(owned), expires: now() + STAGE_TTL_MS });
        return { key };
      } catch {
        return unavailable();
      }
    },
    async apply(method, params) {
      if (!Object.hasOwn(params, ENVIRONMENT_LAUNCH_FIELD)) return params;
      try {
        const { [ENVIRONMENT_LAUNCH_FIELD]: field, ...rest } = params;
        if (closed || !record(field) || !exact(field, ["locator", "key"]) || typeof field.key !== "string")
          return unavailable();
        const locator = environmentLaunchLocator(field.locator);
        // One launch per staged delivery, consumed before any await.
        const entry = staged.get(locatorKey(locator));
        staged.delete(locatorKey(locator));
        if (!entry || entry.key !== field.key || entry.expires <= now()) return unavailable();
        const owned = await read(locator);
        if (canonical(owned) !== entry.admission) return unavailable();
        // The request must be the launch its record admits.
        const threadId = typeof rest.threadId === "string" ? rest.threadId : null;
        if (locator.kind === "turn") {
          if (method !== "thread/resume" || threadId !== locator.threadId) return unavailable();
        } else if (locator.kind === "creation") {
          const source = (owned as EnvironmentCreationAdmission | null)?.source;
          if (
            !owned ||
            !(method === "thread/start"
              ? source === null && !threadId
              : method === "thread/fork" && source === threadId)
          )
            return unavailable();
        } else return unavailable();
        const config = record(rest.config) ? { ...rest.config } : {};
        const current = config[POLICY];
        if (current !== undefined && !record(current)) return unavailable();
        // Git configuration may arrive from the adapter; a delivered name never
        // shadows it, and the adapter never sends a delivered value.
        for (const name of Object.keys(entry.values))
          if (record(current) && Object.hasOwn(current, name)) unavailable();
        config[POLICY] = { ...(record(current) ? current : {}), ...entry.values };
        if (Object.keys(entry.values).length) {
          if (applied.length >= MAX_APPLIED) applied.shift();
          applied.push(entry.values);
        }
        if (closed) return unavailable();
        return { ...rest, config };
      } catch {
        return unavailable();
      }
    },
    redact(value) {
      const secrets = [...new Set(applied.flatMap((values) => Object.values(values)).filter(Boolean))].sort(
        (a, b) => b.length - a.length,
      );
      if (!secrets.length) return value;
      const visit = (item: unknown): unknown => {
        if (typeof item === "string") {
          let text = item;
          for (const secret of secrets) text = text.replaceAll(secret, "[REDACTED]");
          return text;
        }
        if (Array.isArray(item)) return item.map(visit);
        if (record(item)) return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, visit(entry)]));
        return item;
      };
      return visit(value);
    },
    close() {
      closed = true;
      staged.clear();
      applied.length = 0;
      secret.fill(0);
      receiver.close();
    },
  };
}
