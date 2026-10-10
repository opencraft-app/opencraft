import type { LocaleCatalog } from "@opencraft/i18n";
import companionMessages from "./embedded-companion-messages.json";

/** Only ship languages with OpenCraft translations. The English source lives
 * beside its consumers as defaultMessage, exactly as in Codex. */
export const localeCatalogs: readonly LocaleCatalog[] = Object.freeze([
  { locale: "en-US", label: "English", load: async () => ({}) },
  { locale: "zh-CN", label: "简体中文", load: async () => (await import("./locales/zh-CN.json")).default },
]);

/** Console-owned companion copy has additional locales. Other messages retain
 * their English defaultMessage fallback; standalone language options stay unchanged. */
export const embeddedLocaleCatalogs: readonly LocaleCatalog[] = Object.freeze([
  ...localeCatalogs,
  { locale: "ms-MY", label: "Bahasa Melayu", load: async () => (await import("./locales/ms-MY.json")).default },
  { locale: "th-TH", label: "ไทย", load: async () => (await import("./locales/th-TH.json")).default },
  ...Object.entries(companionMessages).map(([locale, messages]) => ({
    locale,
    label: locale,
    load: async () => messages,
  })),
]);
