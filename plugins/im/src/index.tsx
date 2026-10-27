import type { TrustedExtensionDefinition } from "@opencraft/extension-runtime";
import { createDeferredView } from "@opencraft/extension-react";
import { ImController } from "./client";
export { ImClient } from "./client";
export { sourceRoute, stewardRoute } from "./templates";
export const IM_SETTINGS_ID = "opencraft.im.channels";
export function createImExtension(
  fetcher: typeof fetch,
): TrustedExtensionDefinition {
  return {
    manifest: {
      manifestVersion: 1,
      id: "opencraft.im",
      name: "IM channels",
      version: "0.1.0",
      apiVersion: 1,
      trust: "trusted",
      platforms: ["web"],
      activationEvents: ["onStartupFinished"],
    },
    activate(api) {
      const controller = new ImController(fetcher);
      api.views.register({
        id: IM_SETTINGS_ID + ".view",
        title: "IM 渠道",
        viewType: IM_SETTINGS_ID,
        platforms: ["web"],
      });
      api.settings.registerPage({
        id: IM_SETTINGS_ID,
        title: "IM 渠道",
        viewId: IM_SETTINGS_ID + ".view",
        group: "Server",
        icon: "message-circle",
        platforms: ["web"],
      });
      api.internal.register("platformViewRenderer", {
        viewType: IM_SETTINGS_ID,
        Component: createDeferredView(async () =>
          (await import("./view")).createImView(controller),
        ),
      });
      api.subscriptions.add(() => controller.dispose());
    },
  };
}
