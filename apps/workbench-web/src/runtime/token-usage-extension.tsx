import { createDeferredView, type ExtensionSettingsViewProps } from "@opencraft/extension-react";
import type { TrustedExtensionDefinition } from "@opencraft/extension-runtime";
import { tokenUsageBuiltin } from "./token-usage-builtin";

export const tokenUsageExtension: TrustedExtensionDefinition = {
  manifest: tokenUsageBuiltin.manifest,
  activate(api) {
    api.views.register({ id: "opencraft.token-usage.view", title: "Token usage", viewType: "opencraft.token-usage", platforms: ["web", "electron"] });
    api.settings.registerPage({
      id: "opencraft.token-usage.page",
      title: "Token usage",
      titleMessage: { id: "settings.tokenUsage", defaultMessage: "Token usage" },
      viewId: "opencraft.token-usage.view",
      icon: "database",
      platforms: ["web", "electron"],
    });
    api.internal.register("platformViewRenderer", {
      viewType: "opencraft.token-usage",
      Component: createDeferredView(async () => {
        const Dashboard = (await import("../components/token-usage-dashboard")).default;
        return function TokenUsageView({ host }: ExtensionSettingsViewProps) {
          return <Dashboard key={host.activeHostId} hostId={host.activeHostId} />;
        };
      }),
    });
  },
};
