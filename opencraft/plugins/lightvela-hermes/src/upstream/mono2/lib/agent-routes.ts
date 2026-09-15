// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
export type AgentSettingsSectionId =
  | "channel"
  | "model"
  | "skill"
  | "buddy"
  | "automations"
  | "diagnostics"
  | "settings"
  | "memory"
  | "achievement"
  | "chat"
  | "files"
  | "browser"
  | "terminal"
  | "deepseek-harness"
  | "website";

export type AgentWorkbenchSectionId = "workbench";
export type AgentLabSectionId = "deepseek-harness";

export type AgentSectionId = AgentSettingsSectionId | AgentWorkbenchSectionId;

export const AGENTS_HOME_PATH = "/agents";
export const AGENT_CREATING_QUERY_KEY = "creating";
export const AGENT_BOT_QUERY_KEY = "bot";

const AGENT_SECTION_PERSISTENT_QUERY_KEYS: readonly string[] = [AGENT_BOT_QUERY_KEY];

/** 订阅套餐页路由（避免魔法字符串，统一引用） */
export const SUBSCRIBE_PATH = "/subscribe";

/** 账号管理页路由（避免魔法字符串，统一引用） */
export const ACCOUNT_PATH = "/account";

/** 账号页实名提醒 query key：首页「立即创建」跳转账号页时携带，触发实名提醒 tips（避免魔法字符串，统一引用） */
export const REALNAME_REQUIRED_QUERY_KEY = "realname_required";

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
  settings: `${AGENTS_HOME_PATH}/settings`,
  memory: `${AGENTS_HOME_PATH}/memory`,
  achievement: `${AGENTS_HOME_PATH}/achievements`,
  files: `${AGENTS_HOME_PATH}/files`,
  browser: `${AGENTS_HOME_PATH}/browser`,
  chat: `${AGENTS_HOME_PATH}/chat`,
  terminal: `${AGENTS_HOME_PATH}/terminal`,
  "deepseek-harness": `${AGENTS_HOME_PATH}/labs/deepseek-harness`,
  website: `${AGENTS_HOME_PATH}/websites`,
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
  settings: "settings",
  memory: "memory",
  achievements: "achievement",
  workbench: "workbench",
  session: "workbench",
  files: "files",
  browser: "browser",
  chat: "chat",
  terminal: "terminal",
  websites: "website",
};

export const AGENT_LAB_SECTION_ID_BY_SLUG: Record<string, AgentLabSectionId> = {
  "deepseek-harness": "deepseek-harness",
};

export const getAgentSectionFromSlug = (slug?: string): AgentSectionId | null => {
  if (!slug) return null;
  return AGENT_SECTION_ID_BY_SLUG[slug] ?? null;
};

export const getAgentLabSectionFromSlug = (slug?: string): AgentLabSectionId | null => {
  if (!slug) return null;
  return AGENT_LAB_SECTION_ID_BY_SLUG[slug] ?? null;
};

export const getAgentCreatingPath = (creating: true | string) => {
  if (creating === true) return `${AGENTS_HOME_PATH}?${AGENT_CREATING_QUERY_KEY}=true`;
  return `${AGENTS_HOME_PATH}?${AGENT_CREATING_QUERY_KEY}=${encodeURIComponent(creating)}`;
};

/**
 * 「订阅成功后引导用户为首个 Bot 命名」的落点：`/agents?create=1`。
 * 与 `creating`（等待 provisioning 的 Loading 态）语义不同：`create` 表示「还没建 Bot，
 * 请打开命名向导让用户输入名字后再创建」。控制台据此自动弹出与「新建 Bot」一致的命名弹窗，
 * 因此订阅链路不再写死默认名，与删除后重建的体验统一。
 */
export const AGENT_CREATE_QUERY_KEY = "create";
export const getAgentCreateBotPath = () =>
  `${AGENTS_HOME_PATH}?${AGENT_CREATE_QUERY_KEY}=1`;

export const getAgentSectionHref = (pathname: string, params: URLSearchParams): string => {
  const next = new URLSearchParams();
  for (const key of AGENT_SECTION_PERSISTENT_QUERY_KEYS) {
    for (const value of params.getAll(key)) {
      next.append(key, value);
    }
  }
  const search = next.toString();
  return `${pathname}${search ? `?${search}` : ""}`;
};

export const getAgentBotSectionHref = (pathname: string, botId: string): string => {
  const params = new URLSearchParams();
  params.set(AGENT_BOT_QUERY_KEY, botId);
  return getAgentSectionHref(pathname, params);
};

/** 我的工作台页路由（避免魔法字符串，统一引用） */
export const WEBSITES_PATH = "/agents/websites/";
