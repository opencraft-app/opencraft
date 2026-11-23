import { WorkspaceBotOwner } from "./workspaces/bot-owner.js";
import { createWorkspaceExecutionOwner } from "./workspaces/execution-owner.js";
import { createAssetsStorage } from "@opencraft/plugin-assets/server/storage";
import type { GitConnectionProvider } from "@opencraft/plugin-assets/server/git-connections";
import { GitExecutionAuthority, executionScope, resolveExecutionAdmission } from "./git-execution-authority.js";
import { parseGitExecutionLocator } from "@opencraft/execution-environment/git-execution";
import { createHeadlessSandboxProviders } from "./sandbox-providers.js";
import { codexTurnAdmission, creationAdmission } from "./environment-launch-admission.js";
import {
  EnvironmentAccountPartitions,
  type EnvironmentAccountMapping,
} from "@opencraft/execution-environment/environment-account";
/** Only this compiled native host adds execution admission to the shared vault owner. */
export function createHeadlessAssetsStorage(
  directory: string,
  providers?: readonly GitConnectionProvider[],
  workspaces?: { machineId: string; terminalOwner?: { directory: string; endpoint: string; tokenFile: string } },
  options: {
    environmentLaunch?: boolean;
    /** Compiled into this Worker's entry by a trusted composition; never from
     * Worker data, a request or configuration. It maps a verified owner to the
     * vault partition its ENV is read from, among that Actor's verified bindings. */
    environmentAccount?: EnvironmentAccountMapping;
    /** Where the vault owner publishes its stable issuer public key, and the
     * explicit rotation generation of that key. */
    environmentIssuer?: { publish?: string; generation?: string };
  } = {},
) {
  const authority = new GitExecutionAuthority(directory, "actor");
  const { environmentAccount, ...storageOptions } = options;
  const environmentAccounts =
    environmentAccount === undefined
      ? undefined
      : new EnvironmentAccountPartitions(
          {
            owner: (actorId) => authority.environmentAccountOwner(actorId),
            actorOf: (binding) => authority.environmentAccountActor(binding),
          },
          environmentAccount,
        );
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
      actor: (account) => authority.actor(account),
      close: () => authority.close(),
    },
    async (context) => {
      const providers = createHeadlessSandboxProviders();
      const bots = new WorkspaceBotOwner(context, { providers });
      let ordinary;
      try {
        ordinary = workspaces ? await createWorkspaceExecutionOwner(context, { ...workspaces, providers }) : undefined;
      } catch (cause) {
        await bots.close();
        throw cause;
      }
      return {
        workspaceExecution: ordinary !== undefined,
        botExecution: true,
        botBackends: providers.ids(),
        methods: { ...bots.methods, ...ordinary?.methods } as never,
        async close() {
          const outcomes = await Promise.allSettled([bots.close(), ordinary?.close()]);
          const errors = outcomes.flatMap((r) => (r.status === "rejected" ? [r.reason] : []));
          if (errors.length) throw new AggregateError(errors, "Headless workspace cleanup unconfirmed");
        },
      };
    },
    {
      ...storageOptions,
      ...(environmentAccounts ? { environmentAccounts } : {}),
      ...(storageOptions.environmentLaunch
        ? {
            // Core's own durable records: the pending Codex input lease and the
            // Server owner's creation reservation, with the current Actor epoch.
            environmentRecords: {
              codexTurn: (locator) => codexTurnAdmission(authority, locator),
              creation: (locator) => creationAdmission(authority, locator),
              actorEpoch: (actorId) => authority.actorEpoch(actorId),
            },
          }
        : {}),
    },
  );
}
