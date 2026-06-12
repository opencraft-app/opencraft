export type AgentSectionId =
  | "channel"
  | "model"
  | "skill"
  | "buddy"
  | "automations"
  | "memory"
  | "achievement"
  | "chat"
  | "files"
  | "terminal";

export const AGENTS_HOME_PATH = "/agents";

export const AGENT_SECTION_PATH_BY_ID: Record<AgentSectionId, string> = {
  channel: `${AGENTS_HOME_PATH}/channels`,
  model: `${AGENTS_HOME_PATH}/models`,
  skill: `${AGENTS_HOME_PATH}/skills`,
  buddy: `${AGENTS_HOME_PATH}/persona`,
  automations: `${AGENTS_HOME_PATH}/automations`,
  memory: `${AGENTS_HOME_PATH}/memory`,
  achievement: `${AGENTS_HOME_PATH}/achievements`,
  files: `${AGENTS_HOME_PATH}/files`,
  chat: `${AGENTS_HOME_PATH}/chat`,
  terminal: `${AGENTS_HOME_PATH}/terminal`,
};

export const AGENT_SECTION_ID_BY_SLUG: Record<string, AgentSectionId> = {
  channels: "channel",
  models: "model",
  skills: "skill",
  persona: "buddy",
  automations: "automations",
  memory: "memory",
  achievements: "achievement",
  files: "files",
  chat: "chat",
  terminal: "terminal",
};

export const getAgentSectionFromSlug = (slug?: string): AgentSectionId | null => {
  if (!slug) return null;
  return AGENT_SECTION_ID_BY_SLUG[slug] ?? null;
};

export const getAgentCreatingPath = (creating: true | string) => {
  if (creating === true) return `${AGENTS_HOME_PATH}?creating=true`;
  return `${AGENTS_HOME_PATH}?creating=${encodeURIComponent(creating)}`;
};
