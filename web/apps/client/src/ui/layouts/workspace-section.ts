import type { LucideIcon } from "lucide-react-native";
import Bot from "lucide-react-native/icons/bot";
import ListChecks from "lucide-react-native/icons/list-checks";
import MessageCircle from "lucide-react-native/icons/message-circle";
import Monitor from "lucide-react-native/icons/monitor";
import Settings from "lucide-react-native/icons/settings";
import UsersRound from "lucide-react-native/icons/users-round";

import {
  sectionPresentationItems,
  workspaceSectionLabel,
  type WorkspaceSection,
} from "../presentation/section-navigation-model";

export {workspaceSectionLabel};
export type {WorkspaceSection};

export type WorkspaceImStatus =
  | "signed_out"
  | "issuing_session"
  | "logging_in"
  | "waiting_sdk_ready"
  | "ready"
  | "not_ready"
  | "kicked_out"
  | "error";

export interface WorkspaceSectionItem {
  accessibilityLabel: string;
  icon: LucideIcon;
  id: WorkspaceSection;
  label: string;
}

const sectionIcons: Record<WorkspaceSection, LucideIcon> = {
  agents: Bot,
  chat: MessageCircle,
  computers: Monitor,
  members: UsersRound,
  settings: Settings,
  tasks: ListChecks,
};

export const sectionNavigation: WorkspaceSectionItem[] =
  sectionPresentationItems.map((item) => ({...item, icon: sectionIcons[item.id]}));

export function visibleSectionNavigation(canManageServer: boolean) {
  return canManageServer
    ? sectionNavigation
    : sectionNavigation.filter((item) => item.id !== "settings");
}
