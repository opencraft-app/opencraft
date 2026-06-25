import type {
  AgentWorkDetailWire,
  ChatSurfaceAgentWorkItem,
  ChatSurfaceConversationDebug,
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
  turnId?: string;
  agentWorkId?: string;
  detail?: AgentWorkDetailWire;
  detailFingerprint: string;
  debug: ChatSurfaceConversationDebug;
}

export function renderAgentWorkRows(items: ChatSurfaceAgentWorkItem[]): AgentWorkRenderRow[] {
  return items.flatMap((item) => {
    const detail = normalizedAgentWorkDetail(item.detail);
    const presentation = toolPresentation(item, detail);
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
        ...(item.turn_id !== undefined ? { turnId: item.turn_id } : {}),
        agentWorkId: item.id,
        ...(detail ? { detail } : {}),
        detailFingerprint: detail ? JSON.stringify(detail) : "",
        debug: item.debug,
      },
    ];
  });
}

function toolPresentation(
  item: ChatSurfaceAgentWorkItem,
  detail: AgentWorkDetailWire | undefined,
): { title: string; summary: string } | undefined {
  const explicitTitle = isGenericToolTitle(item.title) ? "" : item.title;
  const title =
    titleFromDetail(detail, item.status) ||
    explicitTitle ||
    "Tool call";
  const summary =
    summaryFromDetail(detail) ||
    nonDuplicateSummary(item.summary, item.title);

  if (!title) {
    return undefined;
  }

  return {
    title: isGenericToolTitle(title) ? "Tool call" : title,
    summary,
  };
}

function titleFromDetail(
  detail: AgentWorkDetailWire | undefined,
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
    case "tool":
      return stringField(detail.label) || stringField(detail.name);
    default:
      return "";
  }
}

function summaryFromDetail(detail: AgentWorkDetailWire | undefined): string {
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
    case "tool":
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

function toolDisplayIntent(item: ChatSurfaceAgentWorkItem): AgentWorkDisplay {
  const detail = normalizedAgentWorkDetail(item.detail);
  if (item.status === "failed" || item.status === "running" || item.status === "pending") {
    return "prominent";
  }
  if (!detail) return "compact";

  switch (detail.type) {
    case "edit":
    case "write":
    case "browser":
    case "mcp_tool":
    case "dynamic_tool":
    case "sub_agent":
    case "image_generation":
      return "prominent";
    case "tool": {
      const name = `${stringField(detail.name)} ${stringField(detail.command)}`.toLowerCase();
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

function normalizedAgentWorkDetail(
  detail: unknown,
): AgentWorkDetailWire | undefined {
  if (!isRecord(detail)) return undefined;
  if (typeof detail.type === "string") {
    return detail as AgentWorkDetailWire;
  }

  const nested = detail.detail;
  if (!isRecord(nested) || typeof nested.type !== "string") {
    return undefined;
  }

  const merged: Record<string, unknown> = { ...nested };
  copyIfMissing(detail, merged, "streams");
  copyIfMissing(detail, merged, "stdout");
  copyIfMissing(detail, merged, "stderr");
  copyIfMissing(detail, merged, "output");
  copyIfMissing(detail, merged, "error");
  return merged as AgentWorkDetailWire;
}

function copyIfMissing(
  from: Record<string, unknown>,
  to: Record<string, unknown>,
  key: string,
) {
  if (to[key] === undefined && from[key] !== undefined) {
    to[key] = from[key];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function filePathFromDetail(detail: AgentWorkDetailWire | undefined): string {
  if (!detail) return "";
  const generic = detail as Record<string, unknown>;
  return stringField(generic.file_path) || stringField(generic.path);
}

function outputSummary(detail: AgentWorkDetailWire | undefined): string {
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
