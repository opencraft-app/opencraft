import type {
  AdditionalContextEntry,
  ThreadStartParams,
  TurnStartParams,
  UserInput,
} from "@opencraft/appserver-protocol/generated/v2";
import type {
  ComposerAttachment,
  ComposerBlockNode,
  ComposerContextReference,
  ComposerInline,
  ComposerSelections,
  ComposerTextInline,
  SubmitIntent,
} from "@opencraft/composer-core";
import { resolveReasoningEffort, unsupportedModelInput, type ReasoningCapability } from "@opencraft/composer-core";

export interface SubmitCompileDiagnostic {
  readonly code:
    | "UNSUPPORTED_SELECTION"
    | "NON_NATIVE_RESOURCE"
    | "NON_NATIVE_ATTACHMENT"
    | "TARGET_OPTION_NOT_SUPPORTED";
  readonly message: string;
  readonly sourceId: string | null;
}

export interface CompiledSubmitIntent {
  readonly input: readonly UserInput[];
  readonly additionalContext: Readonly<Record<string, AdditionalContextEntry>> | null;
  readonly threadOptions: Readonly<ThreadStartParams>;
  readonly turnOptions: Readonly<Omit<TurnStartParams, "threadId" | "clientUserMessageId" | "input" | "additionalContext">>;
  readonly diagnostics: readonly SubmitCompileDiagnostic[];
}

export interface SubmitCompilerOptions {
  /** Concrete default resolved from the catalog for this immutable submission. */
  readonly model?: string;
  readonly historyMode?: ThreadStartParams["historyMode"];
  readonly reasoning?: ReasoningCapability;
  readonly inputModalities?: readonly string[];
}

export class SubmitCompileError extends Error {
  readonly code: "ASSET_NOT_READY" | "INVALID_JSON" | "EMPTY_INPUT" | "CAPABILITY_UNAVAILABLE" | "UNSUPPORTED_INPUT";

  constructor(code: SubmitCompileError["code"], message: string) {
    super(message);
    this.name = "SubmitCompileError";
    this.code = code;
  }
}

type ProtocolJsonValue =
  | number
  | string
  | boolean
  | null
  | ProtocolJsonValue[]
  | { [key: string]: ProtocolJsonValue | undefined };

function localPath(uri: string): string | null {
  if (uri.startsWith("file://")) {
    const path = uri.slice("file://".length);
    try {
      return decodeURIComponent(path);
    } catch {
      return path;
    }
  }
  return uri.startsWith("/") ? uri : null;
}

function metadataString(metadata: Readonly<Record<string, unknown>> | undefined, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function appendText(input: UserInput[], text: string): void {
  if (text.length === 0) return;
  const previous = input.at(-1);
  if (previous?.type === "text") {
    input[input.length - 1] = { type: "text", text: previous.text + text, text_elements: [] };
  } else {
    input.push({ type: "text", text, text_elements: [] });
  }
}

function markdownCodeSpan(text: string): string {
  let fenceLength = 1;
  for (const run of text.match(/`+/gu) ?? []) fenceLength = Math.max(fenceLength, run.length + 1);
  const fence = "`".repeat(fenceLength);
  return text.split("\n").map(line => {
    const pad = line.startsWith("`") || line.endsWith("`") || (line.startsWith(" ") && line.endsWith(" "));
    return `${fence}${pad ? " " : ""}${line}${pad ? " " : ""}${fence}`;
  }).join("\n");
}

function markedText(inline: ComposerTextInline): string {
  if (!inline.marks?.length || inline.text.length === 0) return inline.text;
  let text = inline.marks.includes("code")
    ? markdownCodeSpan(inline.text)
    : inline.text.replace(/\\/gu, "\\\\").replace(/\*/gu, "\\*");
  if (inline.marks.includes("emphasis")) text = `*${text}*`;
  if (inline.marks.includes("strong")) text = `**${text}**`;
  return text;
}

function appendInline(
  input: UserInput[],
  inline: ComposerInline,
  diagnostics: SubmitCompileDiagnostic[],
): void {
  switch (inline.type) {
    case "text":
      appendText(input, markedText(inline));
      return;
    case "hard-break":
      appendText(input, "\n");
      return;
    case "link":
      appendText(input, `[${inline.children.map(markedText).join("")}](${inline.href})`);
      return;
    case "command":
      appendText(input, `/${inline.name}${inline.argument === undefined ? "" : ` ${inline.argument}`}`);
      return;
    case "mention": {
      const path = metadataString(inline.metadata, "path") ?? (inline.uri === undefined ? null : localPath(inline.uri));
      if (path !== null) input.push({ type: "mention", name: inline.label, path });
      else appendText(input, `@${inline.label}`);
      return;
    }
    case "resource": {
      const path = metadataString(inline.metadata, "path") ?? localPath(inline.uri);
      if (inline.resourceKind === "skill" && path !== null) {
        input.push({
          type: "skill",
          name: metadataString(inline.metadata, "canonicalName") ?? inline.title,
          path,
        });
        return;
      }
      diagnostics.push({
        code: "NON_NATIVE_RESOURCE",
        message: `Resource ${inline.title} has no native Codex UserInput representation and was serialized as text`,
        sourceId: inline.id,
      });
      appendText(input, `[${inline.title}](${inline.uri})`);
    }
  }
}

function appendParagraph(
  input: UserInput[],
  children: readonly ComposerInline[],
  diagnostics: SubmitCompileDiagnostic[],
): void {
  for (const inline of children) appendInline(input, inline, diagnostics);
}

function appendBlock(input: UserInput[], block: ComposerBlockNode, diagnostics: SubmitCompileDiagnostic[]): void {
  switch (block.type) {
    case "paragraph":
      appendParagraph(input, block.children, diagnostics);
      return;
    case "code-block":
      appendText(input, `\`\`\`${block.language ?? ""}\n${block.text}\n\`\`\``);
      return;
    case "divider":
      appendText(input, "---");
      return;
    case "quote":
      block.children.forEach((child, index) => {
        if (index > 0) appendText(input, "\n");
        appendText(input, "> ");
        appendBlock(input, child, diagnostics);
      });
      return;
    case "list":
      block.items.forEach((item, index) => {
        if (index > 0) appendText(input, "\n");
        appendText(input, block.ordered ? `${(block.start ?? 1) + index}. ` : "- ");
        item.children.forEach((child, childIndex) => {
          if (childIndex > 0) appendText(input, "\n  ");
          appendBlock(input, child, diagnostics);
        });
      });
  }
}

function appendAttachment(
  input: UserInput[],
  attachment: ComposerAttachment,
  diagnostics: SubmitCompileDiagnostic[],
): void {
  if (attachment.lifecycle !== "ready") {
    throw new SubmitCompileError("ASSET_NOT_READY", `Attachment ${attachment.name} is not ready`);
  }
  const codexFileId = attachment.metadata?.codexFileId;
  if (attachment.mimeType.startsWith("image/") && typeof codexFileId === "string") {
    input.push({ type: "image", fileId: codexFileId });
    return;
  }
  if (attachment.uri === null) {
    throw new SubmitCompileError("ASSET_NOT_READY", `Attachment ${attachment.name} is not ready`);
  }
  const path = localPath(attachment.uri);
  // A staged host file is a file reference even when its MIME type is audio.
  // Hosts such as Hermes can read that path without declaring audio input.
  if (path !== null && !attachment.mimeType.startsWith("image/")
    && attachment.metadata?.transport === "opencraft-attachment-staging") {
    input.push({ type: "mention", name: attachment.name, path });
    return;
  }
  if (attachment.mimeType.startsWith("image/")) {
    input.push(path === null
      ? { type: "image", url: attachment.uri }
      : { type: "localImage", path });
    return;
  }
  if (attachment.mimeType.startsWith("audio/")) {
    input.push(path === null
      ? { type: "audio", url: attachment.uri }
      : { type: "localAudio", path });
    return;
  }
  if (path !== null) {
    input.push({ type: "mention", name: attachment.name, path });
    return;
  }
  diagnostics.push({
    code: "NON_NATIVE_ATTACHMENT",
    message: `Attachment ${attachment.name} has no native Codex UserInput representation and was serialized as text`,
    sourceId: attachment.id,
  });
  appendText(input, `\nAttachment: [${attachment.name}](${attachment.uri})`);
}

function contextValue(reference: ComposerContextReference): string {
  for (const key of ["value", "content", "text"] as const) {
    const value = reference.metadata?.[key];
    if (typeof value === "string") return value;
  }
  return reference.uri === null ? reference.title : `${reference.title}\n${reference.uri}`;
}

function compileContext(context: readonly ComposerContextReference[]): Record<string, AdditionalContextEntry> | null {
  const entries: Record<string, AdditionalContextEntry> = {};
  for (const reference of context) {
    if (!reference.visible) continue;
    const explicitKind = reference.metadata?.additionalContextKind;
    const kind = explicitKind === "application" || explicitKind === "untrusted"
      ? explicitKind
      : reference.kind === "mcp" || reference.kind === "resource" || reference.kind === "annotation"
        ? "untrusted"
        : "application";
    entries[reference.id] = { kind, value: contextValue(reference) };
  }
  return Object.keys(entries).length === 0 ? null : entries;
}

function jsonValue(value: unknown, path: string): ProtocolJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item, index) => jsonValue(item, `${path}[${index}]`));
  if (typeof value === "object") {
    const result: Record<string, ProtocolJsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) result[key] = jsonValue(item, `${path}.${key}`);
    }
    return result;
  }
  throw new SubmitCompileError("INVALID_JSON", `${path} is not JSON serializable`);
}

function selectionOptions(
  selections: ComposerSelections,
  outputSchema: Readonly<Record<string, unknown>> | undefined,
  diagnostics: SubmitCompileDiagnostic[],
  reasoning?: ReasoningCapability,
): CompiledSubmitIntent["turnOptions"] {
  if (selections.mode !== undefined) diagnostics.push({
    code: "UNSUPPORTED_SELECTION",
    message: "Composer mode requires a resolved CollaborationMode catalog entry; the raw label was not sent",
    sourceId: null,
  });
  const effort = reasoning === undefined ? selections.effort : resolveReasoningEffort(reasoning, selections.effort);
  if (reasoning !== undefined && selections.effort !== undefined && effort !== selections.effort) diagnostics.push({code:"UNSUPPORTED_SELECTION",message:"Stored reasoning selection was resolved against the current model capability",sourceId:null});
  return {
    ...(selections.model === undefined ? {} : { model: selections.model }),
    ...(effort === undefined ? {} : { effort }),
    ...(selections.permissionProfile === undefined ? {} : { permissions: selections.permissionProfile }),
    ...(selections.cwd === undefined ? {} : { cwd: selections.cwd }),
    ...(selections.serviceTier === undefined ? {} : { serviceTier: selections.serviceTier }),
    ...(selections.personality === undefined ? {} : { personality: selections.personality as TurnStartParams["personality"] }),
    ...(outputSchema === undefined ? {} : { outputSchema: jsonValue(outputSchema, "outputSchema") }),
  };
}

export function compileSubmitIntent(
  intent: SubmitIntent,
  options: SubmitCompilerOptions = {},
): CompiledSubmitIntent {
  const input: UserInput[] = [];
  const diagnostics: SubmitCompileDiagnostic[] = [];
  intent.document.blocks.forEach((block, index) => {
    if (index > 0) appendText(input, "\n\n");
    appendBlock(input, block, diagnostics);
  });
  for (const attachment of intent.attachments) appendAttachment(input, attachment, diagnostics);
  if (options.inputModalities) {
    const unsupported = unsupportedModelInput(options.inputModalities, input);
    if (unsupported) throw new SubmitCompileError("UNSUPPORTED_INPUT", `所选模型不支持 ${unsupported} 输入，请更换模型或移除附件`);
  }
  if (input.length === 0 || input.every((entry) => entry.type === "text" && entry.text.length === 0)) {
    throw new SubmitCompileError("EMPTY_INPUT", "SubmitIntent contains no AppServer input");
  }

  const selections = options.model && intent.selections.model === undefined ? { ...intent.selections, model: options.model } : intent.selections;
  const turnOptions = selectionOptions(selections, intent.options.outputSchema, diagnostics, options.reasoning);
  if ((intent.target.type === "steer-active-turn" || intent.target.type === "enqueue-follow-up")
    && Object.keys(turnOptions).length > 0) {
    diagnostics.push({
      code: "TARGET_OPTION_NOT_SUPPORTED",
      message: `${intent.target.type} does not accept per-turn model, permission, cwd, effort, personality, tier or schema overrides`,
      sourceId: null,
    });
  }
  if (intent.target.type === "enqueue-follow-up" && intent.context.some((reference) => reference.visible)) {
    diagnostics.push({
      code: "TARGET_OPTION_NOT_SUPPORTED",
      message: "thread/queue/add does not accept additionalContext; the immutable SubmitIntent retains it for inspection",
      sourceId: null,
    });
  }
  if (intent.options.developerInstructions !== undefined
    && intent.target.type !== "new-thread"
    && intent.target.type !== "fork-thread") {
    diagnostics.push({
      code: "TARGET_OPTION_NOT_SUPPORTED",
      message: `${intent.target.type} cannot update thread developer instructions`,
      sourceId: null,
    });
  }
  const threadOptions: ThreadStartParams = {
    ...(intent.selections.agentId === undefined ? {} : { agentId: intent.selections.agentId }),
    ...(selections.model === undefined ? {} : { model: selections.model }),
    ...(intent.selections.permissionProfile === undefined ? {} : { permissions: intent.selections.permissionProfile }),
    ...(intent.selections.cwd === undefined ? {} : { cwd: intent.selections.cwd }),
    ...(intent.selections.serviceTier === undefined ? {} : { serviceTier: intent.selections.serviceTier }),
    ...(intent.selections.personality === undefined ? {} : { personality: intent.selections.personality as ThreadStartParams["personality"] }),
    ...(intent.options.developerInstructions === undefined ? {} : { developerInstructions: intent.options.developerInstructions }),
    ...(options.historyMode === undefined ? {} : { historyMode: options.historyMode }),
  };
  return {
    input,
    additionalContext: compileContext(intent.context),
    threadOptions,
    turnOptions,
    diagnostics,
  };
}
