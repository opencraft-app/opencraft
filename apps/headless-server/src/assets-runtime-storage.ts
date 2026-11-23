import { WorkspaceBotOwner } from "./workspaces/bot-owner.js";
import { createWorkspaceExecutionOwner } from "./workspaces/execution-owner.js";
import { createAssetsStorage } from "@opencraft/plugin-assets/server/storage";
import type { GitConnectionProvider } from "@opencraft/plugin-assets/server/git-connections";
import { GitExecutionAuthority, executionScope, resolveExecutionAdmission } from "./git-execution-authority.js";
import { parseGitExecutionLocator } from "@opencraft/execution-environment/git-execution";
import { codexTurnAdmission, creationAdmission } from "./environment-launch-admission.js";
/** Only this compiled native host adds execution admission to the shared vault owner. */
export function createHeadlessAssetsStorage(
  directory: string,
  providers?: readonly GitConnectionProvider[],
  workspaces?: { machineId: string; terminalOwner?: { directory: string; endpoint: string; tokenFile: string } },
  options: { environmentLaunch?: boolean } = {},
) {
  const authority = new GitExecutionAuthority(directory, "actor");
  return createAssetsStorage(
    directory,
    providers,
    {
      resolve: (raw) => resolveExecutionAdmission(authority, raw),
      reserve(raw) {
        const input = parseGitExecutionLocator(raw);
        if (input.hostId !== "local-codex" || !input.inputId || input.turnId) throw Error("git_execution_unavailable");
        const current = authority.reserve(input);
        if (!current) {
          if (authority.unowned(input, "pending")) return null;
          throw Error("git_execution_unavailable");
        }
        return { scope: executionScope(input, current), native: { incarnation: current.incarnation } };
      },
      close: () => authority.close(),
    },
    async (context) => {
      const bots = new WorkspaceBotOwner(context);
      let ordinary;
      try {
        ordinary = workspaces ? await createWorkspaceExecutionOwner(context, workspaces) : undefined;
      } catch (cause) {
        await bots.close();
        throw cause;
      }
      return {
        workspaceExecution: ordinary !== undefined,
        botExecution: true,
        methods: { ...bots.methods, ...ordinary?.methods } as never,
        async close() {
          const outcomes = await Promise.allSettled([bots.close(), ordinary?.close()]);
          const errors = outcomes.flatMap((r) => (r.status === "rejected" ? [r.reason] : []));
          if (errors.length) throw new AggregateError(errors, "Headless workspace cleanup unconfirmed");
        },
      };
    },
    options.environmentLaunch
      ? {
          ...options,
          // Core's own durable records: the pending Codex input lease and the
          // Server owner's creation reservation, with the current Actor epoch.
          environmentRecords: {
            codexTurn: (locator) => codexTurnAdmission(authority, locator),
            creation: (locator) => creationAdmission(authority, locator),
            actorEpoch: (actorId) => authority.actorEpoch(actorId),
          },
        }
      : options,
  );
}
