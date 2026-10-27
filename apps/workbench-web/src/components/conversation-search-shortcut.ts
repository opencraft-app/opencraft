import { matchesWorkbenchShortcut } from "../workbench-shortcuts";
export function conversationSearchShortcut(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "isComposing">, platform: string): boolean {
  return matchesWorkbenchShortcut(event, "search", platform);
}
