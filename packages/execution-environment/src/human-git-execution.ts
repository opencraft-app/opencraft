import type { GitGrantScope } from "@opencraft/execution-environment/personal-git-protocol";
import { PersonalGitEnvironment, type PersonalGitGrant } from "@opencraft/execution-environment/personal-git";
import { ExecutionEnvironmentSnapshot } from "@opencraft/execution-environment/execution-snapshot";
import type {
  GitExecutionLocator,
  GitExecutionHandoff,
  GitExecutionReservation,
} from "@opencraft/execution-environment/git-execution";
export interface HumanGitExecutionPort {
  prepare(input: GitExecutionLocator): Promise<ExecutionEnvironmentSnapshot>;
  reserve(input: GitExecutionLocator): Promise<ExecutionEnvironmentSnapshot>;
  handoff(input: GitExecutionLocator): Promise<GitExecutionHandoff | null>;
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
  return {
    handoff: checkedHandoff,
    prepare: (input) => prepare(input, false),
    reserve: (input) => prepare(input, true),
    async close() {
      closed = true;
      await bridge?.close();
    },
  };
}
