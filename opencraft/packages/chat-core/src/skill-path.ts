const KNOWN_ACRONYMS = new Set([
  "GH", "IA", "MCP", "API", "CI", "CLI", "LLM", "PDF", "PR", "UI", "URL", "SQL", "TW", "GPU", "CPU",
]);

const CANONICAL_NAMES = new Map<string, string>([
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

const LOWERCASE_TITLE_WORDS = new Set(["and", "or", "to", "up", "with"]);

export interface SkillPathInfo {
  readonly skillId: string;
  readonly skillRootPath: string;
  readonly skillName: string;
  readonly pluginId: string | null;
  readonly pluginDisplayName: string | null;
  readonly pluginMarketplaceName: string | null;
  readonly isSystem: boolean;
  readonly isInScriptsFolder: boolean;
  readonly isSkillDefinitionFile: boolean;
}

function displayToken(token: string, index: number): string {
  const upper = token.toLocaleUpperCase();
  if (KNOWN_ACRONYMS.has(upper)) return upper;
  if (token.toLocaleLowerCase().endsWith("s")) {
    const singular = token.slice(0, -1).toLocaleUpperCase();
    if (KNOWN_ACRONYMS.has(singular)) return `${singular}s`;
  }
  const lower = token.toLocaleLowerCase();
  const canonical = CANONICAL_NAMES.get(lower);
  if (canonical !== undefined) return canonical;
  if (index > 0 && LOWERCASE_TITLE_WORDS.has(lower)) return lower;
  return lower.length === 0 ? lower : lower.charAt(0).toLocaleUpperCase() + lower.slice(1);
}

/** Source-equivalent title formatting used by Codex for skill identifiers. */
export function formatSkillDisplayName(value: string): string {
  return value.split(":").map((part) => part
    .replace(/[_-]+/gu, " ")
    .split(/\s+/gu)
    .filter(Boolean)
    .map(displayToken)
    .join(" "))
    .join(": ");
}

function normalizePath(path: string): string {
  const source = path.trim().replace(/^\.\/+/, "").replaceAll("\\", "/");
  const prefix = source.startsWith("/") ? "/" : "";
  const parts: string[] = [];
  for (const part of source.split("/")) {
    if (part.length === 0 || part === ".") continue;
    if (part === ".." && parts.length > 0 && parts.at(-1) !== "..") parts.pop();
    else parts.push(part);
  }
  return `${prefix}${parts.join("/")}`;
}

function resolvePath(path: string, cwd: string | null): string {
  if (path.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(path) || cwd === null || cwd.trim().length === 0) {
    return normalizePath(path);
  }
  return normalizePath(`${cwd}/${path}`);
}

function buildSkillPathInfo({
  isSystem = false,
  pluginId,
  pluginMarketplaceName = null,
  relativePathSegments,
  skillId,
  skillRootPath,
}: {
  readonly isSystem?: boolean;
  readonly pluginId: string | null;
  readonly pluginMarketplaceName?: string | null;
  readonly relativePathSegments: readonly string[];
  readonly skillId: string;
  readonly skillRootPath: string;
}): SkillPathInfo {
  const firstRelativeSegment = relativePathSegments[0]?.toLocaleLowerCase();
  return {
    skillId,
    skillRootPath,
    skillName: formatSkillDisplayName(skillId.replaceAll("_", "-")),
    pluginId,
    pluginDisplayName: pluginId === null ? null : formatSkillDisplayName(pluginId.replaceAll("_", "-")),
    pluginMarketplaceName,
    isSystem,
    isInScriptsFolder: firstRelativeSegment === "scripts",
    isSkillDefinitionFile: relativePathSegments.length === 1 && firstRelativeSegment === "skill.md",
  };
}

/**
 * Parse Codex and plugin skill paths without importing Node path helpers, so
 * the same semantic rule runs in Web, Electron and React Native.
 */
export function parseSkillPath(path: string, cwd: string | null = null): SkillPathInfo | null {
  const normalized = resolvePath(path, cwd).replace(/\/+$/u, "");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0) return null;
  const leadingSlash = normalized.startsWith("/") ? "/" : "";

  for (let index = 0; index < segments.length; index += 1) {
    const directory = segments[index]?.toLocaleLowerCase();
    const skills = segments[index + 1]?.toLocaleLowerCase();
    if ((directory !== ".codex" && directory !== ".agents") || skills !== "skills") continue;
    const scope = segments[index + 2]?.toLocaleLowerCase();
    const skillIndex = index + (scope === "_import" || scope === ".system" ? 3 : 2);
    const skillId = segments[skillIndex];
    if (skillId === undefined || skillId.length === 0) continue;
    return buildSkillPathInfo({
      isSystem: scope === ".system",
      pluginId: null,
      relativePathSegments: segments.slice(skillIndex + 1),
      skillId,
      skillRootPath: `${leadingSlash}${segments.slice(0, skillIndex + 1).join("/")}`,
    });
  }

  for (let index = 0; index < segments.length; index += 1) {
    if (segments[index]?.toLocaleLowerCase() !== "plugins") continue;
    const cached = segments[index + 1]?.toLocaleLowerCase() === "cache";
    const pluginIndex = index + (cached ? 3 : 1);
    const pluginId = segments[pluginIndex];
    if (pluginId === undefined) continue;
    const firstSkillSearchIndex = pluginIndex + (cached ? 1 : 0);
    const skillsIndex = segments.findIndex((segment, segmentIndex) => (
      segmentIndex > firstSkillSearchIndex && segment.toLocaleLowerCase() === "skills"
    ));
    const pluginRootSkill = skillsIndex < 0;
    const skillIndex = pluginRootSkill ? firstSkillSearchIndex : skillsIndex + 1;
    const skillId = pluginRootSkill ? pluginId : segments[skillIndex];
    const relativePathSegments = segments.slice(skillIndex + 1);
    if (skillId === undefined || (pluginRootSkill
      && (relativePathSegments.length !== 1 || relativePathSegments[0]?.toLocaleLowerCase() !== "skill.md"))) continue;
    return buildSkillPathInfo({
      pluginId,
      pluginMarketplaceName: cached ? segments[index + 2] ?? null : null,
      relativePathSegments,
      skillId,
      skillRootPath: `${leadingSlash}${segments.slice(0, skillIndex + 1).join("/")}`,
    });
  }
  return null;
}
