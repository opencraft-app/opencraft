import type { GitGrantScope } from "@opencraft/execution-environment/personal-git-protocol";
import { PersonalGitEnvironment } from "@opencraft/execution-environment/personal-git";
import { ExecutionEnvironmentSnapshot } from "@opencraft/execution-environment/execution-snapshot";
import type { GitExecutionLocator, GitExecutionHandoff } from "@opencraft/execution-environment/git-execution";
export interface HumanGitExecutionPort {
  prepare(input: GitExecutionLocator): Promise<ExecutionEnvironmentSnapshot>;
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
  return {
    handoff: checkedHandoff,
    async prepare(input) {
      const handoff = await checkedHandoff(input);
      if (!handoff)
        return new ExecutionEnvironmentSnapshot({ account: null, ...input, projectId: input.projectId ?? null }, {});
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
      const grant = bridge.grantSealed(handoff.scope, handoff.capability, handoff.authority);
      await grant.ready;
      // A queued retirement or membership change during broker startup must not
      // launch a tool with a stale prepared capability.
      const latest = await options.grant(input);
      if (
        closed ||
        !latest ||
        latest.authority !== handoff.authority ||
        JSON.stringify(latest.scope) !== JSON.stringify(handoff.scope)
      )
        throw Error("git_execution_unavailable");
      if (!(await current(latest))) throw Error("git_execution_unavailable");
      if (closed) throw Error("git_execution_unavailable");
      // npm execution packages use the Host's Node; full bundles retain their
      // bundled interpreter. The execution owner fixes this path, not Git config.
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
    },
    async close() {
      closed = true;
      await bridge?.close();
    },
  };
}
