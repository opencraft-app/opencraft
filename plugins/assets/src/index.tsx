import type { TrustedExtensionDefinition } from "@opencraft/extension-runtime";
import { createDeferredView } from "@opencraft/extension-react";
import { AssetsEntry } from "./entry";
import { ASSETS_VIEW_ID } from "./navigation";
import type { AssetsViewOptions } from "./ports";
export type { AssetsAccount, AssetConnections, AssetVariablesProps, AssetsViewOptions } from "./ports";
export type { AssetProvider } from "./providers";
export { e2bAssetProvider } from "./providers";

/** One provider-neutral page and navigation owner, shared by Web and Electron. */
export function createAssetsExtension(options: AssetsViewOptions): TrustedExtensionDefinition {
  return {
    manifest: {
      manifestVersion: 1,
      id: ASSETS_VIEW_ID,
      name: "Assets",
      version: "0.1.0",
      apiVersion: 1,
      trust: "trusted",
      platforms: ["web", "electron"],
      activationEvents: ["onStartupFinished"],
    },
    activate(api) {
      const titleMessage = { id: "assets.title", defaultMessage: "Assets" };
      api.views.register({
        id: ASSETS_VIEW_ID,
        title: "Assets",
        titleMessage,
        viewType: ASSETS_VIEW_ID,
        platforms: ["web", "electron"],
        keepConversationSidebar: true,
      });
      api.views.register({
        id: ASSETS_VIEW_ID + ".entry",
        title: "Assets",
        viewType: ASSETS_VIEW_ID + ".entry",
        platforms: ["web", "electron"],
      });
      api.sidebar.registerCatalog({
        id: ASSETS_VIEW_ID + ".catalog",
        title: "Assets",
        titleMessage,
        viewId: ASSETS_VIEW_ID + ".entry",
        presentation: "entry",
        order: 36,
      });
      api.internal.register("platformViewRenderer", { viewType: ASSETS_VIEW_ID + ".entry", Component: AssetsEntry });
      api.internal.register("platformViewRenderer", {
        viewType: ASSETS_VIEW_ID,
        Component: createDeferredView(async () => (await import("./view")).createAssetsView(options)),
      });
    },
  };
}
