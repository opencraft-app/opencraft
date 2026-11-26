import type { AppServerThreadItem } from "@opencraft/appserver-protocol";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textFrom(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .flatMap((entry) => {
      if (typeof entry === "string") return [entry];
      if (!isRecord(entry)) return [];
      return typeof entry.text === "string" ? [entry.text] : [];
    })
    .join("\n");
}

export function navigationItemText(item: AppServerThreadItem): string {
  return textFrom(item.content ?? item.text ?? item.message ?? item.fragments);
}

export function isNavigationPromptItem(item: AppServerThreadItem): boolean {
  return item.type === "userMessage" || item.type === "steeringUserMessage" || item.type === "hookPrompt";
}
