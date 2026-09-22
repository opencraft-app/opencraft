import type { LocaleCatalog } from "@opencraft/i18n";

/** Only ship languages with OpenCraft translations. The English source lives
 * beside its consumers as defaultMessage, exactly as in Codex. */
export const localeCatalogs: readonly LocaleCatalog[] = Object.freeze([
  { locale: "en-US", label: "English", load: async () => ({}) },
  { locale: "zh-CN", label: "简体中文", load: async () => (await import("./locales/zh-CN.json")).default },
]);
