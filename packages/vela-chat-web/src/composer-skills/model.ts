import type {
  BackendKindWire,
  BackendSkillDescriptorWire,
  ClientInputPart,
} from "../../../vela-chat-client/src";
import type { ComposerEditorCursor } from "../composer-editor";

export interface ComposerSkill {
  name: string;
  displayName: string;
  description?: string;
  path: string;
  origin: string;
  scope: string;
  protocol: "codex.skills.v1";
}

export interface ComposerSkillTrigger {
  prefix: "$" | "/";
  query: string;
  start: number;
  end: number;
}

export function toComposerSkills(skills: readonly BackendSkillDescriptorWire[]): ComposerSkill[] {
  return skills.map((skill) => ({
    name: skill.name,
    displayName: skill.display_name,
    description: skill.description,
    path: skill.path,
    origin: skill.origin,
    scope: skill.scope,
    protocol: skill.protocol,
  }));
}

export function readComposerSkillTrigger(
  value: string,
  cursor: ComposerEditorCursor | null,
): ComposerSkillTrigger | null {
  if (!cursor || cursor.start !== cursor.end) return null;
  const end = cursor.start;
  const beforeCursor = value.slice(0, end);
  const match = /(^|\s)([$/])([A-Za-z0-9_.-]*)$/.exec(beforeCursor);
  if (!match) return null;
  const prefix = match[2] as "$" | "/";
  const query = match[3] ?? "";
  const start = end - prefix.length - query.length;
  return { prefix, query, start, end };
}

export function applyComposerSkillToken(
  value: string,
  trigger: ComposerSkillTrigger,
  skill: ComposerSkill,
  preferredPrefix = "$",
) {
  const prefix = preferredPrefix === "/" ? "/" : "$";
  const nextToken = `${prefix}${skill.name}`;
  const nextValue = `${value.slice(0, trigger.start)}${nextToken} ${value.slice(trigger.end)}`;
  return {
    value: nextValue,
    cursorIndex: trigger.start + nextToken.length + 1,
  };
}

export function skillRefInputPartsFromText(
  value: string,
  skills: readonly ComposerSkill[],
  backend?: BackendKindWire,
): Extract<ClientInputPart, { type: "skill_ref" }>[] {
  if (!value.trim() || skills.length === 0) return [];
  const tokens = new Set<string>();
  for (const match of value.matchAll(/(^|\s)[$/]([A-Za-z0-9_.-]+)(?=\s|$)/g)) {
    const name = match[2];
    if (name) tokens.add(name);
  }
  if (tokens.size === 0) return [];
  return skills
    .filter((skill) => tokens.has(skill.name))
    .map((skill) => ({
      type: "skill_ref",
      name: skill.name,
      protocol: skill.protocol,
      ...(backend ? { backend } : {}),
      path: skill.path,
    }));
}
