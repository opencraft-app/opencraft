import type { AppServerThreadItem } from "./types";
import { classifyCommand } from "./command-semantics";

export function isHermesToolItem(item: AppServerThreadItem): boolean {
  return item.type === "dynamicToolCall" || item.type === "commandExecution";
}

/** The same semantic projection is used for live updates and stored history.
 * Source metadata stays attached; presentation must not invent an execution. */
export function projectHermesTool(item: AppServerThreadItem): AppServerThreadItem {
  if (!isHermesToolItem(item)) return item;
  if (item.tool !== "terminal") {
    const name = String(item.tool ?? "tool");
    const card = ["edit_file", "patch", "write_file", "clarify", "delegate_task", "image_generate", "setup_mcp"].includes(name);
    const read = name === "read_file";
    const search = ["search_files", "web_search"].includes(name);
    return { ...item, activityPresentation: {
      operation: read ? "read" : search ? "search" : "other",
      grouping: card ? "standalone" : "groupable",
      icon: read ? "read" : search ? "search" : "wrench",
      active: read ? "Reading" : search ? "Searching" : null,
      completed: read ? "Read" : search ? "Searched" : null,
    } };
  }
  const args = (item.arguments ?? {}) as Record<string, unknown>;
  let result: unknown = item.structuredResult;
  if (result == null && Array.isArray(item.contentItems)) result = item.contentItems[0]?.text;
  if (typeof result === "string") { try { result = JSON.parse(result); } catch { /* raw output */ } }
  const data = result && typeof result === "object" ? result as Record<string, unknown> : {};
  const command = typeof args.command === "string" ? args.command : "";
  const output = typeof result === "string" ? result
    : [data.output ?? data.stdout, data.stderr].filter(value => typeof value === "string").join("\n");
  return {
    ...item, type: "commandExecution", command,
    commandActions: args.background === true ? [{ type: "unknown", command }] : classifyCommand(command),
    cwd: typeof args.cwd === "string" ? args.cwd : null,
    processId: typeof data.session_id === "string" ? data.session_id : null,
    aggregatedOutput: output || (result == null ? null : JSON.stringify(result)),
    exitCode: typeof data.exit_code === "number" ? data.exit_code : null,
  };
}
