import type { LucideIcon } from "lucide-react-native";
import Bot from "lucide-react-native/icons/bot";
import ListChecks from "lucide-react-native/icons/list-checks";
import MessageCircle from "lucide-react-native/icons/message-circle";
import Monitor from "lucide-react-native/icons/monitor";
import Settings from "lucide-react-native/icons/settings";
import UsersRound from "lucide-react-native/icons/users-round";

export type WorkspaceImStatus =
  | "signed_out"
  | "issuing_session"
  | "logging_in"
  | "waiting_sdk_ready"
  | "ready"
  | "not_ready"
  | "kicked_out"
  | "error";

export type WorkspaceSection =
  "agents" | "chat" | "computers" | "members" | "settings" | "tasks";

export interface WorkspaceSectionItem {
  accessibilityLabel: string;
  icon: LucideIcon;
  id: WorkspaceSection;
  label: string;
}

export const sectionNavigation: WorkspaceSectionItem[] = [
  {
    accessibilityLabel: "打开聊天",
    icon: MessageCircle,
    id: "chat",
    label: "聊天",
  },
  {
    accessibilityLabel: "打开任务",
    icon: ListChecks,
    id: "tasks",
    label: "任务",
  },
  {
    accessibilityLabel: "打开 Agent",
    icon: Bot,
    id: "agents",
    label: "Agent",
  },
  {
    accessibilityLabel: "打开 Computer",
    icon: Monitor,
    id: "computers",
    label: "Computer",
  },
  {
    accessibilityLabel: "打开成员",
    icon: UsersRound,
    id: "members",
    label: "成员",
  },
  {
    accessibilityLabel: "打开 Server 设置",
    icon: Settings,
    id: "settings",
    label: "设置",
  },
];

export function visibleSectionNavigation(canManageServer: boolean) {
  return canManageServer
    ? sectionNavigation
    : sectionNavigation.filter((item) => item.id !== "settings");
}

export function workspaceSectionLabel(section: WorkspaceSection): string {
  const item = sectionNavigation.find((entry) => entry.id === section);
  if (!item) {
    throw new Error(`Unknown workspace section: ${section}`);
  }
  return item.label;
}
