import type {
  CommandExecutionTimelineBlock,
  ImageTimelineBlock,
  PatchTimelineBlock,
  SubagentTimelineBlock,
  TimelineBlock,
  TimelineExecutionStatus,
  ToolCallTimelineBlock,
} from "./timeline";
import { deriveSubagentActivityPresentation, subagentInlineStatusLabel } from "./subagent-activity";
import { threadHandoffToolResult } from "./codex-app-tools";
import { parseSkillPath } from "./skill-path";
import { formatCodexDuration } from "./format-duration";

export type ToolActivityState = "running" | "completed" | "failed" | "interrupted";
export type ToolActivityGrouping = "groupable" | "standalone";
export type ToolActivityIcon =
  | "none"
  | "terminal"
  | "patch"
  | "wrench"
  | "search"
  | "read"
  | "files"
  | "stop"
  | "agent"
  | "image"
  | "browser"
  | "computer";

export interface ToolActivityPresentation {
  readonly state: ToolActivityState;
  readonly grouping: ToolActivityGrouping;
  readonly icon: ToolActivityIcon;
  readonly summary: string;
  readonly detail: string | null;
  readonly canExpand: boolean;
  readonly durationMs: number | null;
  /** Stable identity used by grouped Activity to coalesce repeated live polls. */
  readonly summaryKey: string;
  readonly continuesLiveActivityBetweenCalls: boolean;
  readonly summaryOnlyInConversationGroup: boolean;
}

export type ToolCallContentRole = "input" | "output" | "error";

export interface ToolCallContentAnnotations {
  readonly audience: readonly string[];
  readonly priority: number | null;
  readonly lastModified: string | null;
}

interface AnnotatedToolCallContentPart {
  readonly annotations?: ToolCallContentAnnotations;
}

/** Renderer-neutral tool body. Web and Native can choose different widgets. */
export type ToolCallContentPart =
  | (AnnotatedToolCallContentPart & { readonly kind: "text"; readonly role: ToolCallContentRole; readonly text: string })
  | (AnnotatedToolCallContentPart & { readonly kind: "json"; readonly role: ToolCallContentRole; readonly value: unknown })
  | (AnnotatedToolCallContentPart & { readonly kind: "unknown"; readonly role: ToolCallContentRole; readonly value: unknown })
  | (AnnotatedToolCallContentPart & { readonly kind: "image"; readonly role: ToolCallContentRole; readonly source: string; readonly alt: string | null })
  | (AnnotatedToolCallContentPart & { readonly kind: "audio"; readonly role: ToolCallContentRole; readonly source: string })
  | (AnnotatedToolCallContentPart & { readonly kind: "resource-link"; readonly role: ToolCallContentRole; readonly uri: string; readonly name: string; readonly mimeType: string | null })
  | (AnnotatedToolCallContentPart & {
      readonly kind: "embedded-resource";
      readonly role: ToolCallContentRole;
      readonly uri: string;
      readonly mimeType: string | null;
      readonly content: string | null;
    });

export interface ToolActivityPresenter {
  readonly name: string;
  readonly priority: number;
  matches(block: ToolCallTimelineBlock): boolean;
  present(block: ToolCallTimelineBlock, state: ToolActivityState): ToolActivityPresentation | null;
}

export interface ToolActivityPresenterClaim {
  readonly claimed: boolean;
  readonly presentation: ToolActivityPresentation | null;
}

/**
 * Product-neutral extension seam for tool semantics. Feature packages can
 * contribute a presenter without importing React or changing AppServer data.
 */
export class ToolActivityPresenterRegistry {
  private readonly presenters: Array<ToolActivityPresenter & { readonly order: number }> = [];
  private readonly listeners = new Set<() => void>();
  private nextOrder = 0;
  private version = 0;

  getSnapshot = (): number => this.version;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private publish(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  register(presenter: ToolActivityPresenter): () => void {
    const entry = { ...presenter, order: this.nextOrder++ };
    this.presenters.push(entry);
    this.presenters.sort((left, right) => right.priority - left.priority || left.order - right.order);
    this.publish();
    return () => {
      const index = this.presenters.indexOf(entry);
      if (index >= 0) {
        this.presenters.splice(index, 1);
        this.publish();
      }
    };
  }

  resolve(block: ToolCallTimelineBlock, state: ToolActivityState): ToolActivityPresentation | null {
    for (const presenter of this.presenters) {
      if (!presenter.matches(block)) continue;
      const presentation = presenter.present(block, state);
      if (presentation !== null) return presentation;
    }
    return null;
  }

  /**
   * Returns the first presenter that owns the call, including an intentional
   * null presentation. Codex uses this distinction for registered tools whose
   * arguments fail the tool-specific schema: the call stays in the protocol
   * record but does not fall through to a generic UI row.
   */
  claim(block: ToolCallTimelineBlock, state: ToolActivityState): ToolActivityPresenterClaim {
    for (const presenter of this.presenters) {
      if (!presenter.matches(block)) continue;
      return { claimed: true, presentation: presenter.present(block, state) };
    }
    return { claimed: false, presentation: null };
  }
}

export interface ToolCallStatistics {
  readonly totalCount: number;
  readonly failedCount: number;
  readonly commandCount: number;
  readonly patchCount: number;
  readonly mcpCount: number;
  readonly dynamicCount: number;
  readonly webSearchCount: number;
  readonly subagentCount: number;
  readonly imageGenerationCount: number;
  readonly imageViewCount: number;
  readonly sleepCount: number;
  readonly durationCount: number;
  readonly durationSumMs: number;
  readonly durationMaxMs: number;
}

type ActivityBlock = CommandExecutionTimelineBlock | PatchTimelineBlock | ToolCallTimelineBlock | SubagentTimelineBlock;

function stateFor(status: TimelineExecutionStatus): ToolActivityState {
  switch (status) {
    case "pending":
    case "running": return "running";
    case "complete": return "completed";
    case "failed": return "failed";
    case "interrupted": return "interrupted";
  }
}

function readableToolName(block: ToolCallTimelineBlock): string {
  const owner = block.server ?? block.namespace;
  return owner === null ? block.name : `${owner} · ${block.name}`;
}

const TOOL_NAME_ACRONYMS = new Set([
  "GH", "IA", "MCP", "API", "CI", "CLI", "LLM", "PDF", "PR", "UI", "URL", "SQL", "TW", "GPU", "CPU",
]);

const TOOL_NAME_CANONICAL = new Map<string, string>([
  ["openai", "OpenAI"],
  ["openaideveloperdocs", "OpenAI Developer Docs"],
  ["openapi", "OpenAPI"],
  ["github", "GitHub"],
  ["pagerduty", "PagerDuty"],
  ["datadog", "DataDog"],
  ["sharepoint", "SharePoint"],
  ["sqlite", "SQLite"],
  ["fastapi", "FastAPI"],
]);

function toolNameTokens(value: string): readonly string[] {
  return value.trim().toLocaleLowerCase().split(/[^a-z0-9]+/gu).filter(Boolean);
}

function stripMatchingAppPrefix(toolName: string, appName: string | null | undefined): readonly string[] {
  let tokens = [...toolNameTokens(toolName)];
  const prefixes = appName == null ? [] : [toolNameTokens(appName)];
  for (const prefix of prefixes.sort((left, right) => right.length - left.length)) {
    if (prefix.length <= tokens.length && prefix.every((token, index) => tokens[index] === token)) {
      tokens = tokens.slice(prefix.length);
      break;
    }
  }
  return tokens.length === 0 ? toolNameTokens(toolName) : tokens;
}

function formatToolToken(token: string, index: number): string {
  const upper = token.toLocaleUpperCase();
  if (TOOL_NAME_ACRONYMS.has(upper)) return upper;
  if (token.endsWith("s") && TOOL_NAME_ACRONYMS.has(token.slice(0, -1).toLocaleUpperCase())) {
    return `${token.slice(0, -1).toLocaleUpperCase()}s`;
  }
  const canonical = TOOL_NAME_CANONICAL.get(token.toLocaleLowerCase());
  if (canonical !== undefined) return canonical;
  const lower = token.toLocaleLowerCase();
  return index === 0 ? lower.charAt(0).toLocaleUpperCase() + lower.slice(1) : lower;
}

const COMPUTER_USE_LABELS: Readonly<Record<string, {
  readonly active: string;
  readonly activeWithApp: string;
  readonly completed: string;
  readonly completedWithApp: string;
  readonly activeWithDetail?: string;
  readonly activeWithDetailAndApp?: string;
  readonly completedWithDetail?: string;
  readonly completedWithDetailAndApp?: string;
}>> = {
  list_apps: { active: "List Mac apps", activeWithApp: "List Mac apps", completed: "List Mac apps", completedWithApp: "List Mac apps" },
  list_mac_apps: { active: "List Mac apps", activeWithApp: "List Mac apps", completed: "List Mac apps", completedWithApp: "List Mac apps" },
  click: { active: "Clicking", activeWithApp: "Clicking in {appName}", completed: "Clicked", completedWithApp: "Clicked in {appName}" },
  drag: { active: "Dragging", activeWithApp: "Dragging in {appName}", completed: "Dragged", completedWithApp: "Dragged in {appName}" },
  get_app_state: { active: "Looking", activeWithApp: "Looking at {appName}", completed: "Looked", completedWithApp: "Looked at {appName}" },
  get_state: { active: "Looking", activeWithApp: "Looking at {appName}", completed: "Looked", completedWithApp: "Looked at {appName}" },
  perform_accessibility_action: { active: "Performing accessibility action", activeWithApp: "Performing accessibility action in {appName}", completed: "Performed accessibility action", completedWithApp: "Performed accessibility action in {appName}" },
  perform_secondary_action: { active: "Performing accessibility action", activeWithApp: "Performing accessibility action in {appName}", completed: "Performed accessibility action", completedWithApp: "Performed accessibility action in {appName}" },
  press_key: { active: "Pressing key", activeWithApp: "Pressing key in {appName}", completed: "Pressed key", completedWithApp: "Pressed key in {appName}" },
  scroll: {
    active: "Scrolling", activeWithApp: "Scrolling in {appName}", completed: "Scrolled", completedWithApp: "Scrolled in {appName}",
    activeWithDetail: "Scrolling {detail}", activeWithDetailAndApp: "Scrolling {detail} in {appName}",
    completedWithDetail: "Scrolled {detail}", completedWithDetailAndApp: "Scrolled {detail} in {appName}",
  },
  set_value: {
    active: "Setting value", activeWithApp: "Setting value in {appName}", completed: "Set value", completedWithApp: "Set value in {appName}",
    activeWithDetail: "Setting to “{detail}”", activeWithDetailAndApp: "Setting to “{detail}” in {appName}",
    completedWithDetail: "Set to “{detail}”", completedWithDetailAndApp: "Set to “{detail}” in {appName}",
  },
  type_text: {
    active: "Typing text", activeWithApp: "Typing text in {appName}", completed: "Typed text", completedWithApp: "Typed text in {appName}",
    activeWithDetail: "Typing text “{detail}”", activeWithDetailAndApp: "Typing text “{detail}” in {appName}",
    completedWithDetail: "Typed text “{detail}”", completedWithDetailAndApp: "Typed text “{detail}” in {appName}",
  },
};

function normalizedComputerUseText(value: unknown, maximumLength = 120): string | null {
  const text = nonEmptyString(value)?.replace(/\s+/gu, " ").trim() ?? null;
  if (text === null) return null;
  if (text.length <= maximumLength) return text;
  return `${text.slice(0, maximumLength).trimEnd()}…`;
}

function computerUseObjectName(value: unknown): string | null {
  if (typeof value === "string") return normalizedComputerUseText(value);
  const source = object(value);
  if (source === null) return null;
  return normalizedComputerUseText(source.displayName)
    ?? normalizedComputerUseText(source.display_name)
    ?? normalizedComputerUseText(source.appName)
    ?? normalizedComputerUseText(source.app_name)
    ?? normalizedComputerUseText(source.name)
    ?? normalizedComputerUseText(source.title)
    ?? normalizedComputerUseText(source.bundleIdentifier)
    ?? normalizedComputerUseText(source.bundle_identifier)
    ?? normalizedComputerUseText(source.bundleId)
    ?? normalizedComputerUseText(source.bundle_id);
}

function looksLikeNativeAppIdentifier(value: string): boolean {
  return /^[a-z][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+)+$/u.test(value.trim())
    || /(^|[\\/])[^\\/]+\.exe$/iu.test(value.trim())
    || /^process:/iu.test(value.trim());
}

function computerUseAppName(block: ToolCallTimelineBlock): string | null {
  const input = object(block.input);
  const argumentName = computerUseObjectName(input?.app)
    ?? computerUseObjectName(input?.currentApp)
    ?? computerUseObjectName(input?.current_app)
    ?? normalizedComputerUseText(input?.targetAppName)
    ?? normalizedComputerUseText(input?.target_app_name)
    ?? normalizedComputerUseText(input?.appName)
    ?? normalizedComputerUseText(input?.app_name)
    ?? normalizedComputerUseText(input?.displayName)
    ?? normalizedComputerUseText(input?.display_name)
    ?? normalizedComputerUseText(input?.bundleIdentifier)
    ?? normalizedComputerUseText(input?.bundle_identifier)
    ?? normalizedComputerUseText(input?.bundleId)
    ?? normalizedComputerUseText(input?.bundle_id);
  const sourceName = block.sourceApp?.kind === "displayName" ? block.sourceApp.displayName : null;
  const candidate = argumentName ?? sourceName;
  if (candidate === null) return normalizedComputerUseText(block.appName);
  if (looksLikeNativeAppIdentifier(candidate)) return normalizedComputerUseText(block.appName) ?? "App";
  return candidate;
}

function computerUseDetail(block: ToolCallTimelineBlock): string | null {
  const input = object(block.input);
  if (input === null) return null;
  if (block.name === "scroll") {
    const direction = normalizedComputerUseText(input.direction)?.toLocaleLowerCase();
    return direction === "up" || direction === "down" || direction === "left" || direction === "right" ? direction : null;
  }
  if (block.name === "set_value") {
    return normalizedComputerUseText(input.value ?? input.targetValue ?? input.target_value, 48);
  }
  if (block.name === "type_text") return normalizedComputerUseText(input.text, 48);
  return null;
}

function fillComputerUseLabel(template: string, appName: string | null, detail: string | null): string {
  return template.replaceAll("{appName}", appName ?? "").replaceAll("{detail}", detail ?? "");
}

/** Source-identical core fallbacks used by Codex's MCP tool registry. */
export function formatMcpToolActivityLabel(block: ToolCallTimelineBlock, state: ToolActivityState = stateFor(block.status)): string {
  if (block.server === "node_repl" && block.name === "js") {
    const title = nonEmptyString(object(block.input)?.title);
    if (title !== null) return title.length <= 80 ? title : `${title.slice(0, 79).trimEnd()}…`;
  }
  if (block.sourceKind === "browserUse") {
    return block.sourceBackend === "chrome" ? "Used Chrome" : "Used the browser";
  }
  if (block.sourceKind === "computerUse" || block.server === "computer-use") {
    const labels = COMPUTER_USE_LABELS[block.name];
    if (labels !== undefined) {
      const completed = state !== "running";
      const appName = computerUseAppName(block);
      const detail = computerUseDetail(block);
      const template = detail !== null && appName !== null
        ? completed ? labels.completedWithDetailAndApp : labels.activeWithDetailAndApp
        : detail !== null
          ? completed ? labels.completedWithDetail : labels.activeWithDetail
          : appName !== null
            ? completed ? labels.completedWithApp : labels.activeWithApp
            : completed ? labels.completed : labels.active;
      return fillComputerUseLabel(template ?? (completed ? labels.completedWithApp : labels.activeWithApp), appName, detail);
    }
  }
  const tokens = stripMatchingAppPrefix(block.name, block.appName);
  return tokens.map(formatToolToken).join(" ") || block.name;
}

const DYNAMIC_TOOL_LABELS: Readonly<Record<string, { readonly active: string; readonly completed: string }>> = {
  automation_update: { active: "Updating scheduled task", completed: "Scheduled task updated" },
  load_workspace_dependencies: { active: "Loading workspace dependencies", completed: "Loaded workspace dependencies" },
  pia_slackbot_dm: { active: "Pia Slackbot DM", completed: "Pia Slackbot DM" },
  read_thread_terminal: { active: "Reading chat terminal", completed: "Read chat terminal" },
};

/** DSH (DeepSeek Harness) tools arrive under `deepseek-harness` with no native
 * presenter. Give the common ones a semantic Activity icon and label so they do
 * not fall through to the bare generic dynamic row. `bash` is listed for
 * completeness but is projected as `commandExecution` upstream. */
const DSH_HARNESS_TOOL_ICONS: Readonly<Record<string, ToolActivityIcon>> = {
  read: "read",
  bash: "terminal",
  glob: "search",
  grep: "search",
  search: "search",
  web_search: "search",
  write: "patch",
  edit: "patch",
};

const DSH_HARNESS_TOOL_LABELS: Readonly<Record<string, { readonly active: string; readonly completed: string }>> = {
  read: { active: "Reading", completed: "Read" },
  glob: { active: "Searching for files", completed: "Searched for files" },
  grep: { active: "Searching", completed: "Searched" },
  web_search: { active: "Searching the web", completed: "Searched the web" },
  write: { active: "Writing", completed: "Wrote" },
  edit: { active: "Editing", completed: "Edited" },
};

function formatDynamicToolName(value: string): string {
  const words = value
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
    .replace(/[_-]+/gu, " ")
    .trim()
    .toLocaleLowerCase();
  return words.length === 0 ? value : words.charAt(0).toLocaleUpperCase() + words.slice(1);
}

/** Generic dynamic calls are compact labels; only registered tools own a body. */
export function formatDynamicToolActivityLabel(block: ToolCallTimelineBlock, state: ToolActivityState): string {
  const labels = DYNAMIC_TOOL_LABELS[block.name];
  if (labels !== undefined) return state === "running" ? labels.active : labels.completed;
  return formatDynamicToolName(block.name);
}

function hasValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function object(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function contentAnnotations(value: unknown): ToolCallContentAnnotations | undefined {
  const source = object(value);
  if (source === null) return undefined;
  const audience = Array.isArray(source.audience)
    ? source.audience.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
  const priority = typeof source.priority === "number" && Number.isFinite(source.priority) ? source.priority : null;
  const lastModified = nonEmptyString(source.lastModified) ?? nonEmptyString(source.last_modified);
  return audience.length === 0 && priority === null && lastModified === null
    ? undefined
    : { audience, priority, lastModified };
}

const WEB_SEARCH_SITE_OPERATOR = /\bsite:([^\s]+)/giu;
const WEB_SEARCH_OR_OPERATOR = /\bOR\b/gu;

function searchHostname(value: string): string | null {
  try {
    return new URL(`https://${value}`).hostname.replace(/^www\./u, "");
  } catch {
    return null;
  }
}

/** Mirrors Codex's compact query label, including its extracted `site:` facets. */
function formatWebSearchQuery(value: string): string {
  const hostnames: string[] = [];
  const text = value.replace(WEB_SEARCH_SITE_OPERATOR, (match, candidate: string) => {
    const hostname = searchHostname(candidate);
    if (hostname === null) return match;
    if (!hostnames.includes(hostname)) hostnames.push(hostname);
    return "";
  });
  if (hostnames.length === 0) return value;
  const compact = text.replace(WEB_SEARCH_OR_OPERATOR, " ").replace(/\s+/gu, " ").trim();
  return compact.length === 0 ? value : `${compact} | ${hostnames.join(" · ")}`;
}

function firstWebSearchQuery(action: Readonly<Record<string, unknown>>): string | null {
  const query = nonEmptyString(action.query);
  if (query !== null) return formatWebSearchQuery(query.trim());
  const queries = Array.isArray(action.queries)
    ? action.queries.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
  const first = queries[0]?.trim();
  if (first === undefined) return null;
  const detail = formatWebSearchQuery(first);
  return queries.length > 1 ? `${detail} ...` : detail;
}

/** Extracts the exact compact detail used by Codex for every WebSearchAction. */
export function extractWebSearchDetail(value: unknown): string | null {
  if (typeof value === "string") return nonEmptyString(value);
  const source = object(value);
  if (source === null) return null;
  const action = object(source.action) ?? source;
  const fallback = nonEmptyString(source.query);
  const type = nonEmptyString(action.type);
  if (type === "search") return firstWebSearchQuery(action) ?? fallback;
  if (type === "openPage" || type === "open_page") return nonEmptyString(action.url) ?? fallback;
  if (type === "findInPage" || type === "find_in_page") {
    const pattern = nonEmptyString(action.pattern);
    const url = nonEmptyString(action.url);
    if (pattern !== null && url !== null) return `'${pattern}' in ${url}`;
    if (pattern !== null) return `'${pattern}'`;
    return url ?? fallback;
  }
  if (type === "other") return fallback;
  return firstWebSearchQuery(action) ?? fallback ?? nonEmptyString(action.pattern) ?? nonEmptyString(action.url);
}

function contentParts(value: unknown, role: ToolCallContentRole): readonly ToolCallContentPart[] {
  if (value === null || value === undefined) return [];
  if (typeof value === "string") return value.trim() === "" ? [] : [{ kind: "text", role, text: value }];
  if (Array.isArray(value)) return value.flatMap((entry) => contentParts(entry, role));
  const source = object(value);
  if (source === null) return [{ kind: "json", role, value }];
  const type = nonEmptyString(source.type);
  const annotations = contentAnnotations(source.annotations);
  if (type === "text" || type === "inputText" || type === "outputText") {
    const text = nonEmptyString(source.text);
    return text === null ? [] : [{ kind: "text", role, text, ...(annotations === undefined ? {} : { annotations }) }];
  }
  if (type === "image" || type === "inputImage" || type === "outputImage") {
    const direct = nonEmptyString(source.imageUrl) ?? nonEmptyString(source.url);
    const data = nonEmptyString(source.data);
    const mimeType = nonEmptyString(source.mimeType) ?? nonEmptyString(source.mime_type) ?? "image/png";
    const imageSource = direct ?? (data === null ? null : `data:${mimeType};base64,${data}`);
    return imageSource === null ? [] : [{ kind: "image", role, source: imageSource, alt: nonEmptyString(source.alt) ?? nonEmptyString(source.name), ...(annotations === undefined ? {} : { annotations }) }];
  }
  if (type === "audio" || type === "inputAudio" || type === "outputAudio") {
    const direct = nonEmptyString(source.audioUrl) ?? nonEmptyString(source.url);
    const data = nonEmptyString(source.data);
    const mimeType = nonEmptyString(source.mimeType) ?? nonEmptyString(source.mime_type) ?? "audio/mpeg";
    const audioSource = direct ?? (data === null ? null : `data:${mimeType};base64,${data}`);
    return audioSource === null ? [] : [{ kind: "audio", role, source: audioSource, ...(annotations === undefined ? {} : { annotations }) }];
  }
  if (type === "resource_link" || type === "resource-link") {
    const uri = nonEmptyString(source.uri);
    return uri === null ? [] : [{
      kind: "resource-link",
      role,
      uri,
      name: nonEmptyString(source.title) ?? nonEmptyString(source.name) ?? uri,
      mimeType: nonEmptyString(source.mimeType) ?? nonEmptyString(source.mime_type),
      ...(annotations === undefined ? {} : { annotations }),
    }];
  }
  if (type === "resource" || type === "embedded_resource" || type === "embedded-resource") {
    const resource = object(source.resource);
    const uri = nonEmptyString(resource?.uri);
    if (uri !== null) return [{
      kind: "embedded-resource",
      role,
      uri,
      mimeType: nonEmptyString(resource?.mimeType) ?? nonEmptyString(resource?.mime_type),
      content: nonEmptyString(resource?.text) ?? nonEmptyString(resource?.blob),
      ...((contentAnnotations(resource?.annotations) ?? annotations) === undefined ? {} : { annotations: contentAnnotations(resource?.annotations) ?? annotations }),
    }];
  }
  // A plain object is structured JSON (arguments and structuredContent use
  // this path). An object that declares an unsupported MCP content type is a
  // protocol content block Codex exposes verbatim as unknown content.
  return [{ kind: type === null ? "json" : "unknown", role, value }];
}

/** Removes MCP transport envelopes while preserving every user-visible body. */
export function extractToolCallContentParts(block: ToolCallTimelineBlock): readonly ToolCallContentPart[] {
  const parts: ToolCallContentPart[] = [];
  if (block.inlineDiff) parts.push({ kind: "text", role: "output", text: block.inlineDiff });
  if (block.errorMessage !== null) parts.push({ kind: "text", role: "error", text: block.errorMessage });
  parts.push(...contentParts(block.input, "input"));
  const output = object(block.output);
  if (output !== null && ("content" in output || "structuredContent" in output)) {
    let outputParts = contentParts(output.content, "output");
    const singleTextJson = (() => {
      if (block.kind !== "mcp" || outputParts.length !== 1) return null;
      const [part] = outputParts;
      if (part?.kind !== "text" || part.annotations !== undefined) return null;
      const text = part.text.trim();
      if (!text.startsWith("{") && !text.startsWith("[")) return null;
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return null;
      }
    })();
    // Codex treats every non-nullish structured result as present, including
    // empty containers and scalar false/zero values.
    const hasStructuredContent = output.structuredContent !== null && output.structuredContent !== undefined;
    const singleTextMatchesStructured = singleTextJson !== null && hasStructuredContent && (() => {
      try {
        return JSON.stringify(singleTextJson, null, 2) === JSON.stringify(output.structuredContent, null, 2);
      } catch {
        return false;
      }
    })();
    if (singleTextJson !== null && (!hasStructuredContent || singleTextMatchesStructured)) outputParts = [];
    parts.push(...outputParts);
    if (hasStructuredContent) {
      parts.push({ kind: "json", role: "output", value: output.structuredContent });
    } else if (singleTextJson !== null) {
      parts.push({ kind: "json", role: "output", value: singleTextJson });
    }
  } else {
    parts.push(...contentParts(block.output, "output"));
  }
  return parts;
}

function genericFields(
  id: string,
): Pick<ToolActivityPresentation, "summaryKey" | "continuesLiveActivityBetweenCalls" | "summaryOnlyInConversationGroup"> {
  return {
    summaryKey: id,
    continuesLiveActivityBetweenCalls: false,
    summaryOnlyInConversationGroup: false,
  };
}

function toolPresentationBase(
  block: ToolCallTimelineBlock,
  state: ToolActivityState,
): Pick<ToolActivityPresentation, "canExpand" | "durationMs" | "state"> {
  return {
    state,
    canExpand: hasValue(block.input) || hasValue(block.output) || block.errorMessage !== null,
    durationMs: block.durationMs,
  };
}

function commandActionPresentation(
  block: CommandExecutionTimelineBlock,
  state: ToolActivityState,
): Pick<ToolActivityPresentation, "summary" | "detail" | "icon"> | null {
  if (block.actions.length !== 1) return null;
  const action = block.actions[0];
  if (action.type === "read") {
    const skill = parseSkillPath(action.path || action.name, block.cwd);
    return {
      icon: state === "interrupted" ? "stop" : skill?.isSkillDefinitionFile === true ? "wrench" : "read",
      summary: state === "running" ? "Reading"
        : state === "failed" ? "Couldn’t read"
        : state === "interrupted" ? "Stopped reading"
        : "Read",
      // Codex displays the parsed read label/name while retaining `path` only
      // as the navigation target.
      detail: skill?.isSkillDefinitionFile === true
        ? `${skill.skillName} skill`
        : action.name || action.path || null,
    };
  }
  if (action.type === "list-files") {
    return {
      icon: state === "interrupted" ? "stop" : "files",
      summary: state === "running" ? "Listing files"
        : state === "failed" ? "Couldn’t list files"
        : state === "interrupted" ? "Stopped listing files"
        : "Listed files",
      detail: action.path === null ? null : `in ${action.path}`,
    };
  }
  if (action.type === "search") {
    const detail = action.query === null
      ? null
      : action.path === null ? `for ${action.query}` : `for ${action.query} in ${action.path}`;
    return {
      icon: state === "interrupted" ? "stop" : "search",
      summary: state === "running" ? (action.query === null ? "Searching for files" : "Searching")
        : state === "failed" ? "Search failed"
        : state === "interrupted" ? "Stopped searching"
        : action.query === null ? "Searched for files" : "Searched",
      detail,
    };
  }
  return null;
}

/** Exact duration shape used by Codex command Activity (`1m 0s`, null below 1s). */
export function formatCodexToolDuration(durationMs: number, locale = "en"): string | null {
  return formatCodexDuration(durationMs, { locale });
}

function isCurrentDateCommand(command: string): boolean {
  const tokens = command.trim().split(/\s+/gu);
  const executable = tokens.shift()?.split("/").at(-1);
  return executable === "date" && tokens.every((token) => token.startsWith("+")
    || token === "-u" || token === "--utc" || token === "--universal"
    || token === "-R" || token === "--rfc-email" || token === "-I"
    || token.startsWith("-I=") || token.startsWith("--iso-8601") || token.startsWith("--rfc-3339"));
}

export interface CommandActivitySummaryOptions {
  readonly expanded: boolean;
  readonly elapsedLabel: string | null;
}

/**
 * Codex command labels depend on disclosure and owning-Turn state, not just the
 * Item status. Keep this renderer-neutral so Web and Native cannot drift.
 */
export function formatCommandActivitySummary(
  block: CommandExecutionTimelineBlock,
  state: ToolActivityState,
  options: CommandActivitySummaryOptions,
): string {
  const elapsed = options.elapsedLabel;
  const command = block.command.trim();
  const withElapsed = (plain: string, connector: "for" | "in" | "after") => elapsed === null ? plain : `${plain} ${connector} ${elapsed}`;
  if (isCurrentDateCommand(command)) {
    if (state === "running") return withElapsed("Checking the current date and time", "for");
    if (state === "interrupted") return withElapsed("Stopped checking the current date and time", "after");
    return withElapsed("Checked the current date and time", "in");
  }

  const backgroundRunning = state === "running" && !block.turnInProgress;
  const backgroundFinished = state !== "running" && !block.turnInProgress && block.processId !== null;
  if (backgroundRunning) return command.length > 0
    ? `Started background terminal with ${command}`
    : "Started background terminal";
  if (backgroundFinished) {
    if (state === "interrupted") return command.length > 0
      ? `Background terminal stopped with ${command}`
      : "Background terminal stopped";
    return command.length > 0 ? `Ran ${command}` : "Background terminal finished";
  }

  if (state === "running") return withElapsed("Running command", "for");
  const showSpecificCommand = !options.expanded && command.length > 0;
  if (state === "interrupted") return withElapsed(
    showSpecificCommand ? `Stopped ${command}` : "Stopped command",
    "after",
  );
  return withElapsed(showSpecificCommand ? `Ran ${command}` : "Ran command", "in");
}

interface CodexAppToolLabels {
  readonly active: string;
  readonly completed: string;
  readonly failed?: string;
  readonly grouping?: ToolActivityGrouping;
  readonly continues?: boolean;
  readonly summaryOnly?: boolean;
}

/** Labels/grouping recovered from Codex's dynamic tool renderer registry. */
const CODEX_APP_TOOL_LABELS: Readonly<Record<string, CodexAppToolLabels>> = {
  fork_thread: { active: "Forking chat", completed: "Forked chat" },
  create_thread: { active: "Creating chat", completed: "Created chat" },
  list_threads: { active: "Listing chats", completed: "Listed chats", continues: true },
  read_thread: { active: "Reading chat", completed: "Read chat", continues: true },
  handoff_thread: {
    active: "Handing off chat",
    completed: "Handed off chat",
    failed: "Failed to hand off chat",
    grouping: "standalone",
  },
  get_handoff_status: {
    active: "Checking handoff status",
    completed: "Checked handoff status",
    summaryOnly: true,
  },
  send_message_to_thread: { active: "Sending message to chat", completed: "Sent message to chat" },
  set_thread_pinned: { active: "Updating chat pin", completed: "Updated chat pin" },
  set_thread_archived: { active: "Updating chat archive", completed: "Updated chat archive" },
  set_thread_title: { active: "Renaming chat", completed: "Renamed chat" },
};

function codexAppSummaryKey(block: ToolCallTimelineBlock): string {
  const input = object(block.input);
  if (block.name === "handoff_thread") {
    return `codex_app:handoff_thread:${nonEmptyString(input?.threadId) ?? nonEmptyString(input?.thread_id) ?? ""}:${nonEmptyString(input?.destinationHostId) ?? nonEmptyString(input?.destination_host_id) ?? ""}`;
  }
  if (block.name === "get_handoff_status") {
    return `codex_app:get_handoff_status:${nonEmptyString(input?.operationId) ?? nonEmptyString(input?.operation_id) ?? ""}`;
  }
  if (block.name === "fork_thread" || block.name === "create_thread") {
    const variant = nonEmptyString(input?.worktreeName)
      ?? nonEmptyString(input?.worktree_name)
      ?? nonEmptyString(input?.cwd)
      ?? "default";
    return `codex_app:${block.name}:${variant}`;
  }
  return `codex_app:${block.name}`;
}

function codexAppToolArgumentsValid(block: ToolCallTimelineBlock): boolean {
  const input = object(block.input);
  if (block.name === "fork_thread") {
    if (input === null) return false;
    const environment = input.environment;
    return environment === undefined
      || (object(environment) !== null && nonEmptyString(object(environment)?.type) !== null);
  }
  if (block.name === "create_thread") {
    const target = object(input?.target);
    if (target === null || nonEmptyString(target.type) === null) return false;
    const environment = target.environment;
    return environment === undefined
      || (object(environment) !== null && nonEmptyString(object(environment)?.type) !== null);
  }
  if (block.name === "handoff_thread") {
    if (nonEmptyString(input?.threadId) === null) return false;
    return input?.destinationHostId === undefined || nonEmptyString(input.destinationHostId) !== null;
  }
  if (block.name === "get_handoff_status") return nonEmptyString(input?.operationId) !== null;
  return true;
}

function createCodexAppPresenter(): ToolActivityPresenter {
  return {
    name: "codex-app-tools",
    priority: 100,
    matches: (block) => block.kind === "dynamic"
      && block.namespace === "codex_app"
      && block.name in CODEX_APP_TOOL_LABELS,
    present(block, state) {
      const labels = CODEX_APP_TOOL_LABELS[block.name];
      if (labels === undefined) return null;
      if (!codexAppToolArgumentsValid(block)) return null;
      const input = object(block.input);
      const hasWorktree = block.name === "fork_thread"
        ? object(input?.environment)?.type === "worktree"
        : block.name === "create_thread"
          ? object(input?.target)?.type === "project" && object(object(input?.target)?.environment)?.type === "worktree"
          : false;
      const active = hasWorktree
        ? block.name === "fork_thread" ? "Forking chat in new worktree" : "Creating worktree chat"
        : labels.active;
      const completed = hasWorktree
        ? block.name === "fork_thread" ? "Forked chat in new worktree" : "Created worktree chat"
        : labels.completed;
      const handoff = threadHandoffToolResult(block);
      const handoffDestination = handoff?.destinationHostDisplayName ?? null;
      const handoffTitle = handoff?.threadTitle ?? null;
      const effectiveState: ToolActivityState = handoff === null ? state
        : handoff.status === "queued" || handoff.status === "running" ? "running"
        : handoff.status === "error" ? "failed"
        : "completed";
      const handoffSummary = handoff === null ? null
        : handoff.status === "queued" || handoff.status === "running"
          ? handoffTitle !== null && handoffDestination !== null
            ? `Handing off ${handoffTitle} to ${handoffDestination}`
            : "Handing off chat"
          : handoff.status === "error"
            ? handoffTitle !== null && handoffDestination !== null
              ? `Failed to hand off ${handoffTitle} to ${handoffDestination}`
              : "Failed to hand off chat"
            : handoff.status === "warning"
              ? handoffDestination === null ? "Handoff needs attention" : `Handoff to ${handoffDestination} needs attention`
              : handoffTitle !== null && handoffDestination !== null
                ? `Handed off ${handoffTitle} to ${handoffDestination}`
                : "Handed off chat";
      const summary = handoffSummary ?? (state === "running"
        ? active
        : state === "failed"
          ? labels.failed ?? completed
          : state === "interrupted"
            ? completed
            : completed);
      return {
        ...toolPresentationBase(block, effectiveState),
        grouping: block.appResourceUri === null ? labels.grouping ?? "groupable" : "standalone",
        icon: "agent",
        summary,
        detail: block.errorMessage,
        summaryKey: codexAppSummaryKey(block),
        continuesLiveActivityBetweenCalls: labels.continues ?? false,
        summaryOnlyInConversationGroup: labels.summaryOnly ?? false,
      };
    },
  };
}

function createCodexSettingsPresenter(): ToolActivityPresenter {
  return {
    name: "codex-settings-tools",
    priority: 110,
    matches: (block) => block.kind === "dynamic"
      && block.namespace === "codex_app"
      && (block.name === "read_settings" || block.name === "write_settings"),
    present(block, state) {
      const writing = block.name === "write_settings";
      const waitingForApproval = writing && state === "running" && object(block.input)?.config !== undefined;
      const summary = writing
        ? waitingForApproval ? "Waiting for approval"
          : state === "running" ? "Updating settings"
            : state === "failed" ? "Couldn’t update settings"
              : "Updated settings"
        : state === "running" ? "Reading settings"
          : "Read settings";
      return {
        ...toolPresentationBase(block, state),
        ...genericFields(`codex_app:${block.name}`),
        grouping: "groupable",
        icon: "wrench",
        summary,
        detail: null,
        canExpand: false,
      };
    },
  };
}

/** Chrome metadata/title and favicon are host-owned; the core fallback is exact. */
function createChromeTabContextPresenter(): ToolActivityPresenter {
  return {
    name: "chrome-tab-context",
    priority: 105,
    matches: (block) => block.kind === "dynamic"
      && block.namespace === "chrome_extension"
      && block.name === "getTabContext",
    present(block, state) {
      const tabId = object(block.input)?.tabId;
      if (typeof tabId !== "number" || !Number.isInteger(tabId) || tabId < 0) return null;
      return {
        ...toolPresentationBase(block, state),
        ...genericFields(`chrome_extension:getTabContext:${block.callId ?? block.id}`),
        grouping: "groupable",
        icon: "browser",
        summary: state === "running" ? "Reading tab"
          : "Read tab",
        detail: null,
        canExpand: false,
      };
    },
  };
}

function createClockSleepPresenter(): ToolActivityPresenter {
  return {
    name: "clock-sleep",
    priority: 90,
    matches: (block) => block.kind === "dynamic" && block.namespace === "clock" && block.name === "sleep",
    present(block, state) {
      return {
        state,
        grouping: "groupable",
        icon: "terminal",
        summary: state === "running" ? "Waiting"
          : state === "failed" ? "Wait failed"
          : state === "interrupted" ? "Stopped waiting"
          : "Waited",
        detail: null,
        canExpand: false,
        durationMs: block.durationMs,
        ...genericFields("clock:sleep"),
      };
    },
  };
}

function firstNonEmptyString(values: unknown): string | null {
  if (!Array.isArray(values)) return null;
  for (const value of values) {
    const text = nonEmptyString(value);
    if (text !== null) return text;
  }
  return null;
}

/** Collapses a DSH tool's arguments into a compact one-line detail. */
function dshHarnessToolDetail(block: ToolCallTimelineBlock): string | null {
  const input = object(block.input);
  const detail = nonEmptyString(input?.path)
    ?? nonEmptyString(input?.file_path)
    ?? nonEmptyString(input?.command)
    ?? nonEmptyString(input?.pattern)
    ?? nonEmptyString(input?.query)
    ?? firstNonEmptyString(input?.queries)
    ?? firstNonEmptyString(input?.questions);
  return detail?.slice(0, 180) ?? null;
}

/** DSH tools are projected under `deepseek-harness`; unlike generic dynamic
 * calls they carry real arguments/contentItems and should render like Codex
 * native tools instead of a bare, unexpandable name. */
function createDshHarnessPresenter(): ToolActivityPresenter {
  return {
    name: "dsh-harness",
    priority: 100,
    matches: (block) => block.kind === "dynamic" && block.namespace === "deepseek-harness",
    present(block, state) {
      const labels = DSH_HARNESS_TOOL_LABELS[block.name];
      return {
        ...toolPresentationBase(block, state),
        grouping: "groupable",
        icon: DSH_HARNESS_TOOL_ICONS[block.name] ?? "wrench",
        summary: labels !== undefined
          ? state === "running" ? labels.active : labels.completed
          : formatDynamicToolName(block.name),
        detail: dshHarnessToolDetail(block),
        ...genericFields(`${block.namespace ?? ""}:${block.name}:${block.id}`),
      };
    },
  };
}

/** Codex reserves these dynamic calls for non-Activity presentation. */
function createHiddenSystemDynamicToolPresenter(): ToolActivityPresenter {
  return {
    name: "hidden-system-dynamic-tools",
    priority: 1_000,
    matches: (block) => block.kind === "dynamic"
      && (block.name === "automation_update" || block.name === "load_workspace_dependencies"),
    present: () => null,
  };
}

export function createDefaultToolActivityPresenterRegistry(): ToolActivityPresenterRegistry {
  const registry = new ToolActivityPresenterRegistry();
  registry.register(createHiddenSystemDynamicToolPresenter());
  registry.register(createCodexSettingsPresenter());
  registry.register(createChromeTabContextPresenter());
  registry.register(createCodexAppPresenter());
  registry.register(createClockSleepPresenter());
  registry.register(createDshHarnessPresenter());
  return registry;
}

const defaultToolActivityPresenters = createDefaultToolActivityPresenterRegistry();

export function isToolActivityBlock(block: TimelineBlock): block is ActivityBlock {
  return block.type === "command-execution"
    || block.type === "patch"
    || block.type === "tool-call"
    || block.type === "subagent";
}

/** Some transport/poll tools contribute to the group summary but never own a visible row. */
export function isSummaryOnlyToolActivityBlock(
  block: TimelineBlock,
  registry: ToolActivityPresenterRegistry = defaultToolActivityPresenters,
): boolean {
  return block.type === "tool-call" && presentToolActivity(block, registry).summaryOnlyInConversationGroup;
}

/** A registered presenter may deliberately claim and suppress an invalid call. */
export function isToolActivityPresentationSuppressed(
  block: ToolCallTimelineBlock,
  registry: ToolActivityPresenterRegistry = defaultToolActivityPresenters,
): boolean {
  if (block.activityPresentation?.hidden === true) return true;
  const state = isToolCallFailed(block) ? "failed" : stateFor(block.status);
  const claim = registry.claim(block, state);
  return claim.claimed && claim.presentation === null;
}

/** Mirrors Codex's failure predicate instead of treating every completed call as successful. */
export function isToolCallFailed(block: ActivityBlock): boolean {
  if (block.status === "failed") return true;
  if (block.type === "command-execution") return block.exitCode !== null && block.exitCode !== 0;
  if (block.type === "tool-call") {
    if (block.errorMessage !== null) return true;
    if (typeof block.output === "object" && block.output !== null && "isError" in block.output) {
      return (block.output as { readonly isError?: unknown }).isError === true;
    }
  }
  return false;
}

export function presentToolActivity(
  block: ActivityBlock,
  registry: ToolActivityPresenterRegistry = defaultToolActivityPresenters,
): ToolActivityPresentation {
  const state = isToolCallFailed(block) ? "failed" : stateFor(block.status);
  if (block.type === "command-execution") {
    const semantic = commandActionPresentation(block, state);
    return {
      state,
      grouping: "groupable",
      icon: semantic?.icon ?? (state === "interrupted" ? "stop" : "terminal"),
      summary: semantic?.summary ?? (state === "running" ? "Running command"
        : state === "interrupted" ? "Stopped command"
        : "Ran command"),
      detail: semantic?.detail ?? null,
      canExpand: Boolean(block.command || block.cwd || block.output || block.exitCode !== null),
      durationMs: block.durationMs,
      ...genericFields(block.id),
    };
  }
  if (block.type === "patch") {
    return {
      state,
      grouping: "groupable",
      icon: "patch",
      summary: state === "running" ? "Applying changes"
        : state === "failed" ? "Couldn’t apply changes"
        : state === "interrupted" ? "Stopped applying changes"
        : block.title,
      detail: block.changes.length === 0 ? null : `${block.changes.length} file${block.changes.length === 1 ? "" : "s"}`,
      canExpand: block.changes.length > 0,
      durationMs: null,
      ...genericFields(block.id),
    };
  }
  if (block.type === "subagent") {
    const subagent = deriveSubagentActivityPresentation(block);
    const inlineAgent = block.activityKind === null ? null : subagent.agents[0] ?? null;
    return {
      state,
      grouping: "standalone",
      icon: "agent",
      summary: inlineAgent === null ? subagent.actionLabel : subagentInlineStatusLabel(inlineAgent),
      detail: inlineAgent !== null ? null
        : subagent.agents.length === 1 ? subagent.agents[0]?.displayName ?? null
        : `${subagent.agents.length} agents`,
      canExpand: subagent.expandable,
      durationMs: null,
      ...genericFields(block.id),
    };
  }

  const specialized = registry.resolve(block, state);
  if (specialized !== null) return specialized;

  const name = readableToolName(block);
  if (block.kind === "web-search") {
    return {
      state,
      grouping: "groupable",
      icon: "browser",
      summary: state === "running" ? "Searching the web"
        : state === "failed" ? "Web search failed"
        : state === "interrupted" ? "Web search stopped"
        : "Searched the web",
      detail: (() => {
        const detail = extractWebSearchDetail(block.input);
        return detail === null ? null : `for ${detail}`;
      })(),
      canExpand: false,
      durationMs: block.durationMs,
      ...genericFields(block.id),
    };
  }
  if (block.kind === "image-view") {
    const imageCount = Math.max(1, block.imagePaths?.length ?? 0);
    return {
      state,
      grouping: "standalone",
      icon: "image",
      summary: state === "running"
        ? imageCount === 1 ? "Viewing an image" : `Viewing ${imageCount} images`
        : imageCount === 1 ? "Viewed an image" : `Viewed ${imageCount} images`,
      detail: null,
      canExpand: (block.imagePaths?.length ?? 0) > 0,
      durationMs: null,
      ...genericFields(block.id),
    };
  }
  if (block.kind === "mcp") {
    return {
      state,
      grouping: block.appResourceUri === null ? "groupable" : "standalone",
      icon: block.sourceKind === "browserUse" ? "browser"
        : block.sourceKind === "computerUse" || block.server === "computer-use" ? "computer"
        : block.server === "node_repl" ? "terminal"
        : "wrench",
      summary: formatMcpToolActivityLabel(block, state),
      // Codex keeps the collapsed MCP row tool-only. Protocol errors belong
      // to the expanded danger surface and the Raw result envelope.
      detail: null,
      // Source disclosure is present for every settled MCP item and as soon as
      // a live result envelope exists, including an intentionally empty one.
      canExpand: state !== "running" || block.output !== null || block.errorMessage !== null,
      durationMs: block.durationMs,
      ...genericFields(block.id),
    };
  }
  if (block.kind === "dynamic") {
    if (block.activityPresentation) {
      const input = object(block.input);
      const target = block.progressText || block.toolContext
        || nonEmptyString(input?.command) || nonEmptyString(input?.path)
        || nonEmptyString(input?.query) || nonEmptyString(input?.url);
      return {
        state,
        grouping: block.appResourceUri ? "standalone" : block.activityPresentation.grouping,
        icon: block.activityPresentation.icon,
        summary: (state === "running" ? block.activityPresentation.active
          : state === "completed" ? block.activityPresentation.completed : null) ?? formatDynamicToolActivityLabel(block, state),
        detail: block.resultMissing ? "Execution result unavailable"
          : block.errorMessage ?? (state === "running" ? target : block.toolSummary || target)?.slice(0, 180) ?? null,
        // Provider-authored labels and grouping do not grant a content
        // surface. Generic dynamic calls stay compact; only a registered
        // presenter may turn protocol payload into an expandable product UI.
        canExpand: false,
        durationMs: block.durationMs,
        ...genericFields(block.id),
      };
    }
    return {
      state,
      grouping: "groupable",
      // The source renderer gives every generic codex_app dynamic call the
      // Codex/agent mark, even when it has no specialized presenter.
      icon: block.namespace === "codex_app" ? "agent" : "none",
      summary: formatDynamicToolActivityLabel(block, state),
      detail: null,
      canExpand: false,
      durationMs: block.durationMs,
      ...genericFields(`${block.namespace ?? ""}:${block.name}:`),
    };
  }
  return {
    state,
    grouping: block.appResourceUri === null ? "groupable" : "standalone",
    icon: "wrench",
    summary: state === "running" ? `Calling ${name}`
      : state === "failed" ? `Call to ${name} failed`
      : state === "interrupted" ? `Call to ${name} stopped`
      : `Called ${name}`,
    detail: block.errorMessage,
    canExpand: hasValue(block.input) || hasValue(block.output) || block.errorMessage !== null,
    durationMs: block.durationMs,
    ...genericFields(block.id),
  };
}

/** Codex deduplicates repeated projected updates by item id before counting and timing calls. */
export function aggregateToolCallStatistics(blocks: readonly TimelineBlock[]): ToolCallStatistics {
  const unique = new Map<string, ActivityBlock | ImageTimelineBlock>();
  for (const block of blocks) {
    if (isToolActivityBlock(block) || (block.type === "image" && block.generated)) unique.set(block.id, block);
  }
  const initial: ToolCallStatistics = {
    totalCount: 0,
    failedCount: 0,
    commandCount: 0,
    patchCount: 0,
    mcpCount: 0,
    dynamicCount: 0,
    webSearchCount: 0,
    subagentCount: 0,
    imageGenerationCount: 0,
    imageViewCount: 0,
    sleepCount: 0,
    durationCount: 0,
    durationSumMs: 0,
    durationMaxMs: 0,
  };
  return [...unique.values()].reduce<ToolCallStatistics>((stats, block) => {
    const durationMs = block.type === "command-execution" || block.type === "tool-call" ? block.durationMs : null;
    const isSleep = block.type === "tool-call" && block.kind === "dynamic" && block.namespace === "clock" && block.name === "sleep";
    return {
      totalCount: stats.totalCount + 1,
      failedCount: stats.failedCount + (block.type === "image" ? (block.status === "failed" ? 1 : 0) : (isToolCallFailed(block) ? 1 : 0)),
      commandCount: stats.commandCount + (block.type === "command-execution" ? 1 : 0),
      patchCount: stats.patchCount + (block.type === "patch" ? 1 : 0),
      mcpCount: stats.mcpCount + (block.type === "tool-call" && block.kind === "mcp" ? 1 : 0),
      dynamicCount: stats.dynamicCount + (block.type === "tool-call" && block.kind === "dynamic" && !isSleep ? 1 : 0),
      webSearchCount: stats.webSearchCount + (block.type === "tool-call" && block.kind === "web-search" ? 1 : 0),
      subagentCount: stats.subagentCount + (block.type === "subagent" ? 1 : 0),
      imageGenerationCount: stats.imageGenerationCount + (block.type === "image" ? 1 : 0),
      imageViewCount: stats.imageViewCount + (block.type === "tool-call" && block.kind === "image-view" ? 1 : 0),
      sleepCount: stats.sleepCount + (isSleep ? 1 : 0),
      durationCount: stats.durationCount + (durationMs === null ? 0 : 1),
      durationSumMs: stats.durationSumMs + (durationMs ?? 0),
      durationMaxMs: Math.max(stats.durationMaxMs, durationMs ?? 0),
    };
  }, initial);
}
