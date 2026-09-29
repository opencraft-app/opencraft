import type { LightVelaRegion } from "@opencraft/plugin-lightvela-hermes/account-contract";

export type MobileLanguagePreference = "system" | "zh-CN" | "en-US";
export type MobileLanguage = Exclude<MobileLanguagePreference, "system">;

export function parseMobileLanguagePreference(value: string | null): MobileLanguagePreference {
  return value === "zh-CN" || value === "en-US" ? value : "system";
}

export function resolveMobileLanguage(preference: MobileLanguagePreference, region: LightVelaRegion): MobileLanguage {
  if (preference !== "system") return preference;
  try {
    const deviceLocale = Intl.DateTimeFormat().resolvedOptions().locale;
    if (deviceLocale.toLowerCase().startsWith("zh")) return "zh-CN";
    if (deviceLocale.toLowerCase().startsWith("en")) return "en-US";
  } catch { /* Fall back to the current site region. */ }
  return region === "cn" ? "zh-CN" : "en-US";
}

/** The international site uses zh-SG for its published simplified Chinese locale. */
export function siteLocaleForMobileLanguage(language: MobileLanguage, region: LightVelaRegion): string {
  return region === "cn" ? "zh-CN" : language === "zh-CN" ? "zh-SG" : "en-US";
}

const copy = {
  "zh-CN": {
    agents: "我的智能体",
    account: "账号",
    billing: "套餐与费用",
    welcome: "让创作继续",
    welcomeDescription: "你的智能工作台，随时随地。",
    chooseRegion: "选择站点",
    chinaRegion: "中国大陆",
    internationalRegion: "国际站",
    signIn: "使用 LightVela 登录",
    settings: "设置",
    language: "语言",
    languageDescription: "应用界面与国际站网页使用此语言。",
    system: "跟随系统",
    chinese: "简体中文",
    english: "English",
    chinaNote: "中国大陆站网页目前固定为简体中文。",
    licenses: "开源授权",
    licensesDescription: "查看应用使用的开源组件与许可。",
    licensesIntro: "以下列出此 App 的直接开源依赖。组件的完整许可条款可在其项目页面查看。",
    fullNotice: "LightVela 完整开源声明",
    back: "返回",
    close: "关闭",
    open: "打开",
    opening: "正在打开 LightVela",
    openFailedTitle: "无法打开 LightVela",
    preparing: "正在准备你的智能体和对话。",
    sessionExpired: "登录已过期，请重新登录。",
    sessionOpenFailed: "无法打开 LightVela 会话。",
    verifyFailed: "无法验证 LightVela 会话。",
    retry: "重试",
    signInError: "暂时无法登录，请重试。",
    saveError: "语言保存失败，请重试。",
  },
  "en-US": {
    agents: "My agents",
    account: "Account",
    billing: "Billing",
    welcome: "Keep ideas moving",
    welcomeDescription: "Your workspace, wherever inspiration finds you.",
    chooseRegion: "Choose your region",
    chinaRegion: "Mainland China",
    internationalRegion: "International",
    signIn: "Continue with LightVela",
    settings: "Settings",
    language: "Language",
    languageDescription: "Use this language in the app and the international website.",
    system: "Follow device",
    chinese: "简体中文",
    english: "English",
    chinaNote: "The mainland China website currently uses Simplified Chinese.",
    licenses: "Open-source licenses",
    licensesDescription: "Libraries and licenses used by this app.",
    licensesIntro: "These are this app's direct open-source dependencies. Full license terms are available from each project.",
    fullNotice: "Full LightVela open-source notice",
    back: "Back",
    close: "Close",
    open: "Open",
    opening: "Opening LightVela",
    openFailedTitle: "Could not open LightVela",
    preparing: "Preparing your agents and conversations.",
    sessionExpired: "Your session has expired. Please sign in again.",
    sessionOpenFailed: "Could not open your LightVela session.",
    verifyFailed: "Could not verify your LightVela session.",
    retry: "Try again",
    signInError: "Could not sign in right now. Please try again.",
    saveError: "Could not save the language. Try again.",
  },
} as const;

export function mobileLanguageCopy(language: MobileLanguage) { return copy[language]; }
