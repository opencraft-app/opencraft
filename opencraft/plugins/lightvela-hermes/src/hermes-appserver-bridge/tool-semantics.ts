import type { AppServerThreadItem } from "./types";
import { classifyCommand } from "./command-semantics";

type JsonRecord = Record<string, unknown>;

const FILE_EDIT_TOOLS = new Set(["edit_file", "patch", "write_file"]);

const TOOL_ACTIVITY: Readonly<Record<string, {
  readonly operation: "read" | "search" | "other";
  readonly grouping: "groupable" | "standalone";
  readonly icon: "read" | "search" | "wrench";
  readonly active: string;
  readonly completed: string;
}>> = {
  read_file: { operation: "read", grouping: "groupable", icon: "read", active: "Reading", completed: "Read" },
  list_files: { operation: "read", grouping: "groupable", icon: "read", active: "Listing files", completed: "Listed files" },
  search_files: { operation: "search", grouping: "groupable", icon: "search", active: "Searching files", completed: "Searched files" },
  web_search: { operation: "search", grouping: "groupable", icon: "search", active: "Searching the web", completed: "Searched the web" },
  web_extract: { operation: "read", grouping: "groupable", icon: "read", active: "Reading page", completed: "Read page" },
  vision_analyze: { operation: "other", grouping: "groupable", icon: "wrench", active: "Analyzing image", completed: "Analyzed image" },
  memory: { operation: "other", grouping: "groupable", icon: "wrench", active: "Using memory", completed: "Used memory" },
  cronjob: { operation: "other", grouping: "groupable", icon: "wrench", active: "Updating schedule", completed: "Updated schedule" },
  browser_navigate: { operation: "other", grouping: "groupable", icon: "wrench", active: "Navigating", completed: "Navigated" },
  browser_snapshot: { operation: "read", grouping: "groupable", icon: "read", active: "Reading page", completed: "Read page" },
  browser_click: { operation: "other", grouping: "groupable", icon: "wrench", active: "Clicking page", completed: "Clicked page" },
  browser_fill: { operation: "other", grouping: "groupable", icon: "wrench", active: "Filling page", completed: "Filled page" },
  browser_type: { operation: "other", grouping: "groupable", icon: "wrench", active: "Typing on page", completed: "Typed on page" },
  clarify: { operation: "other", grouping: "standalone", icon: "wrench", active: "Clarifying", completed: "Clarified" },
  setup_mcp: { operation: "other", grouping: "standalone", icon: "wrench", active: "Setting up integration", completed: "Set up integration" },
};

export function isHermesToolItem(item: AppServerThreadItem): boolean {
  return item.namespace === "hermes" && [
    "dynamicToolCall",
    "commandExecution",
    "fileChange",
    "collabAgentToolCall",
    "imageGeneration",
    "todoList",
  ].includes(item.type);
}

function parseRecord(value: unknown, depth = 0): JsonRecord {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return value as JsonRecord;
  if (typeof value !== "string" || value.trim() === "" || depth > 1) return {};
  try {
    return parseRecord(JSON.parse(value), depth + 1);
  } catch {
    return {};
  }
}

function stringField(source: JsonRecord, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return null;
}

function itemResult(item: AppServerThreadItem): unknown {
  if (item.structuredResult !== undefined && item.structuredResult !== null) return item.structuredResult;
  if (!Array.isArray(item.contentItems)) return null;
  const text = item.contentItems
    .map((entry) => parseRecord(entry))
    .map((entry) => entry.text)
    .find((value): value is string => typeof value === "string" && value.trim() !== "");
  if (text === undefined) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function itemStatus(item: AppServerThreadItem): string {
  return typeof item.status === "string" ? item.status : "completed";
}

function diffPath(value: string): string {
  const path = value.trim().replace(/^"|"$/gu, "").replace(/^[ab]\//u, "");
  return path === "/dev/null" ? "" : path;
}

function diffStats(diff: string): { readonly additions: number; readonly deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.replace(/\r\n?/gu, "\n").split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { additions, deletions };
}

function fileChanges(item: AppServerThreadItem, name: string): JsonRecord[] {
  const args = parseRecord(item.arguments);
  const resultValue = itemResult(item);
  const result = parseRecord(resultValue);
  const inlineDiff = typeof item.inlineDiff === "string" && item.inlineDiff.trim() !== ""
    ? item.inlineDiff.trim()
    : stringField(result, ["inline_diff", "unified_diff", "diff", "patch"]);
  const fallbackPath = stringField(args, ["path", "file", "filepath"])
    ?? stringField(result, ["path", "file", "filepath", "resolved_path"]);

  if (inlineDiff !== null) {
    const lines = inlineDiff.replace(/\r\n?/gu, "\n").split("\n");
    const starts: number[] = [];
    lines.forEach((line, index) => { if (line.startsWith("diff --git ")) starts.push(index); });
    const segments = starts.length === 0
      ? [inlineDiff]
      : starts.map((start, index) => lines.slice(start, starts[index + 1] ?? lines.length).join("\n"));
    return segments.map((segment) => {
      const header = /^diff --git\s+(?:"([^"]+)"|(\S+))\s+(?:"([^"]+)"|(\S+))/mu.exec(segment);
      const oldPathLine = /^---\s+(.+)$/mu.exec(segment)?.[1] ?? "";
      const newPathLine = /^\+\+\+\s+(.+)$/mu.exec(segment)?.[1] ?? "";
      const oldPath = diffPath(oldPathLine.split("\t")[0] ?? "");
      const newPath = diffPath(newPathLine.split("\t")[0] ?? "");
      const path = diffPath(header?.[3] ?? header?.[4] ?? "") || newPath
        || diffPath(header?.[1] ?? header?.[2] ?? "") || oldPath || fallbackPath || "Unknown file";
      const kind = oldPathLine.includes("/dev/null") ? "add"
        : newPathLine.includes("/dev/null") ? "delete"
        : "modify";
      return { path, kind, ...diffStats(segment), unifiedDiff: segment, movePath: null };
    });
  }

  if (fallbackPath === null) return [];
  return [{
    path: fallbackPath,
    kind: name === "edit_file" || name === "patch" ? "modify" : "unknown",
    additions: null,
    deletions: null,
    unifiedDiff: null,
    movePath: null,
  }];
}

function projectFileEdit(item: AppServerThreadItem, name: string): AppServerThreadItem | null {
  const changes = fileChanges(item, name);
  if (changes.length === 0) return null;
  return {
    ...item,
    type: "fileChange",
    hermesToolName: name,
    title: itemStatus(item) === "inProgress" ? "Applying changes" : "Changed files",
    changes,
  };
}

function projectCommand(item: AppServerThreadItem): AppServerThreadItem {
  const args = parseRecord(item.arguments);
  const resultValue = itemResult(item);
  const result = parseRecord(resultValue);
  const command = stringField(args, ["command", "code"]) ?? "";
  const output = typeof resultValue === "string" ? resultValue
    : [result.output ?? result.stdout, result.stderr].filter((value): value is string => typeof value === "string").join("\n");
  return {
    ...item,
    type: "commandExecution",
    hermesToolName: String(item.hermesToolName ?? item.tool ?? "terminal"),
    command,
    commandActions: item.tool === "terminal" && args.background !== true
      ? classifyCommand(command)
      : [{ type: "unknown", command }],
    cwd: stringField(args, ["cwd"]),
    processId: stringField(result, ["session_id", "process_id"]),
    aggregatedOutput: output || (resultValue == null ? null : JSON.stringify(resultValue)),
    exitCode: typeof result.exit_code === "number" ? result.exit_code : null,
  };
}

function projectGeneratedImage(item: AppServerThreadItem): AppServerThreadItem | null {
  const args = parseRecord(item.arguments);
  const result = parseRecord(itemResult(item));
  const candidate = stringField(result, ["host_image", "image", "image_url", "url", "path", "image_path", "agent_visible_image"]);
  const running = itemStatus(item) === "inProgress";
  if (!running && (result.success === false || candidate === null)) return null;
  const browserReadable = candidate !== null && /^(?:data:|blob:|https?:|file:)/iu.test(candidate);
  return {
    ...item,
    type: "imageGeneration",
    hermesToolName: "image_generate",
    src: browserReadable ? candidate : null,
    savedPath: browserReadable ? null : candidate,
    alt: stringField(args, ["prompt"]),
    transparentBackground: args.transparent_background === true,
  };
}

function projectDelegation(item: AppServerThreadItem): AppServerThreadItem {
  const args = parseRecord(item.arguments);
  const result = parseRecord(itemResult(item));
  const tasks = Array.isArray(args.tasks) ? args.tasks.map((value) => parseRecord(value)) : [];
  const results = Array.isArray(result.results) ? result.results.map((value) => parseRecord(value)) : [];
  const dispatchedGoals = Array.isArray(result.goals)
    ? result.goals.filter((value): value is string => typeof value === "string" && value.trim() !== "")
    : [];
  const goals = tasks.map((task) => stringField(task, ["goal", "prompt"])).filter((value): value is string => value !== null);
  const directGoal = stringField(args, ["goal", "prompt"]);
  if (goals.length === 0 && directGoal !== null) goals.push(directGoal);
  if (goals.length === 0) goals.push(...dispatchedGoals);
  const count = Math.max(goals.length, results.length, 1);
  const callId = typeof item.callId === "string" && item.callId !== "" ? item.callId : item.id;
  const receiverThreadIds: string[] = [];
  const agentsStates: JsonRecord = {};
  for (let index = 0; index < count; index += 1) {
    const settled = results[index] ?? {};
    const id = stringField(settled, ["session_id", "thread_id", "id"]) ?? `${callId}:${index}`;
    receiverThreadIds.push(id);
    const settledStatus = stringField(settled, ["status"]);
    const running = itemStatus(item) === "inProgress";
    const failed = settledStatus !== null && !["ok", "completed", "success", "dispatched"].includes(settledStatus);
    agentsStates[id] = {
      status: running ? "running" : failed ? "errored" : "completed",
      displayName: `Agent ${index + 1}`,
      model: stringField(settled, ["model"]),
      message: stringField(settled, ["summary", "message"]),
    };
  }
  return {
    ...item,
    type: "collabAgentToolCall",
    hermesToolName: "delegate_task",
    tool: "spawnAgent",
    agentId: receiverThreadIds[0] ?? null,
    agentName: count === 1 ? "Agent" : `${count} agents`,
    action: goals.join("\n"),
    prompt: goals.join("\n"),
    receiverThreadIds,
    agentsStates,
  };
}

function todoEntries(value: unknown): JsonRecord[] {
  const nested = parseRecord(value).todos;
  const source = Array.isArray(value) ? value : Array.isArray(nested) ? nested : [];
  return source.flatMap((entry, index) => {
    const item = parseRecord(entry);
    const text = stringField(item, ["content", "text", "title"]);
    if (text === null) return [];
    const status = stringField(item, ["status"]);
    return [{
      id: stringField(item, ["id"]) ?? `todo-${index}`,
      text,
      status: status === "completed" ? "completed" : status === "in_progress" ? "inProgress" : "pending",
    }];
  });
}

function projectTodo(item: AppServerThreadItem): AppServerThreadItem | null {
  const entries = todoEntries(itemResult(item));
  const fallback = entries.length > 0 ? entries : todoEntries(item.arguments);
  if (fallback.length === 0) return null;
  return { ...item, type: "todoList", hermesToolName: "todo", plan: fallback, explanation: null };
}

function projectGenericTool(item: AppServerThreadItem, name: string): AppServerThreadItem {
  const presentation = TOOL_ACTIVITY[name] ?? {
    operation: "other" as const,
    grouping: "groupable" as const,
    icon: "wrench" as const,
    active: null,
    completed: null,
  };
  const failed = itemStatus(item) === "failed" || item.success === false;
  // Hermes Desktop gives reactions no transcript surface and lets an active
  // Clarify request be owned exclusively by the Composer interaction. Keep
  // failed calls visible so the error still has one discoverable owner.
  const hidden = !failed && (name === "react_to_message"
    || (name === "clarify" && itemStatus(item) === "inProgress")
    || name === "todo");
  return { ...item, activityPresentation: { ...presentation, hidden } };
}

/**
 * Hermes owns source decoding; AppServer owns canonical Item semantics; the
 * Workbench renderer owns visual surface. Live and durable history both pass
 * through this function so an Item never changes meaning after reconnect.
 */
export function projectHermesTool(item: AppServerThreadItem): AppServerThreadItem {
  if (item.type !== "dynamicToolCall" && item.type !== "commandExecution") return item;
  const name = String(item.hermesToolName ?? item.tool ?? "tool");
  if (name === "terminal" || name === "execute_code") return projectCommand(item);
  if (FILE_EDIT_TOOLS.has(name)) return projectFileEdit(item, name) ?? projectGenericTool(item, name);
  if (name === "delegate_task") return projectDelegation(item);
  if (name === "image_generate") return projectGeneratedImage(item) ?? projectGenericTool(item, name);
  if (name === "todo") return projectTodo(item) ?? projectGenericTool(item, name);
  return projectGenericTool(item, name);
}
