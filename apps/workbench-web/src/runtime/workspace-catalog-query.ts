import { queryOptions } from "@tanstack/react-query";
import { supportsWorkspacePlacement, WORKSPACE_PLACEMENT_EXTENSION } from "@opencraft/appserver-protocol";
import type { AppServerWorkbenchRuntime } from "@opencraft/workbench-runtime";

export function canReadWorkspaceCatalog(runtime: AppServerWorkbenchRuntime): boolean {
  return (
    runtime.getSnapshot().phase === "ready" &&
    !!runtime.resources.workspaceCatalog &&
    supportsWorkspacePlacement(
      runtime.resources.host.getInitializeResult()?.capabilities?.extensions?.[WORKSPACE_PLACEMENT_EXTENSION],
    )
  );
}
const runtimeIds = new WeakMap<AppServerWorkbenchRuntime, number>();
let nextRuntimeId = 0;
function runtimeId(runtime: AppServerWorkbenchRuntime): number {
  let id = runtimeIds.get(runtime);
  if (id === undefined) {
    id = ++nextRuntimeId;
    runtimeIds.set(runtime, id);
  }
  return id;
}
/** Generation is part of identity; cancelled or retired reads cannot authorize selections. */
export function workspaceCatalogOptions(runtime: AppServerWorkbenchRuntime) {
  const { hostId, connectionGeneration } = runtime.getSnapshot();
  return queryOptions({
    queryKey: ["appserver", hostId, "workspace-catalog", connectionGeneration, runtimeId(runtime)] as const,
    enabled: canReadWorkspaceCatalog(runtime),
    staleTime: 30_000,
    queryFn: async ({ signal }) => {
      if (!canReadWorkspaceCatalog(runtime)) throw new Error("Workspace catalog is unavailable");
      const data = await runtime.resources.workspaceCatalog!.read(signal);
      signal.throwIfAborted();
      if (!canReadWorkspaceCatalog(runtime) || runtime.getSnapshot().connectionGeneration !== connectionGeneration)
        throw new Error("Workspace catalog connection changed");
      if (data.version !== 1 || !Array.isArray(data.environments) || !Array.isArray(data.libraries))
        throw new Error("Invalid workspace catalog");
      return { data, owner: runtime };
    },
  });
}
