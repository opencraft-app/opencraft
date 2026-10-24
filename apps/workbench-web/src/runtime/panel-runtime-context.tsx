import { FilePreviewProvider } from "@opencraft/file-preview-web";
import {
  createWorkbenchPanelReactRuntime,
  type PanelRendererRegistration,
  type WorkbenchPanelReactRuntime,
} from "@opencraft/workbench-panels-react";
import type {
  ConversationPanelState,
  PanelToolbarActionDefinition,
} from "@opencraft/workbench-panels";
import type { Context } from "@deepseek-ai/cordis";
import { restoreRightPanelTabs } from "./restore-right-panel-tabs";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useLayoutEffect,
  useSyncExternalStore,
} from "react";

const PanelRuntimeContext = createContext<WorkbenchPanelReactRuntime | null>(null);

export async function createWorkbenchPanelRuntime(context?: Context) {
  // Keep the panel closed until an explicit route or action requests width,
  // so an empty initial tab cannot change conversation viewport measurements
  // or edge scrolling.
  return createWorkbenchPanelReactRuntime({}, context);
}

export function WorkbenchPanelRuntimeProvider({
  children,
  runtime,
}: {
  readonly children: ReactNode;
  readonly runtime: WorkbenchPanelReactRuntime;
}) {
  return (
    <PanelRuntimeContext.Provider value={runtime}>
      <FilePreviewProvider service={runtime.context.filePreviews ?? null}>{children}</FilePreviewProvider>
    </PanelRuntimeContext.Provider>
  );
}

export function useWorkbenchPanelRuntime(): WorkbenchPanelReactRuntime {
  const runtime = useContext(PanelRuntimeContext);
  if (runtime === null) throw new Error("WorkbenchPanelRuntimeProvider is missing");
  return runtime;
}

export function useConversationPanelState(ownerId: string): ConversationPanelState {
  const { panels } = useWorkbenchPanelRuntime();
  useLayoutEffect(() => {
    panels.ensureOwner(ownerId);
    restoreRightPanelTabs(panels, ownerId);
  }, [ownerId, panels]);
  const subscribe = useCallback(
    (listener: () => void) => panels.subscribeOwner(ownerId, listener),
    [panels, ownerId],
  );
  const getSnapshot = useCallback(
    () => panels.getOwnerSnapshot(ownerId),
    [panels, ownerId],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function usePanelRendererSnapshot(): readonly PanelRendererRegistration[] {
  const { renderers } = useWorkbenchPanelRuntime();
  return useSyncExternalStore(renderers.subscribe, renderers.getSnapshot, renderers.getSnapshot);
}

export function usePanelToolbarActions(): readonly PanelToolbarActionDefinition[] {
  const { panels } = useWorkbenchPanelRuntime();
  return useSyncExternalStore(
    panels.subscribeToolbarActions,
    panels.getToolbarActionSnapshot,
    panels.getToolbarActionSnapshot,
  );
}
