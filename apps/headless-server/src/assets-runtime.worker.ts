import { serveWorkerOwner } from "@opencraft/worker-owner/serve";
import { createHeadlessAssetsStorage } from "./assets-runtime-storage.js";
serveWorkerOwner<{ directory: string; workspaceMachineId?: string }>(({ directory, workspaceMachineId }) =>
  createHeadlessAssetsStorage(
    directory,
    undefined,
    workspaceMachineId === undefined ? undefined : { machineId: workspaceMachineId },
  ),
);
