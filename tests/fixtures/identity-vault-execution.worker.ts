import { serveWorkerOwner } from "@opencraft/worker-owner/serve";
import { createAssetsStorage } from "@opencraft/plugin-assets/server/storage";
import { createHeadlessExecutionRecords } from "@opencraft/headless-server/assets-execution-records";

/** The vault Worker of an identity composition that owns its vault, built only
 * from public entry points: core's execution records and the Assets storage. */
serveWorkerOwner<{ directory: string; environmentLaunch?: boolean }>(({ directory, environmentLaunch }) => {
  const { execution, environmentRecords } = createHeadlessExecutionRecords({ directory });
  return createAssetsStorage(directory, undefined, execution, undefined, {
    environmentLaunch: environmentLaunch === true,
    environmentRecords,
  });
});
