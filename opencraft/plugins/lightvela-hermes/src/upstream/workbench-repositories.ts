import type { LightVelaAccountService } from "../account/lightvela-account-service";
import type { Repositories } from "./mono2/repositories/types";

/**
 * The only Workbench-owned seam inside the vendored mono2 Agent Console.
 * Feature code receives the repository contract it already used on lightvela.com;
 * transport and credential ownership stay with the active Workbench account.
 */
export function createWorkbenchRepositories(account: LightVelaAccountService): Repositories {
  const bots = {
    execDebugCommand: account.execDebugCommand.bind(account),
    execDebugCommandStream: account.execDebugCommandStream.bind(account),
    resetInstanceConfig: account.resetInstanceConfig.bind(account),
    getTerminalSession: (botId: string) => account.request(
      `/v1/instances/${encodeURIComponent(botId)}/tat/session`,
      { method: "POST" },
    ),
  };
  return { bots } as unknown as Repositories;
}
