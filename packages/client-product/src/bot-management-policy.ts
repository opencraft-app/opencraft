/** Trusted product presentation policy, never an authorization grant. */
export interface ClientBotManagementPolicy {
  /** Omitted: all enabled providers. Empty: no providers. */
  readonly providerIds?: readonly string[];
  readonly messages?: Partial<BotManagementMessages>;
}

export interface BotManagementMessages {
  readonly noHosts: string;
  readonly ambiguousHosts: string;
  readonly unsupportedHost: string;
}

export interface ResolvedBotManagementPolicy {
  readonly providerIds?: readonly string[];
  readonly messages: BotManagementMessages;
}

const defaultMessages: BotManagementMessages = Object.freeze({
  noHosts: "添加 Agent 后，可在此管理 Bots。",
  ambiguousHosts: "存在多个 Agent，暂时无法确定 Bot 所属实例。",
  unsupportedHost: "当前 Agent 不支持 Bot 管理。",
});

/** Snapshot assembly input before an extension retains it. */
export function resolveBotManagementPolicy(policy: ClientBotManagementPolicy = {}): ResolvedBotManagementPolicy {
  const providers = policy.providerIds;
  if (providers !== undefined && (!Array.isArray(providers) || providers.some(id =>
    typeof id !== "string" || !id.trim() || id !== id.trim()) || new Set(providers).size !== providers.length)) {
    throw new Error("Bot management provider IDs must be unique non-empty strings.");
  }
  const messages = { ...defaultMessages };
  for (const key of Object.keys(defaultMessages) as (keyof BotManagementMessages)[]) {
    const value = policy.messages?.[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid Bot management message: ${key}`);
    messages[key] = value.trim();
  }
  return Object.freeze({
    ...(providers === undefined ? {} : { providerIds: Object.freeze([...providers]) }),
    messages: Object.freeze(messages),
  });
}
