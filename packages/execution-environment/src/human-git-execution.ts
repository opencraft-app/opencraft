import { isAbsolute, join } from "node:path";
import { personalGitSocketPaths } from "./personal-git-sockets.js";
import type { GitGrantScope } from "@opencraft/execution-environment/personal-git-protocol";
import { PersonalGitEnvironment, type PersonalGitGrant } from "@opencraft/execution-environment/personal-git";
import { ExecutionEnvironmentSnapshot } from "@opencraft/execution-environment/execution-snapshot";
import type {
  GitExecutionLocator,
  GitExecutionHandoff,
  GitExecutionReservation,
} from "@opencraft/execution-environment/git-execution";
/** Compiled deployment assembly: a configured shared IPC mount must remain
 * visible at the same absolute path in the command execution namespace. Owner
 * categories avoid discovering a broker with a different native observer. */
export function humanGitRuntimeDirectory(
  fallback: string,
  owner: "gateway" | "codex" | "pi" | "dsh",
  configured = process.env.OPENCRAFT_GIT_RUNTIME_DIRECTORY,
): string {
  if (configured === undefined) return fallback;
  if (!["gateway", "codex", "pi", "dsh"].includes(owner) || !isAbsolute(configured) || configured.includes("\0"))
    throw Error("git_ipc_directory_unavailable");
  const directory = join(configured, owner);
  // A private /tmp fallback cannot cross container mount namespaces. Reject an
  // overlong explicitly shared directory instead of silently selecting it.
  if (personalGitSocketPaths(directory, "owner-000000000000", process.getuid?.() ?? 0).root)
    throw Error("git_shared_ipc_directory_too_long");
  return directory;
}

/** Non-secret binding state of one configured Git host for the run's Actor. */
export interface HumanGitHostStatus {
  readonly host: string;
  readonly bound: boolean;
  /** Transport the bound credential authenticates with; null when unbound. */
  readonly transport: "ssh" | "https" | null;
  readonly signing: boolean;
  readonly username: string | null;
}
/** Binding state for the exact live lease the owner verified. */
export interface HumanGitStatus {
  readonly account: string;
  readonly executionId: string;
  readonly leaseGeneration: number;
  readonly hosts: readonly HumanGitHostStatus[];
}

export interface HumanGitExecutionPort {
  prepare(input: GitExecutionLocator): Promise<ExecutionEnvironmentSnapshot>;
  reserve(input: GitExecutionLocator): Promise<ExecutionEnvironmentSnapshot>;
  handoff(input: GitExecutionLocator): Promise<GitExecutionHandoff | null>;
  /** Null when the run has no personal Git authority; rejects when it cannot
   * be verified now. */
  status(input: GitExecutionLocator): Promise<HumanGitStatus | null>;
  close(): Promise<void>;
}
/** Compiled host composition only. No browser route, raw credential read, or
 * fallback to a second synchronous vault owner belongs to this port. */
export function createHumanGitExecution(options: {
  directory: string;
  runtimeDirectory: string;
  workerFile: string;
  hosts: readonly string[];
  authority: string;
  grant(input: GitExecutionLocator): Promise<GitExecutionHandoff | null>;
  inspect(handoff: GitExecutionHandoff): Promise<boolean>;
  authorize(scope: GitGrantScope): boolean | Promise<boolean>;
  reservation?: {
    grant(input: GitExecutionLocator): Promise<GitExecutionReservation | null>;
    inspect(value: GitExecutionReservation): Promise<boolean>;
  };
}): HumanGitExecutionPort {
  let bridge: PersonalGitEnvironment | undefined,
    closed = false;
  async function current(handoff: GitExecutionHandoff) {
    if (closed || !(await options.authorize(handoff.scope)) || closed) return false;
    if (!(await options.inspect(handoff)) || closed) return false;
    return (await options.authorize(handoff.scope)) && !closed;
  }
  async function checkedHandoff(input: GitExecutionLocator) {
    if (closed) throw Error("git_execution_unavailable");
    const handoff = await options.grant(input);
    if (closed) throw Error("git_execution_unavailable");
    if (handoff && (handoff.authority !== options.authority || !(await current(handoff))))
      throw Error("git_execution_unavailable");
    if (closed) throw Error("git_execution_unavailable");
    return handoff;
  }
  async function checkedReservation(input: GitExecutionLocator) {
    if (closed || !options.reservation || input.hostId !== "local-codex" || !input.inputId || input.turnId)
      throw Error("git_execution_unavailable");
    const handoff = await options.reservation.grant(input);
    if (closed) throw Error("git_execution_unavailable");
    if (
      handoff &&
      (handoff.authority !== options.authority ||
        !(await options.authorize(handoff.scope)) ||
        closed ||
        !(await options.reservation.inspect(handoff)) ||
        closed ||
        !(await options.authorize(handoff.scope)) ||
        closed)
    )
      throw Error("git_execution_unavailable");
    return handoff;
  }
  function broker() {
    bridge ??= new PersonalGitEnvironment(
      options.directory,
      options.runtimeDirectory,
      options.workerFile,
      options.hosts,
      {
        authority: options.authority,
        seal() {
          throw Error("async_git_issuer_required");
        },
      },
      "execution",
      {
        accountMode: "actor",
        authorize: async (scope) => {
          const latest = await options.grant({
            hostId: scope.hostId,
            threadId: scope.threadId,
            inputId: scope.inputId,
          });
          if (
            !latest ||
            latest.scope.account !== scope.account ||
            latest.scope.executionId !== scope.executionId ||
            latest.scope.leaseGeneration !== scope.leaseGeneration ||
            latest.scope.actorGeneration !== scope.actorGeneration ||
            latest.scope.membershipRevision !== scope.membershipRevision
          )
            return false;
          return current(latest);
        },
      },
    );
    return bridge;
  }
  function snapshot(handoff: GitExecutionHandoff | GitExecutionReservation, grant: PersonalGitGrant) {
    return new ExecutionEnvironmentSnapshot(
      handoff.scope,
      {},
      {
        get ready() {
          return grant.ready;
        },
        environment: Object.freeze({ ...grant.environment, OPENCRAFT_GIT_NODE: process.execPath }),
        bindThread: (id) => grant.bindThread(id),
        bindExecution: (input, id) => grant.bindExecution(input, id),
      },
    );
  }
  async function prepare(input: GitExecutionLocator, pending: boolean) {
    const read = pending ? checkedReservation : checkedHandoff;
    const handoff = await read(input);
    if (!handoff)
      return new ExecutionEnvironmentSnapshot({ account: null, ...input, projectId: input.projectId ?? null }, {});
    const grant = broker().grantSealed(handoff.scope, handoff.capability, handoff.authority);
    await grant.ready;
    // Broker readiness never turns a pending admission into command authority.
    // The command port still obtains an active handoff for every actual use.
    const latest = await read(input);
    if (
      closed ||
      !latest ||
      latest.authority !== handoff.authority ||
      JSON.stringify(latest.scope) !== JSON.stringify(handoff.scope) ||
      JSON.stringify(latest.native) !== JSON.stringify(handoff.native)
    )
      throw Error("git_execution_unavailable");
    return snapshot(handoff, grant);
  }
  async function status(input: GitExecutionLocator): Promise<HumanGitStatus | null> {
    const handoff = await checkedHandoff(input);
    if (!handoff) return null;
    const value = await broker().grantStatus(handoff.capability, handoff.scope.threadId);
    if (closed) throw Error("git_execution_unavailable");
    return {
      account: handoff.scope.account,
      executionId: handoff.scope.executionId,
      leaseGeneration: handoff.scope.leaseGeneration,
      hosts: hostStatuses(value, options.hosts),
    };
  }
  return {
    handoff: checkedHandoff,
    status,
    prepare: (input) => prepare(input, false),
    reserve: (input) => prepare(input, true),
    async close() {
      closed = true;
      await bridge?.close();
    },
  };
}

/** Worker replies are re-validated: only the configured hosts and the known
 * non-secret fields cross into the caller. */
function hostStatuses(value: unknown, hosts: readonly string[]): HumanGitHostStatus[] {
  const rows = (value as { hosts?: unknown } | null)?.hosts;
  if (!Array.isArray(rows)) throw Error("git_execution_unavailable");
  return hosts.map((host) => {
    const row = rows.find((candidate) => (candidate as { host?: unknown } | null)?.host === host) as
      | Record<string, unknown>
      | undefined;
    if (!row || typeof row.bound !== "boolean") throw Error("git_execution_unavailable");
    const transport = row.bound && (row.transport === "ssh" || row.transport === "https") ? row.transport : null;
    const username =
      row.bound && typeof row.username === "string" && row.username.length <= 256 && !/[\x00-\x1f\x7f]/u.test(row.username)
        ? row.username
        : null;
    return { host, bound: row.bound, transport, signing: row.bound && row.signing === true, username };
  });
}
