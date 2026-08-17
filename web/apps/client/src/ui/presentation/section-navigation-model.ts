export type WorkspaceSection =
  | "agents"
  | "chat"
  | "computers"
  | "members"
  | "settings"
  | "tasks";

export interface SectionPresentationItem {
  accessibilityLabel: string;
  id: WorkspaceSection;
  label: string;
}

export const sectionPresentationItems: SectionPresentationItem[] = [
  {accessibilityLabel: "打开聊天", id: "chat", label: "聊天"},
  {accessibilityLabel: "打开任务", id: "tasks", label: "任务"},
  {accessibilityLabel: "打开 Agent", id: "agents", label: "Agent"},
  {accessibilityLabel: "打开 Computer", id: "computers", label: "Computer"},
  {accessibilityLabel: "打开成员", id: "members", label: "成员"},
  {accessibilityLabel: "打开 Server 设置", id: "settings", label: "设置"},
];

export function visibleSectionPresentationItems(canManageServer: boolean) {
  return canManageServer
    ? sectionPresentationItems
    : sectionPresentationItems.filter((item) => item.id !== "settings");
}

export function workspaceSectionLabel(section: WorkspaceSection): string {
  const item = sectionPresentationItems.find((entry) => entry.id === section);
  if (!item) throw new Error(`Unknown workspace section: ${section}`);
  return item.label;
}
