import type { ExtensionContributionStore, TrustedExtensionDefinition } from "@opencraft/extension-runtime";
import { createDeferredView, type ExtensionSettingsViewProps, type PlatformViewRendererRegistry } from "@opencraft/extension-react";
import { OVERHOME_VIEW_ID } from "./mini-apps";

export function createOverhomeExtension(contributions: ExtensionContributionStore, renderers: PlatformViewRendererRegistry): TrustedExtensionDefinition { return {
  manifest: { manifestVersion: 1, id: "opencraft.overhome", name: "Applications", version: "0.1.0", apiVersion: 1,
    trust: "trusted", platforms: ["web", "electron"], activationEvents: ["onStartupFinished"] },
  activate(api) {
    api.views.register({ id: OVERHOME_VIEW_ID, title: "Applications", viewType: "opencraft.overhome", platforms: ["web", "electron"] });
    api.internal.register("platformViewRenderer", { viewType: "opencraft.overhome",
      Component: createDeferredView(async () => {
        const { createElement } = await import("react");
        const { OverhomeDesktop } = await import("../features/overhome/desktop");
        return (props: ExtensionSettingsViewProps) => createElement(OverhomeDesktop, { ...props, contributions, renderers });
      }) });
  },
}; }
