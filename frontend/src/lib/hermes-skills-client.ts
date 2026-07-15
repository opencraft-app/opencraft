import { execCommand } from "@/lib/hermes-cron-client";

const HERMES_SKILLS_LIST_COMMAND =
  'cd "$HOME/.hermes/hermes-agent" && COLUMNS=10000 ./venv/bin/python -m hermes_cli.main skills list';

export interface InstalledSkillLoadState {
  status: "idle" | "loading" | "ready" | "error";
  slugs: string[];
  error: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readInstalledSkillSlug(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!isRecord(value)) return "";
  if (typeof value.name === "string" && value.name.trim()) return value.name.trim();
  if (typeof value.slug === "string" && value.slug.trim()) return value.slug.trim();
  return "";
}

function parseInstalledSkillsTable(output: string): string[] {
  const slugs: string[] = [];
  for (const line of output.split("\n")) {
    if (!line.includes("│")) continue;
    const cells = line
      .split("│")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length < 1 || cells[0] === "Name") continue;
    if (cells[0]) slugs.push(cells[0]);
  }
  return slugs;
}

export function buildInstalledSkillsListCommand(): string {
  return HERMES_SKILLS_LIST_COMMAND;
}

export function getUniqueSkillSlugs(skillSlugs: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const skillSlug of skillSlugs) {
    const normalized = skillSlug.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

export function parseInstalledSkillSlugs(output: string): string[] {
  if (!output.trim()) return [];

  try {
    const parsed = JSON.parse(output) as unknown;
    const payload = isRecord(parsed) && parsed.success === true && isRecord(parsed.data)
      ? parsed.data
      : parsed;
    const items = isRecord(payload) && Array.isArray(payload.skills)
      ? payload.skills
      : Array.isArray(payload)
        ? payload
        : null;
    if (items) return getUniqueSkillSlugs(items.map(readInstalledSkillSlug));
  } catch {
    // Non-JSON output falls through to table/plain-text parsing.
  }

  const tableSlugs = parseInstalledSkillsTable(output);
  if (tableSlugs.length > 0) return getUniqueSkillSlugs(tableSlugs);

  return getUniqueSkillSlugs(output.split("\n"));
}

export function formatInstalledSkillDisplayName(slug: string): string {
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

export function matchesInstalledSkillSearch(slug: string, displayName: string, query: string): boolean {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return true;
  return slug.toLocaleLowerCase().includes(normalizedQuery)
    || displayName.toLocaleLowerCase().includes(normalizedQuery);
}

export async function listInstalledSkillSlugs(botId: string): Promise<string[]> {
  const result = await execCommand(botId, buildInstalledSkillsListCommand());
  return parseInstalledSkillSlugs(result.output);
}
