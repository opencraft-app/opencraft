import { serveWorkerOwner } from "@opencraft/worker-owner/serve";
import { createHeadlessAssetsStorage } from "./assets-runtime-storage.js";
serveWorkerOwner<{
  directory: string;
  workspaceMachineId?: string;
  terminalOwner?: { directory: string; endpoint: string; tokenFile: string };
  environmentLaunch?: boolean;
  environmentIssuer?: { publish?: string; generation?: string };
}>(({ directory, workspaceMachineId, terminalOwner, environmentLaunch, environmentIssuer }) =>
  createHeadlessAssetsStorage(
    directory,
    undefined,
    workspaceMachineId === undefined ? undefined : { machineId: workspaceMachineId, terminalOwner },
    { environmentLaunch: environmentLaunch === true, ...(environmentIssuer ? { environmentIssuer } : {}) },
  ),
);
