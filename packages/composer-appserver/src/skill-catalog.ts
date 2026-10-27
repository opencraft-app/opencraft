import type {
  SkillMetadata,
  SkillsListResponse,
} from "@opencraft/appserver-protocol/generated/v2";
import type { ComposerCatalogEntry } from "@opencraft/composer-core";

function displayName(skill: SkillMetadata): string {
  const configured = skill.interface?.displayName?.trim();
  if (configured) return configured;
  return skill.name
    .split(/[-_]+/u)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function shortDescription(skill: SkillMetadata): string | null {
  return skill.interface?.shortDescription?.trim()
    || skill.shortDescription?.trim()
    || skill.description.trim()
    || null;
}

/** Flatten cwd groups while preserving AppServer order and path identity. */
export function enabledSkills(response: SkillsListResponse): readonly SkillMetadata[] {
  const paths = new Set<string>();
  const result: SkillMetadata[] = [];
  for (const group of response.data) {
    for (const skill of group.skills) {
      if (!skill.enabled || paths.has(skill.path)) continue;
      paths.add(skill.path);
      result.push(skill);
    }
  }
  return result;
}

/** Reject failed discovery before it can be cached as a successful empty list. */
export function assertSkillDiscoveryAvailable(response: SkillsListResponse): void {
  if (!response.data.some(group => group.skills.some(skill => skill.enabled))
    && response.data.some(group => group.errors.length > 0)) {
    throw new Error("Skill discovery failed for this workspace");
  }
}

function subsequencePenalty(value: string, query: string): number | null {
  let valueIndex = 0;
  let first = -1;
  let last = -1;
  for (const character of query) {
    const found = value.indexOf(character, valueIndex);
    if (found < 0) return null;
    if (first < 0) first = found;
    last = found;
    valueIndex = found + 1;
  }
  return (first < 0 ? 0 : first) + Math.max(0, last - first - query.length + 1);
}

function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").replace(/\\/gu, "/").toLocaleLowerCase();
}
type SearchWord = { readonly text: string; readonly boundary: RegExp };
function searchScore(candidate: string, word: SearchWord): number | null {
  const query = word.text;
  if (candidate === query) return 0;
  if (candidate.startsWith(query)) return 10 + candidate.length - query.length;
  const boundary = candidate.search(word.boundary);
  if (boundary >= 0) return 100 + boundary;
  const substring = candidate.indexOf(query);
  if (substring >= 0) return 200 + substring;
  const penalty = subsequencePenalty(candidate, query);
  return penalty === null ? null : 300 + penalty;
}
function skillScore(fields: readonly string[], words: readonly SearchWord[]): number {
  const candidates = fields.map(normalizeSearchText);
  return words.reduce((total, word) => total + Math.min(...candidates.map(field => searchScore(field, word) ?? Number.POSITIVE_INFINITY)), 0);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Host skill search: browse on empty query, path-stable, enabled-only and with
 * deterministic fuzzy ordering. Display metadata never replaces protocol
 * identity; canonical name and absolute path remain attached to the entry.
 */
export function searchAppServerSkills(
  response: SkillsListResponse,
  rawQuery: string,
  limit = 50,
): readonly ComposerCatalogEntry[] {
  const query = rawQuery.trim();
  if (limit <= 0) return [];
  assertSkillDiscoveryAvailable(response);
  const skills = enabledSkills(response);
  // Query preparation belongs to this search, not every candidate field.
  const words = query.split(/\s+/u).filter(Boolean).map(raw => {
    const text = normalizeSearchText(raw);
    return { text, boundary: new RegExp(`(?:^|[\\s:_-])${escapeRegExp(text)}`, "u") };
  });
  return skills
    .map((skill, index) => {
      const label = displayName(skill);
      const score = query.length === 0 ? 0 : skillScore([skill.name, label, skill.path], words);
      return { skill, index, label, score };
    })
    .filter((entry) => Number.isFinite(entry.score))
    .sort((left, right) => query.length === 0 ? left.index - right.index : left.score - right.score
      || left.label.localeCompare(right.label)
      || left.skill.name.localeCompare(right.skill.name)
      || left.index - right.index)
    .slice(0, limit)
    .map(({ skill, label }) => ({
      id: `skill:${skill.path}`,
      kind: "skill" as const,
      label,
      detail: shortDescription(skill),
      uri: skill.path,
      metadata: {
        canonicalName: skill.name,
        path: skill.path,
        scope: skill.scope,
        ...(skill.interface?.iconSmall ? { iconSmall: skill.interface.iconSmall } : {}),
        ...(skill.interface?.iconSmallUrl ? { iconSmallUrl: skill.interface.iconSmallUrl } : {}),
      },
    }));
}
