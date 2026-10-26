import { defineMessages, LocaleRuntime } from "@opencraft/i18n";

export const mobileMessages = defineMessages({
  brand: { id: "mobile.brand", defaultMessage: "OpenCraft" },
  source: { id: "mobile.source", defaultMessage: "Workspace source" },
  bundled: { id: "mobile.bundled", defaultMessage: "Built-in workspace" },
  remote: { id: "mobile.remote", defaultMessage: "Self-hosted workspace" },
  description: { id: "mobile.description", defaultMessage: "Use the built-in workspace or open your own OpenCraft website." },
  consent: { id: "mobile.consent", defaultMessage: "Load my self-hosted website" },
  url: { id: "mobile.url", defaultMessage: "HTTPS address" },
  privacy: { id: "mobile.privacy", defaultMessage: "Sign in on your server. This mode uses a private browsing session and does not receive the built-in workspace's credentials or native bridge. Switching workspaces closes the current view." },
  apply: { id: "mobile.apply", defaultMessage: "Open workspace" },
  cancel: { id: "mobile.cancel", defaultMessage: "Cancel" },
  restore: { id: "mobile.restore", defaultMessage: "Use built-in workspace" },
  retry: { id: "mobile.retry", defaultMessage: "Retry" },
  loading: { id: "mobile.loading", defaultMessage: "Opening OpenCraft…" },
  failed: { id: "mobile.failed", defaultMessage: "The workspace could not open. Retry or choose another source." },
  invalid: { id: "mobile.invalid", defaultMessage: "Enter an HTTPS address without credentials, query parameters or a fragment." },
  saveFailed: { id: "mobile.saveFailed", defaultMessage: "The selection could not be saved. Your current workspace has not changed." },
  readFailed: { id: "mobile.readFailed", defaultMessage: "The saved source could not be read. Retry or explicitly choose the built-in workspace." },
});

// Reuse the canonical catalogs; native does not own another translation registry.
export const mobileLocale = new LocaleRuntime([
  { locale: "zh-CN", label: "简体中文", load: async () => (await import("../../../workbench-web/src/i18n/locales/zh-CN.json")).default },
  { locale: "ms-MY", label: "Bahasa Melayu", load: async () => (await import("../../../workbench-web/src/i18n/locales/ms-MY.json")).default },
  { locale: "th-TH", label: "ไทย", load: async () => (await import("../../../workbench-web/src/i18n/locales/th-TH.json")).default },
]);
void mobileLocale.update({ systemLocale: Intl.DateTimeFormat().resolvedOptions().locale });
