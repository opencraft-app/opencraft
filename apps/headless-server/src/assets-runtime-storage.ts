import { WorkspaceBotOwner } from "./workspaces/bot-owner.js";
import { createWorkspaceExecutionOwner } from "./workspaces/execution-owner.js";
import { createAssetsStorage } from "@opencraft/plugin-assets/server/storage";
import type { GitConnectionProvider } from "@opencraft/plugin-assets/server/git-connections";
import type { EnvironmentAccountMapping } from "@opencraft/execution-environment/environment-account";
import { createHeadlessExecutionRecords } from "./assets-execution-records.js";
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
  const { environmentAccount, ...storageOptions } = options;
  const { execution, environmentRecords, environmentAccounts } = createHeadlessExecutionRecords({
    directory,
    ...(environmentAccount ? { environmentAccount } : {}),
  });
  return createAssetsStorage(
    directory,
    providers,
    execution,
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
    {
      ...storageOptions,
      ...(environmentAccounts ? { environmentAccounts } : {}),
      // Core's own durable records: the pending Codex input lease and the
      // Server owner's creation reservation, with the current Actor epoch.
      ...(storageOptions.environmentLaunch ? { environmentRecords } : {}),
    },
  );
}
