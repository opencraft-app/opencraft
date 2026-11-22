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

export interface RemoteEnvironmentLaunchPort {
  /** One-shot launch configuration for the exact original native Turn. `current`
   * is the caller's own native observer; it is rechecked around decryption. */
  prepare(input: GitExecutionLocator, current?: () => void): Promise<ExecutionEnvironmentSnapshot>;
  close(): void;
}

/** Execution-owner side of opaque ENV delivery. Construct INSIDE the process that
 * launches commands, never in the Gateway. The issuer key arrives through trusted
 * composition; the Gateway only relays the admitted context and the capsule. */
export function createRemoteEnvironmentLaunch(options: {
  purpose: Exclude<EnvironmentLaunchPurpose, "codex">;
  /** The authenticated attachment, e.g. the capability serverId of this owner. */
  instance: string;
  issuer: string;
  capabilities: {
    hostEnvironment(threadId: string, source: HostGitSource, recipient: string, signal?: AbortSignal): Promise<unknown>;
  };
  /** Local native observer: the context must name this live process and Turn. */
  inspect(context: EnvironmentLaunchContext): Promise<boolean>;
}): RemoteEnvironmentLaunchPort {
  const lifecycle = new AbortController();
  let closed = false;
  const receiver = new EnvironmentLaunchReceiver({
    purpose: options.purpose,
    instance: options.instance,
    issuer: options.issuer,
    // Checked before and after decryption; the caller's Turn observer runs
    // around the whole delivery as well.
    authorize: async (expected) => {
      if (closed || !(await options.inspect(expected)) || closed) unavailable();
    },
  });
  return {
    async prepare(raw, current) {
      try {
        const input = parseGitExecutionLocator(raw);
        if (closed || input.hostId !== "opencraft-server") return unavailable();
        const source: HostGitSource =
          input.inputId !== undefined ? { inputId: input.inputId } : { turnId: input.turnId! };
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
          // No personal admission (unowned Turn): an empty launch, never another
          // Human's values. A capsule without admitted context is malformed.
          if (reply.capsule !== undefined) return unavailable();
          return new ExecutionEnvironmentSnapshot(
            { account: null, hostId: input.hostId, threadId: input.threadId, projectId: input.projectId ?? null },
            {},
          );
        }
        const context = reply.context as EnvironmentLaunchContext;
        if (
          !record(context) ||
          !record(context.scope) ||
          !record(context.native) ||
          typeof reply.capsule !== "string" ||
          context.scope.hostId !== input.hostId ||
          context.scope.threadId !== input.threadId ||
          (input.inputId !== undefined && context.scope.inputId !== input.inputId) ||
          (input.turnId !== undefined && context.native.turnId !== input.turnId) ||
          (input.projectId != null && context.scope.projectId !== input.projectId)
        )
          return unavailable();
        // The receiver binds the capsule to this context, this process key and
        // the pinned issuer, and consumes it exactly once.
        const snapshot = await receiver.open(reply.capsule, context);
        if (closed) return unavailable();
        current?.();
        return snapshot;
      } catch {
        return unavailable();
      }
    },
    close() {
      closed = true;
      lifecycle.abort();
      receiver.close();
    },
  };
}
