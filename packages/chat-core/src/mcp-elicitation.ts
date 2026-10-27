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

export interface McpElicitationDisplayValue {
  readonly expandedText: string;
  readonly previewText: string;
  readonly kind: "text" | "json";
  readonly isExpandable: boolean;
}


type Data = Readonly<Record<string, unknown>>;
const data = (value: unknown): Data => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Data : {};
const text = (value: unknown): string | null => typeof value === "string" ? value : null;
const finite = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

export function normalizeMcpElicitationMetadata(
  mode: "form" | "openai/form" | "url", metadata: unknown,
  context: McpElicitationMetadataContext = {},
): McpElicitationMetadata {
  const source = data(metadata);
  const scopes = Array.isArray(source.persist) ? source.persist : [source.persist];
  const persist = [...new Set(scopes.filter((scope): scope is "session" | "always" => scope === "session" || scope === "always"))];
  const common = { riskLevel: source.riskLevel === "low" || source.riskLevel === "high" ? source.riskLevel : null,
    subtitle: text(source.subtitle), persist } as const;
  let toolApproval: McpElicitationMetadata["toolApproval"] = null;
  let toolSuggestion: McpElicitationMetadata["toolSuggestion"] = null;
  let connectorAuth: McpElicitationMetadata["connectorAuth"] = null;
  if (mode === "url") {
    const failure = data(data(source._codex_apps).connector_auth_failure);
    if (context.serverName === "codex_apps" && failure.is_auth_failure === true
      && text(failure.connector_id) !== null && text(failure.connector_name) !== null && text(failure.install_url) !== null) {
      connectorAuth = { connectorId: failure.connector_id as string, connectorName: failure.connector_name as string,
        installUrl: failure.install_url as string, authReason: text(failure.auth_reason), linkId: text(failure.link_id), requestedScopes: strings(failure.requested_scopes) };
    }
    return { ...common, interactionKind: connectorAuth === null ? "url-action" : "connector-auth", toolApproval, toolSuggestion, connectorAuth };
  }
  const emptyRequestedFields = Object.keys(data(data(context.requestedSchema).properties)).length === 0;
  const browserOriginApproval = (context.serverName === "browser" || context.serverName === "browser-use")
    && emptyRequestedFields && persist.length > 0 && (text(source.origin)?.trim().length ?? 0) > 0;
  if (source.codex_approval_kind === "tool_suggestion"
    && (source.suggest_type === "install" || source.suggest_type === "enable")
    && (source.tool_type === "connector" || source.tool_type === "plugin")
    && text(source.suggest_reason) !== null && text(source.tool_id) !== null && text(source.tool_name) !== null) {
    toolSuggestion = { suggestType: source.suggest_type, toolType: source.tool_type, suggestReason: source.suggest_reason as string,
      toolId: source.tool_id as string, toolName: source.tool_name as string, installUrl: text(source.install_url),
      remotePluginId: text(source.remote_plugin_id), persistAlways: source.persist === "always" };
  } else if (source.codex_approval_kind === "mcp_tool_call" || browserOriginApproval) {
    const toolParamsDisplay: NonNullable<McpElicitationMetadata["toolApproval"]>["toolParamsDisplay"][number][] = [];
    for (const candidate of Array.isArray(source.tool_params_display) ? source.tool_params_display : []) {
      const row = data(candidate), name = text(row.name);
      if (name !== null) toolParamsDisplay.push({ name, displayName: text(row.display_name) ?? name, value: row.value });
    }
    toolApproval = { connectorId: text(source.connector_id) ?? context.serverName ?? "mcp", connectorName: text(source.connector_name),
      toolName: text(source.tool_name), toolTitle: text(source.tool_title), toolParams: data(source.tool_params), toolParamsDisplay };
  }
  if (toolSuggestion === null && context.serverName === "computer-use" && persist.includes("always")
    && emptyRequestedFields) {
    const message = context.message ?? "", prefix = "Allow Codex to use ";
    if (message.startsWith(prefix) && message.endsWith("?") && message.length > prefix.length + 1
      && !/[\r\n\u2028\u2029]/u.test(message)) {
      const app = message.slice(prefix.length, -1);
      toolApproval = { connectorId: text(source.connector_id) ?? "computer-use", connectorName: text(source.connector_name) ?? "Computer Use",
        toolName: text(source.tool_name), toolTitle: text(source.tool_title),
        toolParams: { app }, toolParamsDisplay: [{ name: "app", displayName: "App", value: app }] };
    }
  }
  return { ...common, interactionKind: toolApproval !== null ? "tool-approval" : toolSuggestion !== null ? "tool-suggestion" : "form",
    toolApproval, toolSuggestion, connectorAuth };
}

export function presentMcpElicitationDisplayValue(value: unknown): McpElicitationDisplayValue {
  if (value === null || ["string", "boolean", "number"].includes(typeof value)) {
    const expandedText = String(value);
    return { expandedText, previewText: expandedText, kind: "text", isExpandable: expandedText.length > 120 || typeof value === "string" && value.split("\n").length > 4 };
  }
  let expandedText: string, compact: string;
  try {
    expandedText = JSON.stringify(value, null, 2) ?? "";
    compact = JSON.stringify(value) ?? "";
  } catch { expandedText = compact = String(value); }
  const isExpandable = compact.length > 48;
  return { expandedText, previewText: isExpandable ? compact.slice(0, 47) + "…" : compact, kind: "json", isExpandable };
}

function choices(schema: Data): McpElicitationOption[] {
  const itemAlternatives = data(schema.items).anyOf;
  const titledChoices = Array.isArray(schema.oneOf) && schema.oneOf.length > 0 ? schema.oneOf
    : Array.isArray(itemAlternatives) && itemAlternatives.length > 0 ? itemAlternatives : null;
  if (titledChoices !== null) {
    return titledChoices.flatMap(candidate => {
      const row = data(candidate), value = text(row.const);
      return value === null ? [] : [{ value, label: text(row.title) ?? value }];
    });
  }
  const labels = strings(schema.enumNames);
  return strings(schema.enum).map((value, index) => ({ value, label: labels[index] ?? value }));
}

export function normalizeMcpElicitationSchema(value: unknown): readonly McpElicitationField[] {
  const source = data(value), required = new Set(strings(source.required));
  return Object.entries(data(source.properties)).map(([name, input]) => {
    const schema = data(input);
    const ownChoices = choices(schema);
    const options = ownChoices.length > 0 ? ownChoices : choices(data(schema.items));
    const kind: McpElicitationFieldKind = schema.type === "array" ? "multi-select" : options.length > 0 ? "select"
      : schema.type === "boolean" ? "boolean" : schema.type === "number" || schema.type === "integer" ? "number" : "text";
    const defaultValue: McpElicitationDraftValue = kind === "boolean" ? schema.default === true
      : kind === "multi-select" ? strings(schema.default)
      : kind === "number" && typeof schema.default === "number" ? String(schema.default)
      : text(schema.default) ?? (kind === "select" ? options[0].value : "");
    return { name, title: text(schema.title) ?? name, description: text(schema.description), required: required.has(name),
      kind, options, integer: schema.type === "integer", minimum: finite(schema.minimum), maximum: finite(schema.maximum),
      minLength: finite(schema.minLength), maxLength: finite(schema.maxLength), format: text(schema.format), defaultValue };
  });
}

export function createMcpElicitationDraft(fields: readonly McpElicitationField[]): McpElicitationDraft {
  return Object.fromEntries(fields.map(field => [field.name, field.defaultValue]));
}

export function validateMcpElicitationDraft(fields: readonly McpElicitationField[], draft: McpElicitationDraft): McpElicitationValidationResult {
  const errors: [string, string][] = [];
  const values: [string, string | number | boolean | string[]][] = [];
  for (const field of fields) {
    const value = draft[field.name] ?? field.defaultValue;
    let error: string | null = null;
    if (field.kind === "boolean") values.push([field.name, value === true]);
    else if (field.kind === "multi-select") {
      const selected = strings(value);
      if (selected.length) values.push([field.name, selected]);
      else if (field.required) error = "Select at least one option";
    } else {
      const trimmed = (text(value) ?? "").trim();
      if (!trimmed) { if (field.required) error = "This field is required"; }
      else if (field.kind === "number") {
        const number = Number(trimmed);
        if (!Number.isFinite(number) || field.integer && !Number.isInteger(number)) error = field.integer ? "Enter a whole number" : "Enter a number";
        else if (field.minimum !== null && number < field.minimum) error = `Must be at least ${field.minimum}`;
        else if (field.maximum !== null && number > field.maximum) error = `Must be at most ${field.maximum}`;
        else values.push([field.name, number]);
      } else if (field.minLength !== null && trimmed.length < field.minLength) error = `Use at least ${field.minLength} characters`;
      else if (field.maxLength !== null && trimmed.length > field.maxLength) error = `Use at most ${field.maxLength} characters`;
      else values.push([field.name, trimmed]);
    }
    if (error !== null) errors.push([field.name, error]);
  }
  return { errors: Object.fromEntries(errors), content: errors.length ? null : Object.fromEntries(values) };
}
