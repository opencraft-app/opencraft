import { createAssetsStorage } from "@opencraft/plugin-assets/server/storage";
import type { GitConnectionProvider } from "@opencraft/plugin-assets/server/git-connections";
import { GitExecutionAuthority } from "./git-execution-authority.js";
import { parseGitExecutionLocator } from "@opencraft/execution-environment/git-execution";
/** Only this compiled native host adds execution admission to the shared vault owner. */
export function createHeadlessAssetsStorage(directory: string, providers?: readonly GitConnectionProvider[]) {
  const authority = new GitExecutionAuthority(directory, "actor");
  return createAssetsStorage(directory, providers, {
    resolve(raw) {
      const input = parseGitExecutionLocator(raw),
        current = authority.resolve(input);
      if (!current) {
        if (authority.unowned(input)) return null;
        throw Error("git_execution_unavailable");
      }
      return {
        scope: {
          account: current.account,
          hostId: input.hostId,
          threadId: input.threadId,
          inputId: input.inputId,
          executionId: current.executionId,
          leaseGeneration: current.generation,
          actorGeneration: current.actorGeneration,
          membershipRevision: current.membershipRevision,
          projectId: input.projectId ?? null,
        },
        native: { turnId: current.turnId, incarnation: current.incarnation },
      };
    },
    close: () => authority.close(),
  });
}
