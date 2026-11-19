import type { LocaleCatalog } from "@opencraft/i18n";

export const ioaLocaleCatalogs: readonly LocaleCatalog[] = [
  { locale: "en-US", label: "English", load: async () => (await import("./locales/en-US.json")).default },
  { locale: "zh-CN", label: "简体中文", load: async () => (await import("./locales/zh-CN.json")).default },
  { locale: "th-TH", label: "ไทย", load: async () => (await import("./locales/th-TH.json")).default },
  { locale: "ms-MY", label: "Bahasa Melayu", load: async () => (await import("./locales/ms-MY.json")).default },
];
