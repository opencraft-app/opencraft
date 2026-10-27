import type { TrustedExtensionDefinition } from "@opencraft/extension-runtime";
import type {
  TasksMethod,
  TasksMethodMap,
} from "@opencraft/appserver-protocol";
import { createTasksView } from "./view";
export const TASKS_EXTENSION_ID = "opencraft.tasks";
export const TASKS_VIEW_ID = "opencraft.tasks.board";
export interface TaskConversationActivity {
  readonly title: string;
  readonly state: "running" | "waiting" | "idle" | "failed" | "unknown";
}
/** The application owns transports, identities and native conversation activity. */
export interface TasksExtensionPorts {
  readonly storageHostId: string | null;
  /** Earliest lane-dwell origin, supplied by product assembly as Unix milliseconds. */
  readonly followUpDwellSince?: number;
  readonly conversationOverview?: import("./conversation-overview-model").ConversationOverviewPort;
  request<M extends TasksMethod>(
    hostId: string,
    method: M,
    params: TasksMethodMap[M]["params"],
  ): Promise<TasksMethodMap[M]["result"]>;
  listThreads(
    hostId: string,
    search: string,
  ): Promise<readonly { id: string; title: string }[]>;
  listProjects(
    hostId: string,
  ): Promise<readonly { id: string; title: string }[]>;
  readConversation(
    hostId: string,
    threadId: string,
  ): Promise<TaskConversationActivity>;
  prepareConversation?(taskId: string, hostId: string): Promise<void>;
  pendingConversationLinks?(): readonly { taskId: string; serverId: string; threadId: string }[];
  retryConversationLinks?(taskId: string): Promise<void>;
  subscribe(listener: (kind: "tasks" | "activity") => void): () => void;
}
export function createTasksExtension(
  ports: TasksExtensionPorts,
): TrustedExtensionDefinition {
  return {
    manifest: {
      manifestVersion: 1,
      id: TASKS_EXTENSION_ID,
      name: "Tasks",
      version: "0.1.0",
      apiVersion: 1,
      trust: "trusted",
      platforms: ["web", "electron"],
      activationEvents: ["onStartupFinished"],
    },
    activate(api) {
      api.views.register({
        id: TASKS_VIEW_ID,
        title: "看板",
        viewType: TASKS_VIEW_ID,
        platforms: ["web", "electron"],
      });
      api.navigation.register({
        id: "opencraft.tasks.navigation",
        title: "看板",
        titleMessage: { id: "sidebar.rail.tasks", defaultMessage: "Board" },
        shortTitleMessage: { id: "sidebar.rail.tasks.short", defaultMessage: "Board" },
        surface: "sidebar-primary",
        target: { kind: "view", viewId: TASKS_VIEW_ID },
        icon: "columns",
        order: 35,
      });
      api.internal.register("platformViewRenderer", {
        viewType: TASKS_VIEW_ID,
        Component: createTasksView(ports, api.signal, api.localPreferences),
      });
    },
  };
}
