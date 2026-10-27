export function resolveDictationKeyAction(event: Pick<KeyboardEvent, "key" | "shiftKey" | "altKey" | "isComposing">, fromEditor: boolean): "send" | "cancel" | null {
  if (event.isComposing) return null;
  if (event.key === "Escape") return "cancel";
  if (fromEditor && event.key === "Enter" && !event.shiftKey && !event.altKey) return "send";
  return null;
}
