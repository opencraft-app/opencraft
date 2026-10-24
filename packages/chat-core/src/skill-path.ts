
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

const skillInitialisms = new Set("GH IA MCP API CI CLI LLM PDF PR UI URL SQL TW GPU CPU".split(" "));
const skillNameSpellings = new Map([
  ["openai", "OpenAI"], ["openaideveloperdocs", "OpenAI Developer Docs"],
  ["openapi", "OpenAPI"], ["github", "GitHub"], ["pagerduty", "PagerDuty"],
  ["datadog", "DataDog"], ["sharepoint", "SharePoint"], ["sqlite", "SQLite"],
  ["fastapi", "FastAPI"],
]);
const skillTitleConnectors = new Set(["and", "or", "to", "up", "with"]);

export function formatSkillDisplayName(value: string): string {
  return value.split(":").map(namespace => namespace.trim().split(/[\s_-]+/u)
    .filter(Boolean).map((word, index) => {
      const lower = word.toLowerCase();
      const upper = word.toUpperCase();
      if (skillInitialisms.has(upper)) return upper;
      if (lower.endsWith("s") && skillInitialisms.has(upper.slice(0, -1))) {
        return `${upper.slice(0, -1)}s`;
      }
      return skillNameSpellings.get(lower)
        ?? (index > 0 && skillTitleConnectors.has(lower) ? lower
          : lower.slice(0, 1).toUpperCase() + lower.slice(1));
    }).join(" ")).join(": ");
}

function components(path: string, cwd: string | null): string[] {
  const portable = path.replaceAll("\\", "/");
  const absolute = portable.startsWith("/") || /^[a-z]:\//iu.test(portable);
  const combined = absolute || !cwd ? portable : `${cwd.replaceAll("\\", "/")}/${portable}`;
  const parts: string[] = [];
  for (const part of combined.split("/")) {
    if (part === "." || (part === "" && parts.length > 0)) continue;
    if (part === "..") {
      if (parts.length > 0 && parts.at(-1) !== ".." && parts.at(-1) !== "" && !/^[a-z]:$/iu.test(parts.at(-1) ?? "")) parts.pop();
      else if (parts[0] !== "" && !/^[a-z]:$/iu.test(parts[0] ?? "")) parts.push(part);
    } else {
      parts.push(part);
    }
  }
  return parts;
}

export function parseSkillPath(path: string, cwd: string | null = null): SkillPathInfo | null {
  if (!path.trim() || path.includes("\0")) return null;
  const parts = components(path.trim(), cwd?.trim() || null);
  const marker = (index: number) => parts[index]?.toLowerCase();
  const describe = (root: number, skillId: string, pluginId: string | null = null,
    pluginMarketplaceName: string | null = null, isSystem = false): SkillPathInfo => {
    const resource = parts.slice(root + 1);
    return {
      skillId, skillRootPath: parts.slice(0, root + 1).join("/"),
      skillName: formatSkillDisplayName(skillId), pluginId,
      pluginDisplayName: pluginId === null ? null : formatSkillDisplayName(pluginId),
      pluginMarketplaceName, isSystem,
      isInScriptsFolder: resource[0]?.toLowerCase() === "scripts",
      isSkillDefinitionFile: resource.length === 1 && resource[0].toLowerCase() === "skill.md",
    };
  };
  for (let owner = 0; owner < parts.length; owner++) {
    if ((marker(owner) !== ".codex" && marker(owner) !== ".agents") || marker(owner + 1) !== "skills") continue;
    let root = owner + 2;
    const isSystem = marker(root) === ".system";
    if (isSystem || marker(root) === "_import") root++;
    const skillId = parts[root];
    if (skillId && skillId !== "..") return describe(root, skillId, null, null, isSystem);
  }
  for (let owner = 0; owner < parts.length; owner++) {
    if (marker(owner) !== "plugins") continue;
    const cached = marker(owner + 1) === "cache";
    const plugin = owner + (cached ? 3 : 1);
    const pluginId = parts[plugin];
    if (!pluginId || pluginId === "..") continue;
    const pluginRoot = plugin + (cached ? 1 : 0);
    const skills = parts.findIndex((_, index) => index > pluginRoot && marker(index) === "skills");
    const root = skills < 0 ? pluginRoot : skills + 1;
    const skillId = skills < 0 ? pluginId : parts[root];
    if (!skillId || skillId === "..") continue;
    if (skills < 0 && (parts.length !== root + 2 || marker(root + 1) !== "skill.md")) continue;
    return describe(root, skillId, pluginId, cached ? parts[owner + 2] : null);
  }
  return null;
}
