import "../styles/toolbar-dock.scss";
import { createContext, useContext, useSyncExternalStore } from "react";
import { useUiPreferencesRuntime } from "../runtime/ui-preferences-runtime";
import { projectToolbarDock, toolbarDockKey } from "./toolbar-dock-model";

export const ToolbarDockCapacityContext = createContext(0);
export const conversationToolbarDock = "conversation-header";

export function useToolbarDock(scope: string, dock: string, actionIds: readonly string[], defaults: readonly string[] = []) {
  const preferences = useUiPreferencesRuntime();
  const snapshot = useSyncExternalStore(preferences.subscribe, preferences.getSnapshot, preferences.getSnapshot);
  const key = toolbarDockKey(scope, dock);
  const order = snapshot.values["shell.toolbarDocks"][key] ?? defaults;
  const capacity = useContext(ToolbarDockCapacityContext);
  return {
    order,
    projection: projectToolbarDock(actionIds.map(id => ({ id })), order, capacity),
    save: (ids: readonly string[]) => preferences.set("shell.toolbarDocks", {
      ...preferences.getSnapshot().values["shell.toolbarDocks"], [key]: [...ids],
    }, { optimistic: false }),
  };
}

/** Inert geometry twin uses exactly the same preference and capacity projection. */
export function ConversationToolbarSizing({ scope, actionIds }: { scope: string; actionIds: readonly string[] }) {
  const { projection } = useToolbarDock(scope, conversationToolbarDock, actionIds, ["link-tasks"]);
  return <span className="conversation-toolbar"><span className="toolbar-dock">{projection.docked.map(action => <span key={action.id} className="chrome-button toolbar-dock__action" />)}</span><span className="chrome-button" /></span>;
}
