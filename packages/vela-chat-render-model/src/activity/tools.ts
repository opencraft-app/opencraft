import type {
  ChatSurfaceActivityItem,
  ChatSurfaceDebug,
} from "../../../vela-chat-surface/src";

export type AgentWorkDisplay = "compact" | "prominent";

export interface AgentWorkRenderRow {
  kind: "agent_work";
  id: string;
  key: string;
  title: string;
  summary: string;
  status: string;
  display: AgentWorkDisplay;
  createdAt: string;
  updatedAt?: string;
  debug: ChatSurfaceDebug;
}

export function renderToolActivityRows(items: ChatSurfaceActivityItem[]): AgentWorkRenderRow[] {
  return items.flatMap((item) => {
    if (!isToolActivity(item)) return [];
    const presentation = toolPresentation(item);
    if (!presentation) return [];
    return [
      {
        kind: "agent_work",
        id: item.id,
        key: `tool:${item.id}`,
        title: presentation.title,
        summary: presentation.summary,
        status: item.status,
        display: toolDisplayIntent(item),
        createdAt: item.created_at,
        updatedAt: item.updated_at,
        activityId: item.id,
        debug: item.debug,
      },
    ];
  });
}

function isToolActivity(item: ChatSurfaceActivityItem): boolean {
  return item.kind === "tool" || Boolean(item.detail?.type);
}

function toolPresentation(
  item: ChatSurfaceActivityItem,
): { title: string; summary: string } | undefined {
  const detail = item.detail;
  const rawLabel = providerLabelPresentation(item.title) ?? providerLabelPresentation(item.summary);
  const explicitTitle = isGenericToolTitle(item.title) ? "" : item.title;
  const title =
    titleFromDetail(detail, item.status) ||
    rawLabel?.title ||
    explicitTitle ||
    legacyToolTitle(detail) ||
    (item.kind === "tool" ? "Tool call" : "");
  const summary =
    summaryFromDetail(detail) ||
    rawLabel?.summary ||
    nonDuplicateSummary(item.summary, item.title) ||
    legacyToolSummary(detail);

  if (!title) {
    return undefined;
  }

  return {
    title: isGenericToolTitle(title) ? "Tool call" : title,
    summary,
  };
}

function titleFromDetail(
  detail: ChatSurfaceActivityItem["detail"],
  status: string,
): string {
  if (!detail) return "";
  switch (detail.type) {
    case "shell":
      return status === "running" || status === "pending" ? "Running command" : "Ran command";
    case "read":
      return "Read file";
    case "edit":
      return "Edited file";
    case "write":
      return "Wrote file";
    case "search":
      return stringField(detail.mode) === "web" ? "Searched web" : "Searched code";
    case "fetch":
      return "Fetched URL";
    case "browser":
      return "Browser action";
    case "mcp_tool":
      return "MCP tool";
    case "dynamic_tool":
      return "Tool call";
    case "sub_agent":
      return "Sub-agent";
    case "image_generation":
      return "Generated image";
    case "image_view":
      return "Viewed image";
    case "plan":
      return "Updated plan";
    case "plain_text":
      return stringField(detail.label);
    default:
      return "";
  }
}

function providerLabelPresentation(
  value: string | undefined,
): { title: string; summary: string } | undefined {
  const label = (value ?? "").trim();
  const separator = label.indexOf(":");
  if (separator <= 0) return undefined;

  const prefix = label.slice(0, separator).trim().toLowerCase();
  const rest = label.slice(separator + 1).trim();
  if (!rest) return undefined;

  switch (prefix) {
    case "search":
    case "grep":
    case "rg":
    case "find":
      return { title: "Searched code", summary: rest };
    case "terminal":
    case "shell":
    case "bash":
    case "command":
      return { title: "Ran command", summary: rest };
    case "python":
      return { title: "Ran Python", summary: rest };
    case "read":
    case "cat":
      return { title: "Read file", summary: rest };
    case "edit":
      return { title: "Edited file", summary: rest };
    case "write":
      return { title: "Wrote file", summary: rest };
    case "fetch":
    case "curl":
      return { title: "Fetched URL", summary: rest };
    default:
      return undefined;
  }
}

function summaryFromDetail(detail: ChatSurfaceActivityItem["detail"]): string {
  if (!detail) return "";
  switch (detail.type) {
    case "shell":
      return truncateMiddle(stringField(detail.command) || outputSummary(detail));
    case "read":
    case "edit":
    case "write":
      return truncateMiddle(filePathFromDetail(detail));
    case "search":
      return joinSummaryParts([
        stringField(detail.query),
        countLabel(numberField(detail.num_matches), "match", "matches") ||
          countLabel(numberField(detail.num_files), "file", "files"),
      ]);
    case "fetch":
      return truncateMiddle(stringField(detail.url) || stringField(detail.result));
    case "plan":
      return truncateMiddle(stringField(detail.text));
    case "plain_text":
      return truncateMiddle(stringField(detail.text));
    case "unknown":
      return truncateMiddle(stringField(detail.output) || stringField(detail.input));
    default: {
      const generic = detail as Record<string, unknown>;
      return truncateMiddle(
        stringField(generic.summary) ||
          stringField(generic.description) ||
          stringField(generic.name) ||
          "",
      );
    }
  }
}

function legacyToolTitle(detail: ChatSurfaceActivityItem["detail"]): string {
  if (!detail || detail.type !== "tool") return "";
  return (
    stringField(detail.name) ||
    stringField(detail.command) ||
    stringField(detail.query) ||
    stringField(detail.path) ||
    "Tool"
  );
}

function legacyToolSummary(detail: ChatSurfaceActivityItem["detail"]): string {
  if (!detail || detail.type !== "tool") return "";
  return (
    stringField(detail.output) ||
    stringField(detail.stdout) ||
    stringField(detail.stderr) ||
    stringField(detail.delta) ||
    stringField(detail.error) ||
    stringField(detail.command) ||
    stringField(detail.query) ||
    stringField(detail.path) ||
    ""
  );
}

function toolDisplayIntent(item: ChatSurfaceActivityItem): AgentWorkDisplay {
  if (item.status === "failed") return "prominent";
  const providerDisplay = providerLabelDisplayIntent(item.title) ?? providerLabelDisplayIntent(item.summary);
  if (providerDisplay) return providerDisplay;
  if (!item.detail) return "compact";

  switch (item.detail.type) {
    case "shell":
    case "edit":
    case "write":
    case "fetch":
    case "browser":
    case "mcp_tool":
    case "dynamic_tool":
    case "sub_agent":
    case "image_generation":
      return "prominent";
    case "tool": {
      const name = `${stringField(item.detail.name)} ${stringField(item.detail.command)}`.toLowerCase();
      if (
        name.includes("bash") ||
        name.includes("shell") ||
        name.includes("command") ||
        name.includes("test") ||
        name.includes("build") ||
        name.includes("browser") ||
        name.includes("edit") ||
        name.includes("write") ||
        name.includes("patch")
      ) {
        return "prominent";
      }
      break;
    }
  }

  return "compact";
}

function providerLabelDisplayIntent(value: string | undefined): AgentWorkDisplay | undefined {
  const label = (value ?? "").trim();
  const separator = label.indexOf(":");
  if (separator <= 0) return undefined;

  const prefix = label.slice(0, separator).trim().toLowerCase();
  switch (prefix) {
    case "terminal":
    case "shell":
    case "bash":
    case "command":
    case "python":
    case "edit":
    case "write":
    case "fetch":
    case "curl":
      return "prominent";
    case "search":
    case "grep":
    case "rg":
    case "find":
    case "read":
    case "cat":
      return "compact";
    default:
      return undefined;
  }
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nonDuplicateSummary(summary: string | undefined, title: string | undefined): string {
  const normalizedSummary = (summary ?? "").trim();
  if (!normalizedSummary) return "";
  if (normalizedSummary === (title ?? "").trim()) return "";
  return normalizedSummary;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function filePathFromDetail(detail: ChatSurfaceActivityItem["detail"]): string {
  if (!detail) return "";
  const generic = detail as Record<string, unknown>;
  return stringField(generic.file_path) || stringField(generic.path);
}

function outputSummary(detail: ChatSurfaceActivityItem["detail"]): string {
  if (!detail) return "";
  const generic = detail as Record<string, unknown>;
  return (
    stringField(generic.output) ||
    stringField(generic.stdout) ||
    stringField(generic.stderr) ||
    stringField(generic.error)
  );
}

function countLabel(
  count: number | undefined,
  singular: string,
  plural: string,
): string {
  if (count === undefined) return "";
  return `${count} ${count === 1 ? singular : plural}`;
}

function joinSummaryParts(parts: string[]): string {
  return parts.filter(Boolean).map((part) => truncateMiddle(part)).join(" · ");
}

function truncateMiddle(value: string, limit = 96): string {
  if (value.length <= limit) return value;
  const head = Math.ceil((limit - 1) * 0.62);
  const tail = Math.floor((limit - 1) * 0.38);
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`;
}

function isGenericToolTitle(value: string | undefined): boolean {
  const normalized = (value ?? "").trim().toLowerCase();
  return [
    "",
    "tool",
    "tool call",
    "dynamic tool call",
    "mcp tool call",
    "command execution",
  ].includes(normalized);
}
