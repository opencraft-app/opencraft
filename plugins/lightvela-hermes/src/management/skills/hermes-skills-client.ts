import { execCommand } from "../schedules/hermes-cron-client";

const HERMES_BUNDLED_MANIFEST_MARKER = "__HERMES_BUNDLED_MANIFEST__";
const HERMES_SKILLS_ROOT_MARKER = "__HERMES_SKILLS_ROOT__";
const HERMES_SKILLS_LIST_COMMAND =
  `cd "$HOME/.hermes/hermes-agent" && COLUMNS=10000 ./venv/bin/python -m hermes_cli.main skills list && { printf '\\n${HERMES_BUNDLED_MANIFEST_MARKER}\\n'; if test -f "$HOME/.hermes/skills/.bundled_manifest"; then cat "$HOME/.hermes/skills/.bundled_manifest"; fi; } && { printf '\\n${HERMES_SKILLS_ROOT_MARKER}\\n'; if test -d "$HOME/.hermes/skills"; then find "$HOME/.hermes/skills" -mindepth 2 -type f -name SKILL.md -print; fi; }`;

export interface InstalledSkillLoadState {
  status: "idle" | "loading" | "ready" | "error";
  slugs: string[];
  error: string | null;
}

export interface InstalledHermesSkill {
  slug: string;
  category?: string;
  source?: string;
  status?: string;
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

function readInstalledSkill(value: unknown): InstalledHermesSkill | null {
  const slug = readInstalledSkillSlug(value);
  if (!slug) return null;
  const source = isRecord(value) && typeof value.source === "string"
    ? value.source.trim()
    : "";
  const category = isRecord(value) && typeof value.category === "string"
    ? value.category.trim()
    : "";
  const status = isRecord(value) && typeof value.status === "string"
    ? value.status.trim()
    : "";
  return {
    slug,
    ...(category ? { category } : {}),
    ...(source ? { source } : {}),
    ...(status ? { status } : {}),
  };
}

function getUniqueInstalledSkills(skills: InstalledHermesSkill[]): InstalledHermesSkill[] {
  const bySlug = new Map<string, InstalledHermesSkill>();
  for (const skill of skills) {
    const slug = skill.slug.trim();
    if (!slug) continue;
    const existing = bySlug.get(slug);
    if (!existing) {
      bySlug.set(slug, { ...skill, slug });
    } else {
      if (!existing.category && skill.category) existing.category = skill.category;
      if (!existing.source && skill.source) existing.source = skill.source;
      if (!existing.status && skill.status) existing.status = skill.status;
    }
  }
  return Array.from(bySlug.values());
}

function parseInstalledSkillsTable(output: string): InstalledHermesSkill[] {
  const skills: InstalledHermesSkill[] = [];
  let nameIndex = 0;
  let categoryIndex = -1;
  let sourceIndex = -1;
  let statusIndex = -1;
  for (const line of output.split("\n")) {
    if (!/[│┃]/.test(line)) continue;
    const cells = line
      .split(/[│┃]/)
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.includes("Name") || cells.includes("名称")) {
      nameIndex = Math.max(cells.indexOf("Name"), cells.indexOf("名称"));
      categoryIndex = Math.max(cells.indexOf("Category"), cells.indexOf("分类"));
      sourceIndex = Math.max(cells.indexOf("Source"), cells.indexOf("来源"));
      statusIndex = Math.max(cells.indexOf("Status"), cells.indexOf("状态"));
      continue;
    }
    const slug = cells[nameIndex]?.trim();
    if (!slug) continue;
    const category = categoryIndex >= 0 ? cells[categoryIndex]?.trim() : "";
    const source = sourceIndex >= 0 ? cells[sourceIndex]?.trim() : "";
    const status = statusIndex >= 0 ? cells[statusIndex]?.trim() : "";
    skills.push({
      slug,
      ...(category ? { category } : {}),
      ...(source ? { source } : {}),
      ...(status ? { status } : {}),
    });
  }
  return getUniqueInstalledSkills(skills);
}

export function buildInstalledSkillsListCommand(): string {
  return HERMES_SKILLS_LIST_COMMAND;
}

export function buildHermesSkillDeleteCommand(slug: string): string {
  const normalized = slug.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(normalized) || normalized === "." || normalized === "..") {
    throw new Error("Invalid Hermes skill slug");
  }
  const skillsRoot = "$HOME/.hermes/skills";
  const findSkill = `find "${skillsRoot}" -mindepth 1 -type d -name "${normalized}" -exec test -f "{}/SKILL.md" \\; -print -quit`;
  const deleteSkill = `find "${skillsRoot}" -mindepth 1 -type d -name "${normalized}" -exec test -f "{}/SKILL.md" \\; -prune -exec rm -rf -- {} +`;
  return `cd "$HOME" && test -d "${skillsRoot}" && ${findSkill} | grep -q . || { echo "Hermes skill not found: ${normalized}" >&2; exit 1; }; ${deleteSkill} && ! ${findSkill} | grep -q .`;
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

function parseInstalledSkillsOutput(output: string): InstalledHermesSkill[] {
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
    if (items) {
      return getUniqueInstalledSkills(
        items.map(readInstalledSkill).filter((skill): skill is InstalledHermesSkill => skill !== null),
      );
    }
  } catch {
    // Non-JSON output falls through to table/plain-text parsing.
  }

  const tableSkills = parseInstalledSkillsTable(output);
  if (tableSkills.length > 0) return tableSkills;

  return getUniqueInstalledSkills(
    output.split("\n").map(readInstalledSkill).filter((skill): skill is InstalledHermesSkill => skill !== null),
  );
}

function parseBundledSkillNames(output: string): Set<string> {
  const names = new Set<string>();
  for (const line of output.split("\n")) {
    const normalized = line.trim();
    const separatorIndex = normalized.indexOf(":");
    if (separatorIndex <= 0) continue;
    names.add(normalized.slice(0, separatorIndex).trim().toLocaleLowerCase());
  }
  return names;
}

function parseSkillNamesFromPaths(output: string): Set<string> {
  const names = new Set<string>();
  for (const line of output.split("\n")) {
    const normalized = line.trim().replace(/\/+$/, "");
    if (!normalized.endsWith("/SKILL.md")) continue;
    const skillDirectory = normalized.slice(0, -"/SKILL.md".length);
    const separatorIndex = skillDirectory.lastIndexOf("/");
    const name = skillDirectory.slice(separatorIndex + 1).trim();
    if (name) names.add(name.toLocaleLowerCase());
  }
  return names;
}

export function parseInstalledSkills(output: string): InstalledHermesSkill[] {
  const bundledMarkerIndex = output.indexOf(HERMES_BUNDLED_MANIFEST_MARKER);
  const skillsRootMarkerIndex = output.indexOf(HERMES_SKILLS_ROOT_MARKER);
  const markerIndexes = [bundledMarkerIndex, skillsRootMarkerIndex].filter((index) => index >= 0);
  const skillsOutput = markerIndexes.length > 0 ? output.slice(0, Math.min(...markerIndexes)) : output;
  const skills = parseInstalledSkillsOutput(skillsOutput);
  if (bundledMarkerIndex < 0 && skillsRootMarkerIndex < 0) return skills;

  const bundledSectionEnd = skillsRootMarkerIndex > bundledMarkerIndex
    ? skillsRootMarkerIndex
    : output.length;
  const bundledSkillNames = bundledMarkerIndex >= 0
    ? parseBundledSkillNames(output.slice(
      bundledMarkerIndex + HERMES_BUNDLED_MANIFEST_MARKER.length,
      bundledSectionEnd,
    ))
    : new Set<string>();
  const hermesRootSkillNames = skillsRootMarkerIndex >= 0
    ? parseSkillNamesFromPaths(output.slice(skillsRootMarkerIndex + HERMES_SKILLS_ROOT_MARKER.length))
    : new Set<string>();

  return skills.map((skill) => {
    const normalizedSlug = skill.slug.toLocaleLowerCase();
    if (bundledSkillNames.has(normalizedSlug)) return { ...skill, source: "builtin" };
    if (hermesRootSkillNames.has(normalizedSlug)) return { ...skill, source: "other" };
    return skill;
  });
}

export function parseInstalledSkillSlugs(output: string): string[] {
  return parseInstalledSkills(output).map((skill) => skill.slug);
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
