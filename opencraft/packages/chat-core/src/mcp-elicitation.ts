export type McpElicitationFieldKind = "text" | "number" | "boolean" | "select" | "multi-select";

export interface McpElicitationOption {
  readonly value: string;
  readonly label: string;
}

export interface McpElicitationField {
  readonly name: string;
  readonly title: string;
  readonly description: string | null;
  readonly kind: McpElicitationFieldKind;
  readonly required: boolean;
  readonly options: readonly McpElicitationOption[];
  readonly integer: boolean;
  readonly minimum: number | null;
  readonly maximum: number | null;
  readonly minLength: number | null;
  readonly maxLength: number | null;
  readonly format: string | null;
  readonly defaultValue: string | boolean | readonly string[];
}

export type McpElicitationDraftValue = string | boolean | readonly string[];
export type McpElicitationDraft = Readonly<Record<string, McpElicitationDraftValue>>;

export interface McpElicitationValidationResult {
  readonly content: Readonly<Record<string, string | number | boolean | string[]>> | null;
  readonly errors: Readonly<Record<string, string>>;
}

export interface McpElicitationMetadata {
  readonly interactionKind: "form" | "tool-approval" | "tool-suggestion" | "connector-auth" | "url-action";
  readonly riskLevel: "low" | "high" | null;
  readonly subtitle: string | null;
  readonly persist: readonly ("session" | "always")[];
  readonly toolApproval: {
    readonly connectorId: string;
    readonly connectorName: string | null;
    readonly toolName: string | null;
    readonly toolTitle: string | null;
    readonly toolParams: Readonly<Record<string, unknown>>;
    readonly toolParamsDisplay: readonly {
      readonly name: string;
      readonly displayName: string;
      readonly value: unknown;
    }[];
  } | null;
  readonly toolSuggestion: {
    readonly suggestType: "install" | "enable";
    readonly suggestReason: string;
    readonly toolId: string;
    readonly toolName: string;
    readonly toolType: "connector" | "plugin";
    readonly installUrl: string | null;
    readonly remotePluginId: string | null;
    readonly persistAlways: boolean;
  } | null;
  readonly connectorAuth: {
    readonly connectorId: string;
    readonly connectorName: string;
    readonly installUrl: string;
    readonly authReason: string | null;
    readonly linkId: string | null;
    readonly requestedScopes: readonly string[];
  } | null;
}

export interface McpElicitationMetadataContext {
  readonly serverName?: string | null;
  readonly message?: string | null;
  readonly requestedSchema?: unknown;
}

type RecordValue = Readonly<Record<string, unknown>>;

function record(value: unknown): RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as RecordValue : {};
}

function string(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function persistValues(value: unknown): readonly ("session" | "always")[] {
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values.filter((entry): entry is "session" | "always" => entry === "session" || entry === "always"))];
}

/**
 * Source-equivalent subset of Codex's normalizeAction metadata pass. Product
 * connector logos and plugin installation remain host extensions; the core
 * keeps the approval facts needed for a faithful generic ChatUI surface.
 */
export function normalizeMcpElicitationMetadata(
  mode: "form" | "openai/form" | "url",
  metadata: unknown,
  context: McpElicitationMetadataContext = {},
): McpElicitationMetadata {
  const source = record(metadata);
  const riskLevel = source.riskLevel === "low" || source.riskLevel === "high" ? source.riskLevel : null;
  const subtitle = string(source.subtitle);
  const persist = persistValues(source.persist);
  if (mode === "url") {
    const auth = record(record(source._codex_apps).connector_auth_failure);
    if (context.serverName === "codex_apps" && auth.is_auth_failure === true) {
      const connectorId = string(auth.connector_id);
      const connectorName = string(auth.connector_name);
      const installUrl = string(auth.install_url);
      if (connectorId !== null && connectorName !== null && installUrl !== null) {
        return {
          interactionKind: "connector-auth",
          riskLevel,
          subtitle,
          persist,
          toolApproval: null,
          toolSuggestion: null,
          connectorAuth: {
            connectorId,
            connectorName,
            installUrl,
            authReason: string(auth.auth_reason),
            linkId: string(auth.link_id),
            requestedScopes: stringArray(auth.requested_scopes),
          },
        };
      }
    }
    return { interactionKind: "url-action", riskLevel, subtitle, persist, toolApproval: null, toolSuggestion: null, connectorAuth: null };
  }
  if (source.codex_approval_kind === "tool_suggestion") {
    const suggestType = source.suggest_type === "install" || source.suggest_type === "enable" ? source.suggest_type : null;
    const toolType = source.tool_type === "connector" || source.tool_type === "plugin" ? source.tool_type : null;
    const suggestReason = string(source.suggest_reason);
    const toolId = string(source.tool_id);
    const toolName = string(source.tool_name);
    if (suggestType !== null && toolType !== null && suggestReason !== null && toolId !== null && toolName !== null) {
      return {
        interactionKind: "tool-suggestion",
        riskLevel,
        subtitle,
        persist,
        toolApproval: null,
        toolSuggestion: {
          suggestType,
          suggestReason,
          toolId,
          toolName,
          toolType,
          installUrl: string(source.install_url),
          remotePluginId: string(source.remote_plugin_id),
          persistAlways: source.persist === "always",
        },
        connectorAuth: null,
      };
    }
  }
  const schemaProperties = record(record(context.requestedSchema).properties);
  const emptyObjectSchema = Object.keys(schemaProperties).length === 0;
  const computerUseApp = context.serverName === "computer-use" && emptyObjectSchema && persist.includes("always")
    ? /^Allow (?:Codex|ChatGPT) to use (.+)\?$/u.exec(context.message ?? "")?.[1]?.trim() ?? null
    : null;
  const browserOriginApproval = (context.serverName === "browser" || context.serverName === "browser-use")
    && emptyObjectSchema && persist.length > 0 && (string(source.origin)?.trim().length ?? 0) > 0;
  if (source.codex_approval_kind !== "mcp_tool_call" && computerUseApp === null && !browserOriginApproval) {
    return { interactionKind: "form", riskLevel, subtitle, persist, toolApproval: null, toolSuggestion: null, connectorAuth: null };
  }
  const toolParamsDisplay = Array.isArray(source.tool_params_display)
    ? source.tool_params_display.flatMap((candidate) => {
        const entry = record(candidate);
        const name = string(entry.name);
        if (name === null) return [];
        return [{
          name,
          displayName: string(entry.display_name) ?? name,
          value: entry.value,
        }];
      })
    : [];
  return {
    interactionKind: "tool-approval",
    riskLevel,
    subtitle,
    persist,
    toolApproval: {
      connectorId: string(source.connector_id) ?? (computerUseApp === null ? context.serverName ?? "mcp" : "computer-use"),
      connectorName: string(source.connector_name) ?? (computerUseApp === null ? null : "Computer Use"),
      toolName: string(source.tool_name),
      toolTitle: string(source.tool_title),
      toolParams: computerUseApp === null ? record(source.tool_params) : { app: computerUseApp },
      toolParamsDisplay: computerUseApp === null ? toolParamsDisplay : [{ name: "app", displayName: "App", value: computerUseApp }],
    },
    toolSuggestion: null,
    connectorAuth: null,
  };
}

/** Stable platform-neutral text for approval parameter previews. */
export function formatMcpElicitationDisplayValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null) return "null";
  if (value === undefined) return "";
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return String(value);
  }
}

export interface McpElicitationDisplayValue {
  readonly expandedText: string;
  readonly previewText: string;
  readonly kind: "text" | "json";
  readonly isExpandable: boolean;
}

/** Source-equivalent value presentation used by Codex MCP approval rows. */
export function presentMcpElicitationDisplayValue(value: unknown): McpElicitationDisplayValue {
  if (typeof value === "string") {
    let lines = 1;
    for (const character of value) if (character === "\n") lines += 1;
    return {
      expandedText: value,
      previewText: value,
      kind: "text",
      isExpandable: lines > 4 || value.length > 120,
    };
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    const text = String(value);
    return { expandedText: text, previewText: text, kind: "text", isExpandable: false };
  }
  let compact = "";
  let expanded = "";
  try {
    compact = JSON.stringify(value) ?? "";
    expanded = JSON.stringify(value, null, 2) ?? "";
  } catch {
    compact = String(value);
    expanded = compact;
  }
  return {
    expandedText: expanded,
    previewText: compact.length <= 48 ? compact : `${compact.slice(0, 47)}…`,
    kind: "json",
    isExpandable: compact.length > 48,
  };
}

function enumOptions(schema: RecordValue): readonly McpElicitationOption[] {
  const oneOf = Array.isArray(schema.oneOf) ? schema.oneOf : [];
  if (oneOf.length > 0) return oneOf.flatMap((entry): McpElicitationOption[] => {
    const option = record(entry);
    const value = string(option.const);
    return value === null ? [] : [{ value, label: string(option.title) ?? value }];
  });
  const items = record(schema.items);
  const anyOf = Array.isArray(items.anyOf) ? items.anyOf : [];
  if (anyOf.length > 0) return anyOf.flatMap((entry): McpElicitationOption[] => {
    const option = record(entry);
    const value = string(option.const);
    return value === null ? [] : [{ value, label: string(option.title) ?? value }];
  });
  const values = stringArray(schema.enum).length > 0 ? stringArray(schema.enum) : stringArray(items.enum);
  const labels = stringArray(schema.enumNames);
  return values.map((value, index) => ({ value, label: labels[index] ?? value }));
}

export function normalizeMcpElicitationSchema(value: unknown): readonly McpElicitationField[] {
  const schema = record(value);
  const required = new Set(stringArray(schema.required));
  return Object.entries(record(schema.properties)).flatMap(([name, candidate]): McpElicitationField[] => {
    const field = record(candidate);
    const type = string(field.type);
    const options = enumOptions(field);
    const kind: McpElicitationFieldKind = type === "array" ? "multi-select"
      : options.length > 0 ? "select"
      : type === "boolean" ? "boolean"
      : type === "number" || type === "integer" ? "number"
      : "text";
    const defaultValue = kind === "boolean" ? field.default === true
      : kind === "multi-select" ? stringArray(field.default)
      : kind === "number" && finiteNumber(field.default) !== null ? String(field.default)
      : string(field.default) ?? (kind === "select" ? options[0]?.value ?? "" : "");
    return [{
      name,
      title: string(field.title) ?? name,
      description: string(field.description),
      kind,
      required: required.has(name),
      options,
      integer: type === "integer",
      minimum: finiteNumber(field.minimum),
      maximum: finiteNumber(field.maximum),
      minLength: finiteNumber(field.minLength),
      maxLength: finiteNumber(field.maxLength),
      format: string(field.format),
      defaultValue,
    }];
  });
}

export function createMcpElicitationDraft(fields: readonly McpElicitationField[]): McpElicitationDraft {
  return Object.fromEntries(fields.map((field) => [field.name, field.defaultValue]));
}

export function validateMcpElicitationDraft(
  fields: readonly McpElicitationField[],
  draft: McpElicitationDraft,
): McpElicitationValidationResult {
  const content: Record<string, string | number | boolean | string[]> = {};
  const errors: Record<string, string> = {};
  for (const field of fields) {
    const value = draft[field.name] ?? field.defaultValue;
    if (field.kind === "boolean") {
      content[field.name] = value === true;
      continue;
    }
    if (field.kind === "multi-select") {
      const values = Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
      if (field.required && values.length === 0) errors[field.name] = "Select at least one option";
      else if (values.length > 0 || field.required) content[field.name] = values;
      continue;
    }
    const text = typeof value === "string" ? value.trim() : "";
    if (text.length === 0) {
      if (field.required) errors[field.name] = "This field is required";
      continue;
    }
    if (field.kind === "number") {
      const parsed = Number(text);
      if (!Number.isFinite(parsed) || field.integer && !Number.isInteger(parsed)) errors[field.name] = field.integer ? "Enter a whole number" : "Enter a number";
      else if (field.minimum !== null && parsed < field.minimum) errors[field.name] = `Must be at least ${field.minimum}`;
      else if (field.maximum !== null && parsed > field.maximum) errors[field.name] = `Must be at most ${field.maximum}`;
      else content[field.name] = parsed;
      continue;
    }
    if (field.minLength !== null && text.length < field.minLength) errors[field.name] = `Use at least ${field.minLength} characters`;
    else if (field.maxLength !== null && text.length > field.maxLength) errors[field.name] = `Use at most ${field.maxLength} characters`;
    else content[field.name] = text;
  }
  return { content: Object.keys(errors).length === 0 ? content : null, errors };
}
