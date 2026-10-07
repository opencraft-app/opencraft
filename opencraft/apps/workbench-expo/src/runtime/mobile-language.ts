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
    regionSwitchSignOut: "切换站点前请先退出登录。",
    regionSwitchError: "暂时无法切换站点，请重试。",
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
    preparing: "请稍候…",
    signingIn: "正在登录…",
    openFailedTitle: "无法打开 LightVela",
    sessionExpired: "登录已过期，请重新登录。",
    sessionOpenFailed: "无法打开 LightVela 会话。",
    verifyFailed: "无法验证 LightVela 会话。",
    retry: "重试",
    signInError: "暂时无法登录，请重试。",
    saveError: "语言保存失败，请重试。",
    developerMode: "开发者模式",
    developerModeDescription: "开启后可在此查看本机诊断日志。",
    diagnosticLog: "诊断日志",
    diagnosticLogDescription: "仅保留最近 100 行，存储在本机。",
    diagnosticLogEmpty: "暂无日志",
    clearLog: "清空日志",
    siteOpenError: "暂时无法打开我的智能体",
    siteRetry: "重新加载",
    subscriptionManagement: "订阅管理",
    subscriptionManagementDescription: "管理你的 LightVela 订阅与续费方式。",
  },
  "en-US": {
    agents: "My agents",
    account: "Account",
    billing: "Billing",
    welcome: "Keep ideas moving",
    welcomeDescription: "Your workspace, wherever inspiration finds you.",
    chooseRegion: "Choose your region",
    regionSwitchSignOut: "Sign out before switching regions.",
    regionSwitchError: "Could not switch regions. Try again.",
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
    preparing: "Just a moment…",
    signingIn: "Signing in…",
    openFailedTitle: "Could not open LightVela",
    sessionExpired: "Your session has expired. Please sign in again.",
    sessionOpenFailed: "Could not open your LightVela session.",
    verifyFailed: "Could not verify your LightVela session.",
    retry: "Try again",
    signInError: "Could not sign in right now. Please try again.",
    saveError: "Could not save the language. Try again.",
    developerMode: "Developer mode",
    developerModeDescription: "Enable to view local diagnostic logs here.",
    diagnosticLog: "Diagnostic log",
    diagnosticLogDescription: "The latest 100 lines are kept on this device.",
    diagnosticLogEmpty: "No log entries yet",
    clearLog: "Clear log",
    siteOpenError: "Could not open My agents",
    siteRetry: "Reload",
    subscriptionManagement: "Subscription management",
    subscriptionManagementDescription: "Manage your LightVela subscription and renewal method.",
  },
} as const;

export function mobileLanguageCopy(language: MobileLanguage) { return copy[language]; }
