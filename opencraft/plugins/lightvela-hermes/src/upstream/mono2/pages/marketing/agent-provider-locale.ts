// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
const isChineseLocale = (locale: string): boolean => /^zh(?:-|$)/i.test(locale);

/** 七彩石仅维护中英文 provider 元数据；所有非中文 locale 复用英文数据。 */
export const shouldUseEnglishProviderData = (locale?: string): boolean => {
  if (!locale) return false;
  return !isChineseLocale(locale);
};

type TranslateAgentCopy = (copy: string) => string;

type AgentConsoleCollectionSection = "channel" | "model";

/** 英文控制台的资源集合入口使用复数；其他 locale 继续走现有词典。 */
export const resolveAgentConsoleCollectionLabel = (
  section: AgentConsoleCollectionSection,
  locale: string | undefined,
  translate: TranslateAgentCopy,
): string => {
  if (/^en(?:-|$)/i.test(locale ?? "")) {
    return section === "channel" ? "Channels" : "Models";
  }
  return translate(section === "channel" ? "通道" : "模型");
};

/** 后端历史默认名是中文固定值；只本地化该系统默认值，不改用户自定义名称。 */
export const resolveAgentDisplayName = (
  name: string,
  translate: TranslateAgentCopy,
): string => name === "我的Hermes" ? translate("我的Hermes") : name;

/**
 * AgentChat 对所有非中文 locale 使用英文语言包，但旧默认会话标题可能仍返回中文。
 * 只归一化精确的系统默认值，历史消息和用户自定义标题保持原样。
 */
export const resolveAgentSessionTitle = (
  title: string,
  locale: string | undefined,
  fallbackTitle: string,
): string => {
  if (!title) return fallbackTitle;
  if (title === "新会话" && locale && !isChineseLocale(locale)) return "New chat";
  return title;
};
