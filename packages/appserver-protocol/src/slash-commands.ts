/** Scoped slash-command discovery advertised by an execution Host or connector. */
export const SCOPED_SLASH_COMMAND_CATALOG_EXTENSION = "opencraft/scoped-slash-command-catalog";
export const SCOPED_SLASH_COMMAND_CATALOG_METHOD = "opencraft/slash-commands/list";
export const SLASH_COMMAND_LIST_METHOD = "slashCommand/list";
export const SLASH_COMMANDS_CHANGED_NOTIFICATION = "opencraft/slash-commands/changed";

export type OpenCraftSlashCommandSource = "builtin" | "agent" | "extension" | "skill" | "host";

export interface OpenCraftSlashCommand {
  /** Command name without leading slash, e.g. `goal`, `compact`, `review-branch`. */
  readonly name: string;
  readonly description: string;
  /** Optional free-form parameter syntax hint, e.g. `[<objective>|clear|pause|resume]`. */
  readonly inputHint?: string | null;
  readonly source?: OpenCraftSlashCommandSource;
}

export interface ScopedSlashCommandListParams {
  readonly threadId?: string;
  readonly model?: string;
  readonly cwd?: string | null;
}

export interface SlashCommandListResponse {
  readonly data: readonly OpenCraftSlashCommand[];
}

const VALID_SLASH_COMMAND_NAME = /^[a-z0-9][a-z0-9.:_-]{0,63}$/iu;

function normalizeSource(value: unknown): OpenCraftSlashCommandSource | undefined {
  return value === "builtin" || value === "agent" || value === "extension" || value === "skill" || value === "host"
    ? value
    : undefined;
}

/**
 * Normalize untrusted ACP / RPC command descriptors at the protocol boundary.
 * Entries beginning with `$` mirror `$skill` mentions and stay in the `$` catalog.
 */
export function normalizeSlashCommands(
  entries: unknown,
  defaultSource: OpenCraftSlashCommandSource = "agent",
): OpenCraftSlashCommand[] {
  if (!Array.isArray(entries)) return [];
  const seen = new Set<string>();
  const normalized: OpenCraftSlashCommand[] = [];
  for (const raw of entries) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const candidate = raw as Record<string, unknown>;
    const rawName = typeof candidate.name === "string" ? candidate.name.trim() : "";
    if (!rawName || rawName.startsWith("$")) continue;
    const stripped = rawName.startsWith("/") ? rawName.slice(1).trim() : rawName;
    if (!VALID_SLASH_COMMAND_NAME.test(stripped)) continue;
    const dedupeKey = stripped.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const description = typeof candidate.description === "string" ? candidate.description.trim() : "";
    const rawInput = typeof candidate.input === "object" && candidate.input !== null && !Array.isArray(candidate.input)
      ? candidate.input as Record<string, unknown>
      : null;
    const hintCandidate = typeof candidate.inputHint === "string"
      ? candidate.inputHint
      : typeof rawInput?.hint === "string"
        ? rawInput.hint
        : null;
    const inputHint = hintCandidate !== null && hintCandidate.trim().length > 0 ? hintCandidate.trim() : null;
    const source = normalizeSource(candidate.source) ?? defaultSource;
    normalized.push({
      name: stripped,
      description,
      ...(inputHint !== null ? { inputHint } : {}),
      source,
    });
  }
  return normalized;
}
