import type { GitExecutionLocator } from "@opencraft/execution-environment/git-execution";
import type { HumanGitHostStatus, HumanGitStatus } from "@opencraft/execution-environment/human-git-execution";
import type { CapabilitySession, CapabilityTool, SessionCapabilityProvider } from "@opencraft/session-capabilities";

/** The human Git execution owner, narrowed to the read this provider needs. */
export interface GitStatusOwner {
  status(locator: GitExecutionLocator): Promise<HumanGitStatus | null>;
}

export interface GitStatusResult {
  /** True when at least one configured host has a personal credential bound. */
  readonly available: boolean;
  readonly hosts: readonly HumanGitHostStatus[];
}

export const GIT_STATUS_TOOL = "git_identity_status";

const tool: CapabilityTool = {
  name: GIT_STATUS_TOOL,
  description:
    "Report whether the person who started this run has a personal Git identity bound for each configured Git host: the transport it authenticates with, whether commits are signed, and the bound username. The Host applies that identity to ordinary git commands in this run; this tool never returns tokens or keys. If no host is bound, ask the person to connect one in their Git settings; do not fall back to credentials found in the repository or a shared account.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  approval: "preauthorized",
};

const gitHosts = new Set<string>(["local-codex", "opencraft-server"]);

/** Only a core-verified human run with an active lease can be located; model
 * arguments never select the thread, input or account. */
function locate(session: CapabilitySession): GitExecutionLocator | null {
  const context = session.context;
  if (!context?.actor || !context.lease || !gitHosts.has(context.host.id)) return null;
  return {
    hostId: context.host.id as GitExecutionLocator["hostId"],
    threadId: session.threadId,
    inputId: context.lease.inputId,
  };
}

function emptyArguments(args: unknown): boolean {
  return (
    args === undefined || (!!args && typeof args === "object" && !Array.isArray(args) && Object.keys(args).length === 0)
  );
}

/** Read-only session capability over the human Git execution owner. It is
 * absent from the catalog and rejects calls unless core resolved the run's
 * Host, verified Actor and active lease, and the owner confirms that lease. */
export function createGitStatusCapability(owner: GitStatusOwner): SessionCapabilityProvider {
  return {
    id: "opencraft.git-status",
    tools: (session) => (locate(session) ? [tool] : []),
    async call(session, name, args, signal) {
      if (name !== GIT_STATUS_TOOL || !emptyArguments(args)) throw new Error("invalid_git_status_request");
      signal.throwIfAborted();
      const locator = locate(session);
      if (!locator) throw new Error("git_status_unavailable");
      const status = await owner.status(locator);
      signal.throwIfAborted();
      const { actor, lease } = session.context!;
      if (
        !status ||
        status.account !== `actor:${actor!.id}` ||
        status.executionId !== lease!.executionId ||
        status.leaseGeneration !== lease!.generation
      )
        throw new Error("git_status_unavailable");
      const hosts = status.hosts.map(({ host, bound, transport, signing, username }) => ({
        host,
        bound,
        transport,
        signing,
        username,
      }));
      return { available: hosts.some((host) => host.bound), hosts } satisfies GitStatusResult;
    },
  };
}
