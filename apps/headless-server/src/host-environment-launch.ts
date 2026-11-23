import type { CapabilitySession } from "@opencraft/session-capabilities";
import type {
  EnvironmentLaunchContext,
  EnvironmentLaunchTarget,
} from "@opencraft/execution-environment/environment-delivery";
import type { GitExecutionHandoff, GitExecutionLocator } from "@opencraft/execution-environment/git-execution";

/** Trusted composition port of the sole ENV vault owner (for example a Worker).
 * Main passes only routing metadata and receives an opaque capsule. */
export interface EnvironmentLaunchIssuerPort {
  /** Issuer X25519 public key pinned into execution owners. */
  readonly issuer: string;
  seal(target: EnvironmentLaunchTarget, context: EnvironmentLaunchContext): Promise<string>;
}
export type HostEnvironmentReply =
  { readonly context: null } | { readonly context: EnvironmentLaunchContext; readonly capsule: string };

// Only attachments whose execution owner constructs a receiver are listed: the
// DSH capability plugin and the independent Pi engine host.
const purposes = new Set(["dsh", "pi"]);
const same = (a: Pick<GitExecutionHandoff, "scope" | "native">, b: Pick<GitExecutionHandoff, "scope" | "native">) =>
  JSON.stringify([a.scope, a.native]) === JSON.stringify([b.scope, b.native]);

/** Gateway relay for `/host-environment`. Admission comes from the same live
 * Actor/lease handoff as Git; the attachment, not the request, selects purpose
 * and instance. Any change during sealing discards the capsule. */
export function createHostEnvironmentLaunch(options: {
  port: EnvironmentLaunchIssuerPort;
  /** Current admitted execution handoff (Actor, lease and native incarnation
   * checked). Only its scope and native identity are used. */
  handoff(input: GitExecutionLocator): Promise<Pick<GitExecutionHandoff, "scope" | "native"> | null>;
  /** The authenticated attachment still routes this Thread to this Host. */
  routes(session: CapabilitySession): boolean;
}): (session: CapabilitySession, recipient: string) => Promise<HostEnvironmentReply> {
  return async (session, recipient) => {
    const purpose = session.serverId.split(":").at(-1) ?? "";
    const execution = session.execution;
    if (!purposes.has(purpose) || !options.routes(session) || !execution || !execution.inputId === !execution.turnId)
      throw Error("environment_launch_unavailable");
    const locator: GitExecutionLocator = {
      hostId: "opencraft-server",
      threadId: session.threadId,
      ...(execution.inputId ? { inputId: execution.inputId } : { turnId: execution.turnId! }),
    };
    const admitted = await options.handoff(locator);
    if (!admitted) return { context: null };
    const context: EnvironmentLaunchContext = { scope: admitted.scope, native: admitted.native };
    const capsule = await options.port.seal(
      { purpose: purpose as "dsh" | "pi", instance: session.serverId, key: recipient },
      context,
    );
    const latest = await options.handoff(locator);
    if (typeof capsule !== "string" || !latest || !same(latest, admitted) || !options.routes(session))
      throw Error("environment_launch_unavailable");
    return { context, capsule };
  };
}
