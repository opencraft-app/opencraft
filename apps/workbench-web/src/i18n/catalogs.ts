import type { LocaleCatalog } from "@opencraft/i18n";
import companionMessages from "./embedded-companion-messages.json";
import { serverWorkbenchExtensions } from "../runtime/server-product-extensions";
import { withProductCatalogs } from "./product-catalogs";

const productCatalogs = serverWorkbenchExtensions.flatMap(extension => extension.localeCatalogs ?? []);

/** Only ship languages with OpenCraft translations. English copy is derived from consumer defaultMessage descriptors;
 * the explicit catalog lets the four sidebar locales share the same validation. */
const coreLocaleCatalogs: readonly LocaleCatalog[] = Object.freeze([
  { locale: "en-US", label: "English", load: async () => (await import("./locales/en-US.json")).default },
  { locale: "zh-CN", label: "简体中文", load: async () => (await import("./locales/zh-CN.json")).default },
]);
export const localeCatalogs = Object.freeze(withProductCatalogs(coreLocaleCatalogs, productCatalogs));

/** Console-owned companion copy has additional locales. Other messages retain
 * their English defaultMessage fallback; standalone language options stay unchanged. */
export const embeddedLocaleCatalogs: readonly LocaleCatalog[] = Object.freeze(withProductCatalogs([
  ...coreLocaleCatalogs,
  { locale: "ms-MY", label: "Bahasa Melayu", load: async () => (await import("./locales/ms-MY.json")).default },
  { locale: "th-TH", label: "ไทย", load: async () => (await import("./locales/th-TH.json")).default },
  ...Object.entries(companionMessages).map(([locale, messages]) => ({
    locale,
    label: locale,
    load: async () => messages,
  })),
], productCatalogs));
