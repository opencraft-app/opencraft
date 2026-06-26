import type { ComposerSkill, ComposerSkillTrigger } from "../composer-skills/model";

export type ComposerSuggestionItem =
  | {
      id: string;
      type: "skill";
      skill: ComposerSkill;
      label: string;
      detail: string;
      meta: string;
    };

interface RankedSuggestion<T> {
  item: T;
  score: number;
  index: number;
}

export function clampComposerSuggestionIndex(length: number, index: number) {
  if (length <= 0) return 0;
  if (!Number.isFinite(index)) return 0;
  return Math.max(0, Math.min(length - 1, Math.trunc(index)));
}

export function nextComposerSuggestionIndex(length: number, index: number, delta: -1 | 1) {
  if (length <= 0) return 0;
  return (clampComposerSuggestionIndex(length, index) + delta + length) % length;
}

export function createSkillSuggestionItems(
  skills: readonly ComposerSkill[],
  trigger: ComposerSkillTrigger | null,
  limit = 8,
): ComposerSuggestionItem[] {
  if (!trigger) return [];
  return rankComposerSuggestionItems(skills, trigger.query, skillSearchFields)
    .slice(0, limit)
    .map((skill) => ({
      id: `skill:${skill.protocol}:${skill.path}`,
      type: "skill",
      skill,
      label: skill.displayName || skill.name,
      detail: skill.description || skill.path,
      meta: formatSkillMeta(skill),
    }));
}

function formatSkillMeta(skill: ComposerSkill) {
  const pieces = [skill.scope, skill.origin].filter((piece) => piece.trim().length > 0);
  return pieces.length > 0 ? pieces.join(" · ") : "skill";
}

type SearchField = {
  value: string | undefined;
  weight?: number;
};

function skillSearchFields(skill: ComposerSkill): SearchField[] {
  return [
    { value: skill.name },
    { value: skill.displayName },
    { value: skill.description, weight: 200 },
    { value: skill.path, weight: 400 },
    { value: skill.origin, weight: 500 },
    { value: skill.scope, weight: 500 },
  ];
}

function normalizeSearchText(value: string | undefined) {
  if (!value) return "";
  return value
    .toLowerCase()
    .replace(/[:/_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compactSearchText(value: string) {
  return value.replace(/\s+/g, "");
}

function scoreSubsequence(value: string, query: string) {
  if (!query) return 0;

  let queryIndex = 0;
  let firstMatchIndex = -1;
  let previousMatchIndex = -1;
  let gapPenalty = 0;

  for (let valueIndex = 0; valueIndex < value.length; valueIndex += 1) {
    if (value[valueIndex] !== query[queryIndex]) continue;

    if (firstMatchIndex === -1) firstMatchIndex = valueIndex;
    if (previousMatchIndex !== -1) gapPenalty += valueIndex - previousMatchIndex - 1;

    previousMatchIndex = valueIndex;
    queryIndex += 1;
    if (queryIndex === query.length) {
      return firstMatchIndex * 2 + gapPenalty * 4 + Math.min(64, value.length - query.length);
    }
  }

  return null;
}

function scoreSearchText(value: string, query: string, options?: { allowFuzzy?: boolean }) {
  if (!query) return 0;
  if (!value) return null;

  const compactValue = compactSearchText(value);
  const compactQuery = compactSearchText(query);
  if (value === query || compactValue === compactQuery) return 0;
  if (value.startsWith(query) || compactValue.startsWith(compactQuery)) return 10;

  const words = value.split(" ").filter(Boolean);
  const wordPrefixIndex = words.findIndex((word) => word.startsWith(query));
  if (wordPrefixIndex !== -1) return 20 + wordPrefixIndex;

  const boundaryIndex = value.indexOf(` ${query}`);
  if (boundaryIndex !== -1) return 30 + boundaryIndex;

  const phraseIndex = value.indexOf(query);
  if (phraseIndex !== -1) return 40 + phraseIndex;

  if (!options?.allowFuzzy) return null;
  const fuzzyScore = scoreSubsequence(compactValue, compactQuery);
  return fuzzyScore === null ? null : 120 + fuzzyScore;
}

function scoreSearchFields(query: string, fields: readonly SearchField[]) {
  let bestScore: number | null = null;
  for (const field of fields) {
    const weight = field.weight ?? 0;
    const fieldScore = scoreSearchText(normalizeSearchText(field.value), query, {
      allowFuzzy: weight === 0,
    });
    if (fieldScore === null) continue;
    const weightedScore = weight + fieldScore;
    if (bestScore === null || weightedScore < bestScore) bestScore = weightedScore;
  }
  return bestScore;
}

export function rankComposerSuggestionItems<T>(
  items: readonly T[],
  query: string,
  fieldsForItem: (item: T) => readonly SearchField[],
) {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return [...items];

  return items
    .map((item, index): RankedSuggestion<T> | null => {
      const score = scoreSearchFields(normalizedQuery, fieldsForItem(item));
      return score === null ? null : { item, score, index };
    })
    .filter((entry): entry is RankedSuggestion<T> => entry !== null)
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .map((entry) => entry.item);
}
