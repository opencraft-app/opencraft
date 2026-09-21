import type {
  ComposerContextReference,
  SubmitIntent,
} from "@opencraft/composer-core";
import type { BrowserTabWithPage } from "./browser-workbench-coordinator";

export const OPENCRAFT_BROWSER_AMBIENT_CONTEXT_ID = "vela.browser.tabs";

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function createBrowserAmbientContext(
  tabs: readonly BrowserTabWithPage[],
): ComposerContextReference | null {
  if (tabs.length === 0) return null;
  const value = [
    '<opencraft-browser-state trust="untrusted-page-metadata">',
    "  <instruction>Browser tabs are currently presented in OpenCraft. Their presence does not prove that a page loaded or rendered correctly. Use the OpenCraft browser tools to inspect or operate them.</instruction>",
    ...tabs.map(({ tab, page }) => [
      `  <tab id="${escapeXml(tab.id)}" loading="${String(page.navigation.isLoading)}">`,
      `    <url>${escapeXml(page.navigation.currentUrl ?? "")}</url>`,
      `    <title>${escapeXml(page.title)}</title>`,
      "  </tab>",
    ].join("\n")),
    "</opencraft-browser-state>",
  ].join("\n");
  return {
    id: OPENCRAFT_BROWSER_AMBIENT_CONTEXT_ID,
    kind: "annotation",
    title: "OpenCraft browser tabs",
    uri: null,
    visible: true,
    metadata: {
      additionalContextKind: "untrusted",
      value,
    },
  };
}

/**
 * Attach ambient browser metadata at the immutable SubmitIntent boundary.
 * This keeps UI state out of the Replica and avoids mutating the editable
 * Composer Draft merely because a browser tab opened or navigated.
 */
export function withBrowserAmbientContext(
  intent: SubmitIntent,
  tabs: readonly BrowserTabWithPage[],
): SubmitIntent {
  if (!intent.options.autoContext || intent.target.type === "enqueue-follow-up") {
    return intent;
  }
  const ambient = createBrowserAmbientContext(tabs);
  if (ambient === null) return intent;
  return {
    ...intent,
    context: [
      ...intent.context.filter((entry) => entry.id !== OPENCRAFT_BROWSER_AMBIENT_CONTEXT_ID),
      ambient,
    ],
  };
}
