import {
  ExecutionEnvironmentSnapshot,
  type ExecutionGitPort,
} from "@opencraft/execution-environment/execution-snapshot";
import { parseGitExecutionLocator, type GitExecutionHandoff } from "@opencraft/execution-environment/git-execution";
import { validGitGrantScope, type GitGrantScope } from "@opencraft/execution-environment/personal-git-protocol";
import { createHumanGitExecution, type HumanGitExecutionPort } from "./human-git-execution.js";

type Reply = { authority: string; hosts: string[]; grant: GitExecutionHandoff | null };
const unavailable = (): never => {
  throw Error("git_execution_unavailable");
};
function reply(value: unknown, input: { hostId: string; threadId: string; inputId: string }): Reply | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return unavailable();
  if (Object.keys(value).length === 1 && (value as { mode?: unknown }).mode === "anonymous") return null;
  const v = value as Reply;
  if (
    Object.keys(v).some((k) => !["authority", "hosts", "grant"].includes(k)) ||
    !/^[a-f0-9]{64}$/u.test(v.authority) ||
    !Array.isArray(v.hosts) ||
    !v.hosts.length ||
    v.hosts.length > 16 ||
    v.hosts.some((h) => typeof h !== "string" || !/^[a-z0-9.-]{1,253}$/u.test(h)) ||
    new Set(v.hosts).size !== v.hosts.length
  )
    return unavailable();
  if (v.grant !== null) {
    const g = v.grant;
    const text = (s: unknown) =>
      typeof s === "string" && s.length > 0 && s.length <= 512 && !/[\x00-\x1f\x7f]/u.test(s);
    if (
      !g ||
      typeof g !== "object" ||
      Object.keys(g).some((k) => !["scope", "authority", "capability", "native"].includes(k)) ||
      !validGitGrantScope(g.scope) ||
      !g.scope.account.startsWith("actor:human://") ||
      Object.keys(g.scope).some(
        (k) =>
          ![
            "account",
            "hostId",
            "threadId",
            "inputId",
            "executionId",
            "leaseGeneration",
            "actorGeneration",
            "membershipRevision",
            "projectId",
          ].includes(k),
      ) ||
      g.scope.projectId !== null ||
      g.scope.hostId !== input.hostId ||
      g.scope.threadId !== input.threadId ||
      g.scope.inputId !== input.inputId ||
      g.authority !== v.authority ||
      typeof g.capability !== "string" ||
      !/^v3\.[A-Za-z0-9_-]+$/u.test(g.capability) ||
      g.capability.length > 8192 ||
      !g.native ||
      Object.keys(g.native).some((k) => !["turnId", "incarnation"].includes(k)) ||
      !text(g.native.turnId) ||
      !text(g.native.incarnation)
    )
      return unavailable();
  }
  return structuredClone(v);
}
const sameScope = (a: GitGrantScope, b: GitGrantScope) =>
  a.account === b.account &&
  a.hostId === b.hostId &&
  a.threadId === b.threadId &&
  a.inputId === b.inputId &&
  a.executionId === b.executionId &&
  a.leaseGeneration === b.leaseGeneration &&
  a.actorGeneration === b.actorGeneration &&
  a.membershipRevision === b.membershipRevision;

/** Same-machine compiled native owner. Reads the existing private capability
 * attachment; never opens a writable vault or receives its key/PAT/private key.
 * Each command/credential/signature rechecks the Server's live admission. */
export function createRemoteHumanGitExecution(options: {
  directory: string;
  runtimeDirectory: string;
  workerFile: string;
  capabilities: { hostGit(threadId: string, inputId: string, signal?: AbortSignal): Promise<unknown> };
  inspect(handoff: GitExecutionHandoff): Promise<boolean>;
}): ExecutionGitPort & { close(): Promise<void> } {
  const lifecycle = new AbortController();
  let closed = false,
    bridge: HumanGitExecutionPort | undefined,
    authority: string | undefined;
  let hosts: readonly string[] | undefined;
  const read = async (raw: Parameters<ExecutionGitPort["prepare"]>[0]) => {
    try {
      const input = parseGitExecutionLocator(raw);
      if (closed || input.hostId !== "opencraft-server") return unavailable();
      const result = reply(await options.capabilities.hostGit(input.threadId, input.inputId, lifecycle.signal), input);
      if (
        closed ||
        (authority &&
          (!result || authority !== result.authority || JSON.stringify(hosts) !== JSON.stringify(result.hosts)))
      )
        return unavailable();
      return result;
    } catch {
      return unavailable();
    }
  };
  return {
    async prepare(input) {
      const result = await read(input);
      if (!result?.grant)
        return new ExecutionEnvironmentSnapshot({ account: null, ...input, projectId: input.projectId ?? null }, {});
      if (!bridge) {
        authority = result.authority;
        hosts = result.hosts;
        bridge = createHumanGitExecution({
          directory: options.directory,
          runtimeDirectory: options.runtimeDirectory,
          workerFile: options.workerFile,
          authority,
          hosts,
          grant: async (locator) => {
            const next = await read(locator);
            if (!next) return unavailable();
            return next.grant;
          },
          inspect: options.inspect,
          authorize: async (scope) => {
            const current = (await read({ hostId: scope.hostId, threadId: scope.threadId, inputId: scope.inputId }))
              ?.grant;
            return !!current && sameScope(current.scope, scope);
          },
        });
      }
      return bridge.prepare(input);
    },
    async close() {
      closed = true;
      lifecycle.abort();
      await bridge?.close();
    },
  };
}
