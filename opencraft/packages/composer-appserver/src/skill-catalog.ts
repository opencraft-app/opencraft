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

function searchScore(value: string, rawQuery: string): number | null {
  const candidate = value.toLocaleLowerCase();
  const query = rawQuery.toLocaleLowerCase();
  if (candidate === query) return 0;
  if (candidate.startsWith(query)) return 10 + candidate.length - query.length;
  const word = candidate.search(new RegExp(`(?:^|[\\s:_-])${escapeRegExp(query)}`, "u"));
  if (word >= 0) return 100 + word;
  const substring = candidate.indexOf(query);
  if (substring >= 0) return 200 + substring;
  const penalty = subsequencePenalty(candidate, query);
  return penalty === null ? null : 300 + penalty;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Codex-shaped skill search: query-gated, path-stable, enabled-only and with
 * deterministic fuzzy ordering. Display metadata never replaces protocol
 * identity; canonical name and absolute path remain attached to the entry.
 */
export function searchAppServerSkills(
  response: SkillsListResponse,
  rawQuery: string,
  limit = 50,
): readonly ComposerCatalogEntry[] {
  const query = rawQuery.trim();
  if (query.length === 0 || limit <= 0) return [];
  return enabledSkills(response)
    .map((skill, index) => {
      const label = displayName(skill);
      const score = Math.min(
        searchScore(skill.name, query) ?? Number.POSITIVE_INFINITY,
        searchScore(label, query) ?? Number.POSITIVE_INFINITY,
        searchScore(`@${label}`, query) ?? Number.POSITIVE_INFINITY,
      );
      return { skill, index, label, score };
    })
    .filter((entry) => Number.isFinite(entry.score))
    .sort((left, right) => left.score - right.score
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
