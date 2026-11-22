import { serveWorkerOwner } from "@opencraft/worker-owner/serve";
import { createHeadlessAssetsStorage } from "./assets-runtime-storage.js";
serveWorkerOwner<{
  directory: string;
  workspaceMachineId?: string;
  terminalOwner?: { directory: string; endpoint: string; tokenFile: string };
  environmentLaunch?: boolean;
}>(({ directory, workspaceMachineId, terminalOwner, environmentLaunch }) =>
  createHeadlessAssetsStorage(
    directory,
    undefined,
    workspaceMachineId === undefined ? undefined : { machineId: workspaceMachineId, terminalOwner },
    { environmentLaunch: environmentLaunch === true },
  ),
);
