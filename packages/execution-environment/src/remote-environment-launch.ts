import type { HostGitSource } from "@opencraft/session-capabilities/credentials";
import {
  EnvironmentLaunchReceiver,
  type EnvironmentLaunchContext,
  type EnvironmentLaunchPurpose,
} from "./environment-delivery.js";
import { ExecutionEnvironmentSnapshot } from "./execution-snapshot.js";
import { parseGitExecutionLocator, type GitExecutionLocator } from "./git-execution.js";

const unavailable = (): never => {
  throw Error("environment_launch_unavailable");
};
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** Canonical field order, so a reordered relay cannot pass or fail by accident. */
const canonical = (c: EnvironmentLaunchContext) =>
  JSON.stringify([
    c.scope.account,
    c.scope.hostId,
    c.scope.threadId,
    c.scope.inputId,
    c.scope.executionId,
    c.scope.leaseGeneration,
    c.scope.actorGeneration,
    c.scope.membershipRevision,
    c.scope.projectId,
    c.native.turnId,
    c.native.incarnation,
  ]);

export interface RemoteEnvironmentLaunchPort {
  /** One-shot launch configuration for the exact original native Turn. `current`
   * is the caller's own native observer; it is rechecked around decryption. */
  prepare(input: GitExecutionLocator, current?: () => void): Promise<ExecutionEnvironmentSnapshot>;
  close(): void;
}

/** Execution-owner side of opaque ENV delivery. Construct INSIDE the process that
 * launches commands, never in the Gateway. The issuer key arrives through trusted
 * composition; the Gateway only relays a capsule. The expected context is the
 * owner's own durable admission: a relayed context is only compared with it. */
export function createRemoteEnvironmentLaunch(options: {
  purpose: Exclude<EnvironmentLaunchPurpose, "codex">;
  /** The authenticated attachment, e.g. the capability serverId of this owner. */
  instance: string;
  issuer: string;
  capabilities: {
    hostEnvironment(threadId: string, source: HostGitSource, recipient: string, signal?: AbortSignal): Promise<unknown>;
  };
  /** The execution owner's own durable admission for this launch: Actor account
   * and generation, input, execution, lease generation, native Turn and live
   * process incarnation, with `projectId: null` (the vault owner resolves the
   * Project). `null` means the owner holds no Human admission (an unowned Turn).
   * It must throw when the admission names another process or cannot be read. */
  admission(input: GitExecutionLocator): Promise<EnvironmentLaunchContext | null>;
}): RemoteEnvironmentLaunchPort {
  const lifecycle = new AbortController();
  let closed = false;
  // Durable admission, reread before and after decryption. A change between
  // reads (lease replaced, Turn ended, process replaced) retires the capsule.
  const pinned = new Map<string, { input: GitExecutionLocator; uses: number }>();
  const receiver = new EnvironmentLaunchReceiver({
    purpose: options.purpose,
    instance: options.instance,
    issuer: options.issuer,
    authorize: async (expected) => {
      const entry = pinned.get(canonical(expected));
      if (closed || !entry) return unavailable();
      const current = await options.admission(entry.input);
      if (closed || !current || canonical(current) !== canonical(expected)) unavailable();
    },
  });
  return {
    async prepare(raw, current) {
      try {
        const input = parseGitExecutionLocator(raw);
        if (closed || input.hostId !== "opencraft-server" || input.projectId != null) return unavailable();
        const source: HostGitSource =
          input.inputId !== undefined ? { inputId: input.inputId } : { turnId: input.turnId! };
        current?.();
        const owned = await options.admission(input);
        if (closed) return unavailable();
        current?.();
        const reply = await options.capabilities.hostEnvironment(
          input.threadId,
          source,
          receiver.target.key,
          lifecycle.signal,
        );
        if (closed || !record(reply) || Object.keys(reply).some((k) => !["context", "capsule"].includes(k)))
          return unavailable();
        current?.();
        if (reply.context === null) {
          // No personal admission on either side (unowned Turn): an empty launch,
          // never another Human's values. A capsule without context is malformed,
          // and a Gateway that denies an admission the owner holds is refused.
          if (reply.capsule !== undefined || owned !== null) return unavailable();
          return new ExecutionEnvironmentSnapshot(
            { account: null, hostId: input.hostId, threadId: input.threadId, projectId: null },
            {},
          );
        }
        const relayed = reply.context as EnvironmentLaunchContext;
        if (
          owned === null ||
          !record(relayed) ||
          !record(relayed.scope) ||
          !record(relayed.native) ||
          typeof reply.capsule !== "string" ||
          owned.scope.hostId !== input.hostId ||
          owned.scope.threadId !== input.threadId ||
          (input.inputId !== undefined && owned.scope.inputId !== input.inputId) ||
          (input.turnId !== undefined && owned.native.turnId !== input.turnId) ||
          owned.scope.projectId !== null ||
          canonical(relayed) !== canonical(owned)
        )
          return unavailable();
        // The receiver binds the capsule to the OWNER's context, this process key
        // and the pinned issuer, and consumes it exactly once.
        const key = canonical(owned);
        const entry = pinned.get(key) ?? { input, uses: 0 };
        entry.uses++;
        pinned.set(key, entry);
        let snapshot: ExecutionEnvironmentSnapshot;
        try {
          snapshot = await receiver.open(reply.capsule, owned);
        } finally {
          if (--entry.uses === 0) pinned.delete(key);
        }
        if (closed) return unavailable();
        current?.();
        return snapshot;
      } catch {
        return unavailable();
      }
    },
    close() {
      closed = true;
      pinned.clear();
      lifecycle.abort();
      receiver.close();
    },
  };
}
