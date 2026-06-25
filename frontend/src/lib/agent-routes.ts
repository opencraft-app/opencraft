export type AgentSettingsSectionId =
  | "channel"
  | "model"
  | "skill"
  | "buddy"
  | "automations"
  | "diagnostics"
  | "memory"
  | "achievement"
  | "chat"
  | "files"
  | "browser"
  | "terminal";

export type AgentWorkbenchSectionId = "workbench";

export type AgentSectionId = AgentSettingsSectionId | AgentWorkbenchSectionId;

export const AGENTS_HOME_PATH = "/agents";

/** 订阅套餐页路由（避免魔法字符串，统一引用） */
export const SUBSCRIBE_PATH = "/subscribe";

export type WorkbenchEntryVisibilityContext = {
  hostname?: string | null;
  revealed?: boolean;
};

export const isLocalWorkbenchHost = (hostname?: string | null): boolean => {
  const normalized = (hostname ?? "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
};

export const shouldShowWorkbenchEntry = ({
  hostname,
  revealed = false,
}: WorkbenchEntryVisibilityContext): boolean => revealed || isLocalWorkbenchHost(hostname);

export const AGENT_SECTION_PATH_BY_ID: Record<AgentSectionId, string> = {
  workbench: `${AGENTS_HOME_PATH}/workbench`,
  channel: `${AGENTS_HOME_PATH}/channels`,
  model: `${AGENTS_HOME_PATH}/models`,
  skill: `${AGENTS_HOME_PATH}/skills`,
  buddy: `${AGENTS_HOME_PATH}/persona`,
  automations: `${AGENTS_HOME_PATH}/automations`,
  diagnostics: `${AGENTS_HOME_PATH}/diagnostics`,
  memory: `${AGENTS_HOME_PATH}/memory`,
  achievement: `${AGENTS_HOME_PATH}/achievements`,
  files: `${AGENTS_HOME_PATH}/files`,
  browser: `${AGENTS_HOME_PATH}/browser`,
  chat: `${AGENTS_HOME_PATH}/chat`,
  terminal: `${AGENTS_HOME_PATH}/terminal`,
};

export const AGENT_SECTION_ID_BY_SLUG: Record<string, AgentSectionId> = {
  channels: "channel",
  models: "model",
  skills: "skill",
  experts: "skill",
  packages: "skill",
  persona: "buddy",
  automations: "automations",
  diagnostics: "diagnostics",
  memory: "memory",
  achievements: "achievement",
  workbench: "workbench",
  session: "workbench",
  files: "files",
  browser: "browser",
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
